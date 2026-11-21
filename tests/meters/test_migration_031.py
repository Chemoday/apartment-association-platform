"""Migration 031 (epic E13 R3b): where the previous value of every existing reading came from."""

import asyncio
import uuid

from alembic import command
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from src.core.migrations import alembic_config
from tests.db_utils import scratch_database


async def test_existing_readings_get_initial_then_history(database_url: str) -> None:
    async with scratch_database(database_url) as url:
        config = alembic_config(url)
        await asyncio.to_thread(command.upgrade, config, "030")
        engine = create_async_engine(url)
        building, meter = uuid.uuid4(), uuid.uuid4()
        periods = {code: uuid.uuid4() for code in ("2026-08", "2026-09", "2026-10")}
        readings = {code: uuid.uuid4() for code in periods}
        async with engine.begin() as connection:
            await connection.execute(
                text("INSERT INTO property_buildings (id, name, address) VALUES (:id, 'B', 'A')"),
                {"id": building},
            )
            await connection.execute(
                text(
                    "INSERT INTO meters_devices (id, building_id, resource_type, serial_number, "
                    "initial_value) VALUES (:id, :building, 'COLD_WATER', 'SN', 100)"
                ),
                {"id": meter, "building": building},
            )
            previous = 100
            # Inserted out of order on purpose: the migration ranks by period, not by row order.
            for code in ("2026-10", "2026-08", "2026-09"):
                await connection.execute(
                    text(
                        "INSERT INTO meters_periods (id, building_id, period_code, status, "
                        "due_date) VALUES (:id, :building, :code, 'LOCKED', now())"
                    ),
                    {"id": periods[code], "building": building, "code": code},
                )
            for code in ("2026-08", "2026-09", "2026-10"):
                await connection.execute(
                    text(
                        "INSERT INTO meters_readings (id, building_id, meter_id, period_id, "
                        "value, previous_value, consumption_delta, source) VALUES (:id, "
                        ":building, :meter, :period, :value, :previous, 5, 'RESIDENT')"
                    ),
                    {
                        "id": readings[code],
                        "building": building,
                        "meter": meter,
                        "period": periods[code],
                        "value": previous + 5,
                        "previous": previous,
                    },
                )
                previous += 5
        await engine.dispose()

        await asyncio.to_thread(command.upgrade, config, "031")

        engine = create_async_engine(url)
        async with engine.connect() as connection:
            origins = dict(
                (
                    await connection.execute(
                        text(
                            "SELECT p.period_code, r.previous_origin FROM meters_readings r "
                            "JOIN meters_periods p ON p.id = r.period_id"
                        )
                    )
                ).all()
            )
            nullable = dict(
                (
                    await connection.execute(
                        text(
                            "SELECT column_name, is_nullable FROM information_schema.columns "
                            "WHERE table_name = 'meters_devices' "
                            "AND column_name IN ('serial_number', 'initial_value')"
                        )
                    )
                ).all()
            )
        await engine.dispose()

    assert origins == {"2026-08": "INITIAL", "2026-09": "HISTORY", "2026-10": "HISTORY"}
    assert nullable == {"serial_number": "YES", "initial_value": "YES"}


async def test_the_downgrade_fills_what_was_left_unknown(database_url: str) -> None:
    async with scratch_database(database_url) as url:
        config = alembic_config(url)
        await asyncio.to_thread(command.upgrade, config, "031")
        engine = create_async_engine(url)
        building = uuid.uuid4()
        async with engine.begin() as connection:
            await connection.execute(
                text("INSERT INTO property_buildings (id, name, address) VALUES (:id, 'B', 'A')"),
                {"id": building},
            )
            await connection.execute(
                text(
                    "INSERT INTO meters_devices (id, building_id, resource_type) "
                    "VALUES (gen_random_uuid(), :building, 'COLD_WATER')"
                ),
                {"building": building},
            )
        await engine.dispose()

        await asyncio.to_thread(command.downgrade, config, "030")

        engine = create_async_engine(url)
        async with engine.connect() as connection:
            row = (
                await connection.execute(
                    text("SELECT serial_number, initial_value FROM meters_devices")
                )
            ).one()
        await engine.dispose()

    assert (row.serial_number, row.initial_value) == ("", 0)
