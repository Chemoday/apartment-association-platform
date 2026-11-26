"""The shared spaces and the chat by kind of object (epic E14, task K2b, section 3.5): the access
table of section 6.2. A tenant of a parking space or a garage has the least access; the role
decides first; the chat is the room of the apartments."""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import DEMO_USER_HEADER
from src.modules.chat.policies import BUILDING_ROOM, takes_part
from src.modules.property.models import User
from src.modules.property.schemas import (
    ApartmentMembershipDTO,
    BuildingRole,
    CurrentUserDTO,
    DisplayMode,
    ObjectKind,
    RelationType,
    TargetDTO,
    TargetScope,
)
from tests.factories import MixedBuilding, create_membership, create_mixed_building


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


@pytest.fixture
async def mixed(db_session: AsyncSession) -> MixedBuilding:
    return await create_mixed_building(db_session)


# person -> (documents, issue tracker, chat, the chat badge)
ACCESS = {
    "A": (200, 200, 201, "Apt. 14"),  # Apt. 14 and P1
    "B": (200, 200, 403, None),  # owner of G12 only
    "C": (403, 403, 403, None),  # tenant of P-2 only
    "X": (200, 200, 201, "Apt. 1"),  # tenant of Apt. 1 and of P-2
    "board member": (200, 200, 201, "Board"),  # owner of G1: the role, no object in the room
    "accountant": (200, 403, 403, None),
}


@pytest.mark.parametrize("name", list(ACCESS))
async def test_who_opens_the_documents_the_tracker_and_the_chat(
    api_client: AsyncClient, mixed: MixedBuilding, name: str
) -> None:
    turned_on = await api_client.put(
        "/api/v1/settings",
        json={"values": {"chat.enabled": True}},
        headers=as_user(mixed.chairman),
    )
    assert turned_on.status_code == 200, turned_on.text
    user = mixed.people[name]
    documents, tracker, chat, badge = ACCESS[name]

    listed = await api_client.get("/api/v1/documents", headers=as_user(user))
    issues = await api_client.get("/api/v1/issues", headers=as_user(user))
    message = await api_client.post(
        "/api/v1/chat/messages", json={"body": "Hello"}, headers=as_user(user)
    )

    assert (listed.status_code, issues.status_code, message.status_code) == (
        documents,
        tracker,
        chat,
    ), name
    if badge is not None:
        assert message.json()["author_badge"]["display_label"] == badge


async def test_the_shared_access_shows_in_the_profile(
    api_client: AsyncClient, mixed: MixedBuilding
) -> None:
    access = {}
    for name in ("A", "B", "C", "X", "accountant"):
        me = await api_client.get("/api/v1/property/me", headers=as_user(mixed.people[name]))
        assert me.status_code == 200, me.text
        access[name] = me.json()["shared_access"]

    assert access == {"A": True, "B": True, "C": False, "X": True, "accountant": False}


async def test_an_accountant_who_rents_a_parking_space_keeps_what_the_role_gives(
    api_client: AsyncClient, db_session: AsyncSession, mixed: MixedBuilding
) -> None:
    await create_membership(db_session, mixed.accountant, mixed.p_2, relation=RelationType.TENANT)

    documents = await api_client.get("/api/v1/documents", headers=as_user(mixed.accountant))
    issues = await api_client.get("/api/v1/issues", headers=as_user(mixed.accountant))
    chat = await api_client.get("/api/v1/chat", headers=as_user(mixed.accountant))

    assert (documents.status_code, issues.status_code) == (200, 403)
    assert chat.json()["can_take_part"] is False


async def test_a_message_cannot_be_signed_by_an_object_outside_the_room(
    api_client: AsyncClient, mixed: MixedBuilding
) -> None:
    await api_client.put(
        "/api/v1/settings",
        json={"values": {"chat.enabled": True}},
        headers=as_user(mixed.chairman),
    )

    response = await api_client.post(
        "/api/v1/chat/messages",
        json={"body": "From P1", "author_apartment_id": str(mixed.p_1.id)},
        headers=as_user(mixed.a),
    )

    assert (response.status_code, response.json()["error_code"]) == (
        422,
        "INVALID_AUTHOR_APARTMENT",
    )


def _member(kind: ObjectKind, relation: RelationType) -> CurrentUserDTO:
    import uuid

    return CurrentUserDTO(
        id=uuid.uuid4(),
        building_id=uuid.uuid4(),
        building_role=BuildingRole.USER,
        privacy_display_mode=DisplayMode.APARTMENT_ONLY,
        memberships=(
            ApartmentMembershipDTO(
                membership_id=uuid.uuid4(),
                apartment_id=uuid.uuid4(),
                apartment_number="12",
                apartment_kind=kind,
                entrance=None if kind != ObjectKind.APARTMENT else 1,
                floor=None,
                relation_type=relation,
                can_submit_readings=True,
                can_view_bills=True,
                can_vote=relation == RelationType.OWNER,
                privacy_display_mode=DisplayMode.APARTMENT_ONLY,
                since=datetime.now(UTC),
            ),
        ),
    )


def test_a_room_per_area_needs_no_new_rule() -> None:
    garages = TargetDTO(scope=TargetScope.KINDS, kinds=frozenset({ObjectKind.GARAGE}))
    garage_owner = _member(ObjectKind.GARAGE, RelationType.OWNER)
    flat_owner = _member(ObjectKind.APARTMENT, RelationType.OWNER)

    assert (takes_part(garage_owner, BUILDING_ROOM), takes_part(flat_owner, BUILDING_ROOM)) == (
        False,
        True,
    )
    assert (takes_part(garage_owner, garages), takes_part(flat_owner, garages)) == (True, False)


@pytest.mark.parametrize(
    ("kind", "relation", "shared"),
    [
        (ObjectKind.APARTMENT, RelationType.TENANT, True),
        (ObjectKind.APARTMENT, RelationType.RESIDENT, True),
        (ObjectKind.GARAGE, RelationType.OWNER, True),
        (ObjectKind.PARKING, RelationType.OWNER, True),
        (ObjectKind.GARAGE, RelationType.TENANT, False),
        (ObjectKind.PARKING, RelationType.TENANT, False),
    ],
)
def test_a_tenant_of_a_parking_space_or_a_garage_has_no_shared_access(
    kind: ObjectKind, relation: RelationType, shared: bool
) -> None:
    assert _member(kind, relation).shared_access is shared


async def test_a_tenant_of_a_parking_space_is_refused_also_by_a_direct_link(
    api_client: AsyncClient, mixed: MixedBuilding
) -> None:
    import uuid

    for path in (
        f"/api/v1/documents/{uuid.uuid4()}",
        f"/api/v1/documents/{uuid.uuid4()}/file",
        f"/api/v1/issues/{uuid.uuid4()}",
        "/api/v1/issues/form",
    ):
        response = await api_client.get(path, headers=as_user(mixed.c))
        assert response.status_code == 403, (path, response.text)


async def test_an_issue_is_reported_only_from_an_object_that_opens_the_tracker(
    api_client: AsyncClient, mixed: MixedBuilding
) -> None:
    form = await api_client.get("/api/v1/issues/form", headers=as_user(mixed.x))
    report = {
        "category": "LIGHTING",
        "entrance": None,
        "place": "The yard",
        "title": "No light",
        "description": None,
    }
    omitted = await api_client.post("/api/v1/issues", json=report, headers=as_user(mixed.x))
    from_space = await api_client.post(
        "/api/v1/issues",
        json={**report, "apartment_id": str(mixed.p_2.id)},
        headers=as_user(mixed.x),
    )

    assert form.json()["apartment_ids"] == [str(mixed.apt_1.id)]
    assert omitted.status_code == 201, omitted.text
    assert (from_space.status_code, from_space.json()["error_code"]) == (
        422,
        "INVALID_AUTHOR_APARTMENT",
    )
