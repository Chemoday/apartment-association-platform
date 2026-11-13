"""Shared file storage (epic E11, task F1): core_files.

docs/SCHEMA.md section 12.

Revision ID: 022
Revises: 021
Create Date: 2026-11-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "022"
down_revision: str | None = "021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "core_files",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("building_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("purpose", sa.String(length=32), nullable=False),
        sa.Column("owner_ref", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("content_type", sa.String(length=64), nullable=False),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("created_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("idempotency_key", sa.String(length=64), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("delete_after", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("purge_after", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("purpose IN ('issue_photo')", name="ck_core_files_purpose"),
        sa.CheckConstraint(
            "(deleted_at IS NULL) = (purge_after IS NULL)", name="ck_core_files_purge"
        ),
        sa.CheckConstraint("size_bytes > 0", name="ck_core_files_size_positive"),
        sa.CheckConstraint("width > 0 AND height > 0", name="ck_core_files_dimensions_positive"),
        sa.ForeignKeyConstraint(["building_id"], ["property_buildings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_user_id"], ["core_users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_core_files_owner", "core_files", ["purpose", "owner_ref"])
    op.create_index("ix_core_files_building", "core_files", ["building_id"])
    op.create_index(
        "ix_core_files_creator_time", "core_files", ["created_by_user_id", "created_at"]
    )
    op.create_index(
        "uq_core_files_idempotency",
        "core_files",
        ["created_by_user_id", "idempotency_key"],
        unique=True,
        postgresql_where=sa.text("idempotency_key IS NOT NULL"),
    )
    op.create_index(
        "ix_core_files_expiring",
        "core_files",
        ["delete_after"],
        postgresql_where=sa.text("deleted_at IS NULL AND delete_after IS NOT NULL"),
    )
    op.create_index(
        "ix_core_files_purge",
        "core_files",
        ["purge_after"],
        postgresql_where=sa.text("purge_after IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table("core_files")
