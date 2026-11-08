"""QA additions: e-mails about issues and their send-time checks (epic E9, task I3).

Uses the e-mail world of test_dispatcher.py (demo mode off, a test SMTP server, JWT callers).
"""

from typing import Any

from httpx import AsyncClient
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import Settings
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
    issue_status,
    mailboxes,
    report_issue,
)
from tests.smtp_server import SmtpServer


async def email_on(client: AsyncClient, user: User, settings: Settings, event_type: str) -> None:
    response = await client.put(
        "/api/v1/notifications/preferences",
        json={"preferences": [{"event_type": event_type, "channel": "email", "enabled": True}]},
        headers=bearer(user, settings),
    )
    assert response.status_code == 200, response.text


async def follow(client: AsyncClient, user: User, settings: Settings, issue_id: str) -> None:
    response = await client.put(f"/api/v1/issues/{issue_id}/follow", headers=bearer(user, settings))
    assert response.status_code == 200, response.text


def states(rows: list[Any]) -> set[tuple[str, str | None]]:
    return {(row.status, row.error_code) for row in rows}


async def test_a_new_report_reaches_the_board_by_e_mail_only_when_switched_on(
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
    await email_on(api_client, world.board_15, email_settings, "ISSUE_REPORTED")

    await report_issue(api_client, world.owner_14, email_settings)
    await dispatcher.tick()

    sent = {email["To"]: email for email in smtp_server.messages}
    assert set(sent) == {mailboxes["board_15"]}, "off by default for everyone else"
    email = sent[mailboxes["board_15"]]
    assert email["Subject"] == "New issue report: lighting, entrance 2"
    text = email.get_content()
    assert "An issue was reported: lighting, entrance 2" in text
    assert "Secret words" not in text and "Landing" not in text and "Ivan Petrov" not in text


async def test_a_new_report_declined_before_sending_is_skipped(
    api_client: AsyncClient,
    world: NotifWorld,
    mailboxes: dict[str, str],  # noqa: F811
    dispatcher: Dispatcher,  # noqa: F811
    db_session: AsyncSession,
    smtp_server: SmtpServer,
    email_settings: Settings,  # noqa: F811
) -> None:
    await email_on(api_client, world.board_15, email_settings, "ISSUE_REPORTED")
    issue_id = await report_issue(api_client, world.owner_14, email_settings)
    await issue_status(api_client, world.chairman, email_settings, issue_id, "DECLINED")

    await dispatcher.tick()

    rows = await email_rows(db_session, event_type="ISSUE_REPORTED")
    assert rows and states(rows) == {("SKIPPED", "ISSUE_ENDED")}
    assert mailboxes["board_15"] not in {email["To"] for email in smtp_server.messages}


async def test_a_follower_who_moved_out_before_sending_is_skipped(
    api_client: AsyncClient,
    world: NotifWorld,
    mailboxes: dict[str, str],  # noqa: F811
    dispatcher: Dispatcher,  # noqa: F811
    db_session: AsyncSession,
    smtp_server: SmtpServer,
    email_settings: Settings,  # noqa: F811
) -> None:
    issue_id = await report_issue(api_client, world.owner_14, email_settings)
    await issue_status(api_client, world.chairman, email_settings, issue_id, "IN_PROGRESS")
    await db_session.execute(
        update(ApartmentMembership)
        .where(ApartmentMembership.user_id == world.owner_14.id)
        .values(ended_at=func.now())
    )

    await dispatcher.tick()

    rows = await email_rows(
        db_session, event_type="ISSUE_STATUS_CHANGED", user_id=world.owner_14.id
    )
    assert rows and states(rows) == {("SKIPPED", "SUBJECT_NOT_FOUND")}
    assert smtp_server.messages == []


async def test_a_quick_round_trip_sends_both_in_progress_notices(
    api_client: AsyncClient,
    world: NotifWorld,
    mailboxes: dict[str, str],  # noqa: F811
    dispatcher: Dispatcher,  # noqa: F811
    db_session: AsyncSession,
    smtp_server: SmtpServer,
    email_settings: Settings,  # noqa: F811
) -> None:
    issue_id = await report_issue(api_client, world.owner_14, email_settings)
    for status in ("IN_PROGRESS", "WAITING_FOR_CONTRACTOR", "IN_PROGRESS"):
        await issue_status(api_client, world.chairman, email_settings, issue_id, status)

    await dispatcher.tick()

    rows = await email_rows(db_session, event_type="ISSUE_STATUS_CHANGED")
    by_status = sorted((row.params["status"], row.status, row.error_code) for row in rows)
    assert by_status == [
        ("IN_PROGRESS", "SENT", None),
        ("IN_PROGRESS", "SENT", None),
        ("WAITING_FOR_CONTRACTOR", "SKIPPED", "STATUS_OUTDATED"),
    ]
    assert len(smtp_server.messages) == 2


async def test_a_merge_e_mail_tells_the_duplicates_follower_once(
    api_client: AsyncClient,
    world: NotifWorld,
    mailboxes: dict[str, str],  # noqa: F811
    dispatcher: Dispatcher,  # noqa: F811
    db_session: AsyncSession,
    smtp_server: SmtpServer,
    email_settings: Settings,  # noqa: F811
) -> None:
    original = await report_issue(api_client, world.board_15, email_settings, entrance=None)
    await issue_status(api_client, world.chairman, email_settings, original, "IN_PROGRESS")
    duplicate = await report_issue(api_client, world.owner_14, email_settings)
    smtp_server.messages.clear()
    response = await api_client.post(
        f"/api/v1/issues/{duplicate}/status",
        json={"status": "DUPLICATE", "duplicate_of": original},
        headers=bearer(world.chairman, email_settings),
    )
    assert response.status_code == 200, response.text

    await dispatcher.tick()

    to_owner = [e for e in smtp_server.messages if e["To"] == mailboxes["owner_14"]]
    assert len(to_owner) == 1, "one merge notice, no 'now: duplicate' notice"
    (email,) = to_owner
    assert email["Subject"] == "Issue update: lighting, entrance 2"
    assert "was merged into another report of the same problem" in email.get_content()
    assert "Secret words" not in email.get_content()
