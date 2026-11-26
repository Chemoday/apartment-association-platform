"""Characterization of the five defaults of the object a request is made from (epic E14,
section 2.5).

A person with two apartments leaves the object out of a forum topic, a comment, a chat message,
an issue report and a ballot. The badge of the first three is the person's first apartment in
list order (entrance, then the number), never a 422; the issue report and the ballot ask to
choose. The memberships are created in the other order, so the list order decides, not the order
of creation. These tests pinned today's behaviour before the defaults moved into the shared
helpers `first_object_in` and `chosen_object`, tested at the end.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import DEMO_USER_HEADER
from src.modules.property.models import User
from src.modules.property.schemas import (
    ApartmentMembershipDTO,
    BuildingRole,
    CurrentUserDTO,
    DisplayMode,
    ObjectKind,
    ObjectNotChosen,
    ObjectNotHeld,
    RelationType,
    TargetDTO,
    TargetScope,
    chosen_object,
    first_object_in,
)
from tests.factories import create_membership, create_user
from tests.issues.conftest import IssueWorld, build_issue_world

COMMUNICATION = "/api/v1/communication"
CHAT = "/api/v1/chat"
ISSUES = "/api/v1/issues"
POLLS = "/api/v1/governance/polls"
SETTINGS = "/api/v1/settings"


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


@pytest.fixture
async def world(db_session: AsyncSession) -> IssueWorld:
    return await build_issue_world(db_session)


@pytest.fixture
async def two_homes(db_session: AsyncSession, world: IssueWorld) -> User:
    """Owner of Apt 14 (entrance 2) first, then tenant of Apt 3 (entrance 1): Apt 3 is first in
    list order."""
    person = await create_user(db_session, world.building, "Two Homes")
    await create_membership(db_session, person, world.apt_14)
    await create_membership(db_session, person, world.apt_3, relation=RelationType.TENANT)
    return person


async def created(response: Response) -> dict[str, Any]:
    assert response.status_code == 201, response.text
    return response.json()


async def test_a_forum_topic_without_an_object_is_signed_by_the_first_apartment(
    api_client: AsyncClient, two_homes: User
) -> None:
    topic = await created(
        await api_client.post(
            f"{COMMUNICATION}/posts",
            json={"post_type": "FORUM_TOPIC", "title": "Bike rack", "body": "Shall we?"},
            headers=as_user(two_homes),
        )
    )

    assert topic["author_badge"] == {"display_label": "Apt. 3", "role_badge": "RESIDENT"}


async def test_a_comment_without_an_object_is_signed_by_the_first_apartment(
    api_client: AsyncClient, world: IssueWorld, two_homes: User
) -> None:
    notice = await created(
        await api_client.post(
            f"{COMMUNICATION}/posts",
            json={
                "post_type": "OFFICIAL_NOTICE",
                "title": "Roof works",
                "body": "From Monday.",
                "target_scope": "ENTRANCE",
                "target_entrance": 2,
            },
            headers=as_user(world.chairman),
        )
    )

    comment = await created(
        await api_client.post(
            f"{COMMUNICATION}/posts/{notice['id']}/comments",
            json={"body": "How long?"},
            headers=as_user(two_homes),
        )
    )

    # Today the default ignores the post's target: Apt 3 is in entrance 1, the notice is for 2.
    assert comment["author_badge"] == {"display_label": "Apt. 3", "role_badge": "RESIDENT"}


async def test_a_chat_message_without_an_object_is_signed_by_the_first_apartment(
    api_client: AsyncClient, world: IssueWorld, two_homes: User
) -> None:
    turned_on = await api_client.put(
        SETTINGS, json={"values": {"chat.enabled": True}}, headers=as_user(world.chairman)
    )
    assert turned_on.status_code == 200, turned_on.text

    message = await created(
        await api_client.post(
            f"{CHAT}/messages", json={"body": "Hello"}, headers=as_user(two_homes)
        )
    )

    assert message["author_badge"] == {"display_label": "Apt. 3", "role_badge": "RESIDENT"}


async def test_an_issue_report_without_an_object_asks_to_choose(
    api_client: AsyncClient, world: IssueWorld, two_homes: User
) -> None:
    payload = {
        "category": "LIGHTING",
        "entrance": 2,
        "place": "3rd floor landing",
        "title": "No light on the stairs",
        "description": None,
    }

    missing = await api_client.post(ISSUES, json=payload, headers=as_user(two_homes))
    chosen = await api_client.post(
        ISSUES, json={**payload, "apartment_id": str(world.apt_14.id)}, headers=as_user(two_homes)
    )

    assert missing.status_code == 422, missing.text
    assert missing.json()["error_code"] == "VALIDATION_ERROR"
    assert missing.json()["errors"][0]["loc"] == ["body", "apartment_id"]
    assert chosen.status_code == 201, chosen.text


@pytest.mark.parametrize(("unit", "status"), [("APARTMENT", 422), ("PERSON", 200)])
async def test_a_ballot_without_an_object_asks_to_choose_per_apartment(
    api_client: AsyncClient, world: IssueWorld, two_homes: User, unit: str, status: int
) -> None:
    from tests.governance.test_api import answers_for, deadline, draft

    poll = await created(
        await api_client.post(
            POLLS,
            json=draft(unit=unit, closes_at=deadline()),
            headers=as_user(world.chairman),
        )
    )
    opened = await api_client.post(f"{POLLS}/{poll['id']}/open", headers=as_user(world.chairman))
    assert opened.status_code == 200, opened.text

    response = await api_client.put(
        f"{POLLS}/{poll['id']}/ballot",
        json={"answers": answers_for(opened.json())},
        headers=as_user(two_homes),
    )

    assert response.status_code == status, response.text
    if status == 422:
        assert response.json()["error_code"] == "VALIDATION_ERROR"
        assert response.json()["errors"][0]["loc"] == ["body", "apartment_id"]


# --- The shared helpers (pure) -------------------------------------------------------------------


def _member(*homes: tuple[uuid.UUID, int]) -> CurrentUserDTO:
    return CurrentUserDTO(
        id=uuid.uuid4(),
        building_id=uuid.uuid4(),
        building_role=BuildingRole.USER,
        privacy_display_mode=DisplayMode.APARTMENT_ONLY,
        memberships=tuple(
            ApartmentMembershipDTO(
                membership_id=uuid.uuid4(),
                apartment_id=apartment_id,
                apartment_number="1",
                apartment_kind=ObjectKind.APARTMENT,
                entrance=entrance,
                floor=1,
                relation_type=RelationType.OWNER,
                can_submit_readings=True,
                can_view_bills=True,
                can_vote=True,
                privacy_display_mode=DisplayMode.APARTMENT_ONLY,
                since=datetime.now(UTC),
            )
            for apartment_id, entrance in homes
        ),
    )


def test_the_badge_object_is_the_first_membership_or_the_first_inside_a_target() -> None:
    first, second = uuid.uuid4(), uuid.uuid4()
    user = _member((first, 1), (second, 2))

    assert first_object_in(user, None) == first
    assert first_object_in(user, TargetDTO(scope=TargetScope.ALL_BUILDING)) == first
    assert first_object_in(user, TargetDTO(scope=TargetScope.ENTRANCE, entrance=2)) == second
    assert first_object_in(user, TargetDTO(scope=TargetScope.ENTRANCE, entrance=3)) is None
    assert first_object_in(_member(), None) is None


def test_the_chosen_object_is_the_requested_the_only_one_or_the_only_apartment() -> None:
    apartment, space, garage, other = (uuid.uuid4() for _ in range(4))
    A, P, G = ObjectKind.APARTMENT, ObjectKind.PARKING, ObjectKind.GARAGE

    assert chosen_object([(apartment, A), (space, P)], space) == space
    assert chosen_object([(space, P)], None) == space
    assert chosen_object([], None) is None
    # An owner of an apartment who also gets a parking space: the apartment.
    assert chosen_object([(space, P), (apartment, A), (garage, G)], None) == apartment
    with pytest.raises(ObjectNotHeld):
        chosen_object([(apartment, A)], space)
    with pytest.raises(ObjectNotHeld):
        chosen_object([], apartment)
    with pytest.raises(ObjectNotChosen):
        chosen_object([(space, P), (garage, G)], None)
    with pytest.raises(ObjectNotChosen):
        chosen_object([(apartment, A), (other, A), (space, P)], None)
