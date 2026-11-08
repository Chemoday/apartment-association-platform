"""Pure rules of the issue tracker (no database access; unit-tested directly).

docs/API.md section 10 and docs/epics/E9_ISSUE_TRACKER.md. The board's transitions (task I2)
add their rules here.
"""

from collections.abc import Sequence
from datetime import datetime, timedelta

from src.modules.issues.schemas import IssueStatus, StatusFilter
from src.modules.property.schemas import BuildingRole

OPEN_STATUSES = frozenset(
    {IssueStatus.REPORTED, IssueStatus.IN_PROGRESS, IssueStatus.WAITING_FOR_CONTRACTOR}
)
ENDED_STATUSES = frozenset(set(IssueStatus) - OPEN_STATUSES)
# Ended issues stay in everyone's list this long, so people see a problem was dealt with.
RECENTLY_ENDED = timedelta(days=30)
# The window of the per-apartment report limits.
LIMIT_WINDOW = timedelta(hours=24)

BOARD_ROLES = frozenset({BuildingRole.CHAIRMAN, BuildingRole.BOARD})


def is_board(role: BuildingRole) -> bool:
    return role in BOARD_ROLES


def is_open(status: IssueStatus) -> bool:
    return status in OPEN_STATUSES


def statuses_for(status_filter: StatusFilter | None) -> frozenset[IssueStatus] | None:
    """The statuses a list filter stands for; None = no filter."""
    if status_filter is None:
        return None
    if status_filter == StatusFilter.OPEN:
        return OPEN_STATUSES
    if status_filter == StatusFilter.ENDED:
        return ENDED_STATUSES
    return frozenset({IssueStatus(status_filter.value)})


def visible(
    *,
    status: IssueStatus,
    ended_at: datetime | None,
    is_reporter: bool,
    board: bool,
    include_old: bool,
    now: datetime,
) -> bool:
    """Whether a user who may use the tracker sees this issue (of their own building).

    Open issues: everyone. Withdrawn: the reporter and the board, for 30 days in lists, by a
    direct link (`include_old`) at any age. Other ended issues: everyone for 30 days, the board
    also later (`include_old`).
    """
    if is_open(status):
        return True
    if status == IssueStatus.WITHDRAWN:
        # Lists show it for 30 days; a direct link (include_old) works for as long as it exists.
        recent = ended_at is not None and now - ended_at < RECENTLY_ENDED
        return (is_reporter or board) and (include_old or recent)
    if board and include_old:
        return True
    return ended_at is not None and now - ended_at < RECENTLY_ENDED


def retry_after_seconds(window: Sequence[datetime], limit: int, now: datetime) -> int | None:
    """None when another report fits within the limit; else the seconds until the oldest report
    that keeps the window full leaves it (at least 1).

    `window` holds the creation times of the apartment's reports in the last 24 hours.
    """
    recent = sorted(at for at in window if now - at < LIMIT_WINDOW)
    if len(recent) < limit:
        return None
    frees_at = recent[len(recent) - limit] + LIMIT_WINDOW
    return max(1, int((frees_at - now).total_seconds() + 0.999))
