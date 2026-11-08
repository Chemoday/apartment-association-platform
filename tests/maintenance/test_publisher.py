"""The publisher of the maintenance calendar (epic E10, task M2; fixture: conftest.py).

Time is injected through Publisher.tick(now=...): `at(day)` is noon in the building's time zone.
"""

import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.core.domain_events import DomainEventRecord
from src.modules.maintenance.models import Task
from src.modules.maintenance.publisher import Publisher
from src.modules.property.models import User
from src.modules.property.schemas import BuildingRole
from tests.maintenance.conftest import MaintWorld, local_today
from tests.maintenance.test_api import API, act, as_user, created

POSTS = "/api/v1/communication/posts"


def at(day: date, hour: int = 12) -> datetime:
    zone = ZoneInfo(get_settings().INSTANCE_TIMEZONE)
    return datetime.combine(day, time(hour), tzinfo=zone).astimezone(UTC)


@pytest.fixture
def publisher(db_app: FastAPI) -> Publisher:
    return db_app.state.maintenance_publisher


async def board_topics(client: AsyncClient, user: User) -> list[dict]:
    response = await client.get(POSTS, params={"post_type": "BOARD_TOPIC"}, headers=as_user(user))
    assert response.status_code == 200, response.text
    return response.json()


async def notices(client: AsyncClient, user: User) -> list[dict]:
    response = await client.get(POSTS, headers=as_user(user))
    assert response.status_code == 200, response.text
    return [post for post in response.json() if post["post_type"] == "OFFICIAL_NOTICE"]


async def comments(client: AsyncClient, user: User, post_id: str) -> list[str]:
    response = await client.get(f"{POSTS}/{post_id}", headers=as_user(user))
    assert response.status_code == 200, response.text
    return [comment["body"] for comment in response.json()["comments"]]


def calendar_task(due: date, **overrides: Any) -> dict[str, Any]:
    return {"first_due_date": due.isoformat(), "lead_days": 14, **overrides}


# --- Publishing ----------------------------------------------------------------------------------


async def test_nothing_before_the_lead_time_then_one_topic_and_one_notice(
    api_client: AsyncClient, publisher: Publisher, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=30)
    task = await created(
        api_client,
        world.chairman,
        **calendar_task(
            due,
            notice={"title": "Gutters", "body": "Move cars.", "target_scope": "ALL_BUILDING"},
        ),
    )

    early = await publisher.tick(now=at(due - timedelta(days=15)))
    first = await publisher.tick(now=at(due - timedelta(days=14)))
    again = await publisher.tick(now=at(due - timedelta(days=13)))

    assert (early.ran, early.published) == (True, 0)
    assert (first.published, again.published, again.reminded) == (1, 0, 0)
    (topic,) = await board_topics(api_client, world.board_15)
    assert topic["origin"] == "MAINTENANCE"
    assert topic["title"].endswith(f"{due:%d.%m.%Y}") and task["title"] in topic["title"]
    assert task["instructions"] in topic["body"]
    assert topic["author_badge"]["display_label"] == "Oleg Sidorov", "the creator"
    (notice,) = await notices(api_client, world.owner_14)
    assert (notice["title"], notice["origin"]) == ("Gutters", "MAINTENANCE")
    assert notice["body"].startswith("Move cars.") and f"{due:%d.%m.%Y}" in notice["body"]
    current = (
        await api_client.get(f"{API}/tasks/{task['id']}", headers=as_user(world.chairman))
    ).json()["current"]
    assert (current["board_post_id"], current["notice_post_id"]) == (topic["id"], notice["id"])
    assert current["published_at"] is not None  # the state follows the real clock


async def test_nothing_at_night(
    api_client: AsyncClient, publisher: Publisher, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=5)
    await created(api_client, world.chairman, **calendar_task(due))

    night = await publisher.tick(now=at(due - timedelta(days=1), hour=22))
    morning = await publisher.tick(now=at(due - timedelta(days=1), hour=8))

    assert (night.ran, morning.ran) == (False, False)
    assert await board_topics(api_client, world.chairman) == []


async def test_a_downtime_is_caught_up_as_overdue(
    api_client: AsyncClient, publisher: Publisher, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=5)
    await created(api_client, world.chairman, **calendar_task(due))

    result = await publisher.tick(now=at(due + timedelta(days=3)))

    assert result.published == 1
    (topic,) = await board_topics(api_client, world.chairman)
    assert "overdue" in topic["title"].lower() or "möödus" in topic["title"]


async def test_overdue_reminders_every_seven_days(
    api_client: AsyncClient, publisher: Publisher, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=20)
    task = await created(api_client, world.chairman, **calendar_task(due))
    await publisher.tick(now=at(due - timedelta(days=14)))

    on_due = await publisher.tick(now=at(due))
    first = await publisher.tick(now=at(due + timedelta(days=1)))
    soon = await publisher.tick(now=at(due + timedelta(days=3)))
    second = await publisher.tick(now=at(due + timedelta(days=8)))

    assert (on_due.reminded, first.reminded, soon.reminded, second.reminded) == (0, 1, 0, 1)
    (topic,) = await board_topics(api_client, world.chairman)
    bodies = await comments(api_client, world.chairman, topic["id"])
    assert len(bodies) == 2 and all(f"{due:%d.%m.%Y}" in body for body in bodies)
    view = (
        await api_client.get(f"{API}/tasks/{task['id']}", headers=as_user(world.chairman))
    ).json()
    assert view["current"]["reminder_count"] == 2


async def test_the_chairman_sets_the_reminder_interval(
    api_client: AsyncClient, publisher: Publisher, world: MaintWorld
) -> None:
    put = await api_client.put(
        "/api/v1/settings",
        json={"values": {"maintenance.overdue_reminder_days": 2}},
        headers=as_user(world.chairman),
    )
    assert put.status_code == 200, put.text
    due = local_today() + timedelta(days=3)
    await created(api_client, world.chairman, **calendar_task(due, lead_days=0))
    await publisher.tick(now=at(due))

    result = await publisher.tick(now=at(due + timedelta(days=2)))

    assert result.reminded == 1


async def test_paused_and_done_tasks_publish_nothing(
    api_client: AsyncClient, publisher: Publisher, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=10)
    paused = await created(api_client, world.chairman, **calendar_task(due))
    await act(api_client, world.chairman, paused, "pause")
    published = await created(api_client, world.chairman, **calendar_task(due, title="Other"))
    await publisher.tick(now=at(due - timedelta(days=14)))
    await act(
        api_client,
        world.chairman,
        published,
        "done",
        occurrence_id=published["current"]["occurrence_id"],
        done_on=local_today().isoformat(),
    )

    later = await publisher.tick(now=at(due + timedelta(days=10)))

    assert (later.published, later.reminded) == (0, 0)
    assert [t["title"] for t in await board_topics(api_client, world.chairman)] == [
        f"Hooldus: Other, tähtaeg {due:%d.%m.%Y}"
    ]


async def test_the_author_falls_back_to_the_chairman(
    api_client: AsyncClient,
    db_session: AsyncSession,
    publisher: Publisher,
    world: MaintWorld,
) -> None:
    due = local_today() + timedelta(days=10)
    await created(api_client, world.board_15, **calendar_task(due))
    await db_session.execute(
        update(User).where(User.id == world.board_15.id).values(building_role=BuildingRole.USER)
    )

    await publisher.tick(now=at(due - timedelta(days=14)))

    (topic,) = await board_topics(api_client, world.chairman)
    assert topic["author_badge"]["display_label"] == "Oleg Sidorov"


async def test_an_invalid_notice_target_does_not_stop_the_board_topic(
    api_client: AsyncClient,
    db_session: AsyncSession,
    publisher: Publisher,
    world: MaintWorld,
) -> None:
    due = local_today() + timedelta(days=10)
    task = await created(
        api_client,
        world.chairman,
        **calendar_task(
            due,
            notice={
                "title": "Works",
                "body": "Stairs.",
                "target_scope": "ENTRANCE",
                "target_entrance": 2,
            },
        ),
    )
    await db_session.execute(
        update(Task).where(Task.id == uuid.UUID(task["id"])).values(notice_target_entrance=9)
    )

    result = await publisher.tick(now=at(due - timedelta(days=14)))
    again = await publisher.tick(now=at(due - timedelta(days=13)))

    assert (result.published, result.failed, again.published) == (1, 0, 0)
    view = (
        await api_client.get(f"{API}/tasks/{task['id']}", headers=as_user(world.chairman))
    ).json()
    assert (view["current"]["notice_failed"], view["current"]["notice_post_id"]) == (True, None)
    (topic,) = await board_topics(api_client, world.chairman)
    assert "teadet ei saanud avaldada" in topic["body"]
    assert await notices(api_client, world.owner_14) == []


async def test_a_deleted_board_topic_is_posted_again_with_the_next_reminder(
    api_client: AsyncClient, publisher: Publisher, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=3)
    await created(api_client, world.chairman, **calendar_task(due, lead_days=0))
    await publisher.tick(now=at(due))
    (topic,) = await board_topics(api_client, world.chairman)
    deleted = await api_client.delete(f"{POSTS}/{topic['id']}", headers=as_user(world.board_15))
    assert deleted.status_code == 204

    result = await publisher.tick(now=at(due + timedelta(days=7)))

    assert result.reminded == 1
    (again,) = await board_topics(api_client, world.chairman)
    assert again["id"] != topic["id"] and "möödus" in again["title"]


async def test_moving_a_published_date_says_so_on_the_topic(
    api_client: AsyncClient, publisher: Publisher, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=5)
    task = await created(api_client, world.chairman, **calendar_task(due))
    await publisher.tick(now=at(local_today()))
    later = due + timedelta(days=20)

    moved = await api_client.patch(
        f"{API}/tasks/{task['id']}",
        json={"next_due_date": later.isoformat()},
        headers=as_user(world.board_15),
    )

    assert moved.status_code == 200, moved.text
    (topic,) = await board_topics(api_client, world.chairman)
    assert await comments(api_client, world.chairman, topic["id"]) == [
        f"Edasi lükatud kuupäevale {later:%d.%m.%Y}."
    ]
    assert moved.json()["current"]["board_post_id"] == topic["id"], "no new publication"


# --- Events --------------------------------------------------------------------------------------


async def stored(db_session: AsyncSession, event_type: str) -> int:
    return await db_session.scalar(
        select(func.count())
        .select_from(DomainEventRecord)
        .where(DomainEventRecord.event_type == event_type)
    )


async def test_publishing_stores_its_events(
    api_client: AsyncClient,
    db_session: AsyncSession,
    publisher: Publisher,
    world: MaintWorld,
) -> None:
    due = local_today() + timedelta(days=3)
    await created(
        api_client,
        world.chairman,
        **calendar_task(
            due, lead_days=0, notice={"title": "N", "body": "B", "target_scope": "ALL_BUILDING"}
        ),
    )

    await publisher.tick(now=at(due))
    await publisher.tick(now=at(due + timedelta(days=7)))

    assert await stored(db_session, "MaintenanceTaskDue") == 2
    assert await stored(db_session, "OfficialNoticePublished") == 1


async def test_a_hand_written_notice_stores_its_event_too(
    api_client: AsyncClient, db_session: AsyncSession, world: MaintWorld
) -> None:
    response = await api_client.post(
        POSTS,
        json={"post_type": "OFFICIAL_NOTICE", "title": "Meeting", "body": "On Monday."},
        headers=as_user(world.chairman),
    )

    assert response.status_code == 201, response.text
    assert response.json()["origin"] is None
    assert await stored(db_session, "OfficialNoticePublished") == 1


# --- Review findings (E10/M2) --------------------------------------------------------------------


async def test_the_first_reminder_is_the_day_after_the_due_date(
    api_client: AsyncClient, publisher: Publisher, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=3)
    await created(api_client, world.chairman, **calendar_task(due, lead_days=0))
    await publisher.tick(now=at(due))

    first = await publisher.tick(now=at(due + timedelta(days=1)))
    none = await publisher.tick(now=at(due + timedelta(days=7)))
    second = await publisher.tick(now=at(due + timedelta(days=8)))

    assert (first.reminded, none.reminded, second.reminded) == (1, 0, 1)


async def test_every_due_occurrence_is_published_even_beyond_one_page(
    api_client: AsyncClient,
    publisher: Publisher,
    world: MaintWorld,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("src.modules.maintenance.publisher.BATCH_SIZE", 1)
    due = local_today() + timedelta(days=3)
    for index in range(3):
        await created(api_client, world.chairman, **calendar_task(due, title=f"Task {index}"))

    result = await publisher.tick(now=at(due))

    assert result.published == 3


async def test_moving_a_published_date_beyond_the_lead_time_publishes_it_again(
    api_client: AsyncClient,
    db_session: AsyncSession,
    publisher: Publisher,
    world: MaintWorld,
) -> None:
    due = local_today() + timedelta(days=5)
    task = await created(
        api_client,
        world.chairman,
        **calendar_task(
            due, notice={"title": "Works", "body": "Stairs.", "target_scope": "ALL_BUILDING"}
        ),
    )
    await publisher.tick(now=at(local_today()))
    later = due + timedelta(days=40)
    moved = await api_client.patch(
        f"{API}/tasks/{task['id']}",
        json={"next_due_date": later.isoformat()},
        headers=as_user(world.chairman),
    )
    assert moved.json()["current"]["published_at"] is None

    early = await publisher.tick(now=at(later - timedelta(days=15)))
    again = await publisher.tick(now=at(later - timedelta(days=14)))

    assert (early.published, again.published) == (0, 1)
    (topic,) = await board_topics(api_client, world.chairman)
    assert await comments(api_client, world.chairman, topic["id"]) == [
        f"Edasi lükatud kuupäevale {later:%d.%m.%Y}.",
        f"Tähtaeg: {later:%d.%m.%Y}.",
    ]
    bodies = [n["body"] for n in await notices(api_client, world.owner_14)]
    assert len(bodies) == 2 and f"{later:%d.%m.%Y}" in bodies[0], "residents get the new date"
    assert await stored(db_session, "MaintenanceTaskDue") == 2


async def test_done_and_skip_close_the_reminder_topic(
    api_client: AsyncClient, publisher: Publisher, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=3)
    task = await created(
        api_client, world.chairman, **calendar_task(due, lead_days=7, period_count=1)
    )
    await publisher.tick(now=at(local_today()))
    closed = await act(
        api_client,
        world.board_15,
        task,
        "done",
        occurrence_id=task["current"]["occurrence_id"],
        done_on=local_today().isoformat(),
    )
    assert closed.status_code == 201, closed.text

    (topic,) = await board_topics(api_client, world.chairman)
    assert await comments(api_client, world.chairman, topic["id"]) == [
        f"Tehtud {local_today():%d.%m.%Y}."
    ]


async def test_nothing_is_published_while_nobody_is_on_the_board(
    api_client: AsyncClient,
    db_session: AsyncSession,
    publisher: Publisher,
    world: MaintWorld,
) -> None:
    due = local_today() + timedelta(days=3)
    await created(api_client, world.board_15, **calendar_task(due))
    for user in (world.board_15, world.chairman):
        await db_session.execute(
            update(User).where(User.id == user.id).values(building_role=BuildingRole.USER)
        )

    nobody = await publisher.tick(now=at(due))
    await db_session.execute(
        update(User).where(User.id == world.chairman.id).values(building_role=BuildingRole.CHAIRMAN)
    )
    somebody = await publisher.tick(now=at(due))

    assert (nobody.published, somebody.published) == (0, 1)
