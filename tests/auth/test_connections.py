# The fixtures of tests/auth/test_invitations.py are imported by name; using them as parameters
# is what pytest expects, so F811 does not apply to this file.
# ruff: noqa: F811
"""The connection overview per apartment (epic E13 R4b, docs/API.md section 7), on a real
PostgreSQL. `world` has apartments 14 (owned by Ivan Petrov), 2 and 21; the tests add more.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.auth.models import AuthInvitation
from src.modules.auth.policies import connection_status
from src.modules.auth.schemas import ConnectionStatus
from src.modules.property.models import Apartment, ApartmentMembership, User
from src.modules.property.schemas import RelationType
from tests.auth.test_invitations import (  # noqa: F401 (fixtures used by name)
    API,
    World,
    app,
    as_,
    client,
    drain,
    mail_settings,
    unique,
    world,
)
from tests.factories import create_apartment, create_building, create_membership, create_user


async def overview(client: AsyncClient, world: World, **params: object):
    response = await client.get(
        f"{API}/connections", params=params, headers=as_(world, world.chairman)
    )
    assert response.status_code == 200, response.text
    return response.json()


def by_number(body: dict) -> dict[str, dict]:
    return {item["apartment_number"]: item for item in body["items"]}


async def invite_owner(client: AsyncClient, world: World, number: str) -> dict:
    response = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("o"), "apartment_number": number},
        headers=as_(world, world.chairman),
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_each_apartment_gets_the_first_status_that_applies(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    building = world.building
    rented = await create_apartment(db_session, building, "30", entrance=3)
    tenant = await create_user(db_session, building, "Tom Tenant", email=unique("tenant"))
    await create_membership(db_session, tenant, rented, relation=RelationType.TENANT)
    paper = await create_apartment(db_session, building, "31", entrance=3)
    await create_apartment(db_session, building, "32", entrance=3)
    left = await create_apartment(db_session, building, "33", entrance=3)
    gone = await create_user(db_session, building, "Gone Owner", email=unique("gone"))
    await create_membership(db_session, gone, left)
    await db_session.execute(update(User).where(User.id == gone.id).values(is_active=False))

    await invite_owner(client, world, "2")
    old = await invite_owner(client, world, "32")
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == uuid.UUID(old["invitation_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(days=1))
    )
    marked = await client.put(
        f"{API}/connections/{paper.id}/paper",
        json={"on_paper": True},
        headers=as_(world, world.chairman),
    )
    assert marked.status_code == 200, marked.text
    assert (marked.json()["status"], marked.json()["on_paper"]) == ("PAPER", True)

    body = await overview(client, world)
    items = by_number(body)
    assert {number: item["status"] for number, item in items.items()} == {
        "14": "CONNECTED",
        "2": "INVITED",
        "21": "NOT_INVITED",
        "30": "TENANT_ONLY",
        "31": "PAPER",
        "32": "EXPIRED",
        "33": "NOT_INVITED",  # its only owner's account is closed
    }
    assert (items["14"]["owners"], items["14"]["tenants"]) == (1, 0)
    assert (items["30"]["owners"], items["30"]["tenants"]) == (0, 1)
    assert items["33"]["owners"] == 0
    assert items["2"]["invitation_delivery"] == "QUEUED"
    assert items["2"]["last_invited_at"] is not None and items["21"]["last_invited_at"] is None
    assert items["32"]["invitation_delivery"] is None  # nothing pending
    assert body["summary"] == {
        "apartments": 7,
        "connected": 1,
        "by_status": {
            "CONNECTED": 1,
            "INVITED": 1,
            "NOT_INVITED": 2,
            "TENANT_ONLY": 1,
            "PAPER": 1,
            "EXPIRED": 1,
        },
    }
    # Entrance first, then the natural order of the numbers.
    assert [item["apartment_number"] for item in body["items"]] == [
        "2",
        "21",
        "14",
        "30",
        "31",
        "32",
        "33",
    ]


async def test_a_sent_invitation_shows_as_sent_and_connecting_wins_over_the_paper_mark(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    await invite_owner(client, world, "21")
    await drain(client)
    assert by_number(await overview(client, world))["21"]["invitation_delivery"] == "SENT"
    await client.put(
        f"{API}/connections/{world.apt_14.id}/paper",
        json={"on_paper": True},
        headers=as_(world, world.chairman),
    )
    item = by_number(await overview(client, world))["14"]
    assert (item["status"], item["on_paper"]) == ("CONNECTED", True)


async def test_the_filter_and_the_pages(client: AsyncClient, world: World) -> None:
    body = await overview(client, world, status="NOT_INVITED", limit=1, offset=1)
    assert body["matching"] == 2
    assert [item["apartment_number"] for item in body["items"]] == ["21"]
    assert body["summary"]["apartments"] == 3  # the summary ignores the filter
    response = await client.get(
        f"{API}/connections", params={"limit": 501}, headers=as_(world, world.chairman)
    )
    assert response.status_code == 422


async def test_it_shows_no_names_and_no_e_mails(client: AsyncClient, world: World) -> None:
    await invite_owner(client, world, "2")
    response = await client.get(f"{API}/connections", headers=as_(world, world.chairman))
    text = response.text
    assert "Ivan" not in text and "Petrov" not in text and "@" not in text


async def test_only_the_chairman_sees_it_and_marks_paper(client: AsyncClient, world: World) -> None:
    for user in (world.owner_14, world.accountant):
        listed = await client.get(f"{API}/connections", headers=as_(world, user))
        assert listed.json()["error_code"] == "FORBIDDEN"
        marked = await client.put(
            f"{API}/connections/{world.apt_2.id}/paper",
            json={"on_paper": True},
            headers=as_(world, user),
        )
        assert marked.json()["error_code"] == "FORBIDDEN"
    demo = await client.get(
        f"{API}/connections", headers={"X-Demo-User-Id": str(world.chairman.id)}
    )
    assert demo.status_code == 401


async def test_the_paper_mark_of_an_unknown_apartment(client: AsyncClient, world: World) -> None:
    response = await client.put(
        f"{API}/connections/{uuid.uuid4()}/paper",
        json={"on_paper": True},
        headers=as_(world, world.chairman),
    )
    assert (response.status_code, response.json()["error_code"]) == (404, "APARTMENT_NOT_FOUND")
    cleared = await client.put(
        f"{API}/connections/{world.apt_2.id}/paper",
        json={"on_paper": False},
        headers=as_(world, world.chairman),
    )
    assert (cleared.json()["status"], cleared.json()["on_paper"]) == ("NOT_INVITED", False)


async def test_counts_leave_out_ended_memberships_closed_accounts_and_family(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    building = world.building
    sold = await create_apartment(db_session, building, "40", entrance=4)
    seller = await create_user(db_session, building, "Seller", email=unique("seller"))
    ended = await create_membership(db_session, seller, sold)
    await db_session.execute(
        update(ApartmentMembership)
        .where(ApartmentMembership.id == ended.id)
        .values(ended_at=datetime.now(UTC))
    )
    family = await create_apartment(db_session, building, "41", entrance=4)
    child = await create_user(db_session, building, "Child", email=unique("child"))
    await create_membership(db_session, child, family, relation=RelationType.RESIDENT)
    shared = await create_apartment(db_session, building, "42", entrance=4)
    for name, active in (("Active Owner", True), ("Closed Owner", False)):
        person = await create_user(db_session, building, name, email=unique("co"))
        await create_membership(db_session, person, shared)
        if not active:
            await db_session.execute(
                update(User).where(User.id == person.id).values(is_active=False)
            )
    rented = await create_apartment(db_session, building, "43", entrance=4)
    gone_tenant = await create_user(db_session, building, "Gone Tenant", email=unique("gt"))
    await create_membership(db_session, gone_tenant, rented, relation=RelationType.TENANT)
    await db_session.execute(update(User).where(User.id == gone_tenant.id).values(is_active=False))
    items = by_number(await overview(client, world))
    counts = {
        n: (items[n]["owners"], items[n]["tenants"], items[n]["status"])
        for n in ("40", "41", "42", "43")
    }
    assert counts == {
        "40": (0, 0, "NOT_INVITED"),
        "41": (0, 0, "NOT_INVITED"),
        "42": (1, 0, "CONNECTED"),
        "43": (0, 0, "NOT_INVITED"),
    }


async def test_invited_comes_before_tenants_and_paper_and_paper_before_expired(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    building = world.building
    rented = await create_apartment(db_session, building, "50", entrance=5)
    tenant = await create_user(db_session, building, "T", email=unique("t"))
    await create_membership(db_session, tenant, rented, relation=RelationType.TENANT)
    marked = await create_apartment(db_session, building, "51", entrance=5)
    old = await create_apartment(db_session, building, "52", entrance=5)
    await invite_owner(client, world, "50")
    await invite_owner(client, world, "51")
    expired = await invite_owner(client, world, "52")
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == uuid.UUID(expired["invitation_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(days=1))
    )
    chairman = as_(world, world.chairman)
    for apartment in (marked, old):
        await client.put(
            f"{API}/connections/{apartment.id}/paper", json={"on_paper": True}, headers=chairman
        )
    items = by_number(await overview(client, world))
    assert [items[n]["status"] for n in ("50", "51", "52")] == ["INVITED", "INVITED", "PAPER"]


async def test_last_invited_at_is_the_latest_e_mail_of_any_owner_invitation(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    first = await invite_owner(client, world, "21")
    await invite_owner(client, world, "21")  # another e-mail, created later
    await drain(client)
    week_ago = datetime.now(UTC) - timedelta(days=8)
    await db_session.execute(
        update(AuthInvitation).values(last_sent_at=week_ago, expires_at=week_ago)
    )
    resent = await client.post(
        f"{API}/invitations/{first['invitation_id']}/resend", headers=chairman
    )
    assert resent.status_code == 200, resent.text
    await drain(client)
    item = by_number(await overview(client, world))["21"]
    assert item["status"] == "INVITED" and item["invitation_delivery"] == "SENT"
    assert datetime.fromisoformat(item["last_invited_at"]) > week_ago + timedelta(days=7)


async def test_the_paper_mark_of_another_building_is_refused_and_unchanged(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    other = await create_building(db_session)
    foreign = await create_apartment(db_session, other, "1")
    response = await client.put(
        f"{API}/connections/{foreign.id}/paper",
        json={"on_paper": True},
        headers=as_(world, world.chairman),
    )
    assert (response.status_code, response.json()["error_code"]) == (404, "APARTMENT_NOT_FOUND")
    db_session.expunge_all()
    stored = await db_session.get(Apartment, foreign.id)
    assert stored is not None and stored.on_paper is False


@pytest.mark.parametrize(
    ("owners", "tenants", "on_paper", "invited", "expired", "expected"),
    [
        (1, 1, True, True, True, ConnectionStatus.CONNECTED),
        (0, 1, True, True, True, ConnectionStatus.INVITED),
        (0, 1, True, False, True, ConnectionStatus.TENANT_ONLY),
        (0, 0, True, False, True, ConnectionStatus.PAPER),
        (0, 0, False, False, True, ConnectionStatus.EXPIRED),
        (0, 0, False, False, False, ConnectionStatus.NOT_INVITED),
    ],
)
def test_the_status_rule(
    owners: int,
    tenants: int,
    on_paper: bool,
    invited: bool,
    expired: bool,
    expected: ConnectionStatus,
) -> None:
    assert (
        connection_status(
            owners=owners,
            tenants=tenants,
            on_paper=on_paper,
            invited=invited,
            newest_expired_unused=expired,
        )
        == expected
    )
