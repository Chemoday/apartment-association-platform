# The fixtures of tests/auth/test_invitations.py and test_bulk_invitations.py are imported by name;
# using them as parameters is what pytest expects, so F811 does not apply to this file.
# ruff: noqa: F811
"""QA pass over epic E13 R4a (docs/API.md section 7: "The language of an invitation", "The
invitation queue", "Bulk invitations of owners", "resend-expired"): edge cases of the bulk list,
the building limit and its Retry-After, the queue's pacing, retries and races with a resend or a
delete, the language of each e-mail, and privacy.

The building of `world` has three apartments (14, 2, 21): its bulk limit is 6 per 24 hours and a
list may hold at most 6 rows.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from src.core.config import Settings, get_settings
from src.modules.auth.bulk import parse_bulk_list
from src.modules.auth.invitations import InvitationService
from src.modules.auth.models import AuthAttempt, AuthInvitation
from src.modules.auth.policies import invitation_retry_delay, mask_email
from src.modules.auth.schemas import AttemptKind, BulkRowOutcome
from src.modules.property.models import User
from src.modules.property.schemas import BuildingRole
from tests.auth.test_bulk_invitations import (  # noqa: F401 (fixtures used by name)
    claim_one,
    preview,
    queue_clock,
    row_of,
    send,
    subject,
    subjects_to,
)
from tests.auth.test_invitation_races import (  # noqa: F401 (fixtures used by name)
    caller,
    engine,
    outcome,
    unit,
)
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
    sign_in,
    unique,
    world,
)
from tests.factories import create_apartment, create_building, create_user
from tests.smtp_server import SmtpServer

OFFERED = frozenset({"et", "en"})
MB = 1024 * 1024


def outcomes(body: dict) -> list[str]:
    return [row["outcome"] for row in body["rows"]]


async def invitation_count(session: AsyncSession) -> int:
    return int(await session.scalar(select(func.count(AuthInvitation.id))) or 0)


async def move_bulk_attempts(session: AsyncSession, since: datetime, to: datetime) -> None:
    """Move the building-limit records made at or after `since` to `to` (as time passing would)."""
    await session.execute(
        update(AuthAttempt)
        .where(
            AuthAttempt.kind == AttemptKind.BULK_INVITATION,
            AuthAttempt.attempted_at >= since,
        )
        .values(attempted_at=to)
    )


async def single(client: AsyncClient, headers: dict[str, str], **body: object):
    return await client.post(f"{API}/invitations", json=body, headers=headers)


# --- Reading the list (pure) ---------------------------------------------------------------------


def test_each_line_picks_its_own_separator_in_one_list() -> None:
    """`;` when the line has one, else a tab, else `,`: per line, so one list may mix them, and a
    tab line that also holds a `;` is split at the `;`."""
    text = "14;a@example.com\n2\tb@example.com\n21,c@example.com\n2\tc@example.com;en\n"
    rows = parse_bulk_list(text, max_rows=6, offered_locales=OFFERED)
    assert [(r.line, r.apartment_number, r.email, r.outcome) for r in rows] == [
        (1, "14", "a@example.com", None),
        (2, "2", "b@example.com", None),
        (3, "21", "c@example.com", None),
        (4, "2\tc@example.com", "en", BulkRowOutcome.INVALID_EMAIL),
    ]


def test_crlf_line_ends_and_a_bom_keep_the_line_numbers() -> None:
    text = "﻿Apartment;E-mail\r\n14;a@example.com\r\n\r\n# note\r\n2;b@example.com\r\n"
    rows = parse_bulk_list(text, max_rows=6, offered_locales=OFFERED)
    assert [(r.line, r.apartment_number, r.email) for r in rows] == [
        (2, "14", "a@example.com"),
        (5, "2", "b@example.com"),
    ]


@pytest.mark.parametrize(
    "header",
    [
        "apartment,email",
        "Korter\tE-mail\tKeel",
        "Apt; Mail address ; Lang",
        "APARTMENT;EMAIL;LANGUAGE;;",
    ],
)
def test_a_first_line_naming_the_columns_is_skipped_in_any_spelling(header: str) -> None:
    rows = parse_bulk_list(f"{header}\n14;a@example.com\n", max_rows=6, offered_locales=OFFERED)
    assert [(r.line, r.email, r.outcome) for r in rows] == [(2, "a@example.com", None)]


def test_only_the_first_line_can_be_a_header() -> None:
    text = "14;a@example.com\nApartment;E-mail\n"
    rows = parse_bulk_list(text, max_rows=6, offered_locales=OFFERED)
    assert [(r.line, r.outcome) for r in rows] == [(1, None), (2, BulkRowOutcome.INVALID_EMAIL)]


def test_a_first_line_without_mail_in_its_second_cell_is_a_row() -> None:
    rows = parse_bulk_list("Apartment;Language\n", max_rows=6, offered_locales=OFFERED)
    assert [(r.line, r.outcome) for r in rows] == [(1, BulkRowOutcome.INVALID_EMAIL)]


def test_spaces_and_empty_cells_at_the_end_are_ignored_but_a_gap_in_between_is_not() -> None:
    text = "  14 ;  a@example.com  ; EN ; ;\n14;b@example.com;;en\n14;;\n ; \n"
    rows = parse_bulk_list(text, max_rows=6, offered_locales=OFFERED)
    assert [(r.apartment_number, r.email, r.locale, r.outcome) for r in rows] == [
        ("14", "a@example.com", "en", None),
        # Four cells: the fourth is the kind (epic E14), and "en" is none.
        ("14", "b@example.com", None, BulkRowOutcome.INVALID_KIND),
        ("14", None, None, BulkRowOutcome.INVALID_ROW),
        (None, None, None, BulkRowOutcome.INVALID_ROW),
    ]


def test_the_row_cap_counts_rows_not_headers_comments_or_empty_lines() -> None:
    rows_text = "".join(f"{n};r{n}@example.com\n" for n in range(6))
    text = "Apartment;E-mail\n# one\n\n" + rows_text + "\n# two\n"
    assert len(parse_bulk_list(text, max_rows=6, offered_locales=OFFERED)) == 6


# --- Reading the list (through the API) ----------------------------------------------------------


async def test_empty_lines_at_the_start_keep_the_line_numbers(
    client: AsyncClient, world: World
) -> None:
    body = (await preview(client, as_(world, world.chairman), "\n\n14;a@example.com\n")).json()
    assert [row["line"] for row in body["rows"]] == [3]


async def test_the_case_and_the_unicode_form_of_an_e_mail_make_a_duplicate(
    client: AsyncClient, world: World
) -> None:
    tag = uuid.uuid4().hex[:8]
    text = (
        f"14;Mari.{tag}@Example.com\n"
        f"14;mari.{tag}@example.COM\n"
        f"14;ｍari.{tag}@example.com\n"  # a full-width "m": NFKC makes it "m"
        f"2;MARI.{tag}@example.com\n"  # another apartment: not a duplicate
        f"14;Mäger.{tag}@Näide.ee\n"
    )
    body = (await preview(client, as_(world, world.chairman), text)).json()
    assert outcomes(body) == ["READY", "DUPLICATE_IN_LIST", "DUPLICATE_IN_LIST", "READY", "READY"]
    assert [row["email"] for row in body["rows"]] == [f"mari.{tag}@example.com"] * 4 + [
        f"mäger.{tag}@näide.ee"
    ]
    assert body["counts"] == {"READY": 3, "DUPLICATE_IN_LIST": 2}


async def test_outcomes_follow_the_documented_order(client: AsyncClient, world: World) -> None:
    text = (
        "99;not-an-address;xx\n"  # bad e-mail, bad language, unknown apartment: INVALID_EMAIL
        "99;a@example.com;xx\n"  # bad language, unknown apartment: INVALID_LOCALE
        "99;a@example.com\n"
        "014;a@example.com\n"  # the number must match exactly
        "99;a@example.com;en;extra\n"  # a fourth cell that is not a kind
        "14;a@nodot\n"
    )
    body = (await preview(client, as_(world, world.chairman), text)).json()
    assert outcomes(body) == [
        "INVALID_EMAIL",
        "INVALID_LOCALE",
        "APARTMENT_NOT_FOUND",
        "APARTMENT_NOT_FOUND",
        "INVALID_KIND",
        "INVALID_EMAIL",
    ]
    assert [row["locale"] for row in body["rows"][:2]] == ["xx", "xx"]


async def test_a_quoted_spreadsheet_row_is_never_invited_silently(
    client: AsyncClient, world: World
) -> None:
    body = (await preview(client, as_(world, world.chairman), '"14";"q@example.com"\n')).json()
    assert body["rows"][0]["outcome"] != "READY"


async def test_very_long_cells_are_reported_as_typed(client: AsyncClient, world: World) -> None:
    long_email = "a" * 400 + "@example.com"
    long_number = "9" * 300
    text = f"14;{long_email}\n{long_number};b@example.com\n"
    body = (await preview(client, as_(world, world.chairman), text)).json()
    assert [(r["apartment_number"], r["email"], r["outcome"]) for r in body["rows"]] == [
        ("14", long_email, "INVALID_EMAIL"),
        (long_number, "b@example.com", "APARTMENT_NOT_FOUND"),
    ]


async def test_the_size_limit_is_one_megabyte_of_utf8_not_of_characters(
    client: AsyncClient, world: World
) -> None:
    chairman = as_(world, world.chairman)
    exactly = await preview(client, chairman, "#" * MB)
    assert (exactly.status_code, exactly.json()["rows"]) == (200, [])
    one_more = await preview(client, chairman, "#" * (MB + 1))
    assert (one_more.status_code, one_more.json()["error_code"]) == (422, "BULK_LIST_TOO_LONG")
    wide = await preview(client, chairman, "#" + "é" * (MB // 2))  # 1 MB + 1 byte
    assert (wide.status_code, wide.json()["error_code"]) == (422, "BULK_LIST_TOO_LONG")


async def test_a_huge_text_or_a_control_character_is_a_validation_error(
    client: AsyncClient, world: World
) -> None:
    chairman = as_(world, world.chairman)
    huge = await preview(client, chairman, "#" * (4 * MB + 1))
    assert (huge.status_code, huge.json()["error_code"]) == (422, "VALIDATION_ERROR")
    for control in ("\x00", "\x07", "\x1b"):
        refused = await send(client, chairman, f"14;a{control}@example.com\n")
        assert (refused.status_code, refused.json()["error_code"]) == (422, "VALIDATION_ERROR")


async def test_six_rows_with_a_header_and_comments_fit_three_apartments(
    client: AsyncClient, world: World
) -> None:
    rows_text = "".join(f"{n};{unique('cap')}\n" for n in ("14", "2", "21", "14", "2", "21"))
    text = "﻿Apartment;E-mail\r\n# first\r\n\r\n" + rows_text.replace("\n", "\r\n")
    response = await preview(client, as_(world, world.chairman), text)
    assert response.status_code == 200, response.text
    assert [row["line"] for row in response.json()["rows"]] == [4, 5, 6, 7, 8, 9]


# --- Outcomes that need the database -------------------------------------------------------------


async def test_only_a_pending_owner_invitation_of_that_apartment_makes_a_row_already_pending(
    client: AsyncClient, world: World
) -> None:
    chairman = as_(world, world.chairman)
    owner_elsewhere, tenant = unique("x"), unique("y")
    made = await single(client, chairman, kind="OWNER", email=owner_elsewhere, apartment_number="2")
    assert made.status_code == 201
    tenant_made = await single(
        client,
        as_(world, world.owner_14),
        kind="TENANT",
        email=tenant,
        apartment_id=str(world.apt_14.id),
    )
    assert tenant_made.status_code == 201
    staff = await single(client, chairman, kind="STAFF", email=tenant, building_role="BOARD")
    assert staff.status_code == 201
    text = f"14;{owner_elsewhere}\n14;{tenant}\n2;{owner_elsewhere}\n2;{owner_elsewhere}\n"
    body = (await preview(client, chairman, text)).json()
    assert outcomes(body) == ["READY", "READY", "ALREADY_PENDING", "DUPLICATE_IN_LIST"]


async def test_a_member_of_the_apartment_is_ready_like_anyone(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    """There is no outcome "already a member": the report never tells whether an e-mail has an
    account."""
    chairman = as_(world, world.chairman)
    member = world.owner_14.email
    stranger = unique("stranger")
    body = (await preview(client, chairman, f"14;{member}\n14;{stranger}\n")).json()
    assert outcomes(body) == ["READY", "READY"]
    sent = (await send(client, chairman, f"14;{member}\n14;{stranger}\n")).json()
    assert outcomes(sent) == ["INVITED", "INVITED"]
    assert sent["counts"] == {"INVITED": 2}


async def test_sending_the_same_list_twice_invites_once_and_counts_once(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    text = f"14;{unique('t')}\n2;{unique('t')}\n"
    first = (await send(client, chairman, text)).json()
    assert (outcomes(first), first["limit_remaining"]) == (["INVITED", "INVITED"], 4)
    second = await send(client, chairman, text)
    assert second.status_code == 200
    assert outcomes(second.json()) == ["ALREADY_PENDING", "ALREADY_PENDING"]
    assert second.json()["limit_remaining"] == 4  # skipped rows do not count
    assert await invitation_count(db_session) == 2


async def test_the_send_answers_with_the_cells_and_the_invitations_carry_them(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    email = unique("Cells").replace("Cells", "CELLS")
    body = (await send(client, as_(world, world.chairman), f" 21 ; {email} ; En \n")).json()
    assert body["rows"] == [
        {
            "line": 1,
            "apartment_number": "21",
            "apartment_kind": "APARTMENT",
            "email": email.lower(),
            "locale": "en",
            "outcome": "INVITED",
        }
    ]
    stored = await db_session.scalar(
        select(AuthInvitation).where(AuthInvitation.email == email.lower())
    )
    assert stored is not None
    assert (stored.kind, stored.apartment_id, stored.locale) == ("OWNER", world.apt_21.id, "en")
    assert stored.invited_by_user_id == world.chairman.id


# --- The building limit --------------------------------------------------------------------------


async def test_a_send_without_ready_rows_passes_when_the_limit_is_used_up(
    client: AsyncClient, world: World
) -> None:
    chairman = as_(world, world.chairman)
    filler = "".join(f"{n};{unique('f')}\n" for n in ("14", "2", "21", "14", "2", "21"))
    assert (await send(client, chairman, filler)).json()["limit_remaining"] == 0
    response = await send(client, chairman, f"99;{unique('x')}\n14;not-an-e-mail\n")
    assert response.status_code == 200, response.text
    assert outcomes(response.json()) == ["APARTMENT_NOT_FOUND", "INVALID_EMAIL"]
    assert response.json()["limit_remaining"] == 0


async def test_retry_after_is_when_enough_counted_invitations_have_aged_out(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    start = datetime.now(UTC) - timedelta(minutes=1)
    assert (await send(client, chairman, f"14;{unique('a')}\n")).status_code == 200
    await move_bulk_attempts(db_session, start, datetime.now(UTC) - timedelta(hours=20))
    batch = "".join(f"{n};{unique('b')}\n" for n in ("14", "2", "21"))
    assert (await send(client, chairman, batch)).json()["limit_remaining"] == 2
    await move_bulk_attempts(db_session, start, datetime.now(UTC) - timedelta(hours=10))
    # used: one 20 hours ago, three 10 hours ago; two still free.
    three = "".join(f"{n};{unique('c')}\n" for n in ("14", "2", "21"))
    refused = await send(client, chairman, three)
    assert (refused.status_code, refused.json()["error_code"]) == (429, "RATE_LIMITED")
    assert abs(int(refused.headers["Retry-After"]) - 4 * 3600) < 120  # the oldest one frees one
    four = "".join(f"{n};{unique('d')}\n" for n in ("14", "2", "21", "14"))
    refused = await send(client, chairman, four)
    assert refused.status_code == 429
    assert abs(int(refused.headers["Retry-After"]) - 14 * 3600) < 120  # two must age out
    assert await invitation_count(db_session) == 4  # all or nothing
    assert (await preview(client, chairman, four)).json()["limit_remaining"] == 2


async def test_the_building_limit_counts_only_the_last_24_hours(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    start = datetime.now(UTC) - timedelta(minutes=1)
    filler = "".join(f"{n};{unique('f')}\n" for n in ("14", "2", "21", "14", "2", "21"))
    assert (await send(client, chairman, filler)).json()["limit_remaining"] == 0
    await move_bulk_attempts(db_session, start, datetime.now(UTC) - timedelta(hours=23, minutes=50))
    assert (await preview(client, chairman, "")).json()["limit_remaining"] == 0
    await move_bulk_attempts(
        db_session,
        datetime.now(UTC) - timedelta(hours=24),
        datetime.now(UTC) - timedelta(hours=24, minutes=1),
    )
    assert (await preview(client, chairman, "")).json()["limit_remaining"] == 6


async def test_resend_expired_waits_until_the_oldest_counted_invitation_ages_out(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    start = datetime.now(UTC) - timedelta(minutes=1)
    filler = "".join(f"{n};{unique('f')}\n" for n in ("14", "2", "21", "14", "2", "21"))
    assert (await send(client, chairman, filler)).json()["limit_remaining"] == 0
    await move_bulk_attempts(db_session, start, datetime.now(UTC) - timedelta(hours=20))
    old = await single(client, chairman, kind="STAFF", email=unique("s"), building_role="BOARD")
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == uuid.UUID(old.json()["invitation_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(hours=1))
    )
    refused = await client.post(f"{API}/invitations/resend-expired", headers=chairman)
    assert (refused.status_code, refused.json()["error_code"]) == (429, "RATE_LIMITED")
    assert abs(int(refused.headers["Retry-After"]) - 4 * 3600) < 120


async def test_resend_expired_in_a_building_without_apartments(
    client: AsyncClient, db_session: AsyncSession, mail_settings: Settings
) -> None:
    """A limit of 0: nothing expired is a plain 200; an expired STAFF invitation gets 429 with
    Retry-After 86400."""
    building = await create_building(db_session, name="Empty house")
    chairman = await create_user(
        db_session, building, "Lone Chair", role=BuildingRole.CHAIRMAN, email=unique("lone")
    )
    headers = await sign_in(db_session, mail_settings, chairman)
    nothing = await client.post(f"{API}/invitations/resend-expired", headers=headers)
    assert (nothing.status_code, nothing.json()) == (200, {"queued": 0, "left": 0})
    made = await single(client, headers, kind="STAFF", email=unique("acc"), building_role="BOARD")
    assert made.status_code == 201, made.text
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == uuid.UUID(made.json()["invitation_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(hours=1))
    )
    refused = await client.post(f"{API}/invitations/resend-expired", headers=headers)
    assert (refused.status_code, refused.json()["error_code"]) == (429, "RATE_LIMITED")
    assert refused.headers["Retry-After"] == "86400"
    one = await client.post(
        f"{API}/invitations/{made.json()['invitation_id']}/resend", headers=headers
    )
    assert one.status_code == 200 and one.json()["status"] == "PENDING"  # one by one still works


async def test_resend_expired_starts_the_week_again_and_queues_the_e_mail(
    client: AsyncClient, world: World, db_session: AsyncSession, smtp_server: SmtpServer
) -> None:
    chairman = as_(world, world.chairman)
    email = unique("again")
    made = await single(client, chairman, kind="OWNER", email=email, apartment_number="21")
    await drain(client)
    await db_session.execute(
        update(AuthInvitation).values(expires_at=datetime.now(UTC) - timedelta(hours=1))
    )
    response = await client.post(f"{API}/invitations/resend-expired", headers=chairman)
    assert response.json() == {"queued": 1, "left": 0}
    listed = (await client.get(f"{API}/invitations", headers=chairman)).json()
    mine = next(i for i in listed if i["invitation_id"] == made.json()["invitation_id"])
    assert (mine["status"], mine["delivery"]) == ("PENDING", "QUEUED")
    await drain(client)
    row = await row_of(db_session, made.json()["invitation_id"])
    assert row.send_due_at is None and row.expires_at > datetime.now(UTC) + timedelta(days=6)
    assert len(links_sent(smtp_server, email)) == 2


async def test_two_bulk_sends_at_once_never_pass_the_building_limit_together(
    engine: AsyncEngine,
) -> None:
    """Two chairmen (or two tabs) send lists at the same time; each fits alone, both do not."""
    settings = get_settings()
    async with unit(engine) as session:
        building = await create_building(session)
        chairman = await create_user(session, building, "Chair", role=BuildingRole.CHAIRMAN)
        for number in ("1", "2"):
            await create_apartment(session, building, number)  # a limit of 4

    async def bulk(session: AsyncSession) -> None:
        text = "".join(f"{n};{unique('race')}\n" for n in ("1", "2", "1"))
        await InvitationService(session, settings).bulk(
            await caller(session, chairman.id), text, send=True
        )

    results = await asyncio.gather(outcome(engine, bulk), outcome(engine, bulk))
    assert sorted(results) == ["RATE_LIMITED", "ok"]
    async with unit(engine) as session:
        count = await session.scalar(
            select(func.count(AuthInvitation.id)).where(AuthInvitation.building_id == building.id)
        )
    assert count == 3


# --- Who sees the e-mails of a bulk send ---------------------------------------------------------


async def test_bulk_invitations_are_masked_to_another_chairman(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    other = await create_user(
        db_session, world.building, "Second Chair", role=BuildingRole.CHAIRMAN, email=unique("c2")
    )
    other_headers = await sign_in(db_session, mail_settings, other)
    email = unique("typed")
    await send(client, as_(world, world.chairman), f"2;{email}\n")
    mine = (await client.get(f"{API}/invitations", headers=as_(world, world.chairman))).json()
    theirs = (await client.get(f"{API}/invitations", headers=other_headers)).json()
    assert [(i["email"], i["mine"]) for i in mine] == [(email, True)]
    assert [(i["email"], i["mine"]) for i in theirs] == [(mask_email(email), False)]
    assert email not in str(theirs)


# --- The queue -----------------------------------------------------------------------------------


async def test_the_pacing_allows_exactly_the_hourly_number_in_any_hour(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
    mail_settings: Settings,
) -> None:
    mail_settings.AUTH_INVITATION_MAILS_PER_HOUR = 3
    chairman = as_(world, world.chairman)
    text = "".join(f"{n};{unique('p')}\n" for n in ("14", "2", "21"))
    assert (await send(client, chairman, text)).status_code == 200
    await drain(client)
    assert len(smtp_server.messages) == 3  # exactly the limit
    await single(client, chairman, kind="OWNER", email=unique("fourth"), apartment_number="2")
    await drain(client)
    assert len(smtp_server.messages) == 3

    async def age_sent_mails(minutes: int) -> None:
        await db_session.execute(
            update(AuthAttempt)
            .where(AuthAttempt.kind == AttemptKind.INVITATION_MAIL)
            .values(attempted_at=datetime.now(UTC) - timedelta(minutes=minutes))
        )

    await age_sent_mails(59)
    await drain(client)
    assert len(smtp_server.messages) == 3  # still within the hour
    await age_sent_mails(61)
    await drain(client)
    assert len(smtp_server.messages) == 4


async def test_failed_sends_follow_the_retry_schedule_until_the_invitation_expires(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
    queue_clock,
) -> None:
    """1, 5, 15 and 60 minutes, then every 3 hours, until the invitation expires."""
    chairman = as_(world, world.chairman)
    made = await single(client, chairman, kind="OWNER", email=unique("fail"), apartment_number="2")
    invitation_id = made.json()["invitation_id"]
    smtp_server.handler.data_reply = "554 refused"
    await drain(client)
    expected = [timedelta(minutes=m) for m in (1, 5, 15, 60)] + [timedelta(hours=3)] * 2
    for attempt, delay in enumerate(expected, start=1):
        row = await row_of(db_session, invitation_id)
        assert row.send_attempts == attempt
        assert row.send_due_at == queue_clock.now + delay
        assert invitation_retry_delay(attempt) == delay
        queue_clock.shift(seconds=delay.total_seconds() - 1)
        await drain(client)
        assert (await row_of(db_session, invitation_id)).send_attempts == attempt  # not yet
        queue_clock.shift(seconds=1)
        await drain(client)
    assert smtp_server.messages == []
    listed = (await client.get(f"{API}/invitations", headers=chairman)).json()
    assert (listed[0]["status"], listed[0]["delivery"]) == ("PENDING", "QUEUED")
    queue_clock.shift(days=7)
    tried = (await row_of(db_session, invitation_id)).send_attempts
    await drain(client)
    assert (await row_of(db_session, invitation_id)).send_attempts == tried  # left the queue
    listed = (await client.get(f"{API}/invitations", headers=chairman)).json()
    assert (listed[0]["status"], listed[0]["delivery"]) == ("EXPIRED", "QUEUED")


async def test_an_invitation_deleted_while_its_e_mail_is_out(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
    mail_settings: Settings,
) -> None:
    chairman = as_(world, world.chairman)
    email = unique("deleted")
    made = await single(client, chairman, kind="OWNER", email=email, apartment_number="2")
    invitation_id = made.json()["invitation_id"]
    claimed = await claim_one(db_session, mail_settings, invitation_id)
    deleted = await client.delete(f"{API}/invitations/{invitation_id}", headers=chairman)
    assert deleted.status_code == 204
    service = InvitationService(db_session, mail_settings)
    assert await service.record_send(claimed, outcome="sent", now=datetime.now(UTC)) is False
    token = claimed.mail.link.rpartition("#")[2]
    refused = await redeem(client, token)
    assert (refused.status_code, refused.json()["error_code"]) == (400, "INVALID_LINK")
    await drain(client)
    assert links_sent(smtp_server, email) == []
    assert await db_session.get(AuthInvitation, uuid.UUID(invitation_id)) is None


async def test_a_resend_while_the_e_mail_is_out_voids_its_link_and_sends_a_new_one(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
    mail_settings: Settings,
) -> None:
    chairman = as_(world, world.chairman)
    email = unique("during")
    made = await single(client, chairman, kind="OWNER", email=email, apartment_number="2")
    invitation_id = made.json()["invitation_id"]
    claimed = await claim_one(db_session, mail_settings, invitation_id)
    resent = await client.post(f"{API}/invitations/{invitation_id}/resend", headers=chairman)
    assert (resent.status_code, resent.json()["delivery"]) == (200, "QUEUED")
    old_token = claimed.mail.link.rpartition("#")[2]
    assert (await redeem(client, old_token)).json()["error_code"] == "INVALID_LINK"
    service = InvitationService(db_session, mail_settings)
    assert await service.record_send(claimed, outcome="sent", now=datetime.now(UTC)) is False
    row = await row_of(db_session, invitation_id)
    assert row.send_due_at is not None  # still queued for the resend
    await drain(client)
    [new_token] = links_sent(smtp_server, email)
    assert new_token != old_token
    assert (await redeem(client, new_token)).status_code == 200


# --- The language of each e-mail -----------------------------------------------------------------


async def test_without_any_language_the_e_mail_is_in_the_instance_default(
    client: AsyncClient, world: World, smtp_server: SmtpServer, mail_settings: Settings
) -> None:
    email = unique("plain")
    made = await single(
        client, as_(world, world.chairman), kind="OWNER", email=email, apartment_number="2"
    )
    assert made.json()["locale"] is None
    await drain(client)
    assert subjects_to(smtp_server, email) == [subject(mail_settings.DEFAULT_LOCALE)]


async def test_an_account_without_its_own_language_gets_the_invitations_language(
    client: AsyncClient, world: World, smtp_server: SmtpServer, db_session: AsyncSession
) -> None:
    email = unique("nolocale")
    await create_user(db_session, world.building, "No Locale", email=email)  # locale null
    await single(
        client,
        as_(world, world.chairman),
        kind="OWNER",
        email=email,
        apartment_number="2",
        locale="en",
    )
    await drain(client)
    assert subjects_to(smtp_server, email) == [subject("en")]


async def test_the_account_language_is_read_when_the_e_mail_goes_out(
    client: AsyncClient, world: World, smtp_server: SmtpServer, db_session: AsyncSession
) -> None:
    email = unique("later")
    await single(
        client,
        as_(world, world.chairman),
        kind="OWNER",
        email=email,
        apartment_number="2",
        locale="en",
    )
    person = await create_user(db_session, world.building, "Late Account", email=email)
    await db_session.execute(update(User).where(User.id == person.id).values(locale="ru"))
    await drain(client)
    assert subjects_to(smtp_server, email) == [subject("ru")]


async def test_a_resend_keeps_the_language_of_the_invitation(
    client: AsyncClient, world: World, smtp_server: SmtpServer
) -> None:
    chairman = as_(world, world.chairman)
    email = unique("keep")
    made = await single(
        client, chairman, kind="OWNER", email=email, apartment_number="21", locale="en"
    )
    await drain(client)
    resent = await client.post(
        f"{API}/invitations/{made.json()['invitation_id']}/resend", headers=chairman
    )
    assert resent.json()["locale"] == "en"
    await drain(client)
    assert subjects_to(smtp_server, email) == [subject("en"), subject("en")]


async def test_a_bulk_row_language_in_capitals_and_a_row_without_one(
    client: AsyncClient, world: World, smtp_server: SmtpServer, mail_settings: Settings
) -> None:
    english, plain = unique("bulk-en"), unique("bulk-plain")
    body = (await send(client, as_(world, world.chairman), f"2;{english};EN\n21;{plain}\n")).json()
    assert [row["locale"] for row in body["rows"]] == ["en", None]
    await drain(client)
    assert subjects_to(smtp_server, english) == [subject("en")]
    assert subjects_to(smtp_server, plain) == [subject(mail_settings.DEFAULT_LOCALE)]


async def test_a_language_that_is_not_offered_in_a_bulk_row_invites_nothing(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    other = "ru" if mail_settings.DEFAULT_LOCALE != "ru" else "et"
    body = (await send(client, as_(world, world.chairman), f"2;{unique('r')};{other}\n")).json()
    assert outcomes(body) == ["INVALID_LOCALE"]
    assert await invitation_count(db_session) == 0


# --- Privacy -------------------------------------------------------------------------------------


async def test_bulk_lists_and_queue_runs_log_no_address_or_link(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
    log_capture,
    span_exporter,
) -> None:
    chairman = as_(world, world.chairman)
    emails = [unique("quiet-one"), unique("quiet-two")]
    text = f"2;{emails[0]}\n21;{emails[1]}\n14;bad-cell-value\n"
    await preview(client, chairman, text)
    await send(client, chairman, text)
    smtp_server.handler.data_reply = "554 refused"
    await drain(client)  # two failed sends are logged
    smtp_server.handler.data_reply = None
    await db_session.execute(update(AuthInvitation).values(send_due_at=datetime.now(UTC)))
    await drain(client)
    tokens = [token for email in emails for token in links_sent(smtp_server, email)]
    assert len(tokens) == 2
    raw = log_capture.raw
    assert "auth_invitation_not_sent" in raw and "auth_invitation_sent" in raw  # capture works
    exported = " ".join(
        f"{span.name} {dict(span.attributes or {})}" for span in span_exporter.get_finished_spans()
    )
    for secret in [*emails, *tokens, "bad-cell-value"]:
        assert secret not in raw
        assert secret not in exported


async def test_a_raised_domain_error_of_a_bulk_send_carries_no_row(
    client: AsyncClient, world: World
) -> None:
    """The 429 of an over-limit send says nothing about the rows (they are the chairman's list)."""
    chairman = as_(world, world.chairman)
    filler = "".join(f"{n};{unique('f')}\n" for n in ("14", "2", "21", "14", "2", "21"))
    await send(client, chairman, filler)
    email = unique("over")
    refused = await send(client, chairman, f"2;{email}\n")
    assert refused.status_code == 429
    assert email not in refused.text
