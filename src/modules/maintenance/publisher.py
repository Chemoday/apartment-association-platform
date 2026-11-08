"""The publisher of the maintenance calendar (epic E10, task M2; docs/ARCHITECTURE.md 8).

Every 10 minutes between 09:00 and 21:00 local time it publishes the occurrences whose time has
come ("due and not published yet", so a downtime loses nothing) and reminds the board of
overdue ones. Each task is handled in its own transaction with its own outbox: a failure rolls
back that task only, and an event is stored and published together with the posts it is about
(never inside a savepoint, which would drop the stored event row but not the in-memory event).
"""

import asyncio
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import structlog
from sqlalchemy import and_, or_, select, tuple_

from src.core.config import Settings
from src.core.database import session_outbox, transaction
from src.core.domain_events import SessionFactory
from src.core.event_bus import EventBus
from src.modules.maintenance.models import Occurrence, Task
from src.modules.maintenance.schemas import OccurrenceStatus, TaskStatus
from src.modules.maintenance.service import MaintenanceService
from src.modules.property.service import PropertyService

logger = structlog.get_logger(__name__)

PUBLISHER_INTERVAL = timedelta(minutes=10)
PUBLISH_FROM, PUBLISH_UNTIL = time(9, 0), time(21, 0)
BATCH_SIZE = 200
MAX_LEAD_DAYS = 90
_sleep = asyncio.sleep  # tests replace it


@dataclass(frozen=True)
class TickResult:
    ran: bool
    published: int = 0
    reminded: int = 0
    failed: int = 0


class Publisher:
    def __init__(
        self,
        session_factory_provider: Callable[[], SessionFactory],
        bus_provider: Callable[[], EventBus],
        settings: Settings,
    ) -> None:
        self._session_factory_provider = session_factory_provider
        self._bus_provider = bus_provider
        self._timezone = ZoneInfo(settings.INSTANCE_TIMEZONE)

    async def tick(self, now: datetime | None = None) -> TickResult:
        now = now or datetime.now(UTC)
        local = now.astimezone(self._timezone)
        if not PUBLISH_FROM <= local.time() < PUBLISH_UNTIL:
            return TickResult(ran=False)
        factory = self._session_factory_provider()
        published = reminded = failed = 0
        async for occurrence_id in self._candidates(factory, local.date()):
            try:
                async with factory() as session, transaction(session):
                    outbox = session_outbox(session, self._bus_provider())
                    service = MaintenanceService(session, PropertyService(session), outbox)
                    done = await service.publish_due(occurrence_id, now)
            except Exception:
                failed += 1
                logger.exception("maintenance_publish_failed", occurrence_id=str(occurrence_id))
                continue
            published += done == "published"
            reminded += done == "reminded"
        return TickResult(ran=True, published=published, reminded=reminded, failed=failed)

    @staticmethod
    async def _candidates(factory: SessionFactory, today: date) -> AsyncIterator[uuid.UUID]:
        """Open occurrences of active tasks that need a post today: not published and in their
        lead time (or later), or published with a reminder due. Read in pages by (due date, id),
        so a long list never hides the occurrences at its end (the service checks each again)."""
        due = or_(
            and_(
                Occurrence.published_at.is_(None),
                # A lead time is at most 90 days: lets the partial index on due_date help.
                Occurrence.due_date <= today + timedelta(days=MAX_LEAD_DAYS),
                Occurrence.due_date - Task.lead_days <= today,
            ),
            and_(Occurrence.published_at.is_not(None), Occurrence.next_remind_on <= today),
        )
        after: tuple[date, uuid.UUID] | None = None
        while True:
            statement = (
                select(Occurrence.due_date, Occurrence.id)
                .join(Task, Task.id == Occurrence.task_id)
                .where(
                    Occurrence.status == OccurrenceStatus.OPEN,
                    Task.status == TaskStatus.ACTIVE,
                    due,
                )
                .order_by(Occurrence.due_date, Occurrence.id)
                .limit(BATCH_SIZE)
            )
            if after is not None:
                statement = statement.where(tuple_(Occurrence.due_date, Occurrence.id) > after)
            async with factory() as session:
                page = (await session.execute(statement)).all()
            for _, occurrence_id in page:
                yield occurrence_id
            if len(page) < BATCH_SIZE:
                return
            after = (page[-1][0], page[-1][1])


async def run_publisher_loop(publisher: Publisher) -> None:
    """Run until cancelled: one tick, then wait for the next one."""
    while True:
        try:
            await publisher.tick()
        except Exception:  # CancelledError is not an Exception, so cancelling still stops the loop
            logger.exception("maintenance_publisher_failed")
        await _sleep(PUBLISHER_INTERVAL.total_seconds())
