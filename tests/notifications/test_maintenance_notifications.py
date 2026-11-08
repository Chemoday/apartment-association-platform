"""E-mails of the maintenance calendar and of official notices (epic E10, task M3).

The e-mail world of test_dispatcher.py (demo mode off, a test SMTP server, JWT callers).
Apt 14 (entrance 2): owner Ivan Petrov. Apt 15 (entrance 2): board member Peeter Saar.
"""

from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import Settings, get_settings
from src.core.security import DEMO_USER_HEADER
from src.modules.maintenance.publisher import Publisher
from src.modules.notifications.dispatcher import Dispatcher
from src.modules.property.models import ApartmentMembership, User
from src.modules.property.schemas import Locale
from tests.notifications.conftest import NotifWorld
from tests.notifications.test_dispatcher import (  # noqa: F401 - fixtures of the e-mail world
    app,
    bearer,
    dispatcher,
    email_rows,
    email_settings,
    mailboxes,
)
from tests.smtp_server import SmtpServer

TASKS = "/api/v1/maintenance/tasks"
FEED = "/api/v1/notifications/feed"
POSTS = "/api/v1/communication/posts"


def today() -> date:
    return datetime.now(ZoneInfo(get_settings().INSTANCE_TIMEZONE)).date()


def at(day: date, hour: int = 12) -> datetime:
    zone = ZoneInfo(get_settings().INSTANCE_TIMEZONE)
    return datetime.combine(day, time(hour), tzinfo=zone).astimezone(UTC)


def daytime_now() -> datetime:
    """Now if it is day in the building, else the next 09:30: never before rows just written."""
    now = datetime.now(UTC)
    local = now.astimezone(ZoneInfo(get_settings().INSTANCE_TIMEZONE))
    if 9 <= local.hour < 21:
        return now
    morning = local.date() + timedelta(days=1 if local.hour >= 21 else 0)
    zone = ZoneInfo(get_settings().INSTANCE_TIMEZONE)
    return datetime.combine(morning, time(9, 30), tzinfo=zone).astimezone(UTC)


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


# --- Before sending ------------------------------------------------------------------------------


async def email_on(client: AsyncClient, user: User, settings: Settings, event_type: str) -> None:
    response = await client.put(
        "/api/v1/notifications/preferences",
        json={"preferences": [{"event_type": event_type, "channel": "email", "enabled": True}]},
        headers=bearer(user, settings),
    )
    assert response.status_code == 200, response.text


async def test_a_due_task_e_mail_names_the_task_and_its_date(
    api_client: AsyncClient,
    world: NotifWorld,
    mailboxes: dict[str, str],  # noqa: F811
    db_app: FastAPI,
    dispatcher: Dispatcher,  # noqa: F811
    db_session: AsyncSession,
    smtp_server: SmtpServer,
    email_settings: Settings,  # noqa: F811
) -> None:
    world.board_15.locale = Locale.EN
    await db_session.flush()
    await email_on(api_client, world.board_15, email_settings, "MAINTENANCE_DUE")
    task = await new_task(api_client, world.chairman, bearer(world.chairman, email_settings))
    due = date.fromisoformat(task["current"]["due_date"])
    await db_app.state.maintenance_publisher.tick(now=at(due))
    await api_client.patch(
        f"{TASKS}/{task['id']}",
        json={"title": "Renamed task"},
        headers=bearer(world.chairman, email_settings),
    )

    await dispatcher.tick(now=at(due))

    sent = {email["To"]: email for email in smtp_server.messages}
    email = sent[mailboxes["board_15"]]
    assert email["Subject"] == f"Maintenance due: Renamed task, {due:%d.%m.%Y}"
    assert "Stop these e-mails" in email.get_content()


async def test_a_reminder_of_a_task_done_or_paused_before_sending_is_skipped(
    api_client: AsyncClient,
    world: NotifWorld,
    mailboxes: dict[str, str],  # noqa: F811
    db_app: FastAPI,
    dispatcher: Dispatcher,  # noqa: F811
    db_session: AsyncSession,
    smtp_server: SmtpServer,
    email_settings: Settings,  # noqa: F811
) -> None:
    await email_on(api_client, world.board_15, email_settings, "MAINTENANCE_DUE")
    headers = bearer(world.chairman, email_settings)
    closed = await new_task(api_client, world.chairman, headers, title="Closed")
    paused = await new_task(api_client, world.chairman, headers, title="Paused")
    due = date.fromisoformat(closed["current"]["due_date"])
    await db_app.state.maintenance_publisher.tick(now=at(due))
    done = await api_client.post(
        f"{TASKS}/{closed['id']}/done",
        json={"occurrence_id": closed["current"]["occurrence_id"], "done_on": today().isoformat()},
        headers=headers,
    )
    assert done.status_code == 201, done.text
    await api_client.post(f"{TASKS}/{paused['id']}/pause", headers=headers)

    await dispatcher.tick(now=at(due))

    rows = await email_rows(db_session, event_type="MAINTENANCE_DUE")
    assert sorted((r.status, r.error_code) for r in rows) == [
        ("SKIPPED", "TASK_DONE"),
        ("SKIPPED", "TASK_NOT_ACTIVE"),
    ]
    assert smtp_server.messages == []


async def test_a_board_reminder_waits_for_the_morning(
    api_client: AsyncClient,
    world: NotifWorld,
    mailboxes: dict[str, str],  # noqa: F811
    db_app: FastAPI,
    dispatcher: Dispatcher,  # noqa: F811
    db_session: AsyncSession,
    smtp_server: SmtpServer,
    email_settings: Settings,  # noqa: F811
) -> None:
    await email_on(api_client, world.board_15, email_settings, "MAINTENANCE_DUE")
    task = await new_task(api_client, world.chairman, bearer(world.chairman, email_settings))
    due = date.fromisoformat(task["current"]["due_date"])
    await db_app.state.maintenance_publisher.tick(now=at(due, hour=20))

    await dispatcher.tick(now=at(due, hour=23))

    (row,) = await email_rows(db_session, event_type="MAINTENANCE_DUE")
    assert row.status == "PENDING" and row.next_attempt_at == at(due + timedelta(days=1), hour=9)
    assert smtp_server.messages == []


async def test_a_notice_e_mail_says_only_that_there_is_a_notice(
    api_client: AsyncClient,
    world: NotifWorld,
    mailboxes: dict[str, str],  # noqa: F811
    dispatcher: Dispatcher,  # noqa: F811
    db_session: AsyncSession,
    smtp_server: SmtpServer,
    email_settings: Settings,  # noqa: F811
) -> None:
    world.board_15.locale = Locale.EN
    await db_session.flush()
    response = await api_client.post(
        POSTS,
        json={
            "post_type": "OFFICIAL_NOTICE",
            "title": "Secret title",
            "body": "Secret body.",
            "target_scope": "ENTRANCE",
            "target_entrance": 2,
        },
        headers=bearer(world.chairman, email_settings),
    )
    assert response.status_code == 201, response.text
    await db_session.execute(
        update(ApartmentMembership)
        .where(ApartmentMembership.user_id == world.owner_14.id)
        .values(ended_at=datetime.now(UTC))
    )

    await dispatcher.tick(now=daytime_now())  # notices wait for the morning at night

    sent = {email["To"]: email for email in smtp_server.messages}
    email = sent[mailboxes["board_15"]]  # lives in entrance 2; the board sees every notice
    assert email["Subject"] == "New notice from the board"
    assert "Secret" not in email.get_content()
    moved_out = await email_rows(
        db_session, event_type="NOTICE_PUBLISHED", user_id=world.owner_14.id
    )
    assert {(r.status, r.error_code) for r in moved_out} == {("SKIPPED", "SUBJECT_NOT_FOUND")}


async def test_a_notice_at_night_waits_for_the_morning(
    api_client: AsyncClient,
    world: NotifWorld,
    mailboxes: dict[str, str],  # noqa: F811
    dispatcher: Dispatcher,  # noqa: F811
    db_session: AsyncSession,
    smtp_server: SmtpServer,
    email_settings: Settings,  # noqa: F811
) -> None:
    response = await api_client.post(
        POSTS,
        json={"post_type": "OFFICIAL_NOTICE", "title": "Meeting", "body": "Monday."},
        headers=bearer(world.chairman, email_settings),
    )
    assert response.status_code == 201, response.text

    await dispatcher.tick(now=at(today(), hour=23))

    rows = await email_rows(db_session, event_type="NOTICE_PUBLISHED")
    assert rows and all(row.status == "PENDING" for row in rows)
    assert {row.next_attempt_at for row in rows} == {at(today() + timedelta(days=1), hour=9)}
    assert smtp_server.messages == []


async def test_a_reminder_to_someone_who_left_the_board_or_of_a_moved_date_is_skipped(
    api_client: AsyncClient,
    world: NotifWorld,
    mailboxes: dict[str, str],  # noqa: F811
    db_app: FastAPI,
    dispatcher: Dispatcher,  # noqa: F811
    db_session: AsyncSession,
    smtp_server: SmtpServer,
    email_settings: Settings,  # noqa: F811
) -> None:
    for user in (world.board_15, world.chairman):
        await email_on(api_client, user, email_settings, "MAINTENANCE_DUE")
    headers = bearer(world.chairman, email_settings)
    task = await new_task(api_client, world.chairman, headers, lead_days=3)
    due = date.fromisoformat(task["current"]["due_date"])
    await db_app.state.maintenance_publisher.tick(now=daytime_now())
    moved = await api_client.patch(
        f"{TASKS}/{task['id']}",
        json={"next_due_date": (due + timedelta(days=1)).isoformat()},
        headers=headers,
    )
    assert moved.status_code == 200, moved.text
    await db_session.execute(
        update(User).where(User.id == world.board_15.id).values(building_role="USER")
    )

    await dispatcher.tick(now=daytime_now())

    rows = {
        r.user_id: (r.status, r.error_code)
        for r in await email_rows(db_session, event_type="MAINTENANCE_DUE")
    }
    assert rows == {
        world.board_15.id: ("SKIPPED", "SUBJECT_NOT_FOUND"),
        world.chairman.id: ("SKIPPED", "TASK_MOVED"),
    }
