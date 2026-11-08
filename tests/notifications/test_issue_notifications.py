"""Notifications about issues (epic E9, task I3; fixture: conftest.py).

Apt 14 (entrance 2): owner Ivan Petrov. Apt 15: board member Peeter Saar. Apt 2 (entrance 1):
tenant Mari Tamm. Staff without apartments: the chairman and an accountant.
"""

import uuid
from contextlib import asynccontextmanager
from typing import Any

from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import DEMO_USER_HEADER
from src.modules.issues.events import IssueMerged, IssueReported, IssueStatusChanged
from src.modules.issues.models import IssueStatusChange
from src.modules.notifications.models import Delivery
from src.modules.notifications.service import NotificationsSubscriber
from src.modules.property.models import ApartmentMembership, User
from tests.notifications.conftest import NotifWorld

ISSUES = "/api/v1/issues"
FEED = "/api/v1/notifications/feed"


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


async def report(client: AsyncClient, user: User, **overrides: Any) -> dict:
    body = {"category": "LIGHTING", "entrance": 2, "place": "Landing", "title": "Dark stairs"}
    response = await client.post(ISSUES, json={**body, **overrides}, headers=as_user(user))
    assert response.status_code == 201, response.text
    return response.json()


async def move(client: AsyncClient, user: User, issue: dict, status: str, **extra: Any) -> dict:
    response = await client.post(
        f"{ISSUES}/{issue['id']}/status",
        json={"status": status, **extra},
        headers=as_user(user),
    )
    assert response.status_code == 200, response.text
    return response.json()


async def notices(client: AsyncClient, user: User, prefix: str = "ISSUE_") -> list[dict]:
    response = await client.get(FEED, headers=as_user(user))
    assert response.status_code == 200, response.text
    return [item for item in response.json() if item["event_type"].startswith(prefix)]


async def enable_urgent(client: AsyncClient, chairman: User) -> None:
    response = await client.put(
        "/api/v1/settings",
        json={"values": {"issues.urgent_enabled": True}},
        headers=as_user(chairman),
    )
    assert response.status_code == 200, response.text


async def test_a_new_report_tells_the_board_but_not_the_reporter(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    issue = await report(api_client, world.owner_14)

    (notice,) = await notices(api_client, world.chairman)
    assert notice["event_type"] == "ISSUE_REPORTED"
    assert (notice["subject_type"], notice["subject_id"]) == ("issue", issue["id"])
    assert notice["params"] == {"category": "LIGHTING", "entrance": 2}
    assert len(await notices(api_client, world.board_15)) == 1
    for user in (world.owner_14, world.tenant_2, world.accountant):
        assert await notices(api_client, user) == []


async def test_a_board_members_report_tells_the_other_board_members(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    await report(api_client, world.board_15, entrance=None, category="YARD")

    assert await notices(api_client, world.board_15) == []
    (notice,) = await notices(api_client, world.chairman)
    assert notice["params"] == {"category": "YARD", "entrance": None}


async def test_an_urgent_report_is_mandatory_and_goes_first(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    await enable_urgent(api_client, world.chairman)
    off = await api_client.put(
        "/api/v1/notifications/preferences",
        json={
            "preferences": [{"event_type": "ISSUE_URGENT", "channel": "email", "enabled": False}]
        },
        headers=as_user(world.chairman),
    )

    issue = await report(api_client, world.owner_14, urgent=True)

    assert (off.status_code, off.json()["error_code"]) == (422, "PREFERENCE_MANDATORY")
    (notice,) = await notices(api_client, world.chairman)
    assert notice["event_type"] == "ISSUE_URGENT"
    priorities = set(
        await db_session.scalars(
            select(Delivery.priority).where(Delivery.subject_id == uuid.UUID(issue["id"]))
        )
    )
    assert priorities == {0}


async def test_a_status_change_tells_the_followers_but_not_the_board_member(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    issue = await report(api_client, world.owner_14)
    await api_client.put(f"{ISSUES}/{issue['id']}/follow", headers=as_user(world.tenant_2))

    await move(api_client, world.board_15, issue, "IN_PROGRESS")

    for user in (world.owner_14, world.tenant_2):
        (notice,) = await notices(api_client, user)
        assert notice["event_type"] == "ISSUE_STATUS_CHANGED"
        assert notice["params"] == {
            "category": "LIGHTING",
            "entrance": 2,
            "status": "IN_PROGRESS",
            "merged": False,
        }
    board = await notices(api_client, world.board_15)
    assert [n["event_type"] for n in board] == ["ISSUE_REPORTED"], "never the actor"


async def test_a_follower_who_moved_out_is_not_told(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    issue = await report(api_client, world.owner_14)
    await api_client.put(f"{ISSUES}/{issue['id']}/follow", headers=as_user(world.tenant_2))
    await db_session.execute(
        update(ApartmentMembership)
        .where(ApartmentMembership.user_id == world.tenant_2.id)
        .values(ended_at=func.now())
    )

    await move(api_client, world.chairman, issue, "RESOLVED")

    assert len(await notices(api_client, world.owner_14)) == 1
    rows = await db_session.scalar(
        select(func.count()).select_from(Delivery).where(Delivery.user_id == world.tenant_2.id)
    )
    assert rows == 0


async def test_a_merge_tells_the_duplicates_followers_with_a_link_to_the_original(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    original = await report(api_client, world.owner_14)
    duplicate = await report(api_client, world.tenant_2, entrance=1)

    await move(api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=original["id"])

    tenant = {n["params"]["status"]: n for n in await notices(api_client, world.tenant_2)}
    # The duplicate's followers follow the original by then, so they also hear that it started.
    assert set(tenant) == {"DUPLICATE", "IN_PROGRESS"}
    merged = tenant["DUPLICATE"]
    assert (merged["subject_id"], merged["params"]) == (
        original["id"],
        {"category": "LIGHTING", "entrance": 1, "status": "DUPLICATE", "merged": True},
    )
    (started,) = await notices(api_client, world.owner_14)
    assert started["params"]["status"] == "IN_PROGRESS", "the original started with the merge"


async def test_withdrawing_editing_and_following_tell_nobody(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    issue = await report(api_client, world.owner_14)
    await api_client.patch(
        f"{ISSUES}/{issue['id']}", json={"title": "Darker"}, headers=as_user(world.owner_14)
    )
    await api_client.put(f"{ISSUES}/{issue['id']}/follow", headers=as_user(world.tenant_2))
    await api_client.post(f"{ISSUES}/{issue['id']}/withdraw", headers=as_user(world.owner_14))

    assert await notices(api_client, world.tenant_2) == []
    assert len(await notices(api_client, world.chairman)) == 1, "only the report itself"


def _subscriber(db_session: AsyncSession) -> NotificationsSubscriber:
    @asynccontextmanager
    async def factory():
        yield db_session

    return NotificationsSubscriber(lambda: factory, "et")


async def _rows(db_session: AsyncSession, issue_id: str) -> int:
    return await db_session.scalar(
        select(func.count())
        .select_from(Delivery)
        .where(Delivery.dedup_key == f"issue_reported:{issue_id}")
    )


async def test_an_event_delivered_twice_notifies_once(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    issue = await report(api_client, world.owner_14)
    before = await _rows(db_session, issue["id"])
    event = IssueReported(
        issue_id=uuid.UUID(issue["id"]),
        building_id=world.building.id,
        reporter_user_id=world.owner_14.id,
        urgent=False,
    )

    await _subscriber(db_session).on_issue_reported(event)

    assert before > 0 and await _rows(db_session, issue["id"]) == before


async def test_a_report_withdrawn_before_the_event_notifies_nobody(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    issue = await report(api_client, world.owner_14)
    await db_session.execute(
        Delivery.__table__.delete().where(Delivery.dedup_key == f"issue_reported:{issue['id']}")
    )
    await api_client.post(f"{ISSUES}/{issue['id']}/withdraw", headers=as_user(world.owner_14))
    event = IssueReported(
        issue_id=uuid.UUID(issue["id"]),
        building_id=world.building.id,
        reporter_user_id=world.owner_14.id,
        urgent=False,
    )

    await _subscriber(db_session).on_issue_reported(event)

    assert await _rows(db_session, issue["id"]) == 0


async def _status_rows(db_session: AsyncSession) -> int:
    return await db_session.scalar(
        select(func.count())
        .select_from(Delivery)
        .where(Delivery.event_type == "ISSUE_STATUS_CHANGED")
    )


async def test_status_and_merge_events_delivered_twice_notify_once(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    original = await report(api_client, world.owner_14)
    duplicate = await report(api_client, world.tenant_2, entrance=1)
    await move(api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=original["id"])
    await move(api_client, world.chairman, original, "RESOLVED")
    before = await _status_rows(db_session)
    changes = list(
        await db_session.execute(
            select(
                IssueStatusChange.id, IssueStatusChange.issue_id, IssueStatusChange.to_status
            ).where(IssueStatusChange.from_status.is_not(None))
        )
    )
    subscriber = _subscriber(db_session)

    for change_id, issue_id, status in changes:
        if status == "DUPLICATE":
            await subscriber.on_issue_merged(
                IssueMerged(
                    issue_id=issue_id,
                    original_id=uuid.UUID(original["id"]),
                    building_id=world.building.id,
                    change_id=change_id,
                    changed_by_user_id=world.chairman.id,
                )
            )
        else:
            await subscriber.on_issue_status_changed(
                IssueStatusChanged(
                    issue_id=issue_id,
                    building_id=world.building.id,
                    change_id=change_id,
                    changed_by_user_id=world.chairman.id,
                    status=status.value,
                )
            )

    assert before > 0 and await _status_rows(db_session) == before
