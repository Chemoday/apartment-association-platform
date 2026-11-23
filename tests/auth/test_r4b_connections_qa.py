# The fixtures of tests/auth/test_invitations.py are imported by name; using them as parameters
# is what pytest expects, so F811 does not apply to this file.
# ruff: noqa: F811
"""QA pass over epic E13 R4b, the connection overview per apartment (docs/API.md section 7, "The
connection overview"): the precedence of the statuses with invitations, codes, requests, tenants,
family, paper marks and closed accounts together; `last_invited_at` and `invitation_delivery`;
the summary, the filter and the pages; the paper mark; and that no name, e-mail or phone shows.

`world` has apartments 14 (owned by Ivan Petrov, entrance 2), 2 and 21 (entrance 1).
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.auth.models import AuthInvitation, AuthJoinCode
from src.modules.property.models import ApartmentMembership
from src.modules.property.schemas import DisplayMode, RelationType
from tests.auth.test_connections import by_number, invite_owner, overview
from tests.auth.test_invitations import (  # noqa: F401 (fixtures used by name)
    API,
    World,
    app,
    as_,
    client,
    drain,
    invite_and_open,
    mail_settings,
    redeem,
    register,
    unique,
    world,
)
from tests.auth.test_join_codes import issue, submit, waiting
from tests.factories import create_apartment, create_membership, create_user
from tests.smtp_server import SmtpServer

ITEM_FIELDS = {
    "apartment_id",
    "apartment_number",
    "entrance",
    "status",
    "owners",
    "tenants",
    "on_paper",
    "last_invited_at",
    "invitation_delivery",
}


async def request_join(client: AsyncClient, world: World, apartment_id: uuid.UUID) -> dict:
    """Issue a code for the apartment and leave a request with it; returns the code item."""
    code = (await issue(client, world, [apartment_id]))["codes"][0]
    response = await submit(client, code["join_code"], unique("joiner"))
    assert response.status_code == 202, response.text
    return code


async def mark_paper(client: AsyncClient, world: World, apartment_id: uuid.UUID, on: bool = True):
    return await client.put(
        f"{API}/connections/{apartment_id}/paper",
        json={"on_paper": on},
        headers=as_(world, world.chairman),
    )


async def set_created(
    session: AsyncSession, model: type, row_id: str, created: datetime, **values: object
) -> None:
    await session.execute(
        update(model).where(model.id == uuid.UUID(row_id)).values(created_at=created, **values)
    )


def at(value: str | None) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


# --- Precedence ----------------------------------------------------------------------------------


async def test_a_waiting_join_request_comes_before_a_pending_invitation_and_a_code(
    client: AsyncClient, world: World
) -> None:
    await invite_owner(client, world, "2")
    await request_join(client, world, world.apt_2.id)
    await issue(client, world, [world.apt_2.id])  # another unused code
    await mark_paper(client, world, world.apt_2.id)
    item = by_number(await overview(client, world))["2"]
    assert item["status"] == "JOIN_REQUEST"
    assert item["invitation_delivery"] == "QUEUED"  # the pending invitation is still shown
    assert item["on_paper"] is True


async def test_an_active_owner_wins_over_requests_invitations_and_codes(
    client: AsyncClient, world: World
) -> None:
    await invite_owner(client, world, "14")  # a co-owner
    await request_join(client, world, world.apt_14.id)
    await issue(client, world, [world.apt_14.id])
    item = by_number(await overview(client, world))["14"]
    assert (item["status"], item["owners"], item["invitation_delivery"]) == (
        "CONNECTED",
        1,
        "QUEUED",
    )


async def test_a_pending_invitation_comes_before_a_code_and_a_code_before_tenants_and_paper(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    rented = await create_apartment(db_session, world.building, "60", entrance=6)
    tenant = await create_user(db_session, world.building, "Tiit Tenant", email=unique("t"))
    await create_membership(db_session, tenant, rented, relation=RelationType.TENANT)
    paper = await create_apartment(db_session, world.building, "61", entrance=6)
    await invite_owner(client, world, "2")
    await issue(client, world, [world.apt_2.id, rented.id, paper.id])
    await mark_paper(client, world, paper.id)
    items = by_number(await overview(client, world))
    assert [items[n]["status"] for n in ("2", "60", "61")] == [
        "INVITED",
        "CODE_ISSUED",
        "CODE_ISSUED",
    ]
    assert (items["60"]["tenants"], items["61"]["on_paper"]) == (1, True)
    assert items["60"]["invitation_delivery"] is None  # a code is not an invitation


async def test_tenants_come_before_the_paper_mark_and_a_closed_owner_counts_for_nothing(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    from src.modules.property.models import User

    flat = await create_apartment(db_session, world.building, "62", entrance=6)
    closed = await create_user(db_session, world.building, "Closed Owner", email=unique("c"))
    await create_membership(db_session, closed, flat)
    await db_session.execute(update(User).where(User.id == closed.id).values(is_active=False))
    tenant = await create_user(db_session, world.building, "Active Tenant", email=unique("t"))
    await create_membership(db_session, tenant, flat, relation=RelationType.TENANT)
    child = await create_user(db_session, world.building, "Family Child", email=unique("f"))
    await create_membership(db_session, child, flat, relation=RelationType.RESIDENT)
    await mark_paper(client, world, flat.id)
    item = by_number(await overview(client, world))["62"]
    assert (item["status"], item["owners"], item["tenants"], item["on_paper"]) == (
        "TENANT_ONLY",
        0,
        1,
        True,
    )


async def test_the_newest_of_invitations_and_codes_decides_whether_it_expired(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    extra = await create_apartment(db_session, world.building, "22", entrance=1)
    now = datetime.now(UTC)
    old, newer = now - timedelta(days=10), now - timedelta(days=5)
    gone = now - timedelta(days=1)

    async def rejected_code(apartment_id: uuid.UUID, created: datetime) -> None:
        code = await request_join(client, world, apartment_id)
        [request] = [
            r for r in await waiting(client, world) if r["apartment_id"] == str(apartment_id)
        ]
        reject = f"{API}/join-requests/{request['request_id']}/reject"
        assert (await client.post(reject, headers=chairman)).status_code == 204
        await set_created(db_session, AuthJoinCode, code["code_id"], created)

    # 2: an expired invitation, then a code that was used (its request rejected).
    first = await invite_owner(client, world, "2")
    await set_created(db_session, AuthInvitation, first["invitation_id"], old, expires_at=gone)
    await rejected_code(world.apt_2.id, newer)
    # 21: a used code, then an invitation that ran out unused.
    await rejected_code(world.apt_21.id, old)
    second = await invite_owner(client, world, "21")
    await set_created(db_session, AuthInvitation, second["invitation_id"], newer, expires_at=gone)
    # 22: an expired invitation, then a cancelled code (which counts for nothing).
    third = await invite_owner(client, world, "22")
    await set_created(db_session, AuthInvitation, third["invitation_id"], old, expires_at=gone)
    cancelled = (await issue(client, world, [extra.id]))["codes"][0]
    await client.delete(f"{API}/join-codes/{cancelled['code_id']}", headers=chairman)
    await set_created(db_session, AuthJoinCode, cancelled["code_id"], newer)

    items = by_number(await overview(client, world))
    assert {n: items[n]["status"] for n in ("2", "21", "22")} == {
        "2": "NOT_INVITED",
        "21": "EXPIRED",
        "22": "EXPIRED",
    }
    assert all(items[n]["invitation_delivery"] is None for n in ("2", "21", "22"))


async def test_tenant_and_staff_invitations_do_not_count(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    tenant_invite = await client.post(
        f"{API}/invitations",
        json={"kind": "TENANT", "email": unique("t"), "apartment_id": str(world.apt_14.id)},
        headers=as_(world, world.owner_14),
    )
    assert tenant_invite.status_code == 201
    staff = await client.post(
        f"{API}/invitations",
        json={"kind": "STAFF", "email": unique("s"), "building_role": "BOARD"},
        headers=as_(world, world.chairman),
    )
    assert staff.status_code == 201
    await db_session.execute(
        update(ApartmentMembership)
        .where(ApartmentMembership.user_id == world.owner_14.id)
        .values(ended_at=datetime.now(UTC))
    )
    items = by_number(await overview(client, world))
    assert {
        n: (items[n]["status"], items[n]["last_invited_at"], items[n]["invitation_delivery"])
        for n in ("14", "2", "21")
    } == {n: ("NOT_INVITED", None, None) for n in ("14", "2", "21")}


# --- Dates and delivery --------------------------------------------------------------------------


async def test_an_accepted_invitation_keeps_its_date_after_the_membership_ended(
    client: AsyncClient, world: World, db_session: AsyncSession, smtp_server: SmtpServer
) -> None:
    email = unique("accepted")
    _, token = await invite_and_open(
        client, smtp_server, as_(world, world.chairman),
        kind="OWNER", email=email, apartment_number="21",
    )  # fmt: skip
    form = (await redeem(client, token)).json()
    assert (await register(client, form["registration_token"])).status_code == 200
    connected = by_number(await overview(client, world))["21"]
    assert (connected["status"], connected["owners"]) == ("CONNECTED", 1)
    assert connected["invitation_delivery"] is None  # accepted: nothing pending
    await db_session.execute(
        update(ApartmentMembership)
        .where(ApartmentMembership.apartment_id == world.apt_21.id)
        .values(ended_at=datetime.now(UTC))
    )
    item = by_number(await overview(client, world))["21"]
    assert (item["status"], item["owners"], item["invitation_delivery"]) == (
        "NOT_INVITED",
        0,
        None,
    )
    assert at(item["last_invited_at"]) == at(connected["last_invited_at"]) is not None


async def test_an_invitation_that_expired_unsent_shows_its_creation_time_and_no_delivery(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    made = await invite_owner(client, world, "2")
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == uuid.UUID(made["invitation_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
    )
    item = by_number(await overview(client, world))["2"]
    assert (item["status"], item["invitation_delivery"]) == ("EXPIRED", None)
    assert at(item["last_invited_at"]) == at(made["created_at"])


async def test_a_resend_still_queued_keeps_the_date_of_the_last_e_mail_that_went_out(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    made = await invite_owner(client, world, "21")
    await drain(client)
    three_days_ago = datetime.now(UTC) - timedelta(days=3)
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == uuid.UUID(made["invitation_id"]))
        .values(last_sent_at=three_days_ago)
    )
    resent = await client.post(
        f"{API}/invitations/{made['invitation_id']}/resend", headers=as_(world, world.chairman)
    )
    assert resent.status_code == 200
    queued = by_number(await overview(client, world))["21"]
    assert (queued["status"], queued["invitation_delivery"]) == ("INVITED", "QUEUED")
    assert at(queued["last_invited_at"]) == three_days_ago
    await drain(client)
    sent = by_number(await overview(client, world))["21"]
    assert sent["invitation_delivery"] == "SENT"
    assert at(sent["last_invited_at"]) > datetime.now(UTC) - timedelta(minutes=5)


async def test_a_code_issue_counts_as_the_latest_activity(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    made = await invite_owner(client, world, "2")
    await drain(client)
    week_ago = datetime.now(UTC) - timedelta(days=7)
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == uuid.UUID(made["invitation_id"]))
        .values(last_sent_at=week_ago)
    )
    await issue(client, world, [world.apt_2.id])
    item = by_number(await overview(client, world))["2"]
    assert item["status"] == "INVITED"
    assert at(item["last_invited_at"]) > datetime.now(UTC) - timedelta(minutes=5)  # the code


# --- Summary, filter and pages -------------------------------------------------------------------


async def test_the_summary_lists_only_statuses_that_occur_whatever_the_filter_and_page(
    client: AsyncClient, world: World
) -> None:
    await issue(client, world, [world.apt_21.id])
    body = await overview(client, world, status="CONNECTED", limit=1, offset=5)
    assert body["summary"] == {
        "apartments": 3,
        "connected": 1,
        "by_status": {"CONNECTED": 1, "NOT_INVITED": 1, "CODE_ISSUED": 1},
    }
    assert (body["matching"], body["items"]) == (1, [])
    only_codes = await overview(client, world, status="CODE_ISSUED")
    assert [(i["apartment_number"], i["status"]) for i in only_codes["items"]] == [
        ("21", "CODE_ISSUED")
    ]


async def test_the_pages_past_the_end_and_a_status_nobody_has(
    client: AsyncClient, world: World
) -> None:
    past = await overview(client, world, offset=100_000)
    assert (past["matching"], past["items"]) == (3, [])
    none = await overview(client, world, status="JOIN_REQUEST")
    assert (none["matching"], none["items"]) == (0, [])
    widest = await overview(client, world, limit=500)
    assert len(widest["items"]) == 3
    assert all(set(item) == ITEM_FIELDS for item in widest["items"])


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 0},
        {"limit": 501},
        {"offset": -1},
        {"offset": 100_001},
        {"status": "BOGUS"},
        {"status": "connected"},
        {"limit": "ten"},
    ],
)
async def test_bad_filters_are_validation_errors(
    client: AsyncClient, world: World, params: dict
) -> None:
    response = await client.get(
        f"{API}/connections", params=params, headers=as_(world, world.chairman)
    )
    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


# --- The paper mark ------------------------------------------------------------------------------


async def test_the_paper_mark_answers_with_the_item_of_the_list_and_can_be_set_twice(
    client: AsyncClient, world: World
) -> None:
    first = await mark_paper(client, world, world.apt_21.id)
    second = await mark_paper(client, world, world.apt_21.id)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert set(first.json()) == ITEM_FIELDS
    assert first.json() == by_number(await overview(client, world))["21"]
    assert (first.json()["status"], first.json()["on_paper"]) == ("PAPER", True)
    cleared = await mark_paper(client, world, world.apt_21.id, on=False)
    assert (cleared.json()["status"], cleared.json()["on_paper"]) == ("NOT_INVITED", False)


@pytest.mark.parametrize(
    "body", [{}, {"on_paper": None}, {"on_paper": True, "note": "x"}, {"on_paper": [True]}]
)
async def test_the_paper_mark_needs_exactly_a_boolean(
    client: AsyncClient, world: World, body: dict
) -> None:
    response = await client.put(
        f"{API}/connections/{world.apt_2.id}/paper",
        json=body,
        headers=as_(world, world.chairman),
    )
    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")
    assert by_number(await overview(client, world))["2"]["on_paper"] is False


async def test_the_paper_mark_of_a_malformed_id_is_a_validation_error(
    client: AsyncClient, world: World
) -> None:
    response = await client.put(
        f"{API}/connections/not-a-uuid/paper",
        json={"on_paper": True},
        headers=as_(world, world.chairman),
    )
    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


# --- Privacy and join requests -------------------------------------------------------------------


async def test_the_overview_shows_no_name_e_mail_or_phone_of_anyone(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    open_owner = await create_user(
        db_session, world.building, "Kristjan Avalik", email=unique("open"), phone="+372 5123 4567"
    )
    await create_membership(db_session, open_owner, world.apt_21, mode=DisplayMode.FULL_NAME)
    tenant = await create_user(
        db_session, world.building, "Tiina Uurnik", email=unique("rent"), phone="+372 5765 4321"
    )
    await create_membership(
        db_session, tenant, world.apt_14, relation=RelationType.TENANT, mode=DisplayMode.FULL_NAME
    )
    await invite_owner(client, world, "2")
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    await client.post(
        f"{API}/join",
        json={
            "join_code": code,
            "full_name": "Salme Taotleja",
            "phone": "+372 5999 8888",
            "email": unique("asker"),
        },
    )
    response = await client.get(f"{API}/connections", headers=as_(world, world.chairman))
    assert response.status_code == 200
    text = response.text
    # Whole numbers in every form (as typed, E.164, the national digits): a 4-digit part could
    # match the microseconds of a timestamp or a UUID by chance.
    phones = [
        form
        for typed in ("+372 5123 4567", "+372 5765 4321", "+372 5999 8888")
        for form in (typed, typed.replace(" ", ""), typed[5:], typed[5:].replace(" ", ""))
    ]
    for private in (
        "Kristjan", "Avalik", "Tiina", "Uurnik", "Ivan", "Petrov", "Salme", "Taotleja",
        "@", *phones, code, code.replace("-", ""),
    ):  # fmt: skip
        assert private not in text
    marked = await mark_paper(client, world, world.apt_21.id)
    assert "Kristjan" not in marked.text and "@" not in marked.text


async def test_a_confirmed_join_request_turns_into_an_invitation_in_the_overview(
    client: AsyncClient, world: World
) -> None:
    await request_join(client, world, world.apt_21.id)
    assert by_number(await overview(client, world))["21"]["status"] == "JOIN_REQUEST"
    [request] = await waiting(client, world)
    confirmed = await client.post(
        f"{API}/join-requests/{request['request_id']}/confirm",
        headers=as_(world, world.chairman),
    )
    assert confirmed.status_code == 200
    item = by_number(await overview(client, world))["21"]
    assert (item["status"], item["invitation_delivery"]) == ("INVITED", "QUEUED")
