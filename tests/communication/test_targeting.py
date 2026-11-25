"""The SQL filter of who sees a post equals the shared rule `apartment_in_target` (epic E14,
section 3.1): the feed, the emergency banner and `can_read_post` against the notification
recipients (`resolve_recipients`), over every scope. Compared for members only: staff without an
apartment see whole-building posts but are not their recipients."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import DEMO_USER_HEADER
from src.modules.communication.service import CommunicationService
from src.modules.property.models import User
from src.modules.property.schemas import ObjectKind, TargetDTO, apartment_in_target
from src.modules.property.service import PropertyService
from tests.factories import create_apartment, create_membership, create_user
from tests.issues.conftest import IssueWorld, build_issue_world

API = "/api/v1/communication"


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


@pytest.fixture
async def world(db_session: AsyncSession) -> IssueWorld:
    return await build_issue_world(db_session)


@pytest.mark.parametrize(
    "target",
    [
        {"target_scope": "ALL_BUILDING"},
        {"target_scope": "ENTRANCE", "target_entrance": 1},
        {"target_scope": "ENTRANCE", "target_entrance": 2},
        {"target_scope": "ENTRANCE", "target_entrance": 3},
        {"target_scope": "APARTMENT_LIST", "apartments": ["2"]},
        {"target_scope": "APARTMENT_LIST", "apartments": ["15", "14"]},
        {"target_scope": "APARTMENT_LIST", "apartments": ["30"]},
    ],
)
async def test_who_sees_a_post_follows_the_shared_targeting_rule(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld, target: dict
) -> None:
    apt_30 = await create_apartment(db_session, world.building, "30", entrance=3, floor=1)
    two_entrances = await create_user(db_session, world.building, "Two Entrances")
    await create_membership(db_session, two_entrances, world.apt_2)
    await create_membership(db_session, two_entrances, world.apt_15)
    apartments = {"2": world.apt_2, "14": world.apt_14, "15": world.apt_15, "30": apt_30}
    body = {k: v for k, v in target.items() if k != "apartments"}
    if "apartments" in target:
        body["target_apartment_ids"] = [str(apartments[n].id) for n in target["apartments"]]
    published = await api_client.post(
        f"{API}/posts",
        json={
            "post_type": "EMERGENCY",
            "category": "WATER_SHUTOFF",
            "title": "Cold water off until 18:00",
            "body": "A riser is being replaced.",
            **body,
        },
        headers=as_user(world.chairman),
    )
    assert published.status_code == 201, published.text
    post_id = published.json()["id"]
    rule = TargetDTO.of(
        target["target_scope"],
        target.get("target_entrance"),
        [apartments[n].id for n in target.get("apartments", [])],
    )
    properties = PropertyService(db_session)
    communication = CommunicationService(db_session, properties)
    recipients = {
        recipient.user_id
        for recipient in await properties.resolve_recipients(world.building.id, rule)
    }

    members = (
        world.owner_14,
        world.family_14,
        world.tenant_2,
        world.board_15,
        two_entrances,
    )
    for user in members:
        current = await properties.get_current_user(user.id)
        assert current is not None
        expected = any(
            apartment_in_target(
                rule,
                apartment_id=membership.apartment_id,
                kind=ObjectKind.APARTMENT,
                entrance=membership.entrance,
            )
            for membership in current.memberships
        )
        feed = await api_client.get(f"{API}/posts", headers=as_user(user))
        banner = await api_client.get(f"{API}/emergencies/active", headers=as_user(user))
        # The board sees every post; the rule decides for everyone else.
        sees = expected or user is world.board_15

        assert (post_id in {post["id"] for post in feed.json()}) is sees, (user.full_name, target)
        assert (post_id in {alert["id"] for alert in banner.json()}) is sees, user.full_name
        assert await communication.can_read_post(current, published.json()["id"]) is sees
        assert (user.id in recipients) is expected, (user.full_name, target)

    # Staff without an apartment see a whole-building post, but are never its recipients.
    accountant = await properties.get_current_user(world.accountant.id)
    assert accountant is not None
    assert await communication.can_read_post(accountant, published.json()["id"]) is (
        target["target_scope"] == "ALL_BUILDING"
    )
    assert world.accountant.id not in recipients
