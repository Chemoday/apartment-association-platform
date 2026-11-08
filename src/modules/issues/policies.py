"""Pure rules of the issue tracker (no database access; unit-tested directly).

docs/API.md section 10 and docs/epics/E9_ISSUE_TRACKER.md. The board's transitions (task I2)
add their rules here.
"""

from collections.abc import Sequence
from datetime import datetime, timedelta
from enum import StrEnum

from src.modules.issues.schemas import BoardStatus, IssueStatus, StatusFilter
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


class Transition(StrEnum):
    ALLOWED = "ALLOWED"
    UNCHANGED = "UNCHANGED"  # the current status again: no change, no log entry
    REFUSED = "REFUSED"


# How long after its end the board may reopen an issue (as long as residents still see it).
REOPEN_WINDOW = RECENTLY_ENDED


def board_transition(
    current: IssueStatus,
    target: BoardStatus,
    *,
    ended_at: datetime | None,
    same_original: bool,
    now: datetime,
) -> Transition:
    """Whether the board may move an issue from `current` to `target`.

    From an open status: any board status. From RESOLVED, DUPLICATE or DECLINED: only reopening
    to IN_PROGRESS within 30 days of the end. WITHDRAWN never changes. A duplicate of another
    original must be reopened first.
    """
    if current.value == target.value:
        if target != BoardStatus.DUPLICATE or same_original:
            return Transition.UNCHANGED
        return Transition.REFUSED
    if current == IssueStatus.WITHDRAWN:
        return Transition.REFUSED
    if is_open(current):
        return Transition.ALLOWED
    reopening = target == BoardStatus.IN_PROGRESS
    recent = ended_at is not None and now - ended_at < REOPEN_WINDOW
    return Transition.ALLOWED if reopening and recent else Transition.REFUSED


def can_be_original(
    status: IssueStatus, *, ended_at: datetime | None, is_same_issue: bool, now: datetime
) -> bool:
    """An original of a duplicate: another issue residents still see (open, or ended within 30
    days) that is not itself a duplicate or withdrawn."""
    if is_same_issue or status in {IssueStatus.DUPLICATE, IssueStatus.WITHDRAWN}:
        return False
    return is_open(status) or (ended_at is not None and now - ended_at < RECENTLY_ENDED)


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
