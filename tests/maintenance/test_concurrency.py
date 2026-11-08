"""Real concurrency on committed data: two board members close the same occurrence at once."""

import asyncio
from collections.abc import AsyncIterator
from datetime import timedelta

import pytest
from alembic import command
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from src.core.database import build_engine
from src.core.exceptions import DomainError
from src.core.migrations import alembic_config
from src.modules.maintenance.models import LogEntry
from src.modules.maintenance.schemas import DoneRequest, PeriodUnit, TaskCreate
from src.modules.maintenance.service import MaintenanceService
from src.modules.property.service import PropertyService
from tests.db_utils import scratch_database
from tests.maintenance.conftest import MaintWorld, build_maint_world, local_today

BLOCKED = 0.5


@pytest.fixture
async def committed(database_url: str) -> AsyncIterator[tuple[AsyncEngine, MaintWorld, object]]:
    async with scratch_database(database_url) as url:
        await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
        engine = build_engine(url)
        async with AsyncSession(engine, expire_on_commit=False) as session:
            world = await build_maint_world(session)
            service, chairman = await service_for(session, world.chairman.id)
            task = await service.create_task(
                chairman,
                TaskCreate(
                    title="Gutters",
                    period_unit=PeriodUnit.MONTH,
                    period_count=6,
                    first_due_date=local_today() + timedelta(days=30),
                ),
            )
            await session.commit()
        try:
            yield engine, world, task
        finally:
            await engine.dispose()


async def service_for(session: AsyncSession, user_id):
    properties = PropertyService(session)
    return MaintenanceService(session, properties), await properties.get_current_user(user_id)


async def test_two_done_marks_of_one_occurrence_make_one_entry(committed) -> None:
    engine, world, task = committed
    request = DoneRequest(occurrence_id=task.current.occurrence_id, done_on=local_today())
    async with AsyncSession(engine) as first, AsyncSession(engine) as second:
        chair_service, chairman = await service_for(first, world.chairman.id)
        board_service, board = await service_for(second, world.board_15.id)
        await chair_service.mark_done(chairman, task.id, request)
        waiting = asyncio.create_task(board_service.mark_done(board, task.id, request))
        await asyncio.sleep(BLOCKED)
        assert not waiting.done(), "the second mark waits for the task's lock"

        await first.commit()
        with pytest.raises(DomainError) as refused:
            await waiting
        await second.rollback()

    assert refused.value.error_code == "OCCURRENCE_CLOSED"
    async with AsyncSession(engine) as check:
        assert await check.scalar(select(func.count()).select_from(LogEntry)) == 1
