"""Migration 038: targets by kind on posts, polls and maintenance notices (epic E14, task K2)."""

import asyncio
import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from alembic import command
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from src.core.migrations import alembic_config
from tests.db_utils import scratch_database

POST = (
    "INSERT INTO comm_posts (id, building_id, author_user_id, post_type, title, body,"
    " target_scope, target_entrance, target_apartment_ids{kinds})"
    " VALUES (gen_random_uuid(), :building, :user, :type, 'T', 'B', :scope, :entrance,"
    " CAST(:ids AS jsonb){value})"
)
POLL = (
    "INSERT INTO gov_polls (id, building_id, created_by_user_id, kind, title, target_scope,"
    " target_entrance, target_apartment_ids, eligibility, unit, closes_at, status, created_at,"
    " updated_at{kinds})"
    " VALUES (gen_random_uuid(), :building, :user, 'INFORMATIVE', 'P', :scope, :entrance,"
    " CAST(:ids AS jsonb), 'RESIDENTS', 'APARTMENT', :closes, 'DRAFT', :now, :now{value})"
)
TASK = (
    "INSERT INTO maint_tasks (id, building_id, title, period_unit, period_count, lead_days,"
    " anchor_date, anchor_day, status, created_by_user_id, updated_by_user_id, notice_title,"
    " notice_body, notice_category, notice_target_scope, notice_target_entrance,"
    " notice_target_apartment_ids, notice_comments_enabled{kinds})"
    " VALUES (gen_random_uuid(), :building, 'T', 'MONTH', 1, 0, :anchor, 1, 'ACTIVE', :user,"
    " :user, 'N', 'B', 'MAINTENANCE', :scope, :entrance, CAST(:ids AS jsonb), false{value})"
)


def old(statement: str) -> str:
    return statement.format(kinds="", value="")


_KIND_COLUMN = {POST: "target_kinds", POLL: "target_kinds", TASK: "notice_target_kinds"}


def new(statement: str) -> str:
    return statement.format(kinds=f", {_KIND_COLUMN[statement]}", value=", CAST(:kinds AS jsonb)")


async def _refused(connection: AsyncConnection, statement: str, values: dict) -> bool:
    try:
        async with connection.begin_nested():
            await connection.execute(text(statement), values)
    except IntegrityError:
        return True
    return False


async def _world(url: str) -> dict:
    engine = create_async_engine(url)
    building, user = uuid.uuid4(), uuid.uuid4()
    async with engine.begin() as connection:
        await connection.execute(
            text("INSERT INTO property_buildings (id, name, address) VALUES (:id, 'B', 'A')"),
            {"id": building},
        )
        await connection.execute(
            text(
                "INSERT INTO core_users (id, building_id, full_name, building_role)"
                " VALUES (:id, :building, 'Chair', 'CHAIRMAN')"
            ),
            {"id": user, "building": building},
        )
    await engine.dispose()
    now = datetime.now(UTC)
    return {
        "building": building,
        "user": user,
        "type": "OFFICIAL_NOTICE",
        "entrance": None,
        "ids": None,
        "closes": now + timedelta(days=7),
        "now": now,
        "anchor": date(2027, 1, 1),
    }


@pytest.mark.parametrize("statement", [POST, POLL, TASK], ids=["post", "poll", "task"])
async def test_targets_by_kind_are_checked_and_block_the_downgrade(
    database_url: str, statement: str
) -> None:
    async with scratch_database(database_url) as url:
        config = alembic_config(url)
        await asyncio.to_thread(command.upgrade, config, "037")
        values = await _world(url)
        engine = create_async_engine(url)
        async with engine.begin() as connection:
            await connection.execute(text(old(statement)), {**values, "scope": "ALL_BUILDING"})
        await engine.dispose()

        await asyncio.to_thread(command.upgrade, config, "038")

        engine = create_async_engine(url)
        async with engine.begin() as connection:
            row = {**values, "scope": "ALL_BUILDING", "kinds": None}
            # The previous release writes no kinds; the new scopes and kinds are accepted.
            assert not await _refused(connection, old(statement), row)
            assert not await _refused(connection, new(statement), {**row, "scope": "ALL_OBJECTS"})
            kinds = {**row, "scope": "KINDS", "kinds": '["PARKING", "GARAGE"]'}
            assert not await _refused(connection, new(statement), kinds)
            for wrong in ('["CELLAR"]', "[]", "[1]", '"PARKING"', '{"a": 1}'):
                assert await _refused(connection, new(statement), {**kinds, "kinds": wrong}), wrong
            assert await _refused(connection, new(statement), {**kinds, "kinds": None})
            assert await _refused(connection, new(statement), {**row, "kinds": '["PARKING"]'}), (
                "kinds on another scope"
            )
        await engine.dispose()

        with pytest.raises(RuntimeError, match="everything or to kinds"):
            await asyncio.to_thread(command.downgrade, config, "037")
        table = {POST: "comm_posts", POLL: "gov_polls", TASK: "maint_tasks"}[statement]
        column = "notice_target_scope" if statement is TASK else "target_scope"
        engine = create_async_engine(url)
        async with engine.begin() as connection:
            await connection.execute(
                text(f"DELETE FROM {table} WHERE {column} IN ('ALL_OBJECTS', 'KINDS')")
            )
        await engine.dispose()
        await asyncio.to_thread(command.downgrade, config, "037")


async def test_a_forum_topic_may_be_stored_to_everything_or_to_kinds(database_url: str) -> None:
    async with scratch_database(database_url) as url:
        config = alembic_config(url)
        await asyncio.to_thread(command.upgrade, config, "038")
        values = {**await _world(url), "type": "FORUM_TOPIC", "kinds": None}
        engine = create_async_engine(url)
        async with engine.begin() as connection:
            for scope, kinds in (("ALL_OBJECTS", None), ("KINDS", '["GARAGE"]')):
                assert not await _refused(
                    connection, new(POST), {**values, "scope": scope, "kinds": kinds}
                )
            assert await _refused(
                connection, new(POST), {**values, "scope": "ENTRANCE", "entrance": 1}
            )
        await engine.dispose()
