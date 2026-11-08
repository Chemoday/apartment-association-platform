"""Real concurrency on committed data: two publisher ticks at the same moment publish once."""

import asyncio
from contextlib import asynccontextmanager
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

from alembic import command
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.core.database import build_engine
from src.core.domain_events import DomainEventRecord
from src.core.event_bus import InMemoryEventBus
from src.core.migrations import alembic_config
from src.modules.communication.models import Post
from src.modules.maintenance.publisher import Publisher
from src.modules.maintenance.schemas import NoticeDraft, PeriodUnit, TaskCreate
from src.modules.maintenance.service import MaintenanceService
from src.modules.property.service import PropertyService
from tests.db_utils import scratch_database
from tests.maintenance.conftest import build_maint_world, local_today


async def test_two_ticks_at_once_publish_one_topic_and_one_notice(database_url: str) -> None:
    async with scratch_database(database_url) as url:
        await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
        engine = build_engine(url)
        try:
            due = local_today() + timedelta(days=2)
            async with AsyncSession(engine, expire_on_commit=False) as session:
                world = await build_maint_world(session)
                chairman = await PropertyService(session).get_current_user(world.chairman.id)
                await MaintenanceService(session, PropertyService(session)).create_task(
                    chairman,
                    TaskCreate(
                        title="Gutters",
                        period_unit=PeriodUnit.MONTH,
                        period_count=6,
                        lead_days=7,
                        first_due_date=due,
                        notice=NoticeDraft(title="Gutters", body="Move cars."),
                    ),
                )
                await session.commit()

            @asynccontextmanager
            async def factory():
                async with AsyncSession(engine, expire_on_commit=False) as session:
                    yield session

            bus = InMemoryEventBus()
            publisher = Publisher(lambda: factory, lambda: bus, get_settings())
            zone = ZoneInfo(get_settings().INSTANCE_TIMEZONE)
            now = datetime.combine(due, time(12), tzinfo=zone).astimezone(UTC)

            first, second = await asyncio.gather(publisher.tick(now=now), publisher.tick(now=now))

            assert first.published + second.published == 1
            async with AsyncSession(engine) as check:
                posts = await check.scalar(select(func.count()).select_from(Post))
                events = await check.scalar(
                    select(func.count())
                    .select_from(DomainEventRecord)
                    .where(DomainEventRecord.event_type == "MaintenanceTaskDue")
                )
            assert (posts, events) == (2, 1), "one board topic, one notice, one event"
        finally:
            await engine.dispose()
