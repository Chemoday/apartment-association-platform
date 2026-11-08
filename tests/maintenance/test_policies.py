"""Unit tests of the pure maintenance calendar rules (no database)."""

from datetime import date

import pytest

from src.modules.maintenance.policies import (
    add_months,
    done_on_problem,
    due_date_problem,
    next_after,
    occurrence_state,
    period_problem,
    schedule_date,
)
from src.modules.maintenance.schemas import OccurrenceState, PeriodUnit, TaskStatus

D, M, Y = PeriodUnit.DAY, PeriodUnit.MONTH, PeriodUnit.YEAR


@pytest.mark.parametrize(
    ("start", "months", "expected"),
    [
        (date(2027, 1, 31), 1, date(2027, 2, 28)),
        (date(2028, 1, 31), 1, date(2028, 2, 29)),
        (date(2027, 1, 31), 2, date(2027, 3, 31)),
        (date(2027, 11, 30), 3, date(2028, 2, 29)),
        (date(2027, 12, 15), 1, date(2028, 1, 15)),
        (date(2027, 5, 10), 0, date(2027, 5, 10)),
    ],
)
def test_months_are_added_with_the_day_clamped(start, months, expected) -> None:
    assert add_months(start, months) == expected


def test_the_schedule_is_counted_from_the_anchor_so_month_ends_never_drift() -> None:
    anchor = date(2027, 1, 31)

    dates = [schedule_date(anchor, M, 1, k) for k in range(4)]

    assert dates == [date(2027, 1, 31), date(2027, 2, 28), date(2027, 3, 31), date(2027, 4, 30)]


def test_a_yearly_task_from_29_february() -> None:
    anchor = date(2028, 2, 29)

    assert [schedule_date(anchor, Y, 1, k) for k in range(5)] == [
        date(2028, 2, 29),
        date(2029, 2, 28),
        date(2030, 2, 28),
        date(2031, 2, 28),
        date(2032, 2, 29),
    ]
    assert schedule_date(date(2027, 3, 1), D, 14, 2) == date(2027, 3, 29)


@pytest.mark.parametrize(
    ("unit", "count", "planned_k", "closed_on", "expected"),
    [
        # Monthly from 15 Jan 2027, occurrence 0 (15 Jan) closed on:
        (M, 1, 0, date(2027, 1, 10), (1, date(2027, 2, 15))),  # early: the rhythm stays
        (M, 1, 0, date(2027, 1, 20), (1, date(2027, 2, 15))),  # a bit late
        (M, 1, 0, date(2027, 3, 20), (3, date(2027, 4, 15))),  # very late: no missed dates
        (M, 1, 0, date(2027, 2, 15), (2, date(2027, 3, 15))),  # done on the next date itself
        (Y, 1, 0, date(2026, 11, 1), (1, date(2028, 1, 15))),  # a year early keeps the rhythm
        (D, 7, 0, date(2027, 2, 1), (3, date(2027, 2, 5))),
        (M, 12, 0, date(2029, 6, 1), (3, date(2030, 1, 15))),
    ],
)
def test_the_next_date_keeps_the_planned_rhythm(unit, count, planned_k, closed_on, expected):
    anchor = date(2027, 1, 15)
    planned = schedule_date(anchor, unit, count, planned_k)

    assert next_after(anchor, unit, count, planned_k, planned, closed_on) == expected


def test_the_next_date_after_a_later_occurrence_of_a_month_end_anchor() -> None:
    anchor = date(2027, 1, 31)

    assert next_after(anchor, M, 1, 1, date(2027, 2, 28), date(2027, 2, 27)) == (
        2,
        date(2027, 3, 31),
    )


@pytest.mark.parametrize(
    ("due", "lead", "today", "status", "expected"),
    [
        (date(2027, 4, 15), 14, date(2027, 3, 31), TaskStatus.ACTIVE, OccurrenceState.UPCOMING),
        (date(2027, 4, 15), 14, date(2027, 4, 1), TaskStatus.ACTIVE, OccurrenceState.DUE),
        (date(2027, 4, 15), 0, date(2027, 4, 15), TaskStatus.ACTIVE, OccurrenceState.DUE),
        (date(2027, 4, 15), 14, date(2027, 4, 16), TaskStatus.ACTIVE, OccurrenceState.OVERDUE),
        (date(2027, 4, 15), 14, date(2027, 4, 16), TaskStatus.PAUSED, OccurrenceState.PAUSED),
    ],
)
def test_the_shown_state(due, lead, today, status, expected) -> None:
    assert occurrence_state(due, lead, today, status) == expected


@pytest.mark.parametrize(
    ("unit", "count", "lead", "fits"),
    [
        (D, 7, 6, True),
        (D, 6, 0, False),
        (D, 7, 7, False),
        (M, 1, 27, True),
        (M, 1, 28, False),
        (M, 121, 0, False),
        (Y, 1, 90, True),
        (Y, 11, 0, False),
    ],
)
def test_period_and_lead_bounds(unit, count, lead, fits) -> None:
    assert (period_problem(unit, count, lead) is None) is fits


def test_due_and_done_date_bounds() -> None:
    today = date(2027, 6, 1)

    assert due_date_problem(date(2026, 6, 1), today) is None  # 365 days ago
    assert due_date_problem(date(2026, 5, 30), today) is not None
    assert due_date_problem(date(2037, 6, 1), today) is None
    assert due_date_problem(date(2037, 6, 2), today) is not None
    assert done_on_problem(today, date(2027, 7, 1), today) is None
    assert done_on_problem(date(2027, 6, 2), date(2027, 6, 1), today) is not None
    assert done_on_problem(date(2026, 1, 1), date(2027, 6, 1), today) is not None
