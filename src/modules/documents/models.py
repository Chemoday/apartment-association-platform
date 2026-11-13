"""Private SQLAlchemy models of the documents module. NEVER import them from another module.

docs/SCHEMA.md section 13. The PDF is a core_files row reached through the FileStore port.
"""

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import BigInteger, CheckConstraint, Date, DateTime, ForeignKey, Index, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.core.database import Base, uuid_pk, varchar_enum
from src.modules.documents.schemas import DocumentAudience, DocumentCategory


def _utc_now() -> datetime:
    return datetime.now(UTC)


class Document(Base):
    __tablename__ = "doc_documents"
    __table_args__ = (
        CheckConstraint("btrim(title) <> ''", name="ck_doc_documents_title_not_blank"),
        CheckConstraint("size_bytes > 0", name="ck_doc_documents_size_positive"),
        Index("ix_doc_documents_building_created", "building_id", "created_at"),
        # Purging a file sets file_id to NULL; without an index that scans the table.
        Index("ix_doc_documents_file", "file_id"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_buildings.id"), nullable=False
    )
    file_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_files.id", ondelete="SET NULL"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[DocumentCategory] = mapped_column(
        varchar_enum(DocumentCategory, "ck_doc_documents_category"), nullable=False
    )
    audience: Mapped[DocumentAudience] = mapped_column(
        varchar_enum(DocumentAudience, "ck_doc_documents_audience"), nullable=False
    )
    document_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    uploaded_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utc_now, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utc_now, server_default=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id", ondelete="SET NULL"), nullable=True
    )
