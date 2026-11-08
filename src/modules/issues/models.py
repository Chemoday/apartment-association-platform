"""Private SQLAlchemy models of the issue tracker. NEVER import them from another module.

docs/SCHEMA.md section 10. Users and apartments are referenced by id and read only through
PropertyService.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.core.database import Base, uuid_pk, varchar_enum
from src.modules.issues.schemas import IssueCategory, IssueStatus

# Keep these texts identical to alembic/versions/018_issues.py: tests compare the catalogs.
ENDED_CHECK = (
    "(status IN ('RESOLVED', 'DUPLICATE', 'DECLINED', 'WITHDRAWN')) = (ended_at IS NOT NULL)"
)
DUPLICATE_CHECK = "(status = 'DUPLICATE') = (duplicate_of_id IS NOT NULL)"


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


class Issue(Base):
    __tablename__ = "iss_issues"
    __table_args__ = (
        CheckConstraint(ENDED_CHECK, name="ck_iss_issues_ended"),
        CheckConstraint(DUPLICATE_CHECK, name="ck_iss_issues_duplicate"),
        CheckConstraint("entrance > 0", name="ck_iss_issues_entrance_positive"),
        CheckConstraint("btrim(title) <> ''", name="ck_iss_issues_title_not_blank"),
        CheckConstraint("btrim(place) <> ''", name="ck_iss_issues_place_not_blank"),
        Index("ix_iss_issues_building_status", "building_id", "status"),
        Index("ix_iss_issues_apartment_created", "reporter_apartment_id", "created_at"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_buildings.id"), nullable=False
    )
    reporter_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id"), nullable=False
    )
    reporter_apartment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_apartments.id"), nullable=True
    )
    category: Mapped[IssueCategory] = mapped_column(
        varchar_enum(IssueCategory, "ck_iss_issues_category"), nullable=False
    )
    entrance: Mapped[int | None] = mapped_column(Integer, nullable=True)
    place: Mapped[str] = mapped_column(String(200), nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, server_default="")
    urgent: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    status: Mapped[IssueStatus] = mapped_column(
        varchar_enum(IssueStatus, "ck_iss_issues_status"), nullable=False
    )
    duplicate_of_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("iss_issues.id"), nullable=True
    )
    created_at: Mapped[datetime] = _timestamp()
    updated_at: Mapped[datetime] = _timestamp()
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class IssueFollower(Base):
    __tablename__ = "iss_followers"

    issue_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("iss_issues.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id"), primary_key=True
    )
    created_at: Mapped[datetime] = _timestamp()


class IssueStatusChange(Base):
    __tablename__ = "iss_status_changes"

    id: Mapped[uuid.UUID] = uuid_pk()
    issue_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("iss_issues.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    from_status: Mapped[IssueStatus | None] = mapped_column(
        varchar_enum(IssueStatus, "ck_iss_status_changes_from_status"), nullable=True
    )
    to_status: Mapped[IssueStatus] = mapped_column(
        varchar_enum(IssueStatus, "ck_iss_status_changes_to_status"), nullable=False
    )
    changed_by_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id"), nullable=False
    )
    changed_at: Mapped[datetime] = _timestamp()
