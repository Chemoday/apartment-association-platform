"""The period opener: opens the reading period of each new month (docs/ARCHITECTURE.md 9).

Every 10 minutes (and once at start-up) it opens the period of the current local month for every
building, each in its own transaction. `INSERT ... ON CONFLICT DO NOTHING` on the unique key makes
it idempotent across ticks and processes: only the insert that won stores `ReadingPeriodOpened`.
Missed months are never filled in.
"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import structlog

from src.core.database import session_outbox, transaction
from src.core.domain_events import SessionFactory
from src.core.event_bus import EventBus
from src.modules.meters.service import MetersService
from src.modules.property.service import PropertyService

logger = structlog.get_logger(__name__)

OPENER_INTERVAL = timedelta(minutes=10)
_sleep = asyncio.sleep  # tests replace it


@dataclass(frozen=True)
class TickResult:
    opened: int = 0
    failed: int = 0


class PeriodOpener:
    def __init__(
        self,
        session_factory_provider: Callable[[], SessionFactory],
        bus_provider: Callable[[], EventBus],
    ) -> None:
        self._session_factory_provider = session_factory_provider
        self._bus_provider = bus_provider

    async def tick(self, now: datetime | None = None) -> TickResult:
        now = now or datetime.now(UTC)
        factory = self._session_factory_provider()
        async with factory() as session:
            deadlines = await PropertyService(session).reading_deadlines()
        opened = failed = 0
        for building_id, deadline_day in deadlines.items():
            try:
                async with factory() as session, transaction(session):
                    outbox = session_outbox(session, self._bus_provider())
                    service = MetersService(session, PropertyService(session), outbox)
                    period_id = await service.open_current_period(building_id, deadline_day, now)
            except Exception:
                failed += 1
                logger.exception("meters_period_open_failed", building_id=str(building_id))
                continue
            if period_id is not None:
                opened += 1
                logger.info(
                    "meters_period_opened", building_id=str(building_id), period_id=str(period_id)
                )
        return TickResult(opened=opened, failed=failed)


async def run_opener_loop(opener: PeriodOpener) -> None:
    """Run until cancelled: one tick, then wait for the next one."""
    while True:
        try:
            await opener.tick()
        except Exception:  # CancelledError is not an Exception, so cancelling still stops the loop
            logger.exception("meters_period_opener_failed")
        await _sleep(OPENER_INTERVAL.total_seconds())
