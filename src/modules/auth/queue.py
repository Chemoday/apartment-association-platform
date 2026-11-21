"""The invitation queue (epic E13 R4a; docs/ARCHITECTURE.md 4.9, docs/API.md 7).

Invitation e-mails wait in auth_invitations (send_due_at) and go out from here, paced by
AUTH_INVITATION_MAILS_PER_HOUR and tried again after a failure, also across restarts and while
the installation has no working e-mail. One tick, like the notifications dispatcher: claim a batch
under a lease and make the links (commit), then for each e-mail send it with no transaction open
(at most INVITATION_SEND_TIMEOUT) and record the result right away, fenced on the attempt. The
lease outlasts a whole batch of timed-out sends, so a slow mail server never lets a second run
claim (and re-link) an e-mail that is still being sent. The plain links live only in memory.

Nothing personal is logged: the invitation id, the attempt and whether it went out.
"""

import asyncio
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import structlog
from opentelemetry import metrics
from sqlalchemy import func, select

from src.core.config import Settings
from src.core.domain_events import SessionFactory
from src.modules.auth.invitations import InvitationService, QueuedMail
from src.modules.auth.mail import mail_allowed, send_auth_email
from src.modules.auth.models import AuthAttempt
from src.modules.auth.policies import INVITATION_SEND_BATCH, INVITATION_SEND_TIMEOUT
from src.modules.auth.schemas import AttemptKind
from src.plugins.registry import PluginRegistry

logger = structlog.get_logger(__name__)
_meter = metrics.get_meter(__name__)
invitation_mails = _meter.create_counter(
    "auth.invitation_mails",
    description="Invitation e-mails of the queue by outcome (sent, failed, not_allowed in demo)",
)

LOOP_INTERVAL = timedelta(seconds=30)
HOUR = timedelta(hours=1)
_sleep = asyncio.sleep  # tests replace it, never the global asyncio.sleep


def _now() -> datetime:
    return datetime.now(UTC)


async def _room(session_factory: SessionFactory, settings: Settings, now: datetime) -> int:
    """How many e-mails the pacing still allows: the per-hour cap minus the invitation e-mails the
    queue sent within the last hour (one INVITATION_MAIL attempt row per e-mail)."""
    async with session_factory() as session:
        sent = await session.scalar(
            select(func.count(AuthAttempt.id)).where(
                AuthAttempt.kind == AttemptKind.INVITATION_MAIL,
                AuthAttempt.attempted_at > now - HOUR,
            )
        )
    return settings.AUTH_INVITATION_MAILS_PER_HOUR - int(sent or 0)


async def _send(plugins: PluginRegistry, settings: Settings, queued: QueuedMail) -> str:
    """'sent', 'failed' or 'not_allowed' (demo mode without AUTH_MAIL_IN_DEMO: tried again later
    like a failure, but not counted as a broken mail server)."""
    mail = queued.mail
    if not mail_allowed(settings, mail.email):
        return "not_allowed"
    try:
        async with asyncio.timeout(INVITATION_SEND_TIMEOUT.total_seconds()):
            ok = await send_auth_email(
                plugins,
                settings,
                email=mail.email,
                locale=mail.locale,
                kind=mail.kind,
                link=mail.link,
                **mail.values,
            )
    except TimeoutError:
        ok = False
    return "sent" if ok else "failed"


async def queue_tick(
    session_factory: SessionFactory, plugins: PluginRegistry, settings: Settings
) -> int:
    """Claim, send and record one batch; returns how many due rows it looked at (claimed or
    pushed back because they no longer apply), so a full batch means "maybe more"."""
    now = _now()
    room = await _room(session_factory, settings, now)
    if room <= 0:
        return 0
    async with session_factory() as session:
        claimed, looked = await InvitationService(session, settings).claim_due(
            now, min(room, INVITATION_SEND_BATCH)
        )
        await session.commit()
    for queued in claimed:
        outcome = await _send(plugins, settings, queued)
        async with session_factory() as session:
            recorded = await InvitationService(session, settings).record_send(
                queued, ok=outcome == "sent", now=_now()
            )
            await session.commit()
        invitation_mails.add(1, {"outcome": outcome})
        log = logger.info if outcome != "failed" else logger.warning
        log(
            "auth_invitation_sent" if outcome == "sent" else "auth_invitation_not_sent",
            invitation_id=str(queued.invitation_id),
            attempt=queued.attempt,
            outcome=outcome,
            recorded=recorded,
        )
    return looked


async def drain_queue(
    session_factory: SessionFactory, plugins: PluginRegistry, settings: Settings
) -> None:
    """Ticks until a batch comes back short (nothing more due, or the pacing is used up)."""
    while await queue_tick(session_factory, plugins, settings) >= INVITATION_SEND_BATCH:
        pass


class InvitationQueue:
    """The queue of one app process: one drain at a time, so concurrent requests never stack
    batches over the pacing or fill the detached-work slots. A wake-up during a drain makes that
    drain run once more, so a newly queued e-mail never waits for the loop."""

    def __init__(
        self,
        session_factory_provider: Callable[[], SessionFactory],
        plugins_provider: Callable[[], PluginRegistry],
        settings_provider: Callable[[], Settings],
    ) -> None:
        # Providers, read at each drain, like the other loops (tests swap app.state objects).
        self._session_factory = session_factory_provider
        self._plugins = plugins_provider
        self._settings = settings_provider
        self._lock = asyncio.Lock()
        self._again = False

    async def drain(self) -> None:
        if self._lock.locked():
            self._again = True
            return
        async with self._lock:
            self._again = True
            while self._again:
                self._again = False
                await drain_queue(self._session_factory(), self._plugins(), self._settings())

    async def run_loop(self) -> None:
        """Run until cancelled: drain what is due, then wait 30 seconds (retries, the pacing)."""
        while True:
            try:
                await self.drain()
            except Exception:  # CancelledError is not an Exception, so cancelling still stops it
                logger.exception("auth_invitation_queue_failed")
            await _sleep(LOOP_INTERVAL.total_seconds())
