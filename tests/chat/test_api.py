"""The building chat through the API (issue #142; fixture: conftest.py)."""

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient, Response
from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.building_settings import BuildingSettingRecord
from src.core.security import DEMO_USER_HEADER
from src.modules.chat.models import ChatMessage
from src.modules.chat.purge import PURGE_LOCK_KEY, purge_tick
from src.modules.property.models import Building, User
from tests.issues.conftest import IssueWorld

API = "/api/v1/chat"
MESSAGES = f"{API}/messages"
SETTINGS = "/api/v1/settings"


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


async def post(client: AsyncClient, user: User, body: str = "Water in the basement", **extra):
    return await client.post(MESSAGES, json={"body": body, **extra}, headers=as_user(user))


async def turn(client: AsyncClient, world: IssueWorld, on: bool) -> None:
    response = await client.put(
        SETTINGS, json={"values": {"chat.enabled": on}}, headers=as_user(world.chairman)
    )
    assert response.status_code == 200, response.text


async def turned_on_since(db_session: AsyncSession, building: Building, since: datetime) -> None:
    """The chat as if the chairman had turned it on at `since` (the API can only say "now")."""
    await db_session.execute(
        insert(BuildingSettingRecord)
        .values(building_id=building.id, key="chat.enabled", value=True, updated_at=since)
        .on_conflict_do_update(
            index_elements=["building_id", "key"], set_={"value": True, "updated_at": since}
        )
    )
    await db_session.flush()


async def stored(
    db_session: AsyncSession, building: Building, author: User, created_at: datetime, body="old"
) -> ChatMessage:
    message = ChatMessage(
        building_id=building.id, author_user_id=author.id, body=body, created_at=created_at
    )
    db_session.add(message)
    await db_session.flush()
    return message


def bodies(response: Response) -> list[str]:
    assert response.status_code == 200, response.text
    return [message["body"] for message in response.json()["messages"]]


# --- The switch and who takes part --------------------------------------------------------------


async def test_the_chat_is_off_until_the_chairman_turns_it_on(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    state = await api_client.get(API, headers=as_user(world.owner_14))
    assert state.status_code == 200
    assert state.json() == {
        "enabled": False,
        "turned_on_at": None,
        "can_take_part": True,
        "recent_count": 0,
        "recent_minutes": 10,
        "last_message_at": None,
        "history_hours": 2,
        "max_length": 500,
    }
    for response in (
        await api_client.get(MESSAGES, headers=as_user(world.owner_14)),
        await post(api_client, world.owner_14),
    ):
        assert response.status_code == 409
        assert response.json()["error_code"] == "CHAT_DISABLED"

    await turn(api_client, world, on=True)
    assert (await post(api_client, world.owner_14)).status_code == 201
    assert (await api_client.get(API, headers=as_user(world.owner_14))).json()["enabled"] is True


async def test_only_the_chairman_turns_it_on(api_client: AsyncClient, world: IssueWorld) -> None:
    response = await api_client.put(
        SETTINGS, json={"values": {"chat.enabled": True}}, headers=as_user(world.board_15)
    )
    assert response.status_code == 403


async def test_staff_without_an_apartment_does_not_take_part(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await turn(api_client, world, on=True)
    await post(api_client, world.owner_14)

    state = (await api_client.get(API, headers=as_user(world.accountant))).json()
    assert state["enabled"] is True
    assert state["can_take_part"] is False
    assert state["recent_count"] == 0 and state["last_message_at"] is None
    for response in (
        await api_client.get(MESSAGES, headers=as_user(world.accountant)),
        await post(api_client, world.accountant),
    ):
        assert response.status_code == 403
        assert response.json()["error_code"] == "FORBIDDEN"


async def test_residents_and_the_board_read_and_write(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await turn(api_client, world, on=True)
    own = await post(api_client, world.owner_14, "Who has the basement key?")
    assert own.status_code == 201
    message = own.json()
    assert message["author_badge"] == {"display_label": "Apt. 14", "role_badge": "OWNER"}
    assert message["is_own"] is True
    created = datetime.fromisoformat(message["created_at"])
    assert datetime.fromisoformat(message["expires_at"]) == created + timedelta(hours=2)
    assert set(message) == {"id", "body", "author_badge", "created_at", "expires_at", "is_own"}

    chairman = await post(api_client, world.chairman, "I am on my way")
    assert chairman.json()["author_badge"] == {"display_label": "Chairman", "role_badge": "BOARD"}
    board = await post(api_client, world.board_15, "Me too")
    assert board.json()["author_badge"]["role_badge"] == "BOARD"
    assert (await post(api_client, world.family_14, "Thanks")).status_code == 201

    page = await api_client.get(MESSAGES, headers=as_user(world.tenant_2))
    assert bodies(page) == ["Who has the basement key?", "I am on my way", "Me too", "Thanks"]
    assert [m["is_own"] for m in page.json()["messages"]] == [False] * 4


async def test_the_author_writes_from_one_of_their_apartments(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await turn(api_client, world, on=True)
    chosen = await post(api_client, world.tenant_2, author_apartment_id=str(world.apt_3.id))
    assert chosen.status_code == 201
    assert chosen.json()["author_badge"]["display_label"] == "Apt. 3"

    for apartment_id in (world.apt_14.id, uuid.uuid4()):
        foreign = await post(api_client, world.tenant_2, author_apartment_id=str(apartment_id))
        assert foreign.status_code == 422
        assert foreign.json()["error_code"] == "INVALID_AUTHOR_APARTMENT"


async def test_who_and_whether_come_before_the_apartment(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    foreign = {"author_apartment_id": str(world.apt_14.id)}
    off = await post(api_client, world.tenant_2, **foreign)
    assert off.status_code == 409 and off.json()["error_code"] == "CHAT_DISABLED"
    await turn(api_client, world, on=True)
    staff = await post(api_client, world.accountant, **foreign)
    assert staff.status_code == 403 and staff.json()["error_code"] == "FORBIDDEN"


async def test_another_building_never_sees_the_chat(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    await turn(api_client, world, on=True)
    await post(api_client, world.owner_14)
    other = await db_session.get(Building, world.other_resident.building_id)
    assert other is not None
    await turned_on_since(db_session, other, datetime.now(UTC) - timedelta(minutes=1))

    assert bodies(await api_client.get(MESSAGES, headers=as_user(world.other_resident))) == []
    state = (await api_client.get(API, headers=as_user(world.other_resident))).json()
    assert state["recent_count"] == 0


# --- Text and limits ----------------------------------------------------------------------------


async def test_the_text_is_one_to_five_hundred_characters(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await turn(api_client, world, on=True)
    assert (await post(api_client, world.owner_14, "x" * 500)).status_code == 201
    trimmed = await post(api_client, world.owner_14, "  hello  ")
    assert trimmed.json()["body"] == "hello"
    for bad in ("x" * 501, "   ", "", "a\x00b"):
        response = await post(api_client, world.owner_14, bad)
        assert response.status_code == 422, bad
        assert response.json()["error_code"] == "VALIDATION_ERROR"
    unknown = await api_client.post(
        MESSAGES, json={"body": "hi", "pinned": True}, headers=as_user(world.owner_14)
    )
    assert unknown.status_code == 422


async def test_ten_messages_a_minute_per_person(api_client: AsyncClient, world: IssueWorld) -> None:
    await turn(api_client, world, on=True)
    for i in range(10):
        assert (await post(api_client, world.owner_14, f"m{i}")).status_code == 201
    limited = await post(api_client, world.owner_14)
    assert limited.status_code == 429
    payload = limited.json()
    assert payload["error_code"] == "RATE_LIMITED"
    assert payload["reason"] == "MINUTE_LIMIT"
    assert 1 <= payload["retry_after_seconds"] <= 60
    assert limited.headers["Retry-After"] == str(payload["retry_after_seconds"])
    assert (await post(api_client, world.family_14)).status_code == 201, "per person"


async def test_sixty_messages_an_hour_per_person(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    now = datetime.now(UTC)
    await turned_on_since(db_session, world.building, now - timedelta(hours=3))
    for i in range(60):
        await stored(
            db_session, world.building, world.owner_14, now - timedelta(minutes=50, seconds=-i)
        )
    limited = await post(api_client, world.owner_14)
    assert limited.status_code == 429
    assert limited.json()["reason"] == "HOUR_LIMIT"


# --- The window, the cursor and the purge -------------------------------------------------------


async def test_messages_live_two_hours(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    now = datetime.now(UTC)
    await turned_on_since(db_session, world.building, now - timedelta(hours=5))
    await stored(
        db_session, world.building, world.owner_14, now - timedelta(hours=2, minutes=1), "gone"
    )
    await stored(
        db_session, world.building, world.owner_14, now - timedelta(hours=1, minutes=58), "kept"
    )
    await stored(db_session, world.building, world.owner_14, now - timedelta(minutes=30), "recent")

    assert bodies(await api_client.get(MESSAGES, headers=as_user(world.tenant_2))) == [
        "kept",
        "recent",
    ]
    state = (await api_client.get(API, headers=as_user(world.tenant_2))).json()
    assert state["recent_count"] == 0, "nothing in the last 10 minutes"
    assert state["last_message_at"] is not None

    await post(api_client, world.owner_14, "now")
    assert (await api_client.get(API, headers=as_user(world.tenant_2))).json()["recent_count"] == 1


async def test_the_cursor_returns_only_newer_messages(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await turn(api_client, world, on=True)
    first = (await post(api_client, world.owner_14, "one")).json()["id"]
    await post(api_client, world.tenant_2, "two")
    await post(api_client, world.chairman, "three")

    page = await api_client.get(MESSAGES, params={"after": first}, headers=as_user(world.owner_14))
    assert bodies(page) == ["two", "three"]
    assert page.json()["has_more"] is False
    cursor = page.json()["cursor"]

    empty = await api_client.get(
        MESSAGES, params={"after": cursor}, headers=as_user(world.owner_14)
    )
    assert bodies(empty) == [] and empty.json()["cursor"] == cursor

    one = await api_client.get(
        MESSAGES, params={"after": first, "limit": 1}, headers=as_user(world.owner_14)
    )
    assert bodies(one) == ["two"] and one.json()["has_more"] is True

    newest = await api_client.get(MESSAGES, params={"limit": 2}, headers=as_user(world.owner_14))
    assert bodies(newest) == ["two", "three"], "without a cursor: the newest, oldest first"
    assert newest.json()["has_more"] is False

    assert (await api_client.get(MESSAGES, headers=as_user(world.owner_14))).json()[
        "cursor"
    ] > first
    for bad in ({"after": -1}, {"after": 2**63}, {"limit": 0}, {"limit": 201}):
        response = await api_client.get(MESSAGES, params=bad, headers=as_user(world.owner_14))
        assert response.status_code == 422, bad


async def test_turning_off_hides_everything_and_on_again_starts_empty(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    await turn(api_client, world, on=True)
    await post(api_client, world.owner_14, "before")
    await turn(api_client, world, on=False)
    assert (await api_client.get(MESSAGES, headers=as_user(world.owner_14))).status_code == 409

    # The chairman turns it on again before the purge ran: the old message stays hidden.
    await turn(api_client, world, on=True)
    assert bodies(await api_client.get(MESSAGES, headers=as_user(world.owner_14))) == []
    await post(api_client, world.tenant_2, "after")
    assert bodies(await api_client.get(MESSAGES, headers=as_user(world.owner_14))) == ["after"]


async def test_a_client_sees_that_the_chat_was_off_meanwhile(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    """A client that polled past an off/on cycle with its old cursor learns about it from
    turned_on_at and clears the screen (docs/FRONTEND_GUIDE.md section 20)."""
    await turn(api_client, world, on=True)
    first = await api_client.get(MESSAGES, headers=as_user(world.owner_14))
    since = first.json()["turned_on_at"]
    assert since is not None
    state = (await api_client.get(API, headers=as_user(world.owner_14))).json()
    assert state["turned_on_at"] == since
    cursor = (await post(api_client, world.owner_14, "abusive")).json()["id"]

    await turn(api_client, world, on=False)
    assert (await api_client.get(API, headers=as_user(world.owner_14))).json()[
        "turned_on_at"
    ] is None
    await turn(api_client, world, on=True)
    later = await api_client.get(
        MESSAGES, params={"after": cursor}, headers=as_user(world.owner_14)
    )
    assert later.json()["turned_on_at"] != since


async def test_saving_the_switch_again_keeps_the_messages(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await turn(api_client, world, on=True)
    await post(api_client, world.owner_14, "still here")
    since = (await api_client.get(API, headers=as_user(world.owner_14))).json()["turned_on_at"]
    await turn(api_client, world, on=True)  # e.g. a settings form that saves every value
    assert bodies(await api_client.get(MESSAGES, headers=as_user(world.owner_14))) == ["still here"]
    assert (await api_client.get(API, headers=as_user(world.owner_14))).json()[
        "turned_on_at"
    ] == since


async def test_the_purge_deletes_what_may_no_longer_be_read(
    db_app, db_session: AsyncSession, world: IssueWorld
) -> None:
    now = datetime.now(UTC)
    since = now - timedelta(hours=1)
    await turned_on_since(db_session, world.building, since)
    old = await stored(
        db_session, world.building, world.owner_14, now - timedelta(hours=2, seconds=1)
    )
    before_on = await stored(
        db_session, world.building, world.owner_14, since - timedelta(minutes=1)
    )
    kept = await stored(db_session, world.building, world.owner_14, now - timedelta(minutes=5))
    other = await db_session.get(Building, world.other_resident.building_id)
    assert other is not None
    switched_off = await stored(db_session, other, world.other_resident, now - timedelta(minutes=5))
    ids = {old.id, before_on.id, kept.id, switched_off.id}

    deleted = await purge_tick(db_app.state.chat_session_factory, now=now)

    assert deleted == 3
    left = set(await db_session.scalars(select(ChatMessage.id).where(ChatMessage.id.in_(ids))))
    assert left == {kept.id}
    assert await purge_tick(db_app.state.chat_session_factory, now=now) == 0


async def test_the_text_never_reaches_the_logs(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld, log_capture
) -> None:
    await turn(api_client, world, on=True)
    secret = "The spare key is under the mat 7f3a"
    assert (await post(api_client, world.owner_14, secret)).status_code == 201
    await api_client.get(MESSAGES, headers=as_user(world.tenant_2))
    for i in range(10):
        await post(api_client, world.owner_14, f"{secret} {i}")
    assert "7f3a" not in log_capture.raw
    count = await db_session.scalar(select(func.count()).select_from(ChatMessage))
    assert count == 10, "the 11th message was refused"


async def test_the_purge_skips_a_round_while_another_process_runs_it(
    db_app, db_engine, world: IssueWorld
) -> None:
    async with db_engine.connect() as other:
        await other.begin()
        await other.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": PURGE_LOCK_KEY}
        )
        assert await purge_tick(db_app.state.chat_session_factory) is None
        await other.rollback()


def test_a_message_never_shows_its_text_in_a_repr() -> None:
    message = ChatMessage(id=7, building_id=uuid.uuid4(), body="secret text")
    assert "secret" not in repr(message)


async def test_successful_polls_write_no_request_log(
    api_client: AsyncClient, world: IssueWorld, log_capture
) -> None:
    """Polling every few seconds must not push the other logs out of the rotated log."""

    def request_logs() -> list[tuple[str, str, int]]:
        return [
            (r["method"], r["path"], r["status_code"])
            for r in log_capture.records
            if r["event"] == "http_request"
        ]

    await api_client.get(MESSAGES, headers=as_user(world.owner_14))  # off: 409, logged
    await turn(api_client, world, on=True)
    await api_client.get(API, headers=as_user(world.owner_14))
    await api_client.get(MESSAGES, headers=as_user(world.owner_14))
    await post(api_client, world.owner_14)
    await api_client.get(MESSAGES, headers=as_user(world.accountant))  # 403, logged

    logged = request_logs()
    assert ("GET", "/api/v1/chat/messages", 409) in logged
    assert ("GET", "/api/v1/chat/messages", 403) in logged
    assert ("POST", "/api/v1/chat/messages", 201) in logged
    assert ("PUT", "/api/v1/settings", 200) in logged
    assert ("GET", "/api/v1/chat/messages", 200) not in logged
    assert ("GET", "/api/v1/chat", 200) not in logged
