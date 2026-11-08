"""Pure rules of the maintenance calendar (no database access; unit-tested directly).

docs/API.md section 11 and docs/epics/E10_MAINTENANCE_CALENDAR.md. Every occurrence is counted
from the task's anchor date, so clamping a day to a shorter month never drifts the rhythm.
"""

from calendar import monthrange
from datetime import date, datetime, timedelta, tzinfo

from src.modules.maintenance.schemas import OccurrenceState, PeriodUnit, TaskStatus
from src.modules.property.schemas import BuildingRole

BOARD_ROLES = frozenset({BuildingRole.CHAIRMAN, BuildingRole.BOARD})
LOG_READERS = BOARD_ROLES | {BuildingRole.ACCOUNTANT}

# Bounds of period_count per unit (the database allows 1..3650 for every unit).
PERIOD_BOUNDS = {PeriodUnit.DAY: (7, 3650), PeriodUnit.MONTH: (1, 120), PeriodUnit.YEAR: (1, 10)}
# The shortest length of one period, for "the lead time is shorter than the period".
_SHORTEST_DAYS = {PeriodUnit.DAY: 1, PeriodUnit.MONTH: 28, PeriodUnit.YEAR: 365}
# How far a first or moved due date may lie in the past or the future.
MAX_PAST = timedelta(days=366)
MAX_FUTURE_YEARS = 10


def is_board(role: BuildingRole) -> bool:
    return role in BOARD_ROLES


def reads_log(role: BuildingRole) -> bool:
    return role in LOG_READERS


def local_today(now: datetime, timezone: tzinfo) -> date:
    return now.astimezone(timezone).date()


# --- The schedule --------------------------------------------------------------------------------


def add_months(day: date, months: int, day_of_month: int | None = None) -> date:
    """The same day (or `day_of_month`) `months` later, clamped to the last day of a shorter
    month."""
    year, month = divmod(day.month - 1 + months, 12)
    year, month = day.year + year, month + 1
    wanted = day.day if day_of_month is None else day_of_month
    return date(year, month, min(wanted, monthrange(year, month)[1]))


def schedule_date(
    anchor: date, unit: PeriodUnit, count: int, k: int, day: int | None = None
) -> date:
    """Occurrence k of the schedule (k = 0 is the anchor itself). `day` is the rhythm's day of
    the month, kept when the anchor itself is a clamped date (31 -> 28 February)."""
    if unit == PeriodUnit.DAY:
        return anchor + timedelta(days=k * count)
    months = k * count * (12 if unit == PeriodUnit.YEAR else 1)
    return add_months(anchor, months, day)


def next_after(
    anchor: date,
    unit: PeriodUnit,
    count: int,
    seq: int,
    planned: date,
    closed_on: date,
    day: int | None = None,
) -> tuple[int, date]:
    """The next occurrence after one closed on `closed_on`: the first k > seq whose date is later
    than both the planned date and the closing date (a fixed rhythm, no missed dates behind).

    Found in closed form, then corrected in a bounded loop.
    """
    after = max(planned, closed_on)
    if unit == PeriodUnit.DAY:
        k = (after - anchor).days // count + 1
    else:
        step = count * (12 if unit == PeriodUnit.YEAR else 1)
        k = ((after.year - anchor.year) * 12 + after.month - anchor.month) // step
    k = max(k, seq + 1)
    while k > seq + 1 and schedule_date(anchor, unit, count, k - 1, day) > after:
        k -= 1
    for _ in range(4):
        if schedule_date(anchor, unit, count, k, day) > after:
            return k, schedule_date(anchor, unit, count, k, day)
        k += 1
    raise AssertionError("the closed form is off by more than a few periods")  # pragma: no cover


def occurrence_state(
    due_date: date, lead_days: int, today: date, task_status: TaskStatus
) -> OccurrenceState:
    if task_status == TaskStatus.PAUSED:
        return OccurrenceState.PAUSED
    if today > due_date:
        return OccurrenceState.OVERDUE
    if today >= due_date - timedelta(days=lead_days):
        return OccurrenceState.DUE
    return OccurrenceState.UPCOMING


# --- Checks --------------------------------------------------------------------------------------


def period_problem(unit: PeriodUnit, count: int, lead_days: int) -> str | None:
    """Why the period and the lead time do not fit, or None."""
    low, high = PERIOD_BOUNDS[unit]
    if not low <= count <= high:
        return f"period_count for {unit.value} is {low}..{high}"
    if lead_days >= _SHORTEST_DAYS[unit] * count:
        return "lead_days must be shorter than the period"
    return None


def due_date_problem(due: date, today: date) -> str | None:
    """A first or moved due date: at most 366 days ago (overdue at once) and 10 years ahead."""
    if due < today - MAX_PAST:
        return "the due date is more than 366 days in the past"
    if due > add_months(today, 12 * MAX_FUTURE_YEARS):
        return "the due date is more than 10 years ahead"
    return None


def done_on_problem(done_on: date, planned: date, today: date) -> str | None:
    if done_on > today:
        return "done_on must not be in the future"
    if done_on < planned - MAX_PAST:
        return "done_on is more than 366 days before the planned date"
    return None
