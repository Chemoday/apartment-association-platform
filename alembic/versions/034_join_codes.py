"""Join codes on paper and join requests (epic E13 R4c, issue #173).

docs/SCHEMA.md sections 5 and 7: auth_join_codes (keyed hashes only), auth_join_requests (the
personal data a person typed, deleted at the decision), auth_join_decisions (without personal
data); auth_attempts.kind gets JOIN (the per-IP limit of the public join page);
JOIN_REQUEST_SUBMITTED joins the event_type checks of notifications and join_request the
subject_type check.

Revision ID: 034
Revises: 033
Create Date: 2026-11-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "034"
down_revision: str | None = "033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_EVENTS = (
    "'EMERGENCY_PUBLISHED', 'EMERGENCY_RESOLVED', 'READING_DEADLINE', 'PERIOD_REVIEW', "
    "'APARTMENT_MESSAGE', 'APARTMENT_MESSAGE_TO_BOARD', 'POLL_OPENED', "
    "'ISSUE_REPORTED', 'ISSUE_URGENT', 'ISSUE_STATUS_CHANGED', "
    "'MAINTENANCE_DUE', 'NOTICE_PUBLISHED', 'STORAGE_ALMOST_FULL', 'ENERGY_CERTIFICATE_EXPIRING'"
)
EVENTS_BEFORE = f"({_EVENTS})"
EVENTS_AFTER = f"({_EVENTS}, 'JOIN_REQUEST_SUBMITTED')"
_SUBJECTS = "'post', 'period', 'poll', 'issue', 'maintenance_task', 'storage', 'building'"
SUBJECTS_BEFORE = f"({_SUBJECTS})"
SUBJECTS_AFTER = f"({_SUBJECTS}, 'join_request')"
EVENT_CHECKS = (
    ("notif_preferences", "ck_notif_preferences_event_type"),
    ("notif_deliveries", "ck_notif_deliveries_event_type"),
)
_KINDS = "'MAGIC_LINK', 'REDEEM', 'PASSWORD', 'INVITATION', 'BULK_INVITATION', 'INVITATION_MAIL'"


def _replace(events: str, subjects: str, kinds: str) -> None:
    for table, name in EVENT_CHECKS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, f"event_type IN {events}")
    op.drop_constraint("ck_notif_deliveries_subject_type", "notif_deliveries", type_="check")
    op.create_check_constraint(
        "ck_notif_deliveries_subject_type", "notif_deliveries", f"subject_type IN {subjects}"
    )
    op.drop_constraint("ck_auth_attempts_kind", "auth_attempts", type_="check")
    op.create_check_constraint("ck_auth_attempts_kind", "auth_attempts", f"kind IN ({kinds})")


def upgrade() -> None:
    op.create_table(
        "auth_join_codes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "building_id",
            UUID(as_uuid=True),
            sa.ForeignKey("property_buildings.id"),
            nullable=False,
        ),
        sa.Column(
            "apartment_id",
            UUID(as_uuid=True),
            sa.ForeignKey("property_apartments.id"),
            nullable=False,
        ),
        sa.Column("code_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("created_by_user_id", UUID(as_uuid=True), sa.ForeignKey("core_users.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        sa.Column("cancelled_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_auth_join_codes_apartment_id", "auth_join_codes", ["apartment_id"])
    op.create_table(
        "auth_join_requests",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "building_id",
            UUID(as_uuid=True),
            sa.ForeignKey("property_buildings.id"),
            nullable=False,
        ),
        sa.Column(
            "apartment_id",
            UUID(as_uuid=True),
            sa.ForeignKey("property_apartments.id"),
            nullable=False,
        ),
        sa.Column(
            "code_id",
            UUID(as_uuid=True),
            sa.ForeignKey("auth_join_codes.id", ondelete="SET NULL"),
            unique=True,
        ),
        sa.Column("full_name", sa.String(200), nullable=False),
        sa.Column("phone", sa.String(32), nullable=False),
        sa.Column("email", sa.String(255), nullable=False),
        sa.Column("locale", sa.String(8)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("locale IN ('et', 'ru', 'en')", name="ck_auth_join_requests_locale"),
    )
    op.create_index("ix_auth_join_requests_apartment_id", "auth_join_requests", ["apartment_id"])
    op.create_table(
        "auth_join_decisions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "building_id",
            UUID(as_uuid=True),
            sa.ForeignKey("property_buildings.id"),
            nullable=False,
        ),
        sa.Column(
            "apartment_id",
            UUID(as_uuid=True),
            sa.ForeignKey("property_apartments.id", ondelete="SET NULL"),
        ),
        sa.Column("outcome", sa.String(16), nullable=False),
        sa.Column("decided_by_user_id", UUID(as_uuid=True), sa.ForeignKey("core_users.id")),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "outcome IN ('CONFIRMED', 'REJECTED', 'EXPIRED')",
            name="ck_auth_join_decisions_outcome",
        ),
    )
    op.create_index("ix_auth_join_decisions_building_id", "auth_join_decisions", ["building_id"])
    _replace(EVENTS_AFTER, SUBJECTS_AFTER, f"{_KINDS}, 'JOIN'")


def downgrade() -> None:
    # The old checks cannot hold the new values: their rows go first.
    op.execute(
        "DELETE FROM notif_deliveries WHERE event_type = 'JOIN_REQUEST_SUBMITTED'"
        " OR subject_type = 'join_request'"
    )
    op.execute("DELETE FROM notif_preferences WHERE event_type = 'JOIN_REQUEST_SUBMITTED'")
    op.execute("DELETE FROM auth_attempts WHERE kind = 'JOIN'")
    _replace(EVENTS_BEFORE, SUBJECTS_BEFORE, _KINDS)
    op.drop_table("auth_join_decisions")
    op.drop_table("auth_join_requests")
    op.drop_table("auth_join_codes")
