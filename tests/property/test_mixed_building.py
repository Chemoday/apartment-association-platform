"""Views of a building with apartments, parking spaces and garages (epic E14, task K1): every
view that names an object by number carries its kind, an object without an entrance, a floor or
an area is shown with null, and badges name the object by kind."""

import uuid
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.core.security import DEMO_USER_HEADER, create_access_token
from src.modules.meters.models import MeterDevice
from src.modules.meters.schemas import MeterUnit, PeriodStatus, ResourceType
from src.modules.property.models import ApartmentMembership, User
from src.modules.property.schemas import DisplayMode, RelationType
from src.modules.property.service import PropertyService
from tests.factories import (
    MixedBuilding,
    create_membership,
    create_meter,
    create_mixed_building,
    create_period,
    create_reading,
    create_user,
)


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


def bearer(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user.id, get_settings())}"}


@pytest.fixture
async def mixed(db_session: AsyncSession) -> MixedBuilding:
    return await create_mixed_building(db_session)


async def ok(response) -> dict | list:
    assert response.status_code == 200, response.text
    return response.json()


async def test_the_memberships_of_a_person_with_an_apartment_and_a_parking_space(
    api_client: AsyncClient, mixed: MixedBuilding
) -> None:
    me = await ok(await api_client.get("/api/v1/property/me", headers=as_user(mixed.a)))

    assert [
        (m["apartment_kind"], m["apartment_number"], m["entrance"], m["floor"])
        for m in me["memberships"]
    ] == [("APARTMENT", "14", 2, 4), ("PARKING", "1", None, None)]
    assert [m["preview_badge"]["display_label"] for m in me["memberships"]] == ["Apt. 14", "P1"]


async def test_the_board_lists_every_object_in_order_with_null_fields(
    api_client: AsyncClient, mixed: MixedBuilding
) -> None:
    listed = await ok(
        await api_client.get("/api/v1/property/apartments", headers=as_user(mixed.chairman))
    )

    rows = [
        (a["apartment_kind"], a["apartment_number"], a["entrance"], a["floor"], a["area_m2"])
        for a in listed["apartments"]
    ]
    assert rows == [
        ("APARTMENT", "1", 1, 1, "54.30"),
        ("APARTMENT", "14", 2, 4, "54.30"),
        ("PARKING", "1", None, None, None),
        ("PARKING", "P-2", None, -1, None),
        ("GARAGE", "1", None, None, None),
        ("GARAGE", "7", None, None, None),
        ("GARAGE", "12", None, None, "18.50"),
    ]
    card = await ok(
        await api_client.get(
            f"/api/v1/property/apartments/{mixed.p_2.id}", headers=as_user(mixed.chairman)
        )
    )
    assert (card["apartment_kind"], card["area_m2"], card["tenant_count"]) == ("PARKING", None, 2)


async def test_the_people_list_names_each_object_by_kind(
    api_client: AsyncClient, mixed: MixedBuilding
) -> None:
    people = await ok(await api_client.get("/api/v1/auth/users", headers=bearer(mixed.chairman)))

    labels = {
        tuple((m["apartment_kind"], m["display_label"]) for m in person["memberships"])
        for person in people["people"]
    }
    assert (("APARTMENT", "Apt. 14"), ("PARKING", "P1")) in labels
    assert (("GARAGE", "T. K. (G12)"),) in labels
    assert (("APARTMENT", "Apt. 1"), ("PARKING", "P-2")) in labels


async def test_a_post_keeps_the_kind_of_its_object_after_the_author_leaves(
    api_client: AsyncClient, db_session: AsyncSession, mixed: MixedBuilding
) -> None:
    published = await api_client.post(
        "/api/v1/communication/posts",
        json={"post_type": "FORUM_TOPIC", "title": "The gate", "body": "It squeaks."},
        headers=as_user(mixed.b),
    )
    assert published.status_code == 201, published.text
    assert published.json()["author_badge"]["display_label"] == "T. K. (G12)"

    await db_session.execute(
        update(ApartmentMembership)
        .where(ApartmentMembership.user_id == mixed.b.id)
        .values(ended_at=datetime.now(UTC))
    )
    topic = await ok(
        await api_client.get(
            f"/api/v1/communication/posts/{published.json()['id']}",
            headers=as_user(mixed.chairman),
        )
    )
    # Nobody consented to show the name there any more: the object alone, with its kind.
    assert topic["author_badge"]["display_label"] == "G12"


async def test_the_matrix_the_dashboard_and_the_connection_overview_carry_the_kind(
    api_client: AsyncClient, db_session: AsyncSession, mixed: MixedBuilding
) -> None:
    await create_period(db_session, mixed.building)

    matrix = await ok(
        await api_client.get(
            "/api/v1/meters/periods/2026-10/matrix", headers=as_user(mixed.chairman)
        )
    )
    dashboard = await ok(
        await api_client.get(
            "/api/v1/meters/my-dashboard",
            params={"period_code": "2026-10"},
            headers=as_user(mixed.x),
        )
    )
    overview = await ok(
        await api_client.get(
            "/api/v1/auth/connections", params={"limit": 50}, headers=bearer(mixed.chairman)
        )
    )

    assert [
        (row["apartment_kind"], row["apartment_number"], row["entrance"], row["floor"])
        for row in matrix["apartments"]
    ] == [("PARKING", "P-2", None, -1), ("GARAGE", "12", None, None)]
    assert [(a["apartment_kind"], a["apartment_number"]) for a in dashboard["apartments"]] == [
        ("APARTMENT", "1"),
        ("PARKING", "P-2"),
    ]
    assert [(i["apartment_kind"], i["apartment_number"], i["entrance"]) for i in overview["items"]][
        2:4
    ] == [("PARKING", "1", None), ("PARKING", "P-2", None)]


# --- The object a request is made from (section 3.6) ---------------------------------------------

ISSUE = {
    "category": "LIGHTING",
    "entrance": None,
    "place": "The yard",
    "title": "No light at the gate",
    "description": None,
}


async def test_an_issue_report_without_an_object_comes_from_the_only_apartment(
    api_client: AsyncClient, db_session: AsyncSession, mixed: MixedBuilding
) -> None:
    spaces_only = await create_user(db_session, mixed.building, "Two Spaces")
    await create_membership(db_session, spaces_only, mixed.p_1)
    await create_membership(db_session, spaces_only, mixed.g_1)

    from_a = await api_client.post("/api/v1/issues", json=ISSUE, headers=as_user(mixed.a))
    from_b = await api_client.post("/api/v1/issues", json=ISSUE, headers=as_user(mixed.b))
    unclear = await api_client.post("/api/v1/issues", json=ISSUE, headers=as_user(spaces_only))

    assert from_a.status_code == 201, from_a.text
    assert from_b.status_code == 201, from_b.text
    issues = {
        issue["id"]: issue
        for issue in await ok(
            await api_client.get("/api/v1/issues", headers=as_user(mixed.chairman))
        )
    }
    assert issues[from_a.json()["id"]]["reporter"]["apartment_id"] == str(mixed.apt_14.id)
    assert issues[from_b.json()["id"]]["reporter"]["apartment_id"] == str(mixed.g_12.id)
    assert unclear.status_code == 422, unclear.text
    assert unclear.json()["errors"][0]["loc"] == ["body", "apartment_id"]


async def test_a_ballot_without_an_object_answers_for_the_only_apartment(
    api_client: AsyncClient, db_session: AsyncSession, mixed: MixedBuilding
) -> None:
    from tests.governance.test_api import answers_for, deadline, draft

    spaces_only = await create_user(db_session, mixed.building, "Two Spaces")
    await create_membership(db_session, spaces_only, mixed.p_1)
    await create_membership(db_session, spaces_only, mixed.g_1)
    polls = "/api/v1/governance/polls"
    created = await api_client.post(
        polls, json=draft(closes_at=deadline()), headers=as_user(mixed.chairman)
    )
    assert created.status_code == 201, created.text
    poll = await ok(
        await api_client.post(
            f"{polls}/{created.json()['id']}/open", headers=as_user(mixed.chairman)
        )
    )

    def ballot(user: User):
        return api_client.put(
            f"{polls}/{poll['id']}/ballot",
            json={"answers": answers_for(poll)},
            headers=as_user(user),
        )

    answered = await ok(await ballot(mixed.a))
    unclear = await ballot(spaces_only)

    assert [b["apartment_id"] for b in answered["my_ballots"]] == [str(mixed.apt_14.id)]
    assert unclear.status_code == 422, unclear.text
    assert unclear.json()["errors"][0]["loc"] == ["body", "apartment_id"]


# --- Invitations and memberships by kind ---------------------------------------------------------


@pytest.mark.parametrize(
    ("number", "kind", "found"),
    [
        ("1", None, "APARTMENT"),
        ("1", "PARKING", "PARKING"),
        ("1", "GARAGE", "GARAGE"),
        ("99", "GARAGE", None),
    ],
)
async def test_the_chairman_invites_an_owner_of_one_number_under_each_kind(
    api_client: AsyncClient, mixed: MixedBuilding, number: str, kind: str | None, found: str | None
) -> None:
    body = {
        "kind": "OWNER",
        "email": f"{uuid.uuid4().hex[:10]}@example.org",
        "apartment_number": number,
    }
    if kind is not None:
        body["apartment_kind"] = kind

    response = await api_client.post(
        "/api/v1/auth/invitations", json=body, headers=bearer(mixed.chairman)
    )

    if found is None:
        assert (response.status_code, response.json()["error_code"]) == (404, "APARTMENT_NOT_FOUND")
    else:
        assert response.status_code == 201, response.text
        assert (response.json()["apartment_number"], response.json()["apartment_kind"]) == (
            number,
            found,
        )


async def test_a_family_member_lives_in_an_apartment_only(
    db_session: AsyncSession, mixed: MixedBuilding
) -> None:
    properties = PropertyService(db_session)
    relative = await create_user(db_session, mixed.building, "Rel Ative")

    with pytest.raises(ValueError, match="RESIDENT"):
        await properties.open_membership(
            relative.id, mixed.g_12.id, RelationType.RESIDENT, DisplayMode.APARTMENT_ONLY
        )
    assert await properties.open_membership(
        relative.id, mixed.apt_14.id, RelationType.RESIDENT, DisplayMode.APARTMENT_ONLY
    )
    assert await properties.open_membership(
        relative.id, mixed.g_7.id, RelationType.TENANT, DisplayMode.APARTMENT_ONLY
    )


async def test_the_consumption_per_m2_counts_only_the_objects_with_an_area(
    api_client: AsyncClient, db_session: AsyncSession, mixed: MixedBuilding
) -> None:
    period = await create_period(db_session, mixed.building, "2026-09", PeriodStatus.LOCKED)
    flat_meter = await create_meter(
        db_session, mixed.building, mixed.apt_14, ResourceType.ELECTRICITY
    )
    flat_meter.unit = MeterUnit.KWH
    meters = {
        m.apartment_id: m
        for m in await db_session.scalars(
            select(MeterDevice).where(MeterDevice.building_id == mixed.building.id)
        )
    }
    for apartment, delta in ((mixed.p_2, "100"), (mixed.g_12, "37"), (mixed.apt_14, "54.3")):
        await create_reading(db_session, meters[apartment.id], period, Decimal(delta), Decimal(0))

    consumption = await ok(
        await api_client.get(
            "/api/v1/meters/consumption", params={"months": 2}, headers=as_user(mixed.chairman)
        )
    )
    export = await api_client.get(
        "/api/v1/meters/periods/2026-09/export-csv", headers=as_user(mixed.chairman)
    )

    (series,) = consumption["resources"]
    (month,) = [m for m in series["months"] if m["period_code"] == "2026-09"]
    # Every object with the meter counts; per m2 only G12 (18.50) and Apt. 14 (54.30), in the
    # consumption and in the area alike: 91.3 / 72.8.
    assert (month["total"], month["apartments_counted"]) == ("191.300", 3)
    assert month["average_per_m2"] == "1.2541"
    assert export.status_code == 200, export.text
    assert len([line for line in export.text.splitlines()[1:] if line]) == 3
