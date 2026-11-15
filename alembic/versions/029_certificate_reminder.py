"""The energy certificate reminder (epic E12 X2b, issue #148).

docs/SCHEMA.md sections 2 and 5: property_building_registry remembers the certificate and the
last threshold reminded; ENERGY_CERTIFICATE_EXPIRING joins the event_type checks of
notif_preferences and notif_deliveries, and 'building' the subject_type check of
notif_deliveries.

Revision ID: 029
Revises: 028
Create Date: 2026-11-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "029"
down_revision: str | None = "028"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_EVENTS = (
    "'EMERGENCY_PUBLISHED', 'EMERGENCY_RESOLVED', 'READING_DEADLINE', 'PERIOD_REVIEW', "
    "'APARTMENT_MESSAGE', 'APARTMENT_MESSAGE_TO_BOARD', 'POLL_OPENED', "
    "'ISSUE_REPORTED', 'ISSUE_URGENT', 'ISSUE_STATUS_CHANGED', "
    "'MAINTENANCE_DUE', 'NOTICE_PUBLISHED', 'STORAGE_ALMOST_FULL'"
)
EVENTS_BEFORE = f"({_EVENTS})"
EVENTS_AFTER = f"({_EVENTS}, 'ENERGY_CERTIFICATE_EXPIRING')"
SUBJECTS_BEFORE = "('post', 'period', 'poll', 'issue', 'maintenance_task', 'storage')"
SUBJECTS_AFTER = "('post', 'period', 'poll', 'issue', 'maintenance_task', 'storage', 'building')"
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
    op.add_column(
        "property_building_registry",
        sa.Column("certificate_reminded_for", sa.Date(), nullable=True),
    )
    op.add_column(
        "property_building_registry",
        sa.Column("certificate_reminded_threshold", sa.Integer(), nullable=True),
    )
    op.create_check_constraint(
        "ck_property_building_registry_threshold",
        "property_building_registry",
        "certificate_reminded_threshold IN (180, 30, 0)",
    )
    _replace(EVENTS_AFTER, SUBJECTS_AFTER)


def downgrade() -> None:
    # The old checks cannot hold the new values: their rows go first.
    op.execute(
        "DELETE FROM notif_deliveries WHERE event_type = 'ENERGY_CERTIFICATE_EXPIRING'"
        " OR subject_type = 'building'"
    )
    op.execute("DELETE FROM notif_preferences WHERE event_type = 'ENERGY_CERTIFICATE_EXPIRING'")
    _replace(EVENTS_BEFORE, SUBJECTS_BEFORE)
    op.drop_constraint(
        "ck_property_building_registry_threshold", "property_building_registry", type_="check"
    )
    op.drop_column("property_building_registry", "certificate_reminded_threshold")
    op.drop_column("property_building_registry", "certificate_reminded_for")
