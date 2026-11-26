"""Migration 037: objects of several kinds (epic E14, task K1)."""

import asyncio
import uuid

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from src.core.migrations import alembic_config
from tests.db_utils import scratch_database


async def _run(url: str, statement: str, **values: object) -> None:
    engine = create_async_engine(url)
    async with engine.begin() as connection:
        await connection.execute(text(statement), values)
    await engine.dispose()


async def _refused(connection: AsyncConnection, statement: str, **values: object) -> bool:
    """Whether the database refuses the insert (in a savepoint, so the test goes on)."""
    try:
        async with connection.begin_nested():
            await connection.execute(text(statement), values)
    except IntegrityError:
        return True
    return False


async def _objects(url: str, columns: str = "kind, number, entrance, floor") -> list[tuple]:
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        rows = (
            await connection.execute(
                text(f"SELECT {columns} FROM property_apartments ORDER BY number, entrance")
            )
        ).all()
    await engine.dispose()
    return [tuple(row) for row in rows]


INSERT = (
    "INSERT INTO property_apartments (id, building_id, number, entrance, floor, area_m2{kind}) "
    "VALUES (gen_random_uuid(), :building, :number, :entrance, :floor, :area{value})"
)
OLD_RELEASE = INSERT.format(kind="", value="")
NEW_RELEASE = INSERT.format(kind=", kind", value=", :kind")


async def test_objects_get_a_kind_and_apartments_keep_their_fields(database_url: str) -> None:
    async with scratch_database(database_url) as url:
        config = alembic_config(url)
        await asyncio.to_thread(command.upgrade, config, "036")
        building = uuid.uuid4()
        await _run(
            url,
            "INSERT INTO property_buildings (id, name, address) VALUES (:id, 'B', 'A')",
            id=building,
        )
        await _run(url, OLD_RELEASE, building=building, number="1", entrance=1, floor=2, area=50)

        await asyncio.to_thread(command.upgrade, config, "037")

        engine = create_async_engine(url)
        async with engine.begin() as connection:
            garage = {"building": building, "kind": "GARAGE", "entrance": None}
            # An insert as the previous release writes it is an apartment.
            assert not await _refused(
                connection, OLD_RELEASE, building=building, number="2", entrance=1, floor=1, area=40
            )
            # Apartment 1 and Garage 1 both exist; a garage may be underground, without an area.
            assert not await _refused(
                connection, NEW_RELEASE, number="1", floor=-1, area=None, **garage
            )
            assert await _refused(
                connection, NEW_RELEASE, number="1", floor=None, area=None, **garage
            )
            assert await _refused(
                connection, NEW_RELEASE, **{**garage, "entrance": 1}, number="3", floor=1, area=None
            )
            apartment = {"building": building, "kind": "APARTMENT", "entrance": 1}
            assert await _refused(
                connection, NEW_RELEASE, **apartment, number="4", floor=1, area=None
            )
            assert await _refused(
                connection, NEW_RELEASE, **apartment, number="5", floor=None, area=9
            )
            assert await _refused(
                connection,
                NEW_RELEASE,
                **{**apartment, "entrance": None},
                number="6",
                floor=1,
                area=9,
            )
            assert await _refused(
                connection,
                NEW_RELEASE,
                **{**apartment, "kind": "CELLAR"},
                number="7",
                floor=1,
                area=9,
            )
        await engine.dispose()

        assert await _objects(url) == [
            ("APARTMENT", "1", 1, 2),
            ("GARAGE", "1", None, -1),
            ("APARTMENT", "2", 1, 1),
        ]

        # The previous release would take the garage for an apartment: the downgrade refuses.
        with pytest.raises(RuntimeError, match="parking spaces or garages"):
            await asyncio.to_thread(command.downgrade, config, "036")
        await _run(url, "DELETE FROM property_apartments WHERE kind = 'GARAGE'")
        await asyncio.to_thread(command.downgrade, config, "036")
        assert await _objects(url, "number, entrance, floor") == [("1", 1, 2), ("2", 1, 1)]
