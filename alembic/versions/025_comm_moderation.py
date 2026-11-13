"""Forum moderation part 1 (issue #135, part of #18): author edits and hiding by the board.

docs/SCHEMA.md section 4: edited_at, hidden_at, hidden_by_user_id and hidden_reason on
comm_posts and comm_comments. Only forum topics are hidden, and the three hidden columns are set
and cleared together. Keep the check texts identical to src/modules/communication/models.py.

Revision ID: 025
Revises: 024
Create Date: 2026-11-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "025"
down_revision: str | None = "024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

HIDDEN_CONSISTENT_CHECK = (
    "(hidden_at IS NULL) = (hidden_by_user_id IS NULL)"
    " AND (hidden_at IS NULL) = (hidden_reason IS NULL)"
)
ONLY_FORUM_HIDDEN_CHECK = "post_type = 'FORUM_TOPIC' OR hidden_at IS NULL"
TABLES = ("comm_posts", "comm_comments")


def upgrade() -> None:
    for table in TABLES:
        op.add_column(table, sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True))
        op.add_column(table, sa.Column("hidden_at", sa.DateTime(timezone=True), nullable=True))
        op.add_column(
            table,
            sa.Column(
                "hidden_by_user_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("core_users.id"),
                nullable=True,
            ),
        )
        op.add_column(table, sa.Column("hidden_reason", sa.String(500), nullable=True))
        op.create_check_constraint(f"ck_{table}_hidden_consistent", table, HIDDEN_CONSISTENT_CHECK)
    op.create_check_constraint(
        "ck_comm_posts_only_forum_hidden", "comm_posts", ONLY_FORUM_HIDDEN_CHECK
    )


def downgrade() -> None:
    op.drop_constraint("ck_comm_posts_only_forum_hidden", "comm_posts", type_="check")
    for table in TABLES:
        op.drop_constraint(f"ck_{table}_hidden_consistent", table, type_="check")
        for column in ("hidden_reason", "hidden_by_user_id", "hidden_at", "edited_at"):
            op.drop_column(table, column)
