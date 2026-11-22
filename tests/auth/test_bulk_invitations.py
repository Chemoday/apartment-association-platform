# The fixtures of tests/auth/test_invitations.py are imported by name; using them as parameters
# is what pytest expects, so F811 does not apply to this file.
# ruff: noqa: F811
"""Bulk invitations, the language of an invitation and the invitation queue (epic E13 R4a,
docs/API.md section 7), on a real PostgreSQL with an in-process SMTP server.

The building of `world` has three apartments (14, 2, 21), so its bulk limit is 6 per 24 hours and
a list may hold at most 6 rows.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import Settings
from src.modules.auth import invitations as invitations_module
from src.modules.auth import queue as queue_module
from src.modules.auth.bulk import BulkListTooLong, parse_bulk_list
from src.modules.auth.invitations import InvitationService, QueuedMail
from src.modules.auth.mail import auth_catalog
from src.modules.auth.models import AuthInvitation, AuthToken
from src.modules.auth.policies import (
    INVITATION_MAX_FAILED_SENDS,
    INVITATION_SEND_LEASE,
    invitation_retry_delay,
)
from src.modules.auth.queue import InvitationQueue, drain_queue
from src.modules.auth.schemas import BulkRowOutcome
from src.modules.property.models import User
from tests.auth.test_invitations import (  # noqa: F401 (fixtures used by name)
    API,
    World,
    app,
    as_,
    client,
    drain,
    links_sent,
    mail_settings,
    redeem,
    unique,
    world,
)
from tests.factories import create_user
from tests.smtp_server import SmtpServer

OFFERED = frozenset({"et", "en"})


def subject(locale: str) -> str:
    """The subject of the invitation e-mail in that language (src/modules/auth/messages.csv)."""
    return auth_catalog().render("invitation.subject", locale)


def subjects_to(smtp_server: SmtpServer, to: str) -> list[str]:
    return [str(m["Subject"]) for m in smtp_server.messages if m["To"] == to]


async def preview(client: AsyncClient, headers: dict[str, str], text: str):
    return await client.post(
        f"{API}/invitations/bulk/preview", json={"text": text}, headers=headers
    )


async def send(client: AsyncClient, headers: dict[str, str], text: str):
    return await client.post(f"{API}/invitations/bulk", json={"text": text}, headers=headers)


async def claim_one(
    session: AsyncSession, settings: Settings, invitation_id: str, now: datetime | None = None
) -> QueuedMail:
    """Claim the due e-mails as the queue would and return the one of this invitation."""
    claimed, _ = await InvitationService(session, settings).claim_due(
        now or datetime.now(UTC), 1000
    )
    found = [q for q in claimed if str(q.invitation_id) == invitation_id]
    assert len(found) == 1
    return found[0]


async def row_of(session: AsyncSession, invitation_id: str) -> AuthInvitation:
    session.expunge_all()
    row = await session.get(AuthInvitation, uuid.UUID(invitation_id))
    assert row is not None
    return row


# --- Reading the list ----------------------------------------------------------------------------


def test_the_list_takes_three_separators_a_header_comments_and_a_bom() -> None:
    text = (
        "﻿Apartment;E-mail;Language\n"
        "# the first entrance\n"
        "\n"
        "14; A@Example.com ; ET\n"
        "2\tb@example.com\n"
        "21,c@example.com,en,,\n"
    )
    rows = parse_bulk_list(text, max_rows=6, offered_locales=OFFERED)
    assert [(r.line, r.apartment_number, r.email, r.locale, r.outcome) for r in rows] == [
        (4, "14", "a@example.com", "et", None),
        (5, "2", "b@example.com", None, None),
        (6, "21", "c@example.com", "en", None),
    ]


def test_a_first_line_with_an_e_mail_is_a_row_not_a_header() -> None:
    rows = parse_bulk_list("14;mail@example.com\n", max_rows=6, offered_locales=OFFERED)
    assert [r.email for r in rows] == ["mail@example.com"]


def test_wrong_rows_are_reported_not_dropped() -> None:
    text = "14\n2;not-an-e-mail\n21;x@example.com;ru\n14;y@example.com;et;extra\n;z@example.com\n"
    rows = parse_bulk_list(text, max_rows=6, offered_locales=OFFERED)
    assert [r.outcome for r in rows] == [
        BulkRowOutcome.INVALID_ROW,
        BulkRowOutcome.INVALID_EMAIL,
        BulkRowOutcome.INVALID_LOCALE,
        BulkRowOutcome.INVALID_ROW,
        BulkRowOutcome.INVALID_ROW,
    ]
    assert rows[1].email == "not-an-e-mail"  # as typed, so the chairman can fix it


def test_a_list_too_long_is_refused_before_anything_is_read() -> None:
    with pytest.raises(BulkListTooLong):
        parse_bulk_list("1;a@example.com\n" * 7, max_rows=6, offered_locales=OFFERED)
    with pytest.raises(BulkListTooLong):
        parse_bulk_list("#" * (1024 * 1024 + 1), max_rows=6, offered_locales=OFFERED)


# --- Preview and send ----------------------------------------------------------------------------


async def test_the_preview_reports_every_row_and_changes_nothing(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    pending = unique("pending")
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": pending, "apartment_number": "2"},
        headers=chairman,
    )
    assert created.status_code == 201
    member = world.owner_14.email  # has an account: must look like anyone else
    text = f"14;{member}\n99;{unique('nobody')}\n21;{unique('dup')};en\n2;{pending}\n21;broken\n"
    dup = text.splitlines()[2].split(";")[1]
    text += f"21;{dup}\n"
    response = await preview(client, chairman, text)
    assert response.status_code == 200, response.text
    body = response.json()
    assert [row["outcome"] for row in body["rows"]] == [
        "READY",
        "APARTMENT_NOT_FOUND",
        "READY",
        "ALREADY_PENDING",
        "INVALID_EMAIL",
        "DUPLICATE_IN_LIST",
    ]
    assert body["counts"] == {
        "READY": 2,
        "APARTMENT_NOT_FOUND": 1,
        "ALREADY_PENDING": 1,
        "INVALID_EMAIL": 1,
        "DUPLICATE_IN_LIST": 1,
    }
    assert body["limit_remaining"] == 6
    assert body["rows"][2]["locale"] == "en"
    count = len(list(await db_session.scalars(select(AuthInvitation.id))))
    assert count == 1  # only the single invitation made above


async def test_the_send_invites_the_ready_rows_in_their_language(
    client: AsyncClient, world: World, smtp_server: SmtpServer, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    estonian, english = unique("tamm"), unique("smith")
    response = await send(client, chairman, f"21;{estonian}\n2;{english};en\n99;{unique('x')}\n")
    assert response.status_code == 200, response.text
    body = response.json()
    assert [row["outcome"] for row in body["rows"]] == ["INVITED", "INVITED", "APARTMENT_NOT_FOUND"]
    assert body["limit_remaining"] == 4

    listed = (await client.get(f"{API}/invitations", headers=chairman)).json()
    by_email = {item["email"]: item for item in listed}
    assert by_email[estonian]["delivery"] == "QUEUED"
    assert (by_email[english]["locale"], by_email[estonian]["locale"]) == ("en", None)

    await drain(client)
    assert subjects_to(smtp_server, estonian) == [subject("et")]
    assert subjects_to(smtp_server, english) == [subject("en")]
    listed = (await client.get(f"{API}/invitations", headers=chairman)).json()
    assert {item["delivery"] for item in listed} == {"SENT"}


async def test_the_send_checks_every_row_again(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    email = unique("late")
    text = f"21;{email}\n"
    assert (await preview(client, chairman, text)).json()["rows"][0]["outcome"] == "READY"
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "21"},
        headers=chairman,
    )
    assert created.status_code == 201
    body = (await send(client, chairman, text)).json()
    assert body["rows"][0]["outcome"] == "ALREADY_PENDING"
    assert body["limit_remaining"] == 6  # nothing was counted


async def test_an_expired_invitation_is_replaced_by_the_bulk_send(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    email = unique("again")
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "21"},
        headers=chairman,
    )
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == uuid.UUID(created.json()["invitation_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(days=1))
    )
    body = (await send(client, chairman, f"21;{email}\n")).json()
    assert body["rows"][0]["outcome"] == "INVITED"


async def test_only_the_chairman_sends_bulk_invitations(client: AsyncClient, world: World) -> None:
    for user in (world.owner_14, world.accountant):
        for call in (preview, send):
            response = await call(client, as_(world, user), f"21;{unique('x')}\n")
            assert response.json()["error_code"] == "FORBIDDEN"
        response = await client.post(f"{API}/invitations/resend-expired", headers=as_(world, user))
        assert response.json()["error_code"] == "FORBIDDEN"


async def test_a_list_longer_than_twice_the_apartments_is_refused(
    client: AsyncClient, world: World
) -> None:
    text = "".join(f"21;{unique('x')}\n" for _ in range(7))
    response = await preview(client, as_(world, world.chairman), text)
    assert (response.status_code, response.json()["error_code"]) == (422, "BULK_LIST_TOO_LONG")
    response = await preview(client, as_(world, world.chairman), "#" * (1024 * 1024 + 1))
    assert (response.status_code, response.json()["error_code"]) == (422, "BULK_LIST_TOO_LONG")
    response = await preview(client, as_(world, world.chairman), "21;a@example.com\x00")
    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


async def test_the_building_limit_is_all_or_nothing(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    first = "".join(f"{n};{unique('a')}\n" for n in ("14", "2", "21", "14"))
    assert (await send(client, chairman, first)).json()["limit_remaining"] == 2
    second = "".join(f"{n};{unique('b')}\n" for n in ("14", "2", "21"))
    response = await send(client, chairman, second)
    assert (response.status_code, response.json()["error_code"]) == (429, "RATE_LIMITED")
    assert 24 * 3600 - 120 < int(response.headers["Retry-After"]) <= 24 * 3600  # just counted
    count = len(list(await db_session.scalars(select(AuthInvitation.id))))
    assert count == 4  # nothing of the second list
    assert (await preview(client, chairman, second)).json()["limit_remaining"] == 2
    # Single invitations have their own limit and do not count here.
    single = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("c"), "apartment_number": "2"},
        headers=chairman,
    )
    assert single.status_code == 201


# --- Resend expired ------------------------------------------------------------------------------


async def test_resend_expired_queues_owner_and_staff_but_not_tenant_invitations(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
) -> None:
    chairman, owner = as_(world, world.chairman), as_(world, world.owner_14)
    made = [
        await client.post(f"{API}/invitations", json=body, headers=headers)
        for body, headers in (
            ({"kind": "OWNER", "email": unique("o"), "apartment_number": "2"}, chairman),
            ({"kind": "STAFF", "email": unique("s"), "building_role": "BOARD"}, chairman),
            ({"kind": "TENANT", "email": unique("t"), "apartment_id": str(world.apt_14.id)}, owner),
        )
    ]
    await drain(client)
    sent_before = len(smtp_server.messages)
    await db_session.execute(
        update(AuthInvitation).values(expires_at=datetime.now(UTC) - timedelta(hours=1))
    )
    response = await client.post(f"{API}/invitations/resend-expired", headers=chairman)
    assert response.json() == {"queued": 2, "left": 0}
    await drain(client)
    assert len(smtp_server.messages) == sent_before + 2
    tenant = await row_of(db_session, made[2].json()["invitation_id"])
    assert tenant.expires_at < datetime.now(UTC)  # left to its owner
    again = await client.post(f"{API}/invitations/resend-expired", headers=chairman)
    assert again.json() == {"queued": 0, "left": 0}
    left = (await preview(client, chairman, "")).json()["limit_remaining"]
    assert left == 4  # the two resent ones counted against the building limit


# --- The language of a single invitation ---------------------------------------------------------


async def test_a_single_invitation_takes_the_default_or_english(
    client: AsyncClient, world: World, smtp_server: SmtpServer
) -> None:
    chairman = as_(world, world.chairman)
    refused = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("r"), "apartment_number": "2", "locale": "ru"},
        headers=chairman,
    )
    assert (refused.status_code, refused.json()["error_code"]) == (422, "VALIDATION_ERROR")
    email = unique("en")
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "2", "locale": "en"},
        headers=chairman,
    )
    assert created.json()["locale"] == "en"
    await drain(client)
    assert subjects_to(smtp_server, email) == [subject("en")]


async def test_an_account_keeps_its_own_language(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
) -> None:
    email = unique("ru")
    anna = await create_user(db_session, world.building, "Anna Ru", email=email)
    await db_session.execute(update(User).where(User.id == anna.id).values(locale="ru"))
    await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "2", "locale": "en"},
        headers=as_(world, world.chairman),
    )
    await drain(client)
    assert subjects_to(smtp_server, email) == [subject("ru")]


# --- The queue -----------------------------------------------------------------------------------


@pytest.fixture
def queue_clock(monkeypatch: pytest.MonkeyPatch):
    class Clock:
        now = datetime.now(UTC)

        def shift(self, **delta: float) -> None:
            self.now += timedelta(**delta)

    clock = Clock()
    for module in (invitations_module, queue_module):
        monkeypatch.setattr(module, "_now", lambda: clock.now)
    return clock


async def test_a_failed_send_is_tried_again_and_the_week_starts_when_it_goes_out(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
    queue_clock,
) -> None:
    email = unique("retry")
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "2"},
        headers=as_(world, world.chairman),
    )
    invitation_id = created.json()["invitation_id"]
    smtp_server.handler.data_reply = "554 refused"
    await drain(client)
    row = await row_of(db_session, invitation_id)
    assert (row.send_attempts, row.send_due_at) == (1, queue_clock.now + invitation_retry_delay(1))

    await drain(client)  # not due yet
    assert (await row_of(db_session, invitation_id)).send_attempts == 1

    smtp_server.handler.data_reply = None
    queue_clock.shift(days=2, minutes=1)
    await drain(client)
    row = await row_of(db_session, invitation_id)
    assert row.send_due_at is None and row.send_attempts == 2
    assert row.last_sent_at == queue_clock.now
    assert row.expires_at == queue_clock.now + timedelta(days=7)
    token = await db_session.scalar(
        select(AuthToken.expires_at).where(AuthToken.invitation_id == row.id)
    )
    assert token == row.expires_at
    assert len(links_sent(smtp_server, email)) == 1


async def test_the_pacing_holds_back_the_rest(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
    mail_settings: Settings,
) -> None:
    mail_settings.AUTH_INVITATION_MAILS_PER_HOUR = 2
    text = "".join(f"{n};{unique('p')}\n" for n in ("14", "2", "21"))
    assert (await send(client, as_(world, world.chairman), text)).status_code == 200
    await drain(client)
    assert len(smtp_server.messages) == 2
    queued = await db_session.scalars(
        select(AuthInvitation).where(AuthInvitation.send_due_at.is_not(None))
    )
    assert len(list(queued)) == 1


async def test_a_queued_invitation_is_left_to_the_queue_by_a_sign_in_link_request(
    client: AsyncClient, world: World, smtp_server: SmtpServer
) -> None:
    email = unique("wait")
    await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "2"},
        headers=as_(world, world.chairman),
    )
    await client.post(f"{API}/magic-link", json={"email": email})
    app = client._transport.app  # type: ignore[attr-defined]
    await app.state.auth_background.drain(within_seconds=10)
    assert links_sent(smtp_server, email) == []  # the sign-in request sent nothing
    await drain(client)
    assert len(links_sent(smtp_server, email)) == 1


async def test_a_resend_voids_the_old_link_at_once(
    client: AsyncClient, world: World, smtp_server: SmtpServer
) -> None:
    chairman = as_(world, world.chairman)
    email = unique("void")
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "2"},
        headers=chairman,
    )
    await drain(client)
    old = links_sent(smtp_server, email)[-1]
    smtp_server.handler.data_reply = "554 refused"
    resent = await client.post(
        f"{API}/invitations/{created.json()['invitation_id']}/resend", headers=chairman
    )
    assert resent.json()["delivery"] == "QUEUED"
    assert (await redeem(client, old)).json()["error_code"] == "INVALID_LINK"


async def test_a_stale_result_never_overwrites_a_newer_queue_state(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("stale"), "apartment_number": "2"},
        headers=as_(world, world.chairman),
    )
    service = InvitationService(db_session, mail_settings)
    now = datetime.now(UTC)
    claimed = [
        q
        for q in (await service.claim_due(now, 1000))[0]
        if str(q.invitation_id) == created.json()["invitation_id"]
    ]
    assert len(claimed) == 1
    # The chairman resends while the e-mail is out: the attempt counter starts again.
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == claimed[0].invitation_id)
        .values(send_attempts=0, send_due_at=now)
    )
    assert await service.record_send(claimed[0], outcome="sent", now=now) is False
    row = await row_of(db_session, created.json()["invitation_id"])
    assert row.send_due_at == now  # still queued for the resend


async def test_accepting_takes_the_invitation_out_of_the_queue(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    email = unique("acc")
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "2"},
        headers=as_(world, world.chairman),
    )
    # Claimed but not yet recorded: the e-mail is "out", send_due_at holds the lease.
    claimed = await claim_one(db_session, mail_settings, created.json()["invitation_id"])
    token = claimed.mail.link.rpartition("#")[2]
    opened = (await redeem(client, token)).json()
    registered = await client.post(
        f"{API}/registration",
        json={"registration_token": opened["registration_token"], "full_name": "N", "locale": "et"},
        headers={"X-Requested-With": "fetch"},
    )
    assert registered.status_code == 200, registered.text
    row = await row_of(db_session, created.json()["invitation_id"])
    assert row.accepted_at is not None and row.send_due_at is None
    assert await db_session.scalar(select(User.id).where(User.email == email)) is not None
    service = InvitationService(db_session, mail_settings)
    assert await service.record_send(claimed, outcome="sent", now=datetime.now(UTC)) is False


async def test_drain_queue_sends_nothing_without_an_e_mail_channel(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("nochannel"), "apartment_number": "2"},
        headers=as_(world, world.chairman),
    )
    app = client._transport.app  # type: ignore[attr-defined]
    original = app.state.plugin_registry.channel

    def no_email(name: str):
        return None if name == "email" else original(name)

    app.state.plugin_registry.channel = no_email
    try:
        await drain_queue(app.state.auth_session_factory, app.state.plugin_registry, mail_settings)
    finally:
        app.state.plugin_registry.channel = original
    row = await row_of(db_session, created.json()["invitation_id"])
    assert row.send_due_at is not None and row.send_attempts == 1  # waits for a retry


async def test_a_claim_whose_lease_ran_out_is_claimed_again_and_its_result_ignored(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("lease"), "apartment_number": "2"},
        headers=as_(world, world.chairman),
    )
    invitation_id = created.json()["invitation_id"]
    now = datetime.now(UTC)
    first = await claim_one(db_session, mail_settings, invitation_id, now)
    service = InvitationService(db_session, mail_settings)
    assert (await service.claim_due(now + timedelta(minutes=5), 1000))[0] == []  # still leased
    later = now + INVITATION_SEND_LEASE + timedelta(seconds=1)
    second = await claim_one(db_session, mail_settings, invitation_id, later)
    assert (first.attempt, second.attempt) == (1, 2)
    assert first.mail.link != second.mail.link
    assert await service.record_send(first, outcome="sent", now=later) is False  # the stale one
    assert await service.record_send(second, outcome="sent", now=later) is True


async def test_an_invitation_that_no_longer_applies_is_not_sent(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("nochair"), "apartment_number": "2"},
        headers=as_(world, world.chairman),
    )
    await db_session.execute(
        update(User).where(User.id == world.chairman.id).values(building_role="USER")
    )
    now = datetime.now(UTC)
    claimed, looked = await InvitationService(db_session, mail_settings).claim_due(now, 1000)
    assert claimed == [] and looked >= 1
    row = await row_of(db_session, created.json()["invitation_id"])
    assert (row.send_due_at, row.send_attempts) == (now + timedelta(hours=3), 0)


async def test_an_invitation_that_expires_unsent_leaves_the_queue(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    chairman = as_(world, world.chairman)
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("unsent"), "apartment_number": "2"},
        headers=chairman,
    )
    await db_session.execute(
        update(AuthInvitation).values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
    )
    claimed, _ = await InvitationService(db_session, mail_settings).claim_due(
        datetime.now(UTC), 1000
    )
    assert claimed == []
    listed = (await client.get(f"{API}/invitations", headers=chairman)).json()
    mine = next(i for i in listed if i["invitation_id"] == created.json()["invitation_id"])
    assert (mine["status"], mine["delivery"]) == ("EXPIRED", "QUEUED")


async def test_resend_expired_takes_the_oldest_as_far_as_the_limit_allows(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    ids = []
    for minutes, number in ((30, "14"), (20, "2"), (10, "21")):  # the oldest first
        made = await client.post(
            f"{API}/invitations",
            json={"kind": "OWNER", "email": unique("old"), "apartment_number": number},
            headers=chairman,
        )
        assert made.status_code == 201
        ids.append(made.json()["invitation_id"])
        await db_session.execute(
            update(AuthInvitation)
            .where(AuthInvitation.id == uuid.UUID(ids[-1]))
            .values(
                created_at=datetime.now(UTC) - timedelta(days=9, minutes=minutes),
                expires_at=datetime.now(UTC) - timedelta(hours=1),
            )
        )
    filler = "".join(f"{n};{unique('f')}\n" for n in ("14", "2", "21", "14"))
    assert (await send(client, chairman, filler)).json()["limit_remaining"] == 2
    first = await client.post(f"{API}/invitations/resend-expired", headers=chairman)
    assert first.json() == {"queued": 2, "left": 1}
    rows = [await row_of(db_session, invitation_id) for invitation_id in ids]
    assert [row.expires_at > datetime.now(UTC) for row in rows] == [True, True, False]
    refused = await client.post(f"{API}/invitations/resend-expired", headers=chairman)
    assert (refused.status_code, refused.json()["error_code"]) == (429, "RATE_LIMITED")
    assert int(refused.headers["Retry-After"]) > 24 * 3600 - 120


async def test_the_pacing_counts_e_mails_not_invitations(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    mail_settings: Settings,
) -> None:
    mail_settings.AUTH_INVITATION_MAILS_PER_HOUR = 2
    chairman = as_(world, world.chairman)
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("twice"), "apartment_number": "2"},
        headers=chairman,
    )
    await drain(client)
    await client.post(
        f"{API}/invitations/{created.json()['invitation_id']}/resend", headers=chairman
    )
    await drain(client)
    assert len(smtp_server.messages) == 2  # the first e-mail and the resend
    await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("third"), "apartment_number": "21"},
        headers=chairman,
    )
    await drain(client)
    assert len(smtp_server.messages) == 2  # the hour's two e-mails are used up


async def test_a_send_that_hangs_is_cut_off_and_tried_again(
    client: AsyncClient,
    world: World,
    db_session: AsyncSession,
    mail_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("hang"), "apartment_number": "2"},
        headers=as_(world, world.chairman),
    )

    async def hang(*args: object, **kwargs: object) -> bool:
        await asyncio.sleep(3600)
        return True

    monkeypatch.setattr(queue_module, "send_auth_email", hang)
    monkeypatch.setattr(queue_module, "INVITATION_SEND_TIMEOUT", timedelta(milliseconds=50))
    await drain(client)
    row = await row_of(db_session, created.json()["invitation_id"])
    assert row.send_attempts == 1 and row.send_due_at is not None


async def test_concurrent_wake_ups_run_one_drain(
    client: AsyncClient, world: World, mail_settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    app = client._transport.app  # type: ignore[attr-defined]
    running = 0
    most = 0
    calls = 0

    async def fake_drain(*args: object) -> None:
        nonlocal running, most, calls
        calls += 1
        running += 1
        most = max(most, running)
        await asyncio.sleep(0.05)
        running -= 1

    monkeypatch.setattr(queue_module, "drain_queue", fake_drain)
    queue = InvitationQueue(
        lambda: app.state.auth_session_factory,
        lambda: app.state.plugin_registry,
        lambda: mail_settings,
    )
    await asyncio.gather(*(queue.drain() for _ in range(5)))
    assert most == 1
    assert calls == 2  # the first drain, and once more for the wake-ups during it


async def test_the_queue_gives_up_after_eight_refusals_and_a_resend_starts_again(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
    queue_clock,
) -> None:
    chairman = as_(world, world.chairman)
    email = unique("refused")
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "21"},
        headers=chairman,
    )
    invitation_id = created.json()["invitation_id"]
    smtp_server.handler.data_reply = "554 refused"
    for failures in range(1, INVITATION_MAX_FAILED_SENDS + 1):
        await drain(client)
        row = await row_of(db_session, invitation_id)
        assert row.send_failures == failures
        queue_clock.shift(hours=4)  # past every retry delay
    assert row.send_due_at is None  # given up
    listed = (await client.get(f"{API}/invitations", headers=chairman)).json()
    mine = next(i for i in listed if i["invitation_id"] == invitation_id)
    assert (mine["status"], mine["delivery"]) == ("PENDING", "FAILED")
    overview = (await client.get(f"{API}/connections", headers=chairman)).json()
    item = next(i for i in overview["items"] if i["apartment_number"] == "21")
    assert (item["status"], item["invitation_delivery"]) == ("INVITED", "FAILED")
    await drain(client)
    assert (await row_of(db_session, invitation_id)).send_failures == INVITATION_MAX_FAILED_SENDS

    smtp_server.handler.data_reply = None
    resent = await client.post(f"{API}/invitations/{invitation_id}/resend", headers=chairman)
    assert resent.json()["delivery"] == "QUEUED"
    await drain(client)
    row = await row_of(db_session, invitation_id)
    assert (row.send_due_at, row.send_failures) == (None, 0)
    assert len(links_sent(smtp_server, email)) == 1


async def test_without_an_e_mail_plugin_nothing_counts_toward_giving_up(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    created = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("noplugin"), "apartment_number": "2"},
        headers=as_(world, world.chairman),
    )
    app = client._transport.app  # type: ignore[attr-defined]
    original = app.state.plugin_registry.channel
    app.state.plugin_registry.channel = lambda name: None if name == "email" else original(name)
    try:
        before = datetime.now(UTC)
        await drain_queue(app.state.auth_session_factory, app.state.plugin_registry, mail_settings)
    finally:
        app.state.plugin_registry.channel = original
    row = await row_of(db_session, created.json()["invitation_id"])
    assert row.send_failures == 0 and row.send_due_at is not None
    assert row.send_due_at >= before + timedelta(minutes=59)


@pytest.mark.parametrize(
    "email",
    [
        "two@@example.com",
        "a@.com",
        "a@example.",
        'a@b.ee"',
        "a@b",
        "a..b@example.com",
        ".a@example.com",
        "a@-x.ee",
        "a@x_y.ee",
        "a@x.e",
        "a,b@example.com",
    ],
)
async def test_an_e_mail_needs_a_basic_shape(client: AsyncClient, world: World, email: str) -> None:
    single = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "2"},
        headers=as_(world, world.chairman),
    )
    assert single.status_code == 422
    report = (await preview(client, as_(world, world.chairman), f"2;{email}\n")).json()
    assert report["rows"][0]["outcome"] == "INVALID_EMAIL"


@pytest.mark.parametrize(
    "email", ["mari.tamm+kyu@example.ee", "jüri@näide.ee", "o'brien@example.co.uk"]
)
async def test_ordinary_e_mails_keep_working(client: AsyncClient, world: World, email: str) -> None:
    report = (await preview(client, as_(world, world.chairman), f"2;{email}\n")).json()
    assert report["rows"][0]["outcome"] == "READY"
