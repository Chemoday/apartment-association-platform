"""Private SQLAlchemy models of the maintenance calendar. NEVER import them from another module.

docs/SCHEMA.md section 11. Users are referenced by id and read only through PropertyService.
"""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.core.database import Base, uuid_pk, varchar_enum
from src.modules.maintenance.schemas import LogKind, OccurrenceStatus, PeriodUnit, TaskStatus

# Keep these texts identical to alembic/versions/020_maintenance.py: tests compare the catalogs.
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


def _utc_now() -> datetime:
    return datetime.now(UTC)


def _timestamp(**kwargs: Any) -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=_utc_now,
        server_default=func.now(),
        **kwargs,
    )


class Task(Base):
    __tablename__ = "maint_tasks"
    __table_args__ = (
        CheckConstraint("btrim(title) <> ''", name="ck_maint_tasks_title_not_blank"),
        CheckConstraint(
            "period_count BETWEEN 1 AND 3650", name="ck_maint_tasks_period_count_range"
        ),
        CheckConstraint("lead_days BETWEEN 0 AND 90", name="ck_maint_tasks_lead_days_range"),
        CheckConstraint("anchor_day BETWEEN 1 AND 31", name="ck_maint_tasks_anchor_day_range"),
        CheckConstraint(
            "(status = 'ARCHIVED') = (archived_at IS NOT NULL)", name="ck_maint_tasks_archived"
        ),
        CheckConstraint(NOTICE_COMPLETE_CHECK, name="ck_maint_tasks_notice_complete"),
        CheckConstraint(NOTICE_TARGET_CHECK, name="ck_maint_tasks_notice_target"),
        Index("ix_maint_tasks_building_status", "building_id", "status"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_buildings.id"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    instructions: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    period_unit: Mapped[PeriodUnit] = mapped_column(
        varchar_enum(PeriodUnit, "ck_maint_tasks_period_unit", length=16), nullable=False
    )
    period_count: Mapped[int] = mapped_column(Integer, nullable=False)
    lead_days: Mapped[int] = mapped_column(Integer, nullable=False)
    anchor_date: Mapped[date] = mapped_column(Date, nullable=False)
    # The rhythm's day of the month (31 stays 31 after a re-anchor on a clamped 28 February).
    anchor_day: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[TaskStatus] = mapped_column(
        varchar_enum(TaskStatus, "ck_maint_tasks_status", length=16), nullable=False
    )
    notice_title: Mapped[str | None] = mapped_column(String(255), nullable=True)
    notice_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    notice_category: Mapped[str | None] = mapped_column(String(50), nullable=True)
    notice_target_scope: Mapped[str | None] = mapped_column(String(32), nullable=True)
    notice_target_entrance: Mapped[int | None] = mapped_column(Integer, nullable=True)
    notice_target_apartment_ids: Mapped[list[str] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    notice_comments_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id"), nullable=False
    )
    updated_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id"), nullable=False
    )
    created_at: Mapped[datetime] = _timestamp()
    updated_at: Mapped[datetime] = _timestamp()
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Occurrence(Base):
    __tablename__ = "maint_occurrences"
    __table_args__ = (
        CheckConstraint("seq >= 0", name="ck_maint_occurrences_seq_positive"),
        CheckConstraint(
            "(status = 'OPEN') = (closed_at IS NULL)", name="ck_maint_occurrences_closed"
        ),
        Index(
            "uq_maint_occurrences_one_open",
            "task_id",
            unique=True,
            postgresql_where=text("status = 'OPEN'"),
        ),
        Index(
            "ix_maint_occurrences_open_due",
            "due_date",
            postgresql_where=text("status = 'OPEN'"),
        ),
        Index(
            "ix_maint_occurrences_open_remind",
            "next_remind_on",
            postgresql_where=text("status = 'OPEN'"),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("maint_tasks.id"), nullable=False
    )
    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_buildings.id"), nullable=False
    )
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    due_date: Mapped[date] = mapped_column(Date, nullable=False)
    status: Mapped[OccurrenceStatus] = mapped_column(
        varchar_enum(OccurrenceStatus, "ck_maint_occurrences_status", length=16), nullable=False
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    board_post_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    notice_post_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    notice_failed: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    last_reminded_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    # The local date of the next overdue reminder: the day after the due date, then every N days.
    next_remind_on: Mapped[date | None] = mapped_column(Date, nullable=True)
    reminder_count: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    created_at: Mapped[datetime] = _timestamp()


class LogEntry(Base):
    __tablename__ = "maint_log_entries"
    __table_args__ = (
        CheckConstraint("cost >= 0", name="ck_maint_log_entries_cost_positive"),
        CheckConstraint("kind = 'DONE' OR cost IS NULL", name="ck_maint_log_entries_cost_done"),
        Index("ix_maint_log_entries_building_closed", "building_id", "closed_on"),
        Index("ix_maint_log_entries_task_closed", "task_id", "closed_on"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_buildings.id"), nullable=False
    )
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("maint_tasks.id"), nullable=False
    )
    occurrence_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("maint_occurrences.id"), nullable=False, unique=True
    )
    kind: Mapped[LogKind] = mapped_column(
        varchar_enum(LogKind, "ck_maint_log_entries_kind", length=16), nullable=False
    )
    closed_on: Mapped[date] = mapped_column(Date, nullable=False)
    note: Mapped[str] = mapped_column(String(1000), nullable=False, server_default="")
    cost: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
    recorded_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id"), nullable=False
    )
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id"), nullable=True
    )
    created_at: Mapped[datetime] = _timestamp()
    updated_at: Mapped[datetime] = _timestamp()
