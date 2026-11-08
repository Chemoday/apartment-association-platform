"""Unit tests of the pure issue tracker rules (no database)."""

from datetime import UTC, datetime, timedelta

import pytest

from src.modules.issues.policies import (
    ENDED_STATUSES,
    OPEN_STATUSES,
    Transition,
    board_transition,
    can_be_original,
    retry_after_seconds,
    statuses_for,
    visible,
)
from src.modules.issues.schemas import BoardStatus, IssueStatus, StatusFilter

NOW = datetime(2026, 11, 8, 12, 0, tzinfo=UTC)


def test_every_status_is_either_open_or_ended() -> None:
    assert OPEN_STATUSES | ENDED_STATUSES == set(IssueStatus)
    assert not OPEN_STATUSES & ENDED_STATUSES


@pytest.mark.parametrize(
    ("status_filter", "expected"),
    [
        (None, None),
        (StatusFilter.OPEN, OPEN_STATUSES),
        (StatusFilter.ENDED, ENDED_STATUSES),
        (StatusFilter.DECLINED, {IssueStatus.DECLINED}),
    ],
)
def test_a_filter_stands_for_statuses(status_filter, expected) -> None:
    assert statuses_for(status_filter) == expected


@pytest.mark.parametrize(
    ("status", "ended_days_ago", "reporter", "board", "include_old", "seen"),
    [
        (IssueStatus.REPORTED, None, False, False, False, True),
        (IssueStatus.RESOLVED, 29, False, False, False, True),
        (IssueStatus.RESOLVED, 30, False, False, False, False),
        (IssueStatus.RESOLVED, 30, False, True, False, False),
        (IssueStatus.RESOLVED, 300, False, True, True, True),
        (IssueStatus.WITHDRAWN, 1, False, False, False, False),
        (IssueStatus.WITHDRAWN, 1, True, False, False, True),
        (IssueStatus.WITHDRAWN, 1, False, True, False, True),
        (IssueStatus.WITHDRAWN, 1, False, False, True, False),
        (IssueStatus.WITHDRAWN, 40, True, False, False, False),
        (IssueStatus.WITHDRAWN, 40, True, False, True, True),
        (IssueStatus.WITHDRAWN, 40, False, True, False, False),
    ],
)
def test_who_sees_an_issue(status, ended_days_ago, reporter, board, include_old, seen) -> None:
    ended_at = None if ended_days_ago is None else NOW - timedelta(days=ended_days_ago)
    assert (
        visible(
            status=status,
            ended_at=ended_at,
            is_reporter=reporter,
            board=board,
            include_old=include_old,
            now=NOW,
        )
        is seen
    )


def test_a_report_fits_until_the_limit_is_reached() -> None:
    window = [NOW - timedelta(hours=hours) for hours in (1, 2)]

    assert retry_after_seconds(window, 3, NOW) is None
    assert retry_after_seconds([*window, NOW - timedelta(hours=30)], 3, NOW) is None


def test_the_wait_ends_when_enough_reports_leave_the_window() -> None:
    window = [NOW - timedelta(hours=hours) for hours in (1, 5, 23)]

    assert retry_after_seconds(window, 3, NOW) == 3600  # the 23-hour-old one leaves in 1 h
    assert retry_after_seconds(window, 2, NOW) == 19 * 3600  # 5 h and 23 h old must both leave
    assert retry_after_seconds([NOW - timedelta(hours=24, seconds=-1)], 1, NOW) == 1


# --- The board's transitions ---------------------------------------------------------------------


@pytest.mark.parametrize(
    ("current", "target", "ended_days_ago", "expected"),
    [
        (IssueStatus.REPORTED, BoardStatus.IN_PROGRESS, None, Transition.ALLOWED),
        (IssueStatus.IN_PROGRESS, BoardStatus.WAITING_FOR_CONTRACTOR, None, Transition.ALLOWED),
        (IssueStatus.WAITING_FOR_CONTRACTOR, BoardStatus.IN_PROGRESS, None, Transition.ALLOWED),
        (IssueStatus.REPORTED, BoardStatus.DECLINED, None, Transition.ALLOWED),
        (IssueStatus.IN_PROGRESS, BoardStatus.IN_PROGRESS, None, Transition.UNCHANGED),
        (IssueStatus.RESOLVED, BoardStatus.IN_PROGRESS, 29, Transition.ALLOWED),
        (IssueStatus.RESOLVED, BoardStatus.IN_PROGRESS, 30, Transition.REFUSED),
        (IssueStatus.RESOLVED, BoardStatus.WAITING_FOR_CONTRACTOR, 1, Transition.REFUSED),
        (IssueStatus.DECLINED, BoardStatus.RESOLVED, 1, Transition.REFUSED),
        (IssueStatus.RESOLVED, BoardStatus.RESOLVED, 1, Transition.UNCHANGED),
        (IssueStatus.WITHDRAWN, BoardStatus.IN_PROGRESS, 1, Transition.REFUSED),
    ],
)
def test_the_board_moves_an_issue(current, target, ended_days_ago, expected) -> None:
    ended_at = None if ended_days_ago is None else NOW - timedelta(days=ended_days_ago)

    verdict = board_transition(current, target, ended_at=ended_at, same_original=False, now=NOW)

    assert verdict == expected


def test_a_duplicate_of_another_original_must_be_reopened_first() -> None:
    def verdict(same: bool) -> Transition:
        return board_transition(
            IssueStatus.DUPLICATE,
            BoardStatus.DUPLICATE,
            ended_at=NOW - timedelta(days=1),
            same_original=same,
            now=NOW,
        )

    assert verdict(True) == Transition.UNCHANGED
    assert verdict(False) == Transition.REFUSED


@pytest.mark.parametrize(
    ("status", "ended_days_ago", "same", "fits"),
    [
        (IssueStatus.REPORTED, None, False, True),
        (IssueStatus.RESOLVED, 29, False, True),
        (IssueStatus.RESOLVED, 30, False, False),
        (IssueStatus.DECLINED, 1, False, True),
        (IssueStatus.DUPLICATE, 1, False, False),
        (IssueStatus.WITHDRAWN, 1, False, False),
        (IssueStatus.IN_PROGRESS, None, True, False),
    ],
)
def test_what_can_be_the_original_of_a_duplicate(status, ended_days_ago, same, fits) -> None:
    ended_at = None if ended_days_ago is None else NOW - timedelta(days=ended_days_ago)

    assert can_be_original(status, ended_at=ended_at, is_same_issue=same, now=NOW) is fits
