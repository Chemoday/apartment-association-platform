# The fixtures of tests/auth/test_invitations.py are imported by name; using them as parameters
# is what pytest expects, so F811 does not apply to this file.
# ruff: noqa: F811
"""QA pass over epic E13 R4c, join codes on paper (docs/API.md section 7, "Join codes on paper";
section 6 JOIN_REQUEST_SUBMITTED; section 9 the URL setting): code normalisation and expiry,
cancelling, the default issue, confirming in the corner cases (a lost role, an owner's e-mail,
another chairman's or an expired invitation, another building), the decision list, the clean-up,
the address limit, the privacy notice setting, privacy of logs and spans, and two races.

`world` has apartments 14 (owned by Ivan Petrov), 2 and 21; its bulk limit is 6 per 24 hours.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import SecretStr
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from src.core.config import Settings, get_settings
from src.modules.auth import join as join_module
from src.modules.auth.join import JoinService, delete_old_join_rows
from src.modules.auth.models import (
    AuthAttempt,
    AuthInvitation,
    AuthJoinCode,
    AuthJoinDecision,
    AuthJoinRequest,
)
from src.modules.auth.policies import mask_email
from src.modules.auth.schemas import AttemptKind, JoinSubmit
from src.modules.notifications.models import Delivery
from src.modules.property.models import User
from src.modules.property.schemas import BuildingRole, RelationType
from tests.auth.test_bulk_invitations import preview, subject, subjects_to
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
    sign_in,
    unique,
    world,
)
from tests.auth.test_join_codes import issue, person, statuses, submit, waiting
from tests.factories import create_apartment, create_building, create_membership, create_user
from tests.smtp_server import SmtpServer

SETTINGS = "/api/v1/settings"
NOTICE_KEY = "auth.privacy_notice_url"
CODE_FIELDS = {
    "code_id",
    "apartment_id",
    "apartment_number",
    "apartment_kind",
    "created_at",
    "expires_at",
}
REQUEST_FIELDS = {
    "request_id",
    "apartment_id",
    "apartment_number",
    "apartment_kind",
    "full_name",
    "phone",
    "email",
    "locale",
    "created_at",
}
DECISION_FIELDS = {
    "apartment_id",
    "apartment_number",
    "apartment_kind",
    "outcome",
    "decided_by_user_id",
    "decided_at",
}


async def lookup(client: AsyncClient, code: str):
    return await client.post(f"{API}/join/lookup", json={"join_code": code})


async def one_request(
    client: AsyncClient, world: World, apartment_id: uuid.UUID, email: str | None = None, **fields
) -> dict:
    """Issue a code for the apartment, submit a request with it and return the waiting request."""
    code = (await issue(client, world, [apartment_id]))["codes"][0]["join_code"]
    response = await submit(client, code, email or unique("joiner"), **fields)
    assert response.status_code == 202, response.text
    found = [r for r in await waiting(client, world) if r["apartment_id"] == str(apartment_id)]
    return found[-1]


async def confirm(client: AsyncClient, headers: dict[str, str], request_id: str):
    return await client.post(f"{API}/join-requests/{request_id}/confirm", headers=headers)


async def reject(client: AsyncClient, headers: dict[str, str], request_id: str):
    return await client.post(f"{API}/join-requests/{request_id}/reject", headers=headers)


async def second_chairman(
    session: AsyncSession, settings: Settings, world: World
) -> tuple[User, dict[str, str]]:
    other = await create_user(
        session, world.building, "Second Chair", role=BuildingRole.CHAIRMAN, email=unique("c2")
    )
    return other, await sign_in(session, settings, other)


async def board_member(
    session: AsyncSession, settings: Settings, world: World
) -> tuple[User, dict[str, str]]:
    board = await create_user(
        session, world.building, "Board Member", role=BuildingRole.BOARD, email=unique("board")
    )
    return board, await sign_in(session, settings, board)


# --- The code ------------------------------------------------------------------------------------


async def test_a_code_typed_with_look_alikes_spaces_hyphens_and_lower_case_is_found(
    client: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(join_module, "new_join_code", lambda: "10K7QFM3TX")
    issued = (await issue(client, world, [world.apt_2.id]))["codes"][0]
    assert issued["join_code"] == "10K7-QFM3-TX"
    for typed in ("10K7-QFM3-TX", "lo k7qf-m3tx", "IOK7QFM3TX", " 1 0-K7-QF M3-TX ", "10k7qfm3tx"):
        response = await lookup(client, typed)
        assert (response.status_code, response.json()["apartment_number"]) == (200, "2"), typed
    for wrong in ("10K7QFM3T", "10K7QFM3TXX", "10K7QFM3TU", "10K7QFM3T*"):
        response = await lookup(client, wrong)
        assert (response.status_code, response.json()["error_code"]) == (400, "INVALID_JOIN_CODE")
    accepted = await submit(client, "lo-k7qf-m3tx", unique("typed"))
    assert accepted.status_code == 202  # the submit normalises the same way


async def test_a_code_works_until_its_expiry_and_not_after(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    mail_settings.AUTH_JOIN_CODE_DAYS = 5
    issued = (await issue(client, world, [world.apt_2.id]))["codes"][0]
    expires = datetime.fromisoformat(issued["expires_at"])
    assert abs(expires - (datetime.now(UTC) + timedelta(days=5))) < timedelta(minutes=1)

    async def expire_in(delta: timedelta) -> None:
        await db_session.execute(
            update(AuthJoinCode)
            .where(AuthJoinCode.id == uuid.UUID(issued["code_id"]))
            .values(expires_at=datetime.now(UTC) + delta)
        )

    await expire_in(timedelta(minutes=1))
    assert (await lookup(client, issued["join_code"])).status_code == 200
    await expire_in(-timedelta(seconds=1))
    assert (await lookup(client, issued["join_code"])).json()["error_code"] == "INVALID_JOIN_CODE"
    late = await submit(client, issued["join_code"], unique("late"))
    assert late.json()["error_code"] == "INVALID_JOIN_CODE"
    assert await waiting(client, world) == []


async def test_rotating_the_hash_secret_voids_every_code(
    client: AsyncClient, world: World, mail_settings: Settings
) -> None:
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    assert (await lookup(client, code)).status_code == 200
    mail_settings.AUTH_HASH_SECRET = SecretStr("a-rotated-secret-" + "x" * 40)
    assert (await lookup(client, code)).json()["error_code"] == "INVALID_JOIN_CODE"


async def test_a_cancelled_code_cannot_be_submitted(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    issued = (await issue(client, world, [world.apt_2.id]))["codes"][0]
    cancelled = await client.delete(
        f"{API}/join-codes/{issued['code_id']}", headers=as_(world, world.chairman)
    )
    assert cancelled.status_code == 204
    response = await submit(client, issued["join_code"], unique("after-cancel"))
    assert (response.status_code, response.json()["error_code"]) == (400, "INVALID_JOIN_CODE")
    assert await db_session.scalar(select(func.count(AuthJoinRequest.id))) == 0
    assert (await statuses(client, world))["2"] == "NOT_INVITED"


async def test_cancelling_refuses_used_expired_unknown_and_foreign_codes(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    chairman = as_(world, world.chairman)
    used, expired = (await issue(client, world, [world.apt_2.id, world.apt_21.id]))["codes"]
    await submit(client, used["join_code"], unique("used"))
    await db_session.execute(
        update(AuthJoinCode)
        .where(AuthJoinCode.id == uuid.UUID(expired["code_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
    )
    other = await create_building(db_session, name="Other house")
    flat = await create_apartment(db_session, other, "1")
    other_chair = await create_user(
        db_session, other, "Other Chair", role=BuildingRole.CHAIRMAN, email=unique("oc")
    )
    other_headers = await sign_in(db_session, mail_settings, other_chair)
    foreign = await client.post(
        f"{API}/join-codes", json={"apartment_ids": [str(flat.id)]}, headers=other_headers
    )
    assert foreign.status_code == 201
    foreign_id = foreign.json()["codes"][0]["code_id"]
    for code_id in (used["code_id"], expired["code_id"], str(uuid.uuid4()), foreign_id):
        response = await client.delete(f"{API}/join-codes/{code_id}", headers=chairman)
        assert (response.status_code, response.json()["error_code"]) == (
            404,
            "JOIN_CODE_NOT_FOUND",
        )
    assert (await lookup(client, foreign.json()["codes"][0]["join_code"])).status_code == 200
    malformed = await client.delete(f"{API}/join-codes/not-a-uuid", headers=chairman)
    assert malformed.status_code == 422


# --- Issuing -------------------------------------------------------------------------------------


async def test_more_ids_than_apartments_or_one_foreign_id_issue_nothing(
    client: AsyncClient, world: World
) -> None:
    chairman = as_(world, world.chairman)
    ids = [str(a.id) for a in (world.apt_14, world.apt_2, world.apt_21)]
    too_many = await client.post(
        f"{API}/join-codes", json={"apartment_ids": [*ids, str(uuid.uuid4())]}, headers=chairman
    )
    assert (too_many.status_code, too_many.json()["error_code"]) == (422, "VALIDATION_ERROR")
    one_foreign = await client.post(
        f"{API}/join-codes", json={"apartment_ids": [ids[1], str(uuid.uuid4())]}, headers=chairman
    )
    assert (one_foreign.status_code, one_foreign.json()["error_code"]) == (
        404,
        "APARTMENT_NOT_FOUND",
    )
    assert (await client.get(f"{API}/join-codes", headers=chairman)).json() == []


async def test_the_default_issue_takes_tenant_only_paper_and_expired_apartments_too(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    building = world.building
    tenant = await create_user(db_session, building, "Tenant Two", email=unique("t"))
    await create_membership(db_session, tenant, world.apt_2, relation=RelationType.TENANT)
    await client.put(
        f"{API}/connections/{world.apt_21.id}/paper", json={"on_paper": True}, headers=chairman
    )
    numbers = ("22", "23", "24", "25", "26")
    flats = {n: await create_apartment(db_session, building, n, entrance=3) for n in numbers}
    old = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("old"), "apartment_number": "22"},
        headers=chairman,
    )
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == uuid.UUID(old.json()["invitation_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(days=1))
    )
    await one_request(client, world, flats["23"].id)
    await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("new"), "apartment_number": "24"},
        headers=chairman,
    )
    await issue(client, world, [flats["25"].id])
    before = await statuses(client, world)
    assert [before[n] for n in ("14", "2", "21", "22", "23", "24", "25", "26")] == [
        "CONNECTED",
        "TENANT_ONLY",
        "PAPER",
        "EXPIRED",
        "JOIN_REQUEST",
        "INVITED",
        "CODE_ISSUED",
        "NOT_INVITED",
    ]
    body = await issue(client, world, None)
    assert sorted(code["apartment_number"] for code in body["codes"]) == ["2", "21", "22", "26"]


async def test_issuing_again_keeps_the_other_codes_and_the_waiting_request(
    client: AsyncClient, world: World
) -> None:
    first = await one_request(client, world, world.apt_2.id)
    second, third = [(await issue(client, world, [world.apt_2.id]))["codes"][0] for _ in range(2)]
    assert [r["request_id"] for r in await waiting(client, world)] == [first["request_id"]]
    assert (await lookup(client, second["join_code"])).status_code == 200
    assert (await lookup(client, third["join_code"])).status_code == 200
    co_owner = await submit(client, second["join_code"], unique("co-owner"))
    assert co_owner.status_code == 202
    assert len(await waiting(client, world)) == 2  # one per code, the same apartment


async def test_the_code_list_has_only_usable_codes_newest_first_and_never_the_code(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    codes = (await issue(client, world, [world.apt_14.id, world.apt_2.id, world.apt_21.id]))[
        "codes"
    ]
    used, expired, kept = codes
    await submit(client, used["join_code"], unique("u"))
    await db_session.execute(
        update(AuthJoinCode)
        .where(AuthJoinCode.id == uuid.UUID(expired["code_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(seconds=1))
    )
    older = (await issue(client, world, [world.apt_21.id]))["codes"][0]
    await db_session.execute(
        update(AuthJoinCode)
        .where(AuthJoinCode.id == uuid.UUID(older["code_id"]))
        .values(created_at=datetime.now(UTC) - timedelta(days=2))
    )
    listed = (await client.get(f"{API}/join-codes", headers=chairman)).json()
    assert [item["code_id"] for item in listed] == [kept["code_id"], older["code_id"]]
    assert all(set(item) == CODE_FIELDS for item in listed)
    text = str(listed)
    assert all(c["join_code"] not in text for c in codes)


# --- The join page -------------------------------------------------------------------------------


async def test_the_request_list_is_not_cached_and_shows_what_was_typed_oldest_first(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    first = await one_request(client, world, world.apt_2.id, full_name="Mari Esimene")
    second = await one_request(
        client,
        world,
        world.apt_21.id,
        full_name="Jaan Teine",
        phone="+371 (2) 012-3456",
        locale=None,
    )
    await db_session.execute(
        update(AuthJoinRequest)
        .where(AuthJoinRequest.id == uuid.UUID(second["request_id"]))
        .values(created_at=datetime.now(UTC) - timedelta(days=1))
    )
    response = await client.get(f"{API}/join-requests", headers=as_(world, world.chairman))
    assert response.headers["cache-control"] == "no-store"
    listed = response.json()
    assert [r["request_id"] for r in listed] == [second["request_id"], first["request_id"]]
    assert all(set(r) == REQUEST_FIELDS for r in listed)
    assert (listed[0]["full_name"], listed[0]["phone"], listed[0]["locale"]) == (
        "Jaan Teine",
        "+37120123456",
        None,
    )


@pytest.mark.parametrize(
    "fields",
    [
        {"locale": "fi"},
        {"phone": "1234"},
        {"phone": "+" + "1" * 32},
        {"phone": "5555 1234"},  # no country code: the server never guesses one
        {"phone": "+372 1234"},  # not a number of Estonia
        {"phone": "+999 5555 1234"},  # no such country code
        {"phone": "+372 5555 1234 ext 7"},
        {"full_name": "x" * 201},
        {"full_name": "   "},
        {"email": "two words@example.com"},
        {"join_code": ""},
    ],
)
async def test_a_bad_field_refuses_the_request_and_keeps_the_code(
    client: AsyncClient, world: World, fields: dict
) -> None:
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    response = await client.post(f"{API}/join", json={**person(code, unique("f")), **fields})
    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")
    assert (await statuses(client, world))["2"] == "CODE_ISSUED"


async def test_a_name_of_two_hundred_characters_and_a_phone_of_another_country_are_accepted(
    client: AsyncClient, world: World
) -> None:
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    body = person(code, unique("edge"), full_name="N" * 200, phone="+358 40 123 4567")
    assert (await client.post(f"{API}/join", json=body)).status_code == 202


# --- Confirming ----------------------------------------------------------------------------------


async def test_a_language_that_is_not_offered_or_none_gives_the_default_e_mail(
    client: AsyncClient, world: World, smtp_server: SmtpServer, mail_settings: Settings
) -> None:
    chairman = as_(world, world.chairman)
    other = "ru" if mail_settings.DEFAULT_LOCALE != "ru" else "et"
    russian, plain = unique("lang-other"), unique("lang-none")
    for apartment, email, locale in ((world.apt_2, russian, other), (world.apt_21, plain, None)):
        request = await one_request(client, world, apartment.id, email, locale=locale)
        confirmed = await confirm(client, chairman, request["request_id"])
        assert confirmed.status_code == 200, confirmed.text
    await drain(client)
    assert subjects_to(smtp_server, russian) == [subject(mail_settings.DEFAULT_LOCALE)]
    assert subjects_to(smtp_server, plain) == [subject(mail_settings.DEFAULT_LOCALE)]


async def test_an_account_language_still_wins_over_the_request_language(
    client: AsyncClient, world: World, smtp_server: SmtpServer, db_session: AsyncSession
) -> None:
    email = unique("has-account")
    account = await create_user(db_session, world.building, "Has Account", email=email)
    await db_session.execute(update(User).where(User.id == account.id).values(locale="ru"))
    request = await one_request(client, world, world.apt_21.id, email, locale="en")
    assert (await confirm(client, as_(world, world.chairman), request["request_id"])).json()[
        "locale"
    ] == "en"
    await drain(client)
    assert subjects_to(smtp_server, email) == [subject("ru")]


async def test_a_chairman_who_lost_the_role_cannot_decide_and_the_request_waits(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    _, other = await second_chairman(db_session, mail_settings, world)
    request = await one_request(client, world, world.apt_2.id)
    await db_session.execute(
        update(User).where(User.id == world.chairman.id).values(building_role="BOARD")
    )
    former = as_(world, world.chairman)
    for response in (
        await confirm(client, former, request["request_id"]),
        await reject(client, former, request["request_id"]),
        await client.get(f"{API}/join-requests", headers=former),
    ):
        assert (response.status_code, response.json()["error_code"]) == (403, "FORBIDDEN")
    still = (await client.get(f"{API}/join-requests", headers=other)).json()
    assert [r["request_id"] for r in still] == [request["request_id"]]
    assert (await client.get(f"{API}/join-decisions", headers=former)).json() == []  # board


async def test_confirming_for_an_owner_of_that_apartment_answers_like_for_anyone(
    client: AsyncClient, world: World, smtp_server: SmtpServer
) -> None:
    email = world.owner_14.email
    request = await one_request(client, world, world.apt_14.id, email)
    confirmed = await confirm(client, as_(world, world.chairman), request["request_id"])
    assert confirmed.status_code == 200, confirmed.text
    view = confirmed.json()
    assert (view["kind"], view["email"], view["apartment_number"], view["status"]) == (
        "OWNER",
        email,
        "14",
        "PENDING",
    )
    assert (await statuses(client, world))["14"] == "CONNECTED"
    await drain(client)
    assert len(links_sent(smtp_server, email)) == 1


async def test_confirming_resends_another_chairmans_invitation_which_stays_theirs(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    _, other = await second_chairman(db_session, mail_settings, world)
    email = unique("theirs")
    pending = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "21"},
        headers=other,
    )
    assert pending.status_code == 201
    request = await one_request(client, world, world.apt_21.id, email, locale="en")
    confirmed = (await confirm(client, as_(world, world.chairman), request["request_id"])).json()
    assert confirmed["invitation_id"] == pending.json()["invitation_id"]
    assert (confirmed["mine"], confirmed["email"], confirmed["locale"]) == (
        False,
        mask_email(email),
        "en",
    )
    theirs = (await client.get(f"{API}/invitations", headers=other)).json()
    [row] = [i for i in theirs if i["invitation_id"] == confirmed["invitation_id"]]
    assert (row["mine"], row["email"]) == (True, email)


async def test_confirming_replaces_an_expired_invitation_of_that_e_mail(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    email = unique("stale")
    old = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "2"},
        headers=chairman,
    )
    await db_session.execute(
        update(AuthInvitation)
        .where(AuthInvitation.id == uuid.UUID(old.json()["invitation_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(days=1))
    )
    request = await one_request(client, world, world.apt_2.id, email)
    confirmed = (await confirm(client, chairman, request["request_id"])).json()
    assert (confirmed["status"], confirmed["delivery"], confirmed["mine"]) == (
        "PENDING",
        "QUEUED",
        True,
    )
    count = await db_session.scalar(
        select(func.count(AuthInvitation.id)).where(
            AuthInvitation.email == email, AuthInvitation.apartment_id == world.apt_2.id
        )
    )
    assert count == 1


async def test_a_confirm_counts_against_the_building_limit_and_a_reject_does_not(
    client: AsyncClient, world: World
) -> None:
    chairman = as_(world, world.chairman)
    assert (await preview(client, chairman, "")).json()["limit_remaining"] == 6
    rejected = await one_request(client, world, world.apt_21.id)
    assert (await reject(client, chairman, rejected["request_id"])).status_code == 204
    assert (await preview(client, chairman, "")).json()["limit_remaining"] == 6
    confirmed = await one_request(client, world, world.apt_2.id)
    assert (await confirm(client, chairman, confirmed["request_id"])).status_code == 200
    assert (await preview(client, chairman, "")).json()["limit_remaining"] == 5


async def test_a_request_of_another_building_is_neither_seen_nor_decided(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    other = await create_building(db_session, name="Other house")
    flat = await create_apartment(db_session, other, "1")
    other_chair = await create_user(
        db_session, other, "Other Chair", role=BuildingRole.CHAIRMAN, email=unique("oc")
    )
    other_headers = await sign_in(db_session, mail_settings, other_chair)
    codes = await client.post(
        f"{API}/join-codes",
        json={"apartment_ids": [str(flat.id)]},
        headers=other_headers,
    )
    assert (
        await submit(client, codes.json()["codes"][0]["join_code"], unique("o"))
    ).status_code == 202
    [foreign] = (await client.get(f"{API}/join-requests", headers=other_headers)).json()
    chairman = as_(world, world.chairman)
    assert (await client.get(f"{API}/join-requests", headers=chairman)).json() == []
    for response in (
        await confirm(client, chairman, foreign["request_id"]),
        await reject(client, chairman, foreign["request_id"]),
    ):
        assert (response.status_code, response.json()["error_code"]) == (
            404,
            "JOIN_REQUEST_NOT_FOUND",
        )
    assert (await client.get(f"{API}/join-codes", headers=chairman)).json() == []
    still = (await client.get(f"{API}/join-requests", headers=other_headers)).json()
    assert [r["request_id"] for r in still] == [foreign["request_id"]]
    notified = {
        d.user_id
        for d in await db_session.scalars(
            select(Delivery).where(Delivery.event_type == "JOIN_REQUEST_SUBMITTED")
        )
    }
    assert notified == {other_chair.id}
    assert await db_session.scalar(select(func.count(AuthJoinDecision.id))) == 0


async def _waiting_request(engine: AsyncEngine, settings: Settings) -> tuple:
    """A building with a chairman and one waiting join request (committed)."""
    async with unit(engine) as session:
        building = await create_building(session)
        chairman = await create_user(session, building, "Chair", role=BuildingRole.CHAIRMAN)
        flat = await create_apartment(session, building, "7")
    async with unit(engine) as session:
        issued = await JoinService(session, settings).issue(
            await caller(session, chairman.id), [flat.id]
        )
    email = unique("race")
    async with unit(engine) as session:
        body = JoinSubmit(
            join_code=issued.codes[0].join_code,
            full_name="Race Person",
            phone="+372 5555 0000",
            email=email,
        )
        await JoinService(session, settings).submit(body, "198.51.100.30")
    async with unit(engine) as session:
        request_id = await session.scalar(
            select(AuthJoinRequest.id).where(AuthJoinRequest.apartment_id == flat.id)
        )
    return chairman, flat, email, request_id


async def _decide(
    engine: AsyncEngine, settings: Settings, chairman_id: uuid.UUID, request_id: uuid.UUID
):
    async def work(session: AsyncSession, confirming: bool) -> None:
        service = JoinService(session, settings)
        who = await caller(session, chairman_id)
        if confirming:
            await service.confirm(who, request_id)
        else:
            await service.reject(who, request_id)

    return lambda confirming: outcome(engine, lambda s: work(s, confirming))


async def _counts(engine: AsyncEngine, email: str, flat_id: uuid.UUID) -> tuple[int, int, int]:
    async with unit(engine) as session:
        invitations = await session.scalar(
            select(func.count(AuthInvitation.id)).where(AuthInvitation.email == email)
        )
        decisions = await session.scalar(
            select(func.count(AuthJoinDecision.id)).where(AuthJoinDecision.apartment_id == flat_id)
        )
        counted = await session.scalar(
            select(func.count(AuthAttempt.id)).where(
                AuthAttempt.kind == AttemptKind.BULK_INVITATION
            )
        )
    return int(invitations or 0), int(decisions or 0), int(counted or 0)


async def test_two_confirms_of_one_request_at_once_make_one_invitation(
    engine: AsyncEngine,
) -> None:
    settings = get_settings().model_copy(update={"DEMO_MODE_ENABLED": False})
    chairman, flat, email, request_id = await _waiting_request(engine, settings)
    decide = await _decide(engine, settings, chairman.id, request_id)
    results = await asyncio.gather(decide(True), decide(True))
    assert sorted(results) == ["JOIN_REQUEST_NOT_FOUND", "ok"]
    assert await _counts(engine, email, flat.id) == (1, 1, 1)


async def test_a_confirm_and_a_reject_at_once_make_one_decision(engine: AsyncEngine) -> None:
    settings = get_settings().model_copy(update={"DEMO_MODE_ENABLED": False})
    chairman, flat, email, request_id = await _waiting_request(engine, settings)
    decide = await _decide(engine, settings, chairman.id, request_id)
    results = await asyncio.gather(decide(True), decide(False))
    assert sorted(results) == ["JOIN_REQUEST_NOT_FOUND", "ok"]
    invitations, decisions, counted = await _counts(engine, email, flat.id)
    assert decisions == 1
    assert (invitations, counted) in {(1, 1), (0, 0)}  # confirmed, or rejected with nothing sent


# --- Decisions and the clean-up ------------------------------------------------------------------


async def test_the_decision_list_pages_newest_first_and_checks_its_bounds(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    chairman = as_(world, world.chairman)
    _, board = await board_member(db_session, mail_settings, world)
    hours = {"2": 3, "21": 2, "14": 1}
    for apartment in (world.apt_2, world.apt_21, world.apt_14):
        request = await one_request(client, world, apartment.id)
        assert (await reject(client, chairman, request["request_id"])).status_code == 204
        await db_session.execute(
            update(AuthJoinDecision)
            .where(AuthJoinDecision.apartment_id == apartment.id)
            .values(decided_at=datetime.now(UTC) - timedelta(hours=hours[apartment.number]))
        )

    async def numbers(headers: dict[str, str], **params: object) -> list[str]:
        response = await client.get(f"{API}/join-decisions", params=params, headers=headers)
        assert response.status_code == 200, response.text
        assert all(set(d) == DECISION_FIELDS for d in response.json())
        return [d["apartment_number"] for d in response.json()]

    assert await numbers(chairman) == ["14", "21", "2"]
    assert await numbers(board) == ["14", "21", "2"]
    assert await numbers(chairman, limit=2) == ["14", "21"]
    assert await numbers(chairman, limit=2, offset=2) == ["2"]
    assert await numbers(chairman, offset=3) == []
    assert await numbers(chairman, limit=100, offset=100_000) == []
    for params in ({"limit": 0}, {"limit": 101}, {"offset": -1}, {"offset": 100_001}):
        response = await client.get(f"{API}/join-decisions", params=params, headers=chairman)
        assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


async def test_an_undecided_request_expires_after_thirty_days_not_before(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    request = await one_request(client, world, world.apt_2.id)
    now = datetime.now(UTC)
    kept = await delete_old_join_rows(db_session, now + timedelta(days=29, hours=23))
    assert kept["join_requests"] == 0
    assert [r["request_id"] for r in await waiting(client, world)] == [request["request_id"]]
    gone = await delete_old_join_rows(db_session, now + timedelta(days=30, minutes=1))
    assert gone["join_requests"] == 1
    decisions = (
        await client.get(f"{API}/join-decisions", headers=as_(world, world.chairman))
    ).json()
    assert [(d["apartment_number"], d["outcome"], d["decided_by_user_id"]) for d in decisions] == [
        ("2", "EXPIRED", None)
    ]
    late = await confirm(client, as_(world, world.chairman), request["request_id"])
    assert (late.status_code, late.json()["error_code"]) == (404, "JOIN_REQUEST_NOT_FOUND")


async def test_an_expired_code_is_deleted_thirty_days_after_it_expired(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    lapsed, long_lived = (await issue(client, world, [world.apt_2.id, world.apt_21.id]))["codes"]
    now = datetime.now(UTC)
    await db_session.execute(
        update(AuthJoinCode)
        .where(AuthJoinCode.id == uuid.UUID(lapsed["code_id"]))
        .values(expires_at=now - timedelta(days=29))
    )
    await db_session.execute(
        update(AuthJoinCode)
        .where(AuthJoinCode.id == uuid.UUID(long_lived["code_id"]))
        .values(created_at=now - timedelta(days=60), expires_at=now + timedelta(days=1))
    )
    assert (await delete_old_join_rows(db_session, now))["codes_on_paper"] == 0
    assert (await statuses(client, world))["2"] == "EXPIRED"
    assert (await delete_old_join_rows(db_session, now + timedelta(days=2)))["codes_on_paper"] == 1
    assert (await statuses(client, world))["2"] == "NOT_INVITED"
    assert (await lookup(client, long_lived["join_code"])).status_code == 200


# --- The address limit ---------------------------------------------------------------------------


async def test_the_join_page_counts_an_ipv6_slash_64_as_one_address(
    db_app: FastAPI, world: World
) -> None:
    def from_address(address: str) -> AsyncClient:
        return AsyncClient(
            transport=ASGITransport(app=db_app, client=(address, 4000)), base_url="https://test"
        )

    async with from_address("2001:db8:1:2::1") as first:
        for _ in range(20):
            assert (await lookup(first, "ZZZZ-ZZZZ-ZZ")).status_code == 400
    async with from_address("2001:db8:1:2:ffff:ffff:ffff:ffff") as neighbour:
        limited = await lookup(neighbour, "ZZZZ-ZZZZ-ZZ")
        assert (limited.status_code, limited.json()["error_code"]) == (429, "RATE_LIMITED")
        assert 0 < int(limited.headers["Retry-After"]) <= 3600
        body = person("ZZZZ-ZZZZ-ZZ", unique("v6"))
        assert (await neighbour.post(f"{API}/join", json=body)).status_code == 429
    async with from_address("2001:db8:1:3::1") as other_network:
        assert (await lookup(other_network, "ZZZZ-ZZZZ-ZZ")).status_code == 400


# --- The privacy notice and its setting ----------------------------------------------------------


async def test_the_url_setting_through_the_settings_api(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    chairman = as_(world, world.chairman)
    _, board = await board_member(db_session, mail_settings, world)

    async def setting(headers: dict[str, str]) -> dict:
        response = await client.get(SETTINGS, headers=headers)
        assert response.status_code == 200, response.text
        return next(s for s in response.json()["settings"] if s["key"] == NOTICE_KEY)

    initial = await setting(chairman)
    assert {k: initial[k] for k in ("type", "value", "default", "minimum", "maximum")} == {
        "type": "URL",
        "value": "",
        "default": "",
        "minimum": None,
        "maximum": None,
    }
    assert (initial["is_default"], initial["updated_at"]) == (True, None)
    assert (await setting(board))["value"] == ""

    number = await client.put(SETTINGS, json={"values": {NOTICE_KEY: 5}}, headers=chairman)
    assert (number.status_code, number.json()["error_code"]) == (422, "VALIDATION_ERROR")
    assert any(e["loc"][:3] == ["body", "values", NOTICE_KEY] for e in number.json()["errors"])
    mixed = await client.put(
        SETTINGS,
        json={"values": {"issues.reports_per_apartment_per_day": 5, NOTICE_KEY: "ftp://x.example"}},
        headers=chairman,
    )
    assert mixed.status_code == 422
    after = (await client.get(SETTINGS, headers=chairman)).json()["settings"]
    assert all(s["is_default"] for s in after)  # all or nothing

    custom = "https://example.org/privacy"
    refused = await client.put(SETTINGS, json={"values": {NOTICE_KEY: custom}}, headers=board)
    assert (refused.status_code, refused.json()["error_code"]) == (403, "FORBIDDEN")
    changed = await client.put(SETTINGS, json={"values": {NOTICE_KEY: custom}}, headers=chairman)
    assert changed.status_code == 200, changed.text
    notice = (await client.get(f"{API}/join/privacy-notice", params={"locale": "et"})).json()
    assert notice == {"custom_url": custom, "locale": "et", "text": None}

    emptied = await client.put(SETTINGS, json={"values": {NOTICE_KEY: ""}}, headers=chairman)
    assert emptied.status_code == 200
    assert (await client.get(f"{API}/join/privacy-notice")).json()["custom_url"] is None
    await client.put(SETTINGS, json={"values": {NOTICE_KEY: custom}}, headers=chairman)
    reset = await client.put(SETTINGS, json={"values": {NOTICE_KEY: None}}, headers=chairman)
    assert reset.status_code == 200
    assert (await setting(chairman))["is_default"] is True
    template = (await client.get(f"{API}/join/privacy-notice", params={"locale": "en"})).json()
    assert template["custom_url"] is None and world.building.name in template["text"]
    assert "{association_name}" not in template["text"]


@pytest.mark.parametrize("locale", ["EN", "et-EE", "fi", ""])
async def test_the_privacy_notice_answers_english_for_any_other_language(
    client: AsyncClient, world: World, locale: str
) -> None:
    response = await client.get(f"{API}/join/privacy-notice", params={"locale": locale})
    assert response.status_code == 200, response.text
    assert response.json()["locale"] == "en"


async def test_a_long_language_value_also_gets_the_english_notice(
    client: AsyncClient, world: World
) -> None:
    response = await client.get(f"{API}/join/privacy-notice", params={"locale": "estonian-ee"})
    assert response.status_code == 200, response.text
    assert response.json()["locale"] == "en"


# --- Privacy and notifications -------------------------------------------------------------------


async def test_the_whole_join_flow_logs_no_code_name_phone_e_mail_or_link(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    log_capture,
    span_exporter,
) -> None:
    chairman = as_(world, world.chairman)
    issued = (await issue(client, world, [world.apt_2.id, world.apt_21.id]))["codes"]
    email = unique("hidden-joiner")
    name, phone = "Varjatud Isik", "+372 5432 1987"
    await lookup(client, issued[0]["join_code"])
    await submit(client, issued[0]["join_code"], email, full_name=name, phone=phone)
    await lookup(client, issued[1]["join_code"].lower())
    [request] = await waiting(client, world)
    assert (await confirm(client, chairman, request["request_id"])).status_code == 200
    await drain(client)
    [token] = links_sent(smtp_server, email)
    raw = log_capture.raw
    assert "auth_join_request_submitted" in raw and "auth_join_request_decided" in raw
    exported = " ".join(
        f"{span.name} {dict(span.attributes or {})}" for span in span_exporter.get_finished_spans()
    )
    secrets = [name, "Varjatud", phone, "5432 1987", email, token]
    for code in issued:
        secrets += [code["join_code"], code["join_code"].replace("-", "")]
    for secret in secrets:
        assert secret not in raw, secret
        assert secret not in exported, secret


async def test_every_chairman_is_notified_once_and_the_board_is_not(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    other, _ = await second_chairman(db_session, mail_settings, world)
    board, _ = await board_member(db_session, mail_settings, world)
    await one_request(client, world, world.apt_21.id, full_name="Teadmata Nimi")
    rows = list(
        await db_session.scalars(
            select(Delivery).where(Delivery.event_type == "JOIN_REQUEST_SUBMITTED")
        )
    )
    assert {d.user_id for d in rows} == {world.chairman.id, other.id}
    pairs = [(d.user_id, d.channel) for d in rows]
    assert len(pairs) == len(set(pairs))  # once per channel
    assert {d.channel for d in rows if d.user_id == other.id} >= {"in_app", "email"}
    assert all(d.params == {"apartment_number": "21"} for d in rows)
    assert board.id not in {d.user_id for d in rows}


async def test_a_name_with_a_next_line_character_is_not_on_one_line(
    client: AsyncClient, world: World
) -> None:
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    body = person(code, unique("nel"), full_name="Mari\u0085Tamm")
    response = await client.post(f"{API}/join", json=body)
    assert response.status_code == 422, response.text


async def test_a_confirmed_e_mail_is_masked_to_the_other_chairmen(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    _, other = await second_chairman(db_session, mail_settings, world)
    email = unique("confirmed")
    request = await one_request(client, world, world.apt_2.id, email)
    confirmed = (await confirm(client, as_(world, world.chairman), request["request_id"])).json()
    assert (confirmed["mine"], confirmed["email"]) == (True, email)
    theirs = (await client.get(f"{API}/invitations", headers=other)).json()
    [row] = [i for i in theirs if i["invitation_id"] == confirmed["invitation_id"]]
    assert (row["mine"], row["email"]) == (False, mask_email(email))
    assert (await client.get(f"{API}/join-requests", headers=other)).json() == []
