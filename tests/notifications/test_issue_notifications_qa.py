"""QA additions for the notifications about issues (epic E9, task I3; docs/API.md sections 6, 10).

In-app only (demo mode); the e-mail side is in test_issue_dispatch_qa.py.
"""

from httpx import AsyncClient, Response
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.notifications.models import Delivery
from src.modules.property.models import User
from src.modules.property.schemas import BuildingRole
from tests.factories import create_membership, create_user
from tests.notifications.conftest import NotifWorld
from tests.notifications.test_issue_notifications import (
    ISSUES,
    as_user,
    enable_urgent,
    move,
    notices,
    report,
)

PREFERENCES = "/api/v1/notifications/preferences"
ISSUE_EVENTS = ("ISSUE_REPORTED", "ISSUE_URGENT", "ISSUE_STATUS_CHANGED")


async def set_preference(
    client: AsyncClient, user: User, event_type: str, channel: str, enabled: bool
) -> Response:
    return await client.put(
        PREFERENCES,
        json={"preferences": [{"event_type": event_type, "channel": channel, "enabled": enabled}]},
        headers=as_user(user),
    )


async def follow(client: AsyncClient, user: User, issue: dict) -> None:
    response = await client.put(f"{ISSUES}/{issue['id']}/follow", headers=as_user(user))
    assert response.status_code == 200, response.text


async def rows_for(session: AsyncSession, user: User) -> int:
    return await session.scalar(
        select(func.count())
        .select_from(Delivery)
        .where(Delivery.user_id == user.id, Delivery.event_type.in_(ISSUE_EVENTS))
    )


# --- New reports ---------------------------------------------------------------------------------


async def test_a_board_member_who_turned_new_reports_off_gets_no_feed_entry(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    off = await set_preference(api_client, world.board_15, "ISSUE_REPORTED", "in_app", False)
    assert off.status_code == 200, off.text

    await report(api_client, world.owner_14)

    assert await notices(api_client, world.board_15) == []
    assert await rows_for(db_session, world.board_15) == 0
    assert len(await notices(api_client, world.chairman)) == 1, "the others still get it"


async def test_an_urgent_report_ignores_the_switched_off_new_reports(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    await enable_urgent(api_client, world.chairman)
    await set_preference(api_client, world.board_15, "ISSUE_REPORTED", "in_app", False)
    mandatory = await set_preference(api_client, world.board_15, "ISSUE_URGENT", "in_app", False)

    await report(api_client, world.owner_14, urgent=True)

    assert (mandatory.status_code, mandatory.json()["error_code"]) == (
        422,
        "PREFERENCE_MANDATORY",
    )
    (notice,) = await notices(api_client, world.board_15)
    assert notice["event_type"] == "ISSUE_URGENT"
    assert notice["params"] == {"category": "LIGHTING", "entrance": 2}
    assert [n["event_type"] for n in await notices(api_client, world.chairman)] == [
        "ISSUE_URGENT"
    ], "instead of ISSUE_REPORTED, not both"


async def test_inactive_and_former_board_members_get_nothing(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    inactive = await create_user(
        db_session, world.building, "Gone Board", role=BuildingRole.BOARD, is_active=False
    )
    former = await create_user(db_session, world.building, "Ex Board", role=BuildingRole.BOARD)
    await create_membership(db_session, former, world.apt_14)
    await db_session.execute(
        update(User).where(User.id == former.id).values(building_role=BuildingRole.USER)
    )
    await enable_urgent(api_client, world.chairman)

    await report(api_client, world.tenant_2, entrance=1)
    await report(api_client, world.owner_14, urgent=True)

    assert await rows_for(db_session, inactive) == 0
    assert await rows_for(db_session, former) == 0
    assert len(await notices(api_client, world.chairman)) == 2


async def test_a_new_report_notice_carries_no_words_and_no_people(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    await report(
        api_client,
        world.owner_14,
        title="Secret title",
        place="Secret place",
        description="Secret description",
    )

    response = await api_client.get("/api/v1/notifications/feed", headers=as_user(world.chairman))

    raw = response.text
    for secret in ("Secret title", "Secret place", "Secret description", "Ivan Petrov"):
        assert secret not in raw
    assert str(world.owner_14.id) not in raw and world.owner_14.email not in raw


# --- Status changes ------------------------------------------------------------------------------


async def test_a_reopen_tells_the_followers_it_is_in_progress_again(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    issue = await report(api_client, world.owner_14)
    await follow(api_client, world.tenant_2, issue)
    await move(api_client, world.chairman, issue, "RESOLVED")

    await move(api_client, world.chairman, issue, "IN_PROGRESS")

    for user in (world.owner_14, world.tenant_2):
        statuses = [n["params"]["status"] for n in await notices(api_client, user)]
        assert statuses == ["IN_PROGRESS", "RESOLVED"], "newest first"


async def test_the_same_status_again_and_clearing_the_flag_tell_nobody(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    await enable_urgent(api_client, world.chairman)
    issue = await report(api_client, world.owner_14, urgent=True)
    await move(api_client, world.chairman, issue, "IN_PROGRESS")

    await move(api_client, world.board_15, issue, "IN_PROGRESS")
    cleared = await api_client.post(
        f"{ISSUES}/{issue['id']}/urgent/clear", headers=as_user(world.board_15)
    )

    assert cleared.status_code == 200
    assert len(await notices(api_client, world.owner_14)) == 1
    assert [n["event_type"] for n in await notices(api_client, world.chairman)] == ["ISSUE_URGENT"]


async def test_someone_who_stopped_following_is_not_told(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    issue = await report(api_client, world.owner_14)
    await follow(api_client, world.tenant_2, issue)
    await api_client.delete(f"{ISSUES}/{issue['id']}/follow", headers=as_user(world.tenant_2))
    await api_client.delete(f"{ISSUES}/{issue['id']}/follow", headers=as_user(world.owner_14))

    await move(api_client, world.chairman, issue, "DECLINED")

    assert await notices(api_client, world.tenant_2) == []
    assert await notices(api_client, world.owner_14) == [], "the reporter stopped too"


async def test_a_following_board_member_hears_about_another_members_change(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    issue = await report(api_client, world.owner_14)
    await follow(api_client, world.board_15, issue)
    await follow(api_client, world.chairman, issue)

    await move(api_client, world.chairman, issue, "WAITING_FOR_CONTRACTOR")

    board = await notices(api_client, world.board_15, prefix="ISSUE_STATUS")
    assert [n["params"]["status"] for n in board] == ["WAITING_FOR_CONTRACTOR"]
    assert await notices(api_client, world.chairman, prefix="ISSUE_STATUS") == [], "the actor"


async def test_a_follower_who_turned_status_notices_off_gets_no_feed_entry(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    issue = await report(api_client, world.owner_14)
    await set_preference(api_client, world.owner_14, "ISSUE_STATUS_CHANGED", "in_app", False)

    await move(api_client, world.chairman, issue, "RESOLVED")

    assert await notices(api_client, world.owner_14) == []


# --- Merges --------------------------------------------------------------------------------------


async def test_the_board_member_who_merged_is_not_told_about_the_merge(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    original = await report(api_client, world.owner_14)
    duplicate = await report(api_client, world.tenant_2, entrance=1)
    await follow(api_client, world.board_15, duplicate)

    await move(api_client, world.board_15, duplicate, "DUPLICATE", duplicate_of=original["id"])

    assert await notices(api_client, world.board_15, prefix="ISSUE_STATUS") == []
    tenant = await notices(api_client, world.tenant_2)
    assert sorted(n["params"]["merged"] for n in tenant) == [False, True]


async def test_a_merge_into_a_started_original_sends_only_the_merge_notice(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    original = await report(api_client, world.owner_14)
    await move(api_client, world.chairman, original, "IN_PROGRESS")
    duplicate = await report(api_client, world.tenant_2, entrance=1)
    await follow(api_client, world.board_15, duplicate)

    await move(api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=original["id"])

    for user in (world.tenant_2, world.board_15):
        (merged,) = await notices(api_client, user, prefix="ISSUE_STATUS")
        assert merged["subject_id"] == original["id"]
        assert merged["params"] == {
            "category": "LIGHTING",
            "entrance": 1,
            "status": "DUPLICATE",
            "merged": True,
        }
    owner = [n["params"]["status"] for n in await notices(api_client, world.owner_14)]
    assert owner == ["IN_PROGRESS"], "the original's own followers hear nothing new"


async def test_after_a_merge_the_moved_followers_hear_about_the_original(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    original = await report(api_client, world.owner_14)
    duplicate = await report(api_client, world.tenant_2, entrance=1)
    await move(api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=original["id"])

    await move(api_client, world.board_15, original, "RESOLVED")

    tenant = await notices(api_client, world.tenant_2)
    latest = tenant[0]
    assert (latest["subject_id"], latest["params"]["status"]) == (original["id"], "RESOLVED")
    assert latest["params"]["entrance"] == 2, "the original's location now"
