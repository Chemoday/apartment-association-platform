"""Documents of the association (epic E11, task F3): doc_documents, and `document` files.

docs/SCHEMA.md sections 12 and 13.

Revision ID: 023
Revises: 022
Create Date: 2026-11-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "023"
down_revision: str | None = "022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CATEGORIES = (
    "'ARTICLES', 'GENERAL_MEETING_MINUTES', 'BOARD_MINUTES', 'CONTRACT', 'INVOICE', "
    "'FINANCIAL_REPORT', 'INSURANCE', 'HOUSE_RULES', 'OTHER'"
)


def upgrade() -> None:
    op.drop_constraint("ck_core_files_purpose", "core_files", type_="check")
    op.create_check_constraint(
        "ck_core_files_purpose", "core_files", "purpose IN ('issue_photo', 'document')"
    )
    op.create_table(
        "doc_documents",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("building_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("category", sa.String(length=32), nullable=False),
        sa.Column("audience", sa.String(length=32), nullable=False),
        sa.Column("document_date", sa.Date(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("uploaded_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.CheckConstraint(f"category IN ({CATEGORIES})", name="ck_doc_documents_category"),
        sa.CheckConstraint(
            "audience IN ('EVERYONE', 'BOARD_AND_ACCOUNTANT', 'BOARD')",
            name="ck_doc_documents_audience",
        ),
        sa.CheckConstraint("btrim(title) <> ''", name="ck_doc_documents_title_not_blank"),
        sa.CheckConstraint("size_bytes > 0", name="ck_doc_documents_size_positive"),
        sa.ForeignKeyConstraint(["building_id"], ["property_buildings.id"]),
        sa.ForeignKeyConstraint(["file_id"], ["core_files.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["uploaded_by_user_id"], ["core_users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["deleted_by_user_id"], ["core_users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_doc_documents_building_created", "doc_documents", ["building_id", "created_at"]
    )
    op.create_index("ix_doc_documents_file", "doc_documents", ["file_id"])


def downgrade() -> None:
    op.drop_table("doc_documents")
    # The old check cannot hold documents: their files go first.
    op.execute("DELETE FROM core_files WHERE purpose = 'document'")
    op.drop_constraint("ck_core_files_purpose", "core_files", type_="check")
    op.create_check_constraint("ck_core_files_purpose", "core_files", "purpose IN ('issue_photo')")
