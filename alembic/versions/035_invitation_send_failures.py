"""Refusals of an invitation e-mail in a row (epic E13 R4a, owner decision 2026-11-22).

docs/SCHEMA.md section 7: auth_invitations.send_failures counts the mail server's refusals in a
row; after 8 the queue gives up and the invitation shows delivery FAILED until a resend. 0 for
every existing invitation; the server default keeps the previous release working after a
rollback (it inserts invitations without this column, and ignores it).

Revision ID: 035
Revises: 034
Create Date: 2026-11-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "035"
down_revision: str | None = "034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "auth_invitations",
        sa.Column("send_failures", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
    )


def downgrade() -> None:
    op.drop_column("auth_invitations", "send_failures")
