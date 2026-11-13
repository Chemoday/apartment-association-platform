"""Storage usage alerts (epic E11, task F4): core_file_alerts and STORAGE_ALMOST_FULL.

docs/SCHEMA.md sections 5 and 12: the table of reached thresholds; STORAGE_ALMOST_FULL joins the
event_type checks of notif_preferences and notif_deliveries, and 'storage' the subject_type
check of notif_deliveries.

Revision ID: 024
Revises: 023
Create Date: 2026-11-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "024"
down_revision: str | None = "023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

EVENTS_BEFORE = (
    "('EMERGENCY_PUBLISHED', 'EMERGENCY_RESOLVED', 'READING_DEADLINE', 'PERIOD_REVIEW', "
    "'APARTMENT_MESSAGE', 'APARTMENT_MESSAGE_TO_BOARD', 'POLL_OPENED', "
    "'ISSUE_REPORTED', 'ISSUE_URGENT', 'ISSUE_STATUS_CHANGED', "
    "'MAINTENANCE_DUE', 'NOTICE_PUBLISHED')"
)
EVENTS_AFTER = (
    "('EMERGENCY_PUBLISHED', 'EMERGENCY_RESOLVED', 'READING_DEADLINE', 'PERIOD_REVIEW', "
    "'APARTMENT_MESSAGE', 'APARTMENT_MESSAGE_TO_BOARD', 'POLL_OPENED', "
    "'ISSUE_REPORTED', 'ISSUE_URGENT', 'ISSUE_STATUS_CHANGED', "
    "'MAINTENANCE_DUE', 'NOTICE_PUBLISHED', 'STORAGE_ALMOST_FULL')"
)
SUBJECTS_BEFORE = "('post', 'period', 'poll', 'issue', 'maintenance_task')"
SUBJECTS_AFTER = "('post', 'period', 'poll', 'issue', 'maintenance_task', 'storage')"
EVENT_CHECKS = (
    ("notif_preferences", "ck_notif_preferences_event_type"),
    ("notif_deliveries", "ck_notif_deliveries_event_type"),
)


def _replace(events: str, subjects: str) -> None:
    for table, name in EVENT_CHECKS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, f"event_type IN {events}")
    op.drop_constraint("ck_notif_deliveries_subject_type", "notif_deliveries", type_="check")
    op.create_check_constraint(
        "ck_notif_deliveries_subject_type", "notif_deliveries", f"subject_type IN {subjects}"
    )


def upgrade() -> None:
    op.create_table(
        "core_file_alerts",
        sa.Column("building_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("threshold", sa.Integer(), nullable=False),
        sa.Column("reached_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("threshold IN (70, 90)", name="ck_core_file_alerts_threshold"),
        sa.ForeignKeyConstraint(["building_id"], ["property_buildings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("building_id", "threshold"),
    )
    _replace(EVENTS_AFTER, SUBJECTS_AFTER)


def downgrade() -> None:
    # The old checks cannot hold the new values: their rows go first.
    op.execute(
        "DELETE FROM notif_deliveries WHERE event_type = 'STORAGE_ALMOST_FULL'"
        " OR subject_type = 'storage'"
    )
    op.execute("DELETE FROM notif_preferences WHERE event_type = 'STORAGE_ALMOST_FULL'")
    _replace(EVENTS_BEFORE, SUBJECTS_BEFORE)
    op.drop_table("core_file_alerts")
