"""The chairman's mark "worked on paper" of an apartment (epic E13 R4b, issue #172).

docs/SCHEMA.md section 2: property_apartments.on_paper, false for every existing apartment. The
server default keeps the previous release working after a rollback (it inserts apartments
without this column).

Revision ID: 033
Revises: 032
Create Date: 2026-11-22
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "033"
down_revision: str | None = "032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "property_apartments",
        sa.Column("on_paper", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("property_apartments", "on_paper")
