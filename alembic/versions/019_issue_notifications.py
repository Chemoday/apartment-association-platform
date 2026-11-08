"""Notifications about issues (epic E9, task I3).

docs/SCHEMA.md section 5: ISSUE_REPORTED, ISSUE_URGENT and ISSUE_STATUS_CHANGED join the
event_type checks of notif_preferences and notif_deliveries, and 'issue' the subject_type check
of notif_deliveries.

Revision ID: 019
Revises: 018
Create Date: 2026-11-08
"""

from collections.abc import Sequence

from alembic import op

revision: str = "019"
down_revision: str | None = "018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EVENTS_BEFORE = (
    "('EMERGENCY_PUBLISHED', 'EMERGENCY_RESOLVED', 'READING_DEADLINE', 'PERIOD_REVIEW', "
    "'APARTMENT_MESSAGE', 'APARTMENT_MESSAGE_TO_BOARD', 'POLL_OPENED')"
)
EVENTS_AFTER = (
    "('EMERGENCY_PUBLISHED', 'EMERGENCY_RESOLVED', 'READING_DEADLINE', 'PERIOD_REVIEW', "
    "'APARTMENT_MESSAGE', 'APARTMENT_MESSAGE_TO_BOARD', 'POLL_OPENED', "
    "'ISSUE_REPORTED', 'ISSUE_URGENT', 'ISSUE_STATUS_CHANGED')"
)
SUBJECTS_BEFORE = "('post', 'period', 'poll')"
SUBJECTS_AFTER = "('post', 'period', 'poll', 'issue')"
EVENT_CHECKS = (
    ("notif_preferences", "ck_notif_preferences_event_type"),
    ("notif_deliveries", "ck_notif_deliveries_event_type"),
)
NEW_EVENTS = "('ISSUE_REPORTED', 'ISSUE_URGENT', 'ISSUE_STATUS_CHANGED')"


def _replace(events: str, subjects: str) -> None:
    for table, name in EVENT_CHECKS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, f"event_type IN {events}")
    op.drop_constraint("ck_notif_deliveries_subject_type", "notif_deliveries", type_="check")
    op.create_check_constraint(
        "ck_notif_deliveries_subject_type", "notif_deliveries", f"subject_type IN {subjects}"
    )


def upgrade() -> None:
    _replace(EVENTS_AFTER, SUBJECTS_AFTER)


def downgrade() -> None:
    # The old checks cannot hold the new values: their rows go first.
    op.execute(
        f"DELETE FROM notif_deliveries WHERE event_type IN {NEW_EVENTS} OR subject_type = 'issue'"
    )
    op.execute(f"DELETE FROM notif_preferences WHERE event_type IN {NEW_EVENTS}")
    _replace(EVENTS_BEFORE, SUBJECTS_BEFORE)
