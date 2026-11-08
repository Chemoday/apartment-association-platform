"""Building settings changed by the chairman (epic E9, task I0; docs/API.md section 9)."""

import asyncio
from dataclasses import dataclass

import pytest
from alembic import command
from httpx import AsyncClient, Response
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.building_settings import (
    BoolSetting,
    BuildingSettingChange,
    BuildingSettingRecord,
    BuildingSettings,
    IntSetting,
    SettingsRegistry,
    SettingsUpdate,
    get_settings_registry,
)
from src.core.database import build_engine
from src.core.migrations import alembic_config
from src.core.security import DEMO_USER_HEADER
from src.modules.issues.settings import (
    REPORTS_PER_APARTMENT_PER_DAY,
    URGENT_ENABLED,
    URGENT_PER_APARTMENT_PER_DAY,
)
from src.modules.property.models import Building, User
from src.modules.property.schemas import BuildingRole
from src.modules.property.service import PropertyService
from tests.db_utils import scratch_database
from tests.factories import create_building, create_demo_building, create_membership, create_user

API = "/api/v1/settings"
REPORTS = REPORTS_PER_APARTMENT_PER_DAY.key
URGENT = URGENT_ENABLED.key
URGENT_LIMIT = URGENT_PER_APARTMENT_PER_DAY.key


@dataclass
class World:
    building: Building
    chairman: User
    board: User
    accountant: User
    resident: User
    other_chairman: User


@pytest.fixture
async def world(db_session: AsyncSession) -> World:
    demo = await create_demo_building(db_session)
    board = await create_user(db_session, demo.building, "Peeter Saar", role=BuildingRole.BOARD)
    await create_membership(db_session, board, demo.apt_14)
    accountant = await create_user(
        db_session, demo.building, "Anna Kask", role=BuildingRole.ACCOUNTANT
    )
    other = await create_building(db_session, name="KÜ Tamme 3")
    other_chairman = await create_user(db_session, other, "Kalle Kask", role=BuildingRole.CHAIRMAN)
    return World(
        building=demo.building,
        chairman=demo.chairman,
        board=board,
        accountant=accountant,
        resident=demo.owner_14,
        other_chairman=other_chairman,
    )


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


async def put(client: AsyncClient, user: User, values: dict) -> Response:
    return await client.put(API, json={"values": values}, headers=as_user(user))


def by_key(response: Response) -> dict[str, dict]:
    assert response.status_code == 200, response.text
    return {item["key"]: item for item in response.json()["settings"]}


async def changes(session: AsyncSession) -> list[tuple]:
    rows = await session.execute(
        select(
            BuildingSettingChange.key,
            BuildingSettingChange.old_value,
            BuildingSettingChange.new_value,
        ).order_by(BuildingSettingChange.changed_at, BuildingSettingChange.key)
    )
    return [tuple(row) for row in rows]


# --- Declarations --------------------------------------------------------------------------------


def test_the_issue_settings_are_declared_with_their_defaults() -> None:
    specs = {spec.key: spec for spec in get_settings_registry().specs()}

    assert specs[REPORTS] == IntSetting(REPORTS, default=3, minimum=1, maximum=20)
    assert specs[URGENT] == BoolSetting(URGENT, default=False)
    assert specs[URGENT_LIMIT] == IntSetting(URGENT_LIMIT, default=1, minimum=1, maximum=5)


@pytest.mark.parametrize(
    "specs",
    [
        [BoolSetting("a.flag", False), BoolSetting("a.flag", True)],
        [IntSetting("a.limit", default=0, minimum=1, maximum=5)],
        [BoolSetting("no_module", False)],
        [BoolSetting("a." + "x" * 63, False)],
    ],
    ids=["twice", "default-out-of-bounds", "no-module-prefix", "too-long"],
)
def test_a_wrong_declaration_fails_at_start(specs: list) -> None:
    with pytest.raises(ValueError):
        SettingsRegistry(specs)


@pytest.mark.parametrize(
    ("spec", "value", "fits"),
    [
        (IntSetting("a.n", default=1, minimum=1, maximum=5), 5, True),
        (IntSetting("a.n", default=1, minimum=1, maximum=5), 6, False),
        (IntSetting("a.n", default=1, minimum=1, maximum=5), True, False),
        (IntSetting("a.n", default=1, minimum=1, maximum=5), 2.0, False),
        (BoolSetting("a.b", default=False), True, True),
        (BoolSetting("a.b", default=False), 1, False),
    ],
)
def test_a_value_must_fit_its_declaration(spec, value, fits: bool) -> None:
    assert (spec.problem(value) is None) is fits


# --- Reading -------------------------------------------------------------------------------------


async def test_the_board_reads_every_setting_with_its_default(
    api_client: AsyncClient, world: World
) -> None:
    for user in (world.chairman, world.board):
        settings = by_key(await api_client.get(API, headers=as_user(user)))

        assert list(settings) == sorted(settings)
        assert settings[REPORTS] == {
            "key": REPORTS,
            "type": "INTEGER",
            "value": 3,
            "default": 3,
            "minimum": 1,
            "maximum": 20,
            "is_default": True,
            "updated_at": None,
        }
        assert settings[URGENT] == {
            "key": URGENT,
            "type": "BOOLEAN",
            "value": False,
            "default": False,
            "minimum": None,
            "maximum": None,
            "is_default": True,
            "updated_at": None,
        }


async def test_residents_and_the_accountant_cannot_read_or_change(
    api_client: AsyncClient, world: World
) -> None:
    for user in (world.resident, world.accountant):
        read = await api_client.get(API, headers=as_user(user))
        change = await put(api_client, user, {URGENT: True})
        assert (read.status_code, read.json()["error_code"]) == (403, "FORBIDDEN")
        assert (change.status_code, change.json()["error_code"]) == (403, "FORBIDDEN")
    board_change = await put(api_client, world.board, {URGENT: True})
    assert (board_change.status_code, board_change.json()["error_code"]) == (403, "FORBIDDEN")
    assert (await api_client.get(API)).status_code == 401


# --- Changing ------------------------------------------------------------------------------------


async def test_the_chairman_changes_and_resets_settings(
    api_client: AsyncClient, db_session: AsyncSession, world: World
) -> None:
    changed = by_key(await put(api_client, world.chairman, {URGENT: True, REPORTS: 5}))

    assert (changed[URGENT]["value"], changed[URGENT]["is_default"]) == (True, False)
    assert changed[REPORTS]["value"] == 5 and changed[REPORTS]["updated_at"] is not None
    assert changed[URGENT_LIMIT]["is_default"] is True
    service = BuildingSettings(db_session)
    assert await service.get(world.building.id, URGENT_ENABLED) is True
    assert await service.get(world.building.id, REPORTS_PER_APARTMENT_PER_DAY) == 5

    reset = by_key(await put(api_client, world.chairman, {REPORTS: None}))

    assert (reset[REPORTS]["value"], reset[REPORTS]["is_default"]) == (3, True)
    assert reset[REPORTS]["updated_at"] is None
    assert await service.get(world.building.id, REPORTS_PER_APARTMENT_PER_DAY) == 3
    assert await changes(db_session) == [
        (REPORTS, None, 5),
        (URGENT, None, True),
        (REPORTS, 5, None),
    ]


async def test_setting_the_same_value_again_logs_nothing(
    api_client: AsyncClient, db_session: AsyncSession, world: World
) -> None:
    await put(api_client, world.chairman, {REPORTS: 4})

    again = await put(api_client, world.chairman, {REPORTS: 4, URGENT_LIMIT: None})

    assert again.status_code == 200
    assert await changes(db_session) == [(REPORTS, None, 4)]


@pytest.mark.parametrize(
    ("values", "problem_key"),
    [
        ({"issues.unknown": 1}, "issues.unknown"),
        ({REPORTS: 21}, REPORTS),
        ({REPORTS: 0}, REPORTS),
        ({REPORTS: True}, REPORTS),
        ({URGENT: 1}, URGENT),
    ],
)
async def test_a_wrong_entry_changes_nothing(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: World,
    values: dict,
    problem_key: str,
) -> None:
    response = await put(api_client, world.chairman, {URGENT_LIMIT: 2, **values})

    assert response.status_code == 422, response.text
    body = response.json()
    assert body["error_code"] == "VALIDATION_ERROR"
    assert [error["loc"] for error in body["errors"]] == [["body", "values", problem_key]]
    assert await changes(db_session) == []
    assert by_key(await api_client.get(API, headers=as_user(world.chairman)))[URGENT_LIMIT][
        "is_default"
    ]


@pytest.mark.parametrize(
    "body",
    [
        {"values": {}},
        {"values": {REPORTS: "3"}},
        {"values": {REPORTS: 3.0}},
        {"values": {f"a.k{index}": 1 for index in range(51)}},
        {"values": {REPORTS: 3}, "extra": True},
    ],
    ids=["empty", "string", "float", "too-many", "unknown-field"],
)
async def test_a_malformed_body_is_a_validation_error(
    api_client: AsyncClient, world: World, body: dict
) -> None:
    response = await api_client.put(API, json=body, headers=as_user(world.chairman))

    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


async def test_each_building_has_its_own_settings(
    api_client: AsyncClient, db_session: AsyncSession, world: World
) -> None:
    await put(api_client, world.other_chairman, {URGENT: True})

    mine = by_key(await api_client.get(API, headers=as_user(world.chairman)))

    assert mine[URGENT]["value"] is False
    assert await BuildingSettings(db_session).get(world.building.id, URGENT_ENABLED) is False


async def test_a_stored_value_that_no_longer_fits_reads_as_the_default(
    api_client: AsyncClient, db_session: AsyncSession, world: World
) -> None:
    await put(api_client, world.chairman, {REPORTS: 20})
    # As if a later release narrowed the bounds below the stored value.
    narrowed = SettingsRegistry([IntSetting(REPORTS, default=3, minimum=1, maximum=10)])

    value = await BuildingSettings(db_session, narrowed).get(
        world.building.id, narrowed.get(REPORTS)
    )

    assert value == 3
    stored = await db_session.scalar(select(func.count()).select_from(BuildingSettingRecord))
    assert stored == 1, "the stored row stays until the chairman sets a new value"


async def test_changing_a_value_answers_with_the_new_one(
    api_client: AsyncClient, db_session: AsyncSession, world: World
) -> None:
    await put(api_client, world.chairman, {REPORTS: 4})

    changed = by_key(await put(api_client, world.chairman, {REPORTS: 5, URGENT_LIMIT: 1}))

    assert (changed[REPORTS]["value"], changed[REPORTS]["is_default"]) == (5, False)
    assert changed[URGENT_LIMIT]["is_default"] is True, "the default again is a no-op"
    assert await changes(db_session) == [(REPORTS, None, 4), (REPORTS, 4, 5)]
    who = set(await db_session.scalars(select(BuildingSettingChange.changed_by_user_id)))
    assert who == {world.chairman.id}


async def test_a_stored_value_out_of_bounds_shows_the_default_until_overwritten(
    api_client: AsyncClient, db_session: AsyncSession, world: World
) -> None:
    await put(api_client, world.chairman, {REPORTS: 4})
    await db_session.execute(
        update(BuildingSettingRecord).where(BuildingSettingRecord.key == REPORTS).values(value=30)
    )

    shown = by_key(await api_client.get(API, headers=as_user(world.board)))[REPORTS]
    overwritten = by_key(await put(api_client, world.chairman, {REPORTS: 6}))[REPORTS]

    assert (shown["value"], shown["is_default"], shown["updated_at"]) == (3, True, None)
    assert (overwritten["value"], overwritten["is_default"]) == (6, False)
    assert (await changes(db_session))[-1] == (REPORTS, 30, 6), "the log keeps the real old value"


async def test_two_chairman_changes_at_once_are_logged_in_order(database_url: str) -> None:
    """Real concurrency on committed data: the second change waits for the first."""
    async with scratch_database(database_url) as url:
        await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
        engine = build_engine(url)
        try:
            async with AsyncSession(engine, expire_on_commit=False) as session:
                demo = await create_demo_building(session)
                await session.commit()
            async with AsyncSession(engine) as first, AsyncSession(engine) as second:
                one = await PropertyService(first).get_current_user(demo.chairman.id)
                two = await PropertyService(second).get_current_user(demo.chairman.id)
                await BuildingSettings(first).update(one, SettingsUpdate(values={REPORTS: 5}))
                waiting = asyncio.create_task(
                    BuildingSettings(second).update(two, SettingsUpdate(values={REPORTS: 7}))
                )
                await asyncio.sleep(0.5)
                assert not waiting.done(), "the second change waits for the building's lock"
                await first.commit()
                view = await waiting
                await second.commit()
            assert {item.key: item.value for item in view.settings}[REPORTS] == 7
            async with AsyncSession(engine) as check:
                assert await changes(check) == [(REPORTS, None, 5), (REPORTS, 5, 7)]
        finally:
            await engine.dispose()
