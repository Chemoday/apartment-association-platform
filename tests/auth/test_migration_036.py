"""Migration 036: the stored phones of users and join requests in E.164 form (issue #179)."""

import asyncio
import importlib.util
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pytest
from alembic import command
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from src.core.migrations import alembic_config
from src.core.validation import PhoneNumber
from tests.db_utils import scratch_database

USERS = {
    "+372 5765 4321": "+37257654321",
    "+372 (5000) 00-01": "+37250000001",
    "+37255551234": "+37255551234",
    "+44 20 7946 0958": "+442079460958",
    "5765 4321": None,  # no country code: never guessed
    "call me in the evening": None,
    "+372 1": None,
}
REQUESTS = {"+372 5999 8888": "+37259998888", "(0) 555-1234": None, "12345": None}


async def _insert(url: str) -> None:
    engine = create_async_engine(url)
    async with engine.begin() as connection:
        building, apartment = uuid.uuid4(), uuid.uuid4()
        await connection.execute(
            text("INSERT INTO property_buildings (id, name, address) VALUES (:id, 'B', 'A')"),
            {"id": building},
        )
        await connection.execute(
            text(
                "INSERT INTO property_apartments (id, building_id, number, area_m2) "
                "VALUES (:id, :building, '14', 50)"
            ),
            {"id": apartment, "building": building},
        )
        for phone in [*USERS, None]:
            await connection.execute(
                text(
                    "INSERT INTO core_users (id, building_id, full_name, phone) "
                    "VALUES (:id, :building, :name, :phone)"
                ),
                {"id": uuid.uuid4(), "building": building, "name": phone or "-", "phone": phone},
            )
        for phone in REQUESTS:
            await connection.execute(
                text(
                    "INSERT INTO auth_join_requests "
                    "(id, building_id, apartment_id, full_name, phone, email, created_at) "
                    "VALUES (:id, :building, :apartment, :phone, :phone, 'x@example.com', :now)"
                ),
                {
                    "id": uuid.uuid4(),
                    "building": building,
                    "apartment": apartment,
                    "phone": phone,
                    "now": datetime.now(UTC),
                },
            )
    await engine.dispose()


async def _phones(url: str, table: str) -> dict[str, str | None]:
    """The phone of every row by its full_name, which holds the phone as it was typed."""
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        rows = (await connection.execute(text(f"SELECT full_name, phone FROM {table}"))).all()
    await engine.dispose()
    return {name: phone for name, phone in rows}


async def _outcomes(url: str) -> list[str]:
    engine = create_async_engine(url)
    async with engine.connect() as connection:
        rows = list(
            await connection.scalars(
                text(
                    "SELECT outcome FROM auth_join_decisions "
                    "WHERE apartment_id IS NOT NULL AND decided_by_user_id IS NULL"
                )
            )
        )
    await engine.dispose()
    return rows


async def test_the_migration_stores_phones_in_e164_form_and_drops_the_rest(
    database_url: str,
) -> None:
    async with scratch_database(database_url) as url:
        config = alembic_config(url)
        await asyncio.to_thread(command.upgrade, config, "035")
        await _insert(url)

        await asyncio.to_thread(command.upgrade, config, "036")

        assert await _phones(url, "core_users") == {**USERS, "-": None}
        # A request needs a phone: one that is not a valid number goes with its request, and
        # leaves an EXPIRED decision like the daily clean-up of old requests.
        assert await _phones(url, "auth_join_requests") == {"+372 5999 8888": "+37259998888"}
        assert await _outcomes(url) == ["EXPIRED", "EXPIRED"]

        # One way: a downgrade keeps the E.164 numbers.
        await asyncio.to_thread(command.downgrade, config, "035")
        assert (await _phones(url, "core_users"))["+372 5765 4321"] == "+37257654321"


def _migration_rule():
    path = Path(__file__).parents[2] / "alembic" / "versions" / "036_phones_in_e164.py"
    spec = importlib.util.spec_from_file_location("migration_036", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._e164


@pytest.mark.parametrize(
    "typed",
    [
        *USERS,
        *REQUESTS,
        "  +372 5765 4321  ",
        "+372\u00a05765\u00a04321",
        "\u202a+372 5765 4321\u202c",
        "\uff0b\uff13\uff17\uff12 5765 4321",
        "+372 5765 4321\x0b",
        "\x1f+372 5765 4321",
        "+372\u00005765 4321",
        "+372.5765.4321",
        "+372\u20115765\u20134321",
        "+372 5765 4321" + "\u200b" * 120,
        "+372 5765 4321 ext 7",
        "+" + "5" * 32,
        "",
    ],
)
def test_the_migration_and_the_api_follow_the_same_rule(typed: str) -> None:
    try:
        expected = TypeAdapter(PhoneNumber).validate_python(typed)
    except ValidationError:
        expected = None
    assert _migration_rule()(typed) == expected
