"""The building chat (issue #142): chat_messages.

docs/SCHEMA.md section 14: messages of residents and the board that live at most 2 hours; the
setting `chat.enabled` needs no schema change (core_building_settings).

Revision ID: 026
Revises: 025
Create Date: 2026-11-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "026"
down_revision: str | None = "025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("building_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("author_user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("author_apartment_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("body", sa.String(500), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("btrim(body) <> ''", name="ck_chat_messages_body_not_blank"),
        sa.ForeignKeyConstraint(["building_id"], ["property_buildings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["author_user_id"], ["core_users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(
            ["author_apartment_id"], ["property_apartments.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_chat_messages_building_id", "chat_messages", ["building_id", "id"])
    op.create_index(
        "ix_chat_messages_author_created", "chat_messages", ["author_user_id", "created_at"]
    )
    op.create_index("ix_chat_messages_created", "chat_messages", ["created_at"])


def downgrade() -> None:
    op.drop_table("chat_messages")
