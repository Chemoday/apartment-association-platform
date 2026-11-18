"""The operator command create-building (docs/API.md section 1, "The building of a new
installation"; epic E13 task R2)."""

import asyncio
import io
from contextlib import asynccontextmanager

import pytest
from alembic import command
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.core.database import build_engine
from src.core.instance import InstanceRecord
from src.core.migrations import alembic_config
from src.modules.property.__main__ import create_building, main
from src.modules.property.models import Building
from src.modules.property.service import PropertyService
from tests.db_utils import scratch_database
from tests.factories import create_building as create_existing_building

FIELDS = {
    "name": "KÜ Näide 5",
    "address": "Näide tn 5, Tallinn",
    "country": "EE",
    "registry_code": "80123456",
    "reading_deadline_day": 4,
}


@pytest.fixture(autouse=True)
async def real_installation(db_session: AsyncSession) -> None:
    """create-building works only on a database marked as a real installation."""
    db_session.add(InstanceRecord(id=1, instance_id="assoc-1", demo=False))
    # Committed like the data of a running installation: a refusal rolls back only the command.
    await db_session.commit()


def factory_of(session: AsyncSession):
    @asynccontextmanager
    async def factory():
        yield session

    return factory


async def run(session: AsyncSession, **changes: object) -> tuple[int, str]:
    out = io.StringIO()
    code = await create_building(factory_of(session), **{**FIELDS, **changes}, out=out)
    return code, out.getvalue()


async def buildings(session: AsyncSession) -> list[Building]:
    return list(await session.scalars(select(Building)))


async def test_the_building_of_a_new_installation_is_created(db_session: AsyncSession) -> None:
    code, out = await run(
        db_session,
        name="  KÜ Näide 5 ",
        address=" Näide tn 5, Tallinn",
        country="ee",
        reading_deadline_day=31,
    )

    assert code == 0
    [building] = await buildings(db_session)
    assert out == f"building {building.id} created\n"
    assert (
        building.name,
        building.address,
        building.country_code,
        building.registry_code,
        building.reading_deadline_day,
    ) == ("KÜ Näide 5", "Näide tn 5, Tallinn", "EE", "80123456", 31)
    # create-chairman needs exactly one building.
    assert await PropertyService(db_session).building_ids() == [building.id]


async def test_the_defaults_and_no_registry_code(db_session: AsyncSession) -> None:
    code, _ = await run(db_session, registry_code=None)

    assert code == 0
    [building] = await buildings(db_session)
    assert (building.country_code, building.registry_code, building.reading_deadline_day) == (
        "EE",
        None,
        4,
    )


async def test_another_country_takes_its_own_registry_code(db_session: AsyncSession) -> None:
    code, _ = await run(db_session, country="LV", registry_code="40008-ABC")

    assert code == 0
    [building] = await buildings(db_session)
    assert (building.country_code, building.registry_code) == ("LV", "40008-ABC")


@pytest.mark.parametrize("marker", ["demo", "none"])
async def test_it_refuses_unless_the_installation_is_a_real_one(
    db_session: AsyncSession, marker: str
) -> None:
    """In a demo anyone could act as the new building's chairman; without a marker the backend
    has not started yet. The seed never fills a real installation, so the two never race."""
    record = await db_session.get(InstanceRecord, 1)
    if marker == "demo":
        record.demo = True
    else:
        await db_session.delete(record)
    await db_session.commit()

    code, out = await run(db_session)

    assert code == 1
    assert out.startswith("error: the installation is not marked as a real one")
    assert await buildings(db_session) == []


async def test_it_refuses_when_the_installation_has_a_building(db_session: AsyncSession) -> None:
    existing = await create_existing_building(db_session)
    await db_session.commit()

    code, out = await run(db_session)

    assert (code, out) == (1, "error: the installation already has a building\n")
    assert [building.id for building in await buildings(db_session)] == [existing.id]


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"name": "   "}, "error: --name text must not be blank"),
        ({"name": "x" * 256}, "error: --name at most 255 characters"),
        ({"name": "KÜ\x00Näide"}, "error: --name text must not contain control characters"),
        ({"address": ""}, "error: --address text must not be blank"),
        ({"address": "x" * 501}, "error: --address at most 500 characters"),
        ({"country": "EST"}, "error: --country two letters (ISO 3166-1 alpha-2)"),
        ({"country": "E1"}, "error: --country two letters (ISO 3166-1 alpha-2)"),
        ({"country": "\u00df"}, "error: --country two letters (ISO 3166-1 alpha-2)"),
        ({"country": "e\u0131"}, "error: --country two letters (ISO 3166-1 alpha-2)"),
        ({"name": "KÜ\nNäide"}, "error: --name one line of visible text"),
        ({"address": "Näide\ttn 5"}, "error: --address one line of visible text"),
        ({"name": "KÜ \u202eNäide"}, "error: --name one line of visible text"),
        ({"name": "KÜ\u200bNäide"}, "error: --name one line of visible text"),
        ({"name": "KÜ\u2028Näide"}, "error: --name one line of visible text"),
        ({"address": "Näide\u2029tn 5"}, "error: --address one line of visible text"),
        ({"name": "KÜ\x85Näide"}, "error: --name one line of visible text"),
        ({"registry_code": "---"}, "error: --registry-code 1 to 20 letters, digits or '-'"),
        ({"registry_code": ""}, "error: --registry-code 1 to 20 letters, digits or '-'"),
        ({"reading_deadline_day": "abc"}, "error: --reading-deadline-day Input should be a valid"),
        ({"registry_code": "8012 3456"}, "error: --registry-code 1 to 20 letters, digits or '-'"),
        (
            {"registry_code": "8012345"},
            "error: --registry-code an Estonian registry code has exactly 8 digits",
        ),
        ({"reading_deadline_day": 0}, "error: --reading-deadline-day Input should be greater"),
        ({"reading_deadline_day": 32}, "error: --reading-deadline-day Input should be less"),
    ],
)
async def test_every_field_is_checked_before_anything_is_written(
    db_session: AsyncSession, changes: dict, message: str
) -> None:
    code, out = await run(db_session, **changes)

    assert code == 2
    assert out.startswith(message), out
    assert await buildings(db_session) == []


async def test_two_runs_at_once_create_one_building(database_url: str) -> None:
    async with scratch_database(database_url) as url:
        await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
        engine = build_engine(url)
        sessions = async_sessionmaker(engine, expire_on_commit=False)
        async with sessions() as session:
            session.add(InstanceRecord(id=1, instance_id="assoc-1", demo=False))
            await session.commit()
        outs = [io.StringIO(), io.StringIO()]

        codes = await asyncio.gather(
            *(create_building(sessions, **FIELDS, out=out) for out in outs)
        )
        async with sessions() as session:
            count = await session.scalar(select(func.count(Building.id)))
        await engine.dispose()

    assert sorted(codes) == [0, 1]
    assert count == 1


def test_the_command_line(db_session: AsyncSession, capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as missing:
        main(["create-building", "--name", "KÜ Näide 5"], lambda: factory_of(db_session))
    assert missing.value.code == 2
    assert "--address" in capsys.readouterr().err


def test_the_command_line_hands_every_option_to_the_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict] = []

    async def fake(factory, **options):
        calls.append(options)
        return 0

    monkeypatch.setattr("src.modules.property.__main__.create_building", fake)
    argv = ["create-building", "--name", "KÜ Näide 5", "--address", "Näide tn 5"]

    assert main(argv, lambda: None) == 0
    assert (
        main(
            [*argv, "--country", "lv", "--registry-code", "40008", "--reading-deadline-day", "9"],
            lambda: None,
        )
        == 0
    )

    defaults, given = calls
    assert {k: v for k, v in defaults.items() if k != "out"} == {
        "name": "KÜ Näide 5", "address": "Näide tn 5", "country": "EE",
        "registry_code": None, "reading_deadline_day": "4",
    }  # fmt: skip
    assert (given["country"], given["registry_code"], given["reading_deadline_day"]) == (
        "lv", "40008", "9",
    )  # fmt: skip
