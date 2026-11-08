"""Notifications of the maintenance calendar and of official notices in the app (epic E10, M3).

The demo-mode world of conftest.py. Apt 14 (entrance 2): owner
Ivan Petrov. Apt 15 (entrance 2): board member Peeter Saar. Apt 2 (entrance 1): tenant Mari Tamm.
"""

from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from httpx import AsyncClient

from src.core.config import get_settings
from src.core.security import DEMO_USER_HEADER
from src.modules.maintenance.publisher import Publisher
from src.modules.property.models import User
from tests.notifications.conftest import NotifWorld

TASKS = "/api/v1/maintenance/tasks"
FEED = "/api/v1/notifications/feed"
POSTS = "/api/v1/communication/posts"


def today() -> date:
    return datetime.now(ZoneInfo(get_settings().INSTANCE_TIMEZONE)).date()


def at(day: date, hour: int = 12) -> datetime:
    zone = ZoneInfo(get_settings().INSTANCE_TIMEZONE)
    return datetime.combine(day, time(hour), tzinfo=zone).astimezone(UTC)


@pytest.fixture
def publisher(db_app: FastAPI) -> Publisher:
    return db_app.state.maintenance_publisher


def demo(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


async def feed(client: AsyncClient, user: User, event_type: str) -> list[dict]:
    response = await client.get(FEED, headers=demo(user))
    assert response.status_code == 200, response.text
    return [item for item in response.json() if item["event_type"] == event_type]


async def new_task(client: AsyncClient, user: User, headers: dict, **overrides: Any) -> dict:
    body = {
        "title": "Inspect the fire extinguishers",
        "period_unit": "MONTH",
        "period_count": 1,
        "lead_days": 0,
        "first_due_date": (today() + timedelta(days=3)).isoformat(),
        **overrides,
    }
    response = await client.post(TASKS, json=body, headers=headers)
    assert response.status_code == 201, response.text
    return response.json()


# --- In the app ----------------------------------------------------------------------------------


async def test_the_board_is_told_when_a_task_is_due_and_again_when_overdue(
    api_client: AsyncClient, publisher: Publisher, world: NotifWorld
) -> None:
    task = await new_task(api_client, world.chairman, demo(world.chairman))
    due = date.fromisoformat(task["current"]["due_date"])

    await publisher.tick(now=at(due))
    await publisher.tick(now=at(due + timedelta(days=7)))

    notices = await feed(api_client, world.board_15, "MAINTENANCE_DUE")
    assert [(n["params"]["reminder_number"], n["params"]["overdue"]) for n in notices] == [
        (1, True),
        (0, False),
    ], "newest first"
    first = notices[1]
    assert (first["subject_type"], first["subject_id"]) == ("maintenance_task", task["id"])
    assert first["params"]["due_date"] == due.isoformat() and "title" not in first["params"]
    assert len(await feed(api_client, world.chairman, "MAINTENANCE_DUE")) == 2
    for user in (world.owner_14, world.tenant_2, world.accountant):
        assert await feed(api_client, user, "MAINTENANCE_DUE") == []


async def test_a_notice_tells_its_target_but_not_its_author(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    response = await api_client.post(
        POSTS,
        json={
            "post_type": "OFFICIAL_NOTICE",
            "title": "Stairs painted",
            "body": "Entrance 2, Monday.",
            "target_scope": "ENTRANCE",
            "target_entrance": 2,
        },
        headers=demo(world.board_15),
    )
    assert response.status_code == 201, response.text

    (notice,) = await feed(api_client, world.owner_14, "NOTICE_PUBLISHED")
    assert (notice["subject_type"], notice["subject_id"], notice["params"]) == (
        "post",
        response.json()["id"],
        {},
    )
    for user in (world.board_15, world.tenant_2, world.chairman, world.other_resident):
        assert await feed(api_client, user, "NOTICE_PUBLISHED") == []


async def test_the_calendar_s_notice_tells_the_residents_too(
    api_client: AsyncClient, publisher: Publisher, world: NotifWorld
) -> None:
    task = await new_task(
        api_client,
        world.chairman,
        demo(world.chairman),
        notice={"title": "Gutters", "body": "Move cars.", "target_scope": "ALL_BUILDING"},
    )

    await publisher.tick(now=at(date.fromisoformat(task["current"]["due_date"])))

    for user in (world.owner_14, world.tenant_2, world.board_15):
        assert len(await feed(api_client, user, "NOTICE_PUBLISHED")) == 1, user.full_name
    assert await feed(api_client, world.chairman, "NOTICE_PUBLISHED") == [], "the author"


async def test_a_republication_after_a_move_tells_the_board_again(
    api_client: AsyncClient, publisher: Publisher, world: NotifWorld
) -> None:
    task = await new_task(api_client, world.chairman, demo(world.chairman), lead_days=2)
    await publisher.tick(
        now=at(date.fromisoformat(task["current"]["due_date"]) - timedelta(days=2))
    )
    later = date.fromisoformat(task["current"]["due_date"]) + timedelta(days=30)
    moved = await api_client.patch(
        f"{TASKS}/{task['id']}",
        json={"next_due_date": later.isoformat()},
        headers=demo(world.chairman),
    )
    assert moved.status_code == 200, moved.text

    await publisher.tick(now=at(later - timedelta(days=2)))

    notices = await feed(api_client, world.board_15, "MAINTENANCE_DUE")
    assert [n["params"]["due_date"] for n in notices] == [
        later.isoformat(),
        task["current"]["due_date"],
    ]


async def test_a_notice_for_listed_apartments(api_client: AsyncClient, world: NotifWorld) -> None:
    response = await api_client.post(
        POSTS,
        json={
            "post_type": "OFFICIAL_NOTICE",
            "title": "Your meter",
            "body": "Replaced on Friday.",
            "target_scope": "APARTMENT_LIST",
            "target_apartment_ids": [str(world.apt_2.id)],
        },
        headers=demo(world.chairman),
    )
    assert response.status_code == 201, response.text

    assert len(await feed(api_client, world.tenant_2, "NOTICE_PUBLISHED")) == 1
    for user in (world.owner_14, world.board_15):
        assert await feed(api_client, user, "NOTICE_PUBLISHED") == []
