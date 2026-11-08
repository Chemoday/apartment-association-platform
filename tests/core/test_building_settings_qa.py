"""QA additions for the building settings (epic E9, task I0; docs/API.md section 9)."""

from datetime import UTC, datetime, timedelta

from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.building_settings import BuildingSettingChange, BuildingSettingRecord
from src.modules.property.models import User
from src.modules.property.schemas import BuildingRole
from tests.conftest import LogCapture
from tests.core.test_building_settings import (
    API,
    REPORTS,
    URGENT,
    URGENT_LIMIT,
    World,
    as_user,
    by_key,
    changes,
    put,
    world,  # noqa: F401
)


async def _stored_rows(session: AsyncSession) -> int:
    return await session.scalar(select(func.count()).select_from(BuildingSettingRecord))


async def test_put_without_credentials_is_not_authenticated(
    api_client: AsyncClient,
    world: World,  # noqa: F811
) -> None:
    response = await api_client.put(API, json={"values": {URGENT: True}})

    assert response.status_code == 401
    assert response.json()["error_code"] == "NOT_AUTHENTICATED"


async def test_the_chairman_of_another_building_cannot_touch_this_one(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: World,  # noqa: F811
) -> None:
    await put(api_client, world.other_chairman, {REPORTS: 7, URGENT: True})

    mine = by_key(await api_client.get(API, headers=as_user(world.board)))
    rows = set(await db_session.scalars(select(BuildingSettingChange.building_id)))

    assert all(item["is_default"] for item in mine.values())
    assert all(item["updated_at"] is None for item in mine.values())
    assert rows == {world.other_chairman.building_id}, "the log rows belong to the other building"


async def test_get_shows_the_time_of_the_last_change(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: World,  # noqa: F811
) -> None:
    before = datetime.now(UTC) - timedelta(seconds=5)
    changed = by_key(await put(api_client, world.chairman, {REPORTS: 5}))

    read = by_key(await api_client.get(API, headers=as_user(world.board)))

    assert read == changed, "PUT answers with the same body as GET"
    stamp = datetime.fromisoformat(read[REPORTS]["updated_at"])
    assert stamp.tzinfo is not None and stamp >= before
    assert (read[REPORTS]["value"], read[REPORTS]["is_default"]) == (5, False)
    assert read[URGENT]["updated_at"] is None, "only the changed setting has a time"

    await db_session.execute(
        update(BuildingSettingRecord)
        .where(BuildingSettingRecord.key == REPORTS)
        .values(updated_at=datetime.now(UTC) - timedelta(days=2))
    )
    again = by_key(await put(api_client, world.chairman, {REPORTS: 6}))
    assert datetime.fromisoformat(again[REPORTS]["updated_at"]) >= before, (
        "a new change, a new time"
    )


async def test_resetting_a_setting_that_was_never_set_is_a_no_op(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: World,  # noqa: F811
) -> None:
    response = await put(api_client, world.chairman, {URGENT: None, REPORTS: None})

    assert response.status_code == 200, response.text
    assert all(item["is_default"] for item in by_key(response).values())
    assert await changes(db_session) == []
    assert await _stored_rows(db_session) == 0


async def test_setting_the_default_explicitly_after_a_change_is_logged_and_kept(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: World,  # noqa: F811
) -> None:
    await put(api_client, world.chairman, {REPORTS: 5})

    back = by_key(await put(api_client, world.chairman, {REPORTS: 3}))
    reset = by_key(await put(api_client, world.chairman, {REPORTS: None}))

    assert back[REPORTS]["value"] == 3 and back[REPORTS]["updated_at"] is not None
    assert (reset[REPORTS]["is_default"], reset[REPORTS]["updated_at"]) == (True, None)
    assert await changes(db_session) == [(REPORTS, None, 5), (REPORTS, 5, 3), (REPORTS, 3, None)]
    assert await _stored_rows(db_session) == 0


async def test_every_wrong_entry_is_reported_once_and_nothing_changes(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: World,  # noqa: F811
) -> None:
    response = await put(
        api_client,
        world.chairman,
        {REPORTS: 0, URGENT: 1, URGENT_LIMIT: 6, "issues.unknown": None, "issues.ok": 2},
    )

    assert response.status_code == 422, response.text
    body = response.json()
    assert body["error_code"] == "VALIDATION_ERROR"
    locs = sorted(tuple(error["loc"]) for error in body["errors"])
    assert locs == sorted(
        ("body", "values", key)
        for key in (REPORTS, URGENT, URGENT_LIMIT, "issues.unknown", "issues.ok")
    ), "one entry per wrong key, an unknown key also with null"
    assert await changes(db_session) == []
    assert await _stored_rows(db_session) == 0


async def test_a_key_longer_than_64_characters_is_refused(
    api_client: AsyncClient,
    world: World,  # noqa: F811
) -> None:
    response = await put(api_client, world.chairman, {"issues." + "x" * 60: 1})

    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


async def test_a_former_chairman_can_no_longer_change_settings(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: World,  # noqa: F811
) -> None:
    await db_session.execute(
        update(User).where(User.id == world.chairman.id).values(building_role=BuildingRole.BOARD)
    )

    change = await put(api_client, world.chairman, {URGENT: True})
    read = await api_client.get(API, headers=as_user(world.chairman))

    assert (change.status_code, change.json()["error_code"]) == (403, "FORBIDDEN")
    assert read.status_code == 200, "a board member still reads them"
    assert await changes(db_session) == []


async def test_a_deactivated_chairman_is_not_authenticated(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: World,  # noqa: F811
) -> None:
    await db_session.execute(
        update(User).where(User.id == world.chairman.id).values(is_active=False)
    )

    response = await put(api_client, world.chairman, {URGENT: True})

    assert (response.status_code, response.json()["error_code"]) == (401, "UNKNOWN_USER")


async def test_no_payload_names_who_changed_a_setting(
    api_client: AsyncClient,
    world: World,  # noqa: F811
) -> None:
    changed = await put(api_client, world.chairman, {URGENT: True})
    read = await api_client.get(API, headers=as_user(world.board))

    for response in (changed, read):
        raw = response.text
        assert str(world.chairman.id) not in raw
        assert "Oleg Sidorov" not in raw and "+372 5000 0001" not in raw
        for item in response.json()["settings"]:
            assert set(item) == {
                "key",
                "type",
                "value",
                "default",
                "minimum",
                "maximum",
                "is_default",
                "updated_at",
            }


async def test_a_change_logs_the_key_but_not_the_values(
    api_client: AsyncClient,
    world: World,  # noqa: F811
    log_capture: LogCapture,
) -> None:
    await put(api_client, world.chairman, {REPORTS: 17})

    events = [r for r in log_capture.records if r.get("event") == "building_setting_changed"]

    assert [event["key"] for event in events] == [REPORTS]
    for event in events:
        assert not {"value", "old_value", "new_value"} & set(event), "values stay in the database"
    assert "Oleg Sidorov" not in log_capture.raw
