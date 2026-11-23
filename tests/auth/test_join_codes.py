# The fixtures of tests/auth/test_invitations.py are imported by name; using them as parameters
# is what pytest expects, so F811 does not apply to this file.
# ruff: noqa: F811
"""Join codes on paper and join requests (epic E13 R4c, docs/API.md section 7), on a real
PostgreSQL with an in-process SMTP server. `world` has apartments 14 (owned by Ivan Petrov), 2
and 21; its bulk limit is 6 per 24 hours.
"""

import logging
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import Settings, get_settings
from src.main import create_app
from src.modules.auth.join import delete_old_join_rows
from src.modules.auth.models import AuthJoinCode, AuthJoinDecision, AuthJoinRequest
from src.modules.auth.policies import (
    JOIN_CODE_ALPHABET,
    format_join_code,
    new_join_code,
    normalise_join_code,
)
from src.modules.notifications.models import Delivery
from src.modules.property.models import Building
from tests.auth.test_invitations import (  # noqa: F401 (fixtures used by name)
    API,
    World,
    app,
    as_,
    client,
    drain,
    invite_and_open,
    links_sent,
    mail_settings,
    redeem,
    unique,
    world,
)
from tests.smtp_server import SmtpServer


async def issue(client: AsyncClient, world: World, ids: list | None) -> dict:
    response = await client.post(
        f"{API}/join-codes",
        json={"apartment_ids": None if ids is None else [str(i) for i in ids]},
        headers=as_(world, world.chairman),
    )
    assert response.status_code == 201, response.text
    assert response.headers["cache-control"] == "no-store"
    return response.json()


def person(code: str, email: str, **fields: object) -> dict:
    return {
        "join_code": code,
        "full_name": "Mari Tamm",
        "phone": "+372 5555 1234",
        "email": email,
        "locale": "en",
        **fields,
    }


async def submit(client: AsyncClient, code: str, email: str, **fields: object):
    return await client.post(f"{API}/join", json=person(code, email, **fields))


async def waiting(client: AsyncClient, world: World) -> list[dict]:
    response = await client.get(f"{API}/join-requests", headers=as_(world, world.chairman))
    assert response.status_code == 200, response.text
    return response.json()


async def statuses(client: AsyncClient, world: World) -> dict[str, str]:
    body = (await client.get(f"{API}/connections", headers=as_(world, world.chairman))).json()
    return {item["apartment_number"]: item["status"] for item in body["items"]}


# --- The code -------------------------------------------------------------------------------------


def test_a_code_is_ten_characters_of_crockford_base32_shown_in_groups() -> None:
    code = new_join_code()
    assert len(code) == 10 and all(c in JOIN_CODE_ALPHABET for c in code)
    assert not set("ILOU") & set(code)
    shown = format_join_code(code)
    assert len(shown) == 12 and shown[4] == shown[9] == "-"
    assert normalise_join_code(f"  {shown.lower()} ") == code


def test_look_alikes_and_separators_are_read_the_crockford_way() -> None:
    assert normalise_join_code("k7qf m3tx-9r") == "K7QFM3TX9R"
    assert normalise_join_code("I0L1-O0O0-11") == "1011000011"
    assert normalise_join_code("K7QF-M3TX-9U") is None  # U is not a code character
    assert normalise_join_code("K7QF-M3TX") is None


# --- Issuing and cancelling -----------------------------------------------------------------------


async def test_the_default_issue_picks_apartments_with_nothing_going_on(
    client: AsyncClient, world: World
) -> None:
    await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": unique("o"), "apartment_number": "21"},
        headers=as_(world, world.chairman),
    )
    body = await issue(client, world, None)
    assert [code["apartment_number"] for code in body["codes"]] == ["2"]  # 14 owned, 21 invited
    assert body["join_url"] == "https://kyu.example.test/join"
    assert body["association_name"] == world.building.name
    again = await issue(client, world, None)
    assert again["codes"] == []  # 2 now holds an unused code
    assert (await statuses(client, world))["2"] == "CODE_ISSUED"


async def test_codes_for_picked_apartments_are_listed_without_the_code_and_cancelled(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    body = await issue(client, world, [world.apt_14.id, world.apt_2.id])
    assert len(body["codes"]) == 2
    listed = (await client.get(f"{API}/join-codes", headers=as_(world, world.chairman))).json()
    assert {item["apartment_number"] for item in listed} == {"14", "2"}
    assert all("join_code" not in item for item in listed)
    stored = await db_session.scalar(select(AuthJoinCode.code_hash).limit(1))
    assert stored is not None and body["codes"][0]["join_code"].replace("-", "") not in stored
    code_id = body["codes"][1]["code_id"]
    cancelled = await client.delete(
        f"{API}/join-codes/{code_id}", headers=as_(world, world.chairman)
    )
    assert cancelled.status_code == 204
    again = await client.delete(f"{API}/join-codes/{code_id}", headers=as_(world, world.chairman))
    assert again.json()["error_code"] == "JOIN_CODE_NOT_FOUND"
    lookup = await client.post(
        f"{API}/join/lookup", json={"join_code": body["codes"][1]["join_code"]}
    )
    assert lookup.json()["error_code"] == "INVALID_JOIN_CODE"


async def test_issuing_refuses_foreign_or_repeated_apartments(
    client: AsyncClient, world: World
) -> None:
    chairman = as_(world, world.chairman)
    foreign = await client.post(
        f"{API}/join-codes", json={"apartment_ids": [str(uuid.uuid4())]}, headers=chairman
    )
    assert (foreign.status_code, foreign.json()["error_code"]) == (404, "APARTMENT_NOT_FOUND")
    twice = await client.post(
        f"{API}/join-codes",
        json={"apartment_ids": [str(world.apt_2.id), str(world.apt_2.id)]},
        headers=chairman,
    )
    assert twice.status_code == 422
    empty = await client.post(f"{API}/join-codes", json={"apartment_ids": []}, headers=chairman)
    assert empty.status_code == 422


async def test_only_the_chairman_issues_and_decides(client: AsyncClient, world: World) -> None:
    for user in (world.owner_14, world.accountant):
        headers = as_(world, user)
        for method, path in (
            ("post", "/join-codes"),
            ("get", "/join-codes"),
            ("get", "/join-requests"),
            ("post", f"/join-requests/{uuid.uuid4()}/confirm"),
            ("post", f"/join-requests/{uuid.uuid4()}/reject"),
        ):
            kwargs = (
                {"json": {"apartment_ids": None}}
                if path == "/join-codes" and method == "post"
                else {}
            )
            response = await getattr(client, method)(f"{API}{path}", headers=headers, **kwargs)
            assert response.json()["error_code"] == "FORBIDDEN", (method, path)


# --- The join page --------------------------------------------------------------------------------


async def test_the_join_lookup_and_the_invitation_tell_the_country_of_the_building(
    client: AsyncClient, world: World, smtp_server: SmtpServer, db_session: AsyncSession
) -> None:
    # Not the default EE: the value is read from the building.
    await db_session.execute(
        update(Building).where(Building.id == world.building.id).values(country_code="LV")
    )
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    looked = await client.post(f"{API}/join/lookup", json={"join_code": code})
    assert looked.json()["country_code"] == "LV"
    _, token = await invite_and_open(
        client, smtp_server, as_(world, world.chairman),
        kind="OWNER", email=unique("lv"), apartment_number="21",
    )  # fmt: skip
    assert (await redeem(client, token)).json()["invitation"]["country_code"] == "LV"


async def test_a_person_joins_and_the_chairman_confirms(
    client: AsyncClient,
    world: World,
    smtp_server: SmtpServer,
    db_session: AsyncSession,
) -> None:
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    looked = await client.post(f"{API}/join/lookup", json={"join_code": code.lower()})
    assert looked.json() == {
        "association_name": world.building.name,
        "apartment_number": "2",
        "country_code": "EE",
    }

    email = unique("mari")
    response = await submit(client, code, email.upper())
    assert (response.status_code, response.json()) == (202, {"accepted": True})
    await drain(client)
    assert links_sent(smtp_server, email) == []  # nothing goes to the e-mail before the decision
    assert (await statuses(client, world))["2"] == "JOIN_REQUEST"
    used_again = await submit(client, code, unique("other"))
    assert used_again.json()["error_code"] == "INVALID_JOIN_CODE"  # one use only

    [request] = await waiting(client, world)
    assert (request["full_name"], request["phone"], request["email"]) == (
        "Mari Tamm",
        "+37255551234",  # typed "+372 5555 1234", stored in E.164 form
        email,
    )
    # The chairmen are told, with the apartment number only.
    notified = list(
        await db_session.scalars(
            select(Delivery).where(Delivery.event_type == "JOIN_REQUEST_SUBMITTED")
        )
    )
    assert {d.user_id for d in notified} == {world.chairman.id}
    assert all(d.params == {"apartment_number": "2"} for d in notified)

    confirmed = await client.post(
        f"{API}/join-requests/{request['request_id']}/confirm",
        headers=as_(world, world.chairman),
    )
    assert confirmed.status_code == 200, confirmed.text
    invitation = confirmed.json()
    assert (invitation["kind"], invitation["email"], invitation["mine"]) == ("OWNER", email, True)
    assert invitation["locale"] == "en"
    await drain(client)
    assert len(links_sent(smtp_server, email)) == 1
    assert await waiting(client, world) == []
    left = await db_session.scalar(select(func.count(AuthJoinRequest.id)))
    assert left == 0  # the name and phone are gone
    decisions = (
        await client.get(f"{API}/join-decisions", headers=as_(world, world.chairman))
    ).json()
    assert [(d["apartment_number"], d["outcome"], d["decided_by_user_id"]) for d in decisions] == [
        ("2", "CONFIRMED", str(world.chairman.id))
    ]
    assert "full_name" not in decisions[0] and "email" not in decisions[0]


async def test_a_rejected_request_sends_nothing_and_keeps_only_the_decision(
    client: AsyncClient, world: World, smtp_server: SmtpServer
) -> None:
    code = (await issue(client, world, [world.apt_21.id]))["codes"][0]["join_code"]
    email = unique("nope")
    await submit(client, code, email)
    [request] = await waiting(client, world)
    rejected = await client.post(
        f"{API}/join-requests/{request['request_id']}/reject", headers=as_(world, world.chairman)
    )
    assert rejected.status_code == 204
    await drain(client)
    assert links_sent(smtp_server, email) == []
    assert (await statuses(client, world))["21"] == "NOT_INVITED"
    again = await client.post(
        f"{API}/join-requests/{request['request_id']}/reject", headers=as_(world, world.chairman)
    )
    assert again.json()["error_code"] == "JOIN_REQUEST_NOT_FOUND"
    board_view = await client.get(f"{API}/join-decisions", headers=as_(world, world.accountant))
    assert board_view.json()["error_code"] == "FORBIDDEN"  # the accountant is not the board


async def test_confirming_resends_a_pending_invitation_of_that_e_mail(
    client: AsyncClient, world: World
) -> None:
    email = unique("known")
    pending = await client.post(
        f"{API}/invitations",
        json={"kind": "OWNER", "email": email, "apartment_number": "21"},
        headers=as_(world, world.chairman),
    )
    code = (await issue(client, world, [world.apt_21.id]))["codes"][0]["join_code"]
    await submit(client, code, email, locale="ru")  # not offered: the default language
    [request] = await waiting(client, world)
    confirmed = await client.post(
        f"{API}/join-requests/{request['request_id']}/confirm", headers=as_(world, world.chairman)
    )
    assert confirmed.json()["invitation_id"] == pending.json()["invitation_id"]
    assert confirmed.json()["locale"] is None


async def test_the_answer_is_the_same_for_every_bad_code_and_for_members(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    body = await issue(client, world, [world.apt_2.id, world.apt_21.id])
    expired, cancelled = body["codes"][0], body["codes"][1]
    await db_session.execute(
        update(AuthJoinCode)
        .where(AuthJoinCode.id == uuid.UUID(expired["code_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
    )
    await client.delete(
        f"{API}/join-codes/{cancelled['code_id']}", headers=as_(world, world.chairman)
    )
    answers = set()
    for code in ("ZZZZ-ZZZZ-ZZ", "nonsense", expired["join_code"], cancelled["join_code"]):
        response = await client.post(f"{API}/join/lookup", json={"join_code": code})
        answers.add((response.status_code, response.text))
    assert len(answers) == 1
    # A member's e-mail gets the same 202 as anyone else's.
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    member = await submit(client, code, world.owner_14.email)
    assert (member.status_code, member.json()) == (202, {"accepted": True})


async def test_the_join_page_is_limited_per_address(db_app: FastAPI, world: World) -> None:
    async with AsyncClient(
        transport=ASGITransport(app=db_app, client=("203.0.113.9", 4000)),
        base_url="https://test",
    ) as other:
        for _ in range(20):
            response = await other.post(f"{API}/join/lookup", json={"join_code": "ZZZZ-ZZZZ-ZZ"})
            assert response.status_code == 400
        limited = await other.post(f"{API}/join/lookup", json={"join_code": "ZZZZ-ZZZZ-ZZ"})
        assert limited.status_code == 429 and int(limited.headers["Retry-After"]) > 0


async def test_the_form_checks_its_fields(client: AsyncClient, world: World) -> None:
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    for bad in ({"phone": "call me"}, {"full_name": ""}, {"email": "nope"}, {"extra": 1}):
        response = await client.post(f"{API}/join", json={**person(code, unique("f")), **bad})
        assert response.status_code == 422, bad
    assert (await statuses(client, world))["2"] == "CODE_ISSUED"  # the code is still unused


async def test_no_code_name_or_phone_reaches_the_logs(
    client: AsyncClient, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.INFO)
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    email = unique("quietperson")
    await submit(client, code, email, full_name="Secretname Person")
    text = caplog.text
    assert "auth_join_request_submitted" in text  # the capture works
    assert code not in text and code.replace("-", "") not in text
    assert "Secretname" not in text and "5555 1234" not in text
    assert email.split("@")[0] not in text


# --- The privacy notice ---------------------------------------------------------------------------


async def test_the_privacy_notice_is_the_template_until_the_chairman_sets_a_url(
    client: AsyncClient, world: World
) -> None:
    template = (await client.get(f"{API}/join/privacy-notice", params={"locale": "et"})).json()
    assert template["custom_url"] is None and template["locale"] == "et"
    assert (
        world.building.name in template["text"] and "Andmekaitse Inspektsioon" in template["text"]
    )
    russian = (await client.get(f"{API}/join/privacy-notice", params={"locale": "ru"})).json()
    assert russian["locale"] == "en"  # the template is in et and en only
    chairman = as_(world, world.chairman)
    refused = await client.put(
        "/api/v1/settings",
        json={"values": {"auth.privacy_notice_url": "http://example.org/privacy"}},
        headers=chairman,
    )
    assert refused.status_code == 422
    custom = "https://example.org/privacy"
    changed = await client.put(
        "/api/v1/settings", json={"values": {"auth.privacy_notice_url": custom}}, headers=chairman
    )
    assert changed.status_code == 200, changed.text
    notice = (await client.get(f"{API}/join/privacy-notice")).json()
    assert notice == {"custom_url": custom, "locale": "en", "text": None}


# --- Retention and demo mode ----------------------------------------------------------------------


async def test_undecided_requests_expire_and_old_codes_go(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    await submit(client, code, unique("late"))
    later = datetime.now(UTC) + timedelta(days=31)
    deleted = await delete_old_join_rows(db_session, later)
    assert deleted == {"join_requests": 1, "codes_on_paper": 1}
    outcome = await db_session.scalar(select(AuthJoinDecision.outcome))
    assert outcome == "EXPIRED"
    assert (await statuses(client, world))["2"] == "NOT_INVITED"


async def test_join_codes_do_not_exist_in_demo_mode(mail_settings: Settings) -> None:
    demo = Settings(**{**mail_settings.model_dump(), "DEMO_MODE_ENABLED": True})
    demo_app = create_app(demo)
    demo_app.dependency_overrides[get_settings] = lambda: demo
    async with AsyncClient(transport=ASGITransport(app=demo_app), base_url="https://test") as c:
        for method, path, body in (
            ("post", "/join/lookup", {"join_code": "K7QF-M3TX-9R"}),
            ("get", "/join/privacy-notice", None),
        ):
            response = await getattr(c, method)(f"{API}{path}", **({"json": body} if body else {}))
            assert (response.status_code, response.json()["error_code"]) == (404, "NOT_FOUND")


@pytest.mark.parametrize(
    ("value", "fits"),
    [
        ("", True),
        ("https://example.org/privacy", True),
        ("http://example.org/privacy", False),
        ("https://", False),
        ("https://example.org/a b", False),
        ("https://example.org/" + "a" * 500, False),
        (3, False),
    ],
)
def test_the_url_setting_takes_https_addresses_or_nothing(value: object, fits: bool) -> None:
    from src.modules.auth.settings import PRIVACY_NOTICE_URL

    assert (PRIVACY_NOTICE_URL.problem(value) is None) is fits


async def test_cleanup_keeps_decided_requests_and_young_codes(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    body = await issue(client, world, [world.apt_2.id, world.apt_21.id, world.apt_14.id])
    used, cancelled, young = body["codes"]
    await submit(client, used["join_code"], unique("dec"))
    [request] = await waiting(client, world)
    await client.post(
        f"{API}/join-requests/{request['request_id']}/reject", headers=as_(world, world.chairman)
    )
    await client.delete(
        f"{API}/join-codes/{cancelled['code_id']}", headers=as_(world, world.chairman)
    )
    now = datetime.now(UTC)
    # A decided request is gone already; the used and cancelled codes are young: all stay.
    assert await delete_old_join_rows(db_session, now + timedelta(days=1)) == {
        "join_requests": 0,
        "codes_on_paper": 0,
    }
    await db_session.execute(
        update(AuthJoinCode)
        .where(AuthJoinCode.id == uuid.UUID(cancelled["code_id"]))
        .values(cancelled_at=now - timedelta(days=31))
    )
    assert (await delete_old_join_rows(db_session, now))["codes_on_paper"] == 1
    left = {str(c) for c in await db_session.scalars(select(AuthJoinCode.id))}
    assert left == {used["code_id"], young["code_id"]}
    decisions = list(await db_session.scalars(select(AuthJoinDecision.outcome)))
    assert decisions == ["REJECTED"]  # no EXPIRED for an already decided request


async def test_a_confirm_over_the_building_limit_keeps_the_request(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    filler = "".join(f"{n};{unique('f')}\n" for n in ("14", "2", "21", "14", "2", "21"))
    sent = await client.post(f"{API}/invitations/bulk", json={"text": filler}, headers=chairman)
    assert sent.json()["limit_remaining"] == 0
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    await submit(client, code, unique("wait"))
    [request] = await waiting(client, world)
    refused = await client.post(
        f"{API}/join-requests/{request['request_id']}/confirm", headers=chairman
    )
    assert (refused.status_code, refused.json()["error_code"]) == (429, "RATE_LIMITED")
    assert [r["request_id"] for r in await waiting(client, world)] == [request["request_id"]]
    assert await db_session.scalar(select(func.count(AuthJoinDecision.id))) == 0


async def test_every_lookup_and_submit_counts_toward_the_address_limit(
    db_app: FastAPI, world: World, client: AsyncClient
) -> None:
    codes = (await issue(client, world, [world.apt_2.id, world.apt_21.id]))["codes"]
    async with AsyncClient(
        transport=ASGITransport(app=db_app, client=("203.0.113.77", 4000)),
        base_url="https://test",
    ) as other:
        for _ in range(9):
            assert (
                await other.post(f"{API}/join/lookup", json={"join_code": codes[0]["join_code"]})
            ).status_code == 200
        for code in codes:
            assert (
                await other.post(f"{API}/join", json=person(code["join_code"], unique("p")))
            ).status_code == 202
        for _ in range(9):
            await other.post(f"{API}/join/lookup", json={"join_code": "ZZZZ-ZZZZ-ZZ"})
        limited = await other.post(f"{API}/join/lookup", json={"join_code": "ZZZZ-ZZZZ-ZZ"})
        assert limited.status_code == 429  # 9 + 2 + 9 = 20 counted


async def test_the_overview_counts_codes_expired_cancelled_and_their_date(
    client: AsyncClient, world: World, db_session: AsyncSession
) -> None:
    chairman = as_(world, world.chairman)
    body = await issue(client, world, [world.apt_2.id, world.apt_21.id])
    expired, cancelled = body["codes"]
    await db_session.execute(
        update(AuthJoinCode)
        .where(AuthJoinCode.id == uuid.UUID(expired["code_id"]))
        .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
    )
    await client.delete(f"{API}/join-codes/{cancelled['code_id']}", headers=chairman)
    items = {
        item["apartment_number"]: item
        for item in (await client.get(f"{API}/connections", headers=chairman)).json()["items"]
    }
    assert items["2"]["status"] == "EXPIRED"
    assert items["21"]["status"] == "NOT_INVITED"  # a cancelled code counts for nothing
    assert items["2"]["last_invited_at"] is not None  # the code's issue


async def test_the_board_reads_decisions_and_demo_mode_hides_the_chairman_routes(
    client: AsyncClient, world: World, db_session: AsyncSession, mail_settings: Settings
) -> None:
    from src.modules.auth.schemas import AuthMethod
    from src.modules.auth.service import AuthService
    from src.modules.property.schemas import BuildingRole
    from tests.factories import create_user

    board = await create_user(
        db_session, world.building, "Board Member", role=BuildingRole.BOARD, email=unique("b")
    )
    issued = await AuthService(db_session, mail_settings).start_session(
        board.id, AuthMethod.MAGIC_LINK, None
    )
    seen = await client.get(
        f"{API}/join-decisions",
        headers={"Authorization": f"Bearer {issued.response.access_token}"},
    )
    assert (seen.status_code, seen.json()) == (200, [])

    demo = Settings(**{**mail_settings.model_dump(), "DEMO_MODE_ENABLED": True})
    demo_app = create_app(demo)
    demo_app.dependency_overrides[get_settings] = lambda: demo
    async with AsyncClient(transport=ASGITransport(app=demo_app), base_url="https://test") as c:
        response = await c.get(f"{API}/join-requests")  # no sign-in at all
        assert (response.status_code, response.json()["error_code"]) == (404, "NOT_FOUND")


@pytest.mark.parametrize(
    "fields",
    [{"phone": "-----"}, {"phone": "+37 (1)"}, {"full_name": "Mari\nTamm"}],
)
async def test_a_phone_needs_digits_and_a_name_one_line(
    client: AsyncClient, world: World, fields: dict
) -> None:
    code = (await issue(client, world, [world.apt_2.id]))["codes"][0]["join_code"]
    response = await client.post(f"{API}/join", json={**person(code, unique("x")), **fields})
    assert response.status_code == 422


@pytest.mark.parametrize(
    "value",
    [
        "https://trusted.ee@evil.example/privacy",
        "https://example.org:99999/privacy",
        "https://example.org/\u202eyvacirp",
        "https://exam\u00adple.org/privacy",
    ],
)
def test_the_url_setting_refuses_userinfo_bad_ports_and_format_characters(value: str) -> None:
    from src.modules.auth.settings import PRIVACY_NOTICE_URL

    assert PRIVACY_NOTICE_URL.problem(value) is not None
