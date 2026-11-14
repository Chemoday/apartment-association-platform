"""Pure rules of the building chat (no database access; unit-tested directly)."""

import math
from collections.abc import Sequence
from datetime import datetime, timedelta

from src.modules.property.schemas import BuildingRole, CurrentUserDTO

HISTORY = timedelta(hours=2)  # a message lives this long (owner decision)
RECENT = timedelta(minutes=10)  # the activity indicator counts this far back
MAX_LENGTH = 500
PER_MINUTE = 10
PER_HOUR = 60
_BOARD = frozenset({BuildingRole.CHAIRMAN, BuildingRole.BOARD})


def takes_part(user: CurrentUserDTO) -> bool:
    """Residents (any active membership) and the board; an accountant without an apartment not."""
    return bool(user.memberships) or user.building_role in _BOARD


def window_start(now: datetime, turned_on_at: datetime | None) -> datetime:
    """The oldest moment a visible message may have: 2 hours back, and never before the chat was
    last turned on (`None`: no such bound)."""
    oldest = now - HISTORY
    return oldest if turned_on_at is None else max(oldest, turned_on_at)


def rate_limit(own_times: Sequence[datetime], now: datetime) -> tuple[str, int] | None:
    """(reason, seconds to wait) when one more message would break a limit, else None.

    `own_times`: when the caller's messages of the last hour were written, in any order.
    """
    times = sorted(t for t in own_times if t > now - timedelta(hours=1))
    broken: list[tuple[int, str]] = []
    for reason, limit, span in (
        ("MINUTE_LIMIT", PER_MINUTE, timedelta(minutes=1)),
        ("HOUR_LIMIT", PER_HOUR, timedelta(hours=1)),
    ):
        inside = [t for t in times if t > now - span]
        if len(inside) >= limit:
            frees_at = inside[len(inside) - limit] + span  # when one of them leaves the span
            broken.append((max(1, math.ceil((frees_at - now).total_seconds())), reason))
    if not broken:
        return None
    wait, reason = max(broken)  # both broken: the longer wait, so a retry is not refused again
    return reason, wait
