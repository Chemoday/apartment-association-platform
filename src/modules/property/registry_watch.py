"""The reminder of an expiring energy certificate (epic E12 X2b, issue #148).

Every 6 hours, under pg_try_advisory_xact_lock, it reads the accepted building passports (never
the register), asks the country's provider until when the energy certificate is valid, and
publishes EnergyCertificateExpiring once per threshold: 180 and 30 days before, and the day
itself. A passport accepted late sends only the nearest threshold that is due.
"""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import structlog
from sqlalchemy import select, text

from src.core.database import session_outbox, transaction
from src.core.domain_events import SessionFactory
from src.core.event_bus import EventBus
from src.modules.property.events import EnergyCertificateExpiring
from src.modules.property.models import Building, BuildingRegistryRecord
from src.modules.property.registry import load_block
from src.plugins.registry import PluginRegistry

logger = structlog.get_logger(__name__)
WATCH_INTERVAL = timedelta(hours=6)
WATCH_LOCK_KEY = "property:registry_watch"
THRESHOLDS = (180, 30, 0)  # days before valid_until (owner decision 2026-11-15)
_sleep = asyncio.sleep  # tests replace it, never the global asyncio.sleep


def due_threshold(days_left: int) -> int | None:
    """The nearest threshold reached with `days_left` to go, or None while none is."""
    reached = [threshold for threshold in THRESHOLDS if days_left <= threshold]
    return min(reached) if reached else None


def needs_reminder(
    valid_until: date,
    threshold: int,
    reminded_for: date | None,
    reminded_threshold: int | None,
) -> bool:
    """Not yet sent for this certificate at this threshold or a nearer one."""
    if reminded_for != valid_until or reminded_threshold is None:
        return True
    return threshold < reminded_threshold


@dataclass
class WatchResult:
    ran: bool
    reminded: int = 0


class RegistryWatch:
    def __init__(
        self,
        session_factory_provider: Callable[[], SessionFactory],
        bus_provider: Callable[[], EventBus],
        plugins_provider: Callable[[], PluginRegistry],
        timezone: str = "Europe/Tallinn",
    ) -> None:
        self._session_factory_provider = session_factory_provider
        self._bus_provider = bus_provider
        self._plugins_provider = plugins_provider
        self._timezone = ZoneInfo(timezone)

    async def tick(self, now: datetime | None = None) -> WatchResult:
        # The calendar day of the association, as the reminders of the maintenance calendar.
        today = (now or datetime.now(UTC)).astimezone(self._timezone).date()
        plugins = self._plugins_provider()
        reminded = 0
        async with self._session_factory_provider()() as session, transaction(session):
            locked = await session.scalar(
                text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
                {"key": WATCH_LOCK_KEY},
            )
            if not locked:
                return WatchResult(ran=False)
            outbox = session_outbox(session, self._bus_provider())
            rows = await session.execute(
                select(BuildingRegistryRecord, Building.country_code)
                .join(Building, Building.id == BuildingRegistryRecord.building_id)
                .where(BuildingRegistryRecord.accepted.is_not(None))
                .with_for_update(of=BuildingRegistryRecord)
            )
            for record, country_code in rows.all():
                provider = plugins.building_registry(country_code)
                block = load_block(record.accepted)
                if provider is None or block is None:
                    continue
                try:
                    valid_until = provider.certificate_valid_until(block)
                except Exception:  # one broken provider or block never stops the others
                    logger.exception("registry_watch_certificate_failed", country_code=country_code)
                    continue
                if valid_until is None:
                    continue
                days_left = (valid_until - today).days
                threshold = due_threshold(days_left)
                if threshold is None or not needs_reminder(
                    valid_until,
                    threshold,
                    record.certificate_reminded_for,
                    record.certificate_reminded_threshold,
                ):
                    continue
                record.certificate_reminded_for = valid_until
                record.certificate_reminded_threshold = threshold
                outbox.add(
                    EnergyCertificateExpiring(
                        building_id=record.building_id,
                        valid_until=valid_until,
                        days_left=days_left,
                        threshold=threshold,
                    )
                )
                reminded += 1
        if reminded:
            logger.info("registry_certificate_reminders", reminded=reminded)
        return WatchResult(ran=True, reminded=reminded)


async def run_watch_loop(watch: RegistryWatch) -> None:
    """Run until cancelled: one tick, then wait 6 hours."""
    while True:
        try:
            await watch.tick()
        except Exception:  # CancelledError is not an Exception, so cancelling still stops it
            logger.exception("registry_watch_failed")
        await _sleep(WATCH_INTERVAL.total_seconds())
