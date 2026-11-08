"""Real concurrency on committed data: two reports of one apartment at the same moment."""

import asyncio
from collections.abc import AsyncIterator

import pytest
from alembic import command
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from src.core.building_settings import BuildingSettingRecord
from src.core.database import build_engine
from src.core.exceptions import DomainError
from src.core.migrations import alembic_config
from src.modules.issues.models import Issue
from src.modules.issues.schemas import IssueCategory, IssueReport
from src.modules.issues.service import IssuesService
from src.modules.property.service import PropertyService
from tests.db_utils import scratch_database
from tests.issues.conftest import IssueWorld, build_issue_world

BLOCKED = 0.5


@pytest.fixture
async def committed(database_url: str) -> AsyncIterator[tuple[AsyncEngine, IssueWorld]]:
    async with scratch_database(database_url) as url:
        await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
        engine = build_engine(url)
        async with AsyncSession(engine, expire_on_commit=False) as session:
            world = await build_issue_world(session)
            session.add(
                BuildingSettingRecord(
                    building_id=world.building.id,
                    key="issues.reports_per_apartment_per_day",
                    value=1,
                    updated_at=func.now(),
                )
            )
            await session.commit()
        try:
            yield engine, world
        finally:
            await engine.dispose()


async def service_for(session: AsyncSession, user_id):
    properties = PropertyService(session)
    return IssuesService(session, properties), await properties.get_current_user(user_id)


REPORT = IssueReport(category=IssueCategory.LIGHTING, entrance=2, place="Landing", title="Dark")


async def test_two_reports_of_one_apartment_cannot_both_take_the_last_slot(committed) -> None:
    engine, world = committed
    async with AsyncSession(engine) as first, AsyncSession(engine) as second:
        owner_service, owner = await service_for(first, world.owner_14.id)
        family_service, family = await service_for(second, world.family_14.id)
        await owner_service.report(owner, REPORT)
        waiting = asyncio.create_task(family_service.report(family, REPORT))
        await asyncio.sleep(BLOCKED)
        assert not waiting.done(), "the second report waits for the apartment's lock"

        await first.commit()
        with pytest.raises(DomainError) as refused:
            await waiting
        await second.rollback()

    assert refused.value.error_code == "RATE_LIMITED"
    async with AsyncSession(engine) as check:
        assert await check.scalar(select(func.count()).select_from(Issue)) == 1
