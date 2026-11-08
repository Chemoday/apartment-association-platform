"""The maintenance calendar and log (epic E10, task M1).

docs/SCHEMA.md section 11: maint_tasks, maint_occurrences and maint_log_entries.

Revision ID: 020
Revises: 019
Create Date: 2026-11-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "020"
down_revision: str | None = "019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UUID = sa.UUID(as_uuid=True)

# Keep these texts identical to src/modules/maintenance/models.py: tests compare the catalogs.
NOTICE_COMPLETE_CHECK = (
    "(notice_title IS NULL) = (notice_body IS NULL)"
    " AND (notice_title IS NULL) = (notice_target_scope IS NULL)"
    " AND (notice_title IS NULL) = (notice_category IS NULL)"
    " AND (notice_title IS NULL) = (notice_comments_enabled IS NULL)"
)
NOTICE_TARGET_CHECK = (
    "notice_target_scope IS NULL"
    " OR (notice_target_scope = 'ALL_BUILDING' AND notice_target_entrance IS NULL"
    " AND notice_target_apartment_ids IS NULL)"
    " OR (notice_target_scope = 'ENTRANCE' AND notice_target_entrance IS NOT NULL"
    " AND notice_target_apartment_ids IS NULL)"
    " OR (notice_target_scope = 'APARTMENT_LIST' AND notice_target_entrance IS NULL"
    " AND notice_target_apartment_ids IS NOT NULL"
    " AND jsonb_typeof(notice_target_apartment_ids) = 'array'"
    " AND notice_target_apartment_ids <> '[]'::jsonb)"
)


def _timestamp(name: str) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())


def upgrade() -> None:
    op.create_table(
        "maint_tasks",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("building_id", UUID, sa.ForeignKey("property_buildings.id"), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("instructions", sa.Text(), nullable=False, server_default=""),
        sa.Column("period_unit", sa.String(16), nullable=False),
        sa.Column("period_count", sa.Integer(), nullable=False),
        sa.Column("lead_days", sa.Integer(), nullable=False),
        sa.Column("anchor_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("notice_title", sa.String(255), nullable=True),
        sa.Column("notice_body", sa.Text(), nullable=True),
        sa.Column("notice_category", sa.String(50), nullable=True),
        sa.Column("notice_target_scope", sa.String(32), nullable=True),
        sa.Column("notice_target_entrance", sa.Integer(), nullable=True),
        sa.Column("notice_target_apartment_ids", JSONB(), nullable=True),
        sa.Column("notice_comments_enabled", sa.Boolean(), nullable=True),
        sa.Column("created_by_user_id", UUID, sa.ForeignKey("core_users.id"), nullable=False),
        sa.Column("updated_by_user_id", UUID, sa.ForeignKey("core_users.id"), nullable=False),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("btrim(title) <> ''", name="ck_maint_tasks_title_not_blank"),
        sa.CheckConstraint(
            "period_count BETWEEN 1 AND 3650", name="ck_maint_tasks_period_count_range"
        ),
        sa.CheckConstraint("lead_days BETWEEN 0 AND 90", name="ck_maint_tasks_lead_days_range"),
        sa.CheckConstraint(
            "(status = 'ARCHIVED') = (archived_at IS NOT NULL)", name="ck_maint_tasks_archived"
        ),
        sa.CheckConstraint(NOTICE_COMPLETE_CHECK, name="ck_maint_tasks_notice_complete"),
        sa.CheckConstraint(NOTICE_TARGET_CHECK, name="ck_maint_tasks_notice_target"),
        sa.CheckConstraint(
            "period_unit IN ('DAY', 'MONTH', 'YEAR')", name="ck_maint_tasks_period_unit"
        ),
        sa.CheckConstraint(
            "status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')", name="ck_maint_tasks_status"
        ),
    )
    op.create_index("ix_maint_tasks_building_status", "maint_tasks", ["building_id", "status"])

    op.create_table(
        "maint_occurrences",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("task_id", UUID, sa.ForeignKey("maint_tasks.id"), nullable=False),
        sa.Column("building_id", UUID, sa.ForeignKey("property_buildings.id"), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("due_date", sa.Date(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("board_post_id", UUID, nullable=True),
        sa.Column("notice_post_id", UUID, nullable=True),
        sa.Column("notice_failed", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("last_reminded_on", sa.Date(), nullable=True),
        sa.Column("reminder_count", sa.Integer(), nullable=False, server_default=sa.text("0")),
        _timestamp("created_at"),
        sa.CheckConstraint("seq >= 0", name="ck_maint_occurrences_seq_positive"),
        sa.CheckConstraint(
            "(status = 'OPEN') = (closed_at IS NULL)", name="ck_maint_occurrences_closed"
        ),
        sa.CheckConstraint(
            "status IN ('OPEN', 'DONE', 'SKIPPED', 'CANCELLED')",
            name="ck_maint_occurrences_status",
        ),
    )
    op.create_index(
        "uq_maint_occurrences_one_open",
        "maint_occurrences",
        ["task_id"],
        unique=True,
        postgresql_where=sa.text("status = 'OPEN'"),
    )
    op.create_index(
        "ix_maint_occurrences_open_due",
        "maint_occurrences",
        ["due_date"],
        postgresql_where=sa.text("status = 'OPEN'"),
    )

    op.create_table(
        "maint_log_entries",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("building_id", UUID, sa.ForeignKey("property_buildings.id"), nullable=False),
        sa.Column("task_id", UUID, sa.ForeignKey("maint_tasks.id"), nullable=False),
        sa.Column(
            "occurrence_id",
            UUID,
            sa.ForeignKey("maint_occurrences.id"),
            nullable=False,
            unique=True,
        ),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("closed_on", sa.Date(), nullable=False),
        sa.Column("note", sa.String(1000), nullable=False, server_default=""),
        sa.Column("cost", sa.Numeric(12, 2), nullable=True),
        sa.Column("recorded_by_user_id", UUID, sa.ForeignKey("core_users.id"), nullable=False),
        sa.Column("updated_by_user_id", UUID, sa.ForeignKey("core_users.id"), nullable=True),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.CheckConstraint("cost >= 0", name="ck_maint_log_entries_cost_positive"),
        sa.CheckConstraint("kind = 'DONE' OR cost IS NULL", name="ck_maint_log_entries_cost_done"),
        sa.CheckConstraint("kind IN ('DONE', 'SKIPPED')", name="ck_maint_log_entries_kind"),
    )
    op.create_index(
        "ix_maint_log_entries_building_closed",
        "maint_log_entries",
        ["building_id", "closed_on"],
    )


def downgrade() -> None:
    op.drop_index("ix_maint_log_entries_building_closed", table_name="maint_log_entries")
    op.drop_table("maint_log_entries")
    op.drop_index("ix_maint_occurrences_open_due", table_name="maint_occurrences")
    op.drop_index("uq_maint_occurrences_one_open", table_name="maint_occurrences")
    op.drop_table("maint_occurrences")
    op.drop_index("ix_maint_tasks_building_status", table_name="maint_tasks")
    op.drop_table("maint_tasks")
