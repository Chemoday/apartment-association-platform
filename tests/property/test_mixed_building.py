"""Views of a building with apartments, parking spaces and garages (epic E14, task K1): every
view that names an object by number carries its kind, an object without an entrance, a floor or
an area is shown with null, and badges name the object by kind."""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.core.security import DEMO_USER_HEADER, create_access_token
from src.modules.property.models import ApartmentMembership, User
from tests.factories import MixedBuilding, create_mixed_building, create_period


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
