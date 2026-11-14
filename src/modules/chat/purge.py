"""The purge of the building chat (docs/SCHEMA.md section 14).

Every minute it deletes the messages older than 2 hours, every message of a building whose chat
is off, and every message written before the chat was last turned on. Reads apply the same rule,
so the purge only frees the rows. One short transaction under pg_try_advisory_xact_lock.
"""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import structlog
from sqlalchemy import delete, not_, or_, text

from src.core.building_settings import BuildingSettings
from src.core.domain_events import SessionFactory
from src.modules.chat.models import ChatMessage
from src.modules.chat.policies import HISTORY
from src.modules.chat.settings import CHAT_ENABLED

logger = structlog.get_logger(__name__)
PURGE_INTERVAL = timedelta(minutes=1)
PURGE_LOCK_KEY = "chat:purge"
_sleep = asyncio.sleep  # tests replace it, never the global asyncio.sleep


async def purge_tick(session_factory: SessionFactory, now: datetime | None = None) -> int | None:
    """Delete what may no longer be read; the number deleted, or None when another process held
    the lock."""
    now = now or datetime.now(UTC)
    readable = BuildingSettings.holds_since(
        CHAT_ENABLED, ChatMessage.building_id, ChatMessage.created_at
    )
    async with session_factory() as session:
        locked = await session.scalar(
            text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": PURGE_LOCK_KEY},
        )
        if not locked:
            return None
        result = await session.execute(
            delete(ChatMessage)
            .where(or_(ChatMessage.created_at < now - HISTORY, not_(readable)))
            .execution_options(synchronize_session=False)
        )
        await session.commit()
    deleted = result.rowcount or 0
    if deleted:
        logger.info("chat_purge", deleted=deleted)
    return deleted


async def run_purge_loop(session_factory_provider: Callable[[], SessionFactory]) -> None:
    """Run until cancelled: one tick, then wait a minute."""
    while True:
        try:
            await purge_tick(session_factory_provider())
        except Exception:  # CancelledError is not an Exception, so cancelling still stops it
            logger.exception("chat_purge_failed")
        await _sleep(PURGE_INTERVAL.total_seconds())
