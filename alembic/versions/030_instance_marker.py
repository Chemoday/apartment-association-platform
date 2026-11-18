"""The installation marker (epic E13 R1, issue #158).

docs/SCHEMA.md section 6: core_instance holds at most one row, the INSTANCE_ID of the installation
the database belongs to and whether its data are a demo. The startup check
(src/core/instance.py) writes it; an existing database gets it on its first start after this.

Revision ID: 030
Revises: 029
Create Date: 2026-11-18
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "030"
down_revision: str | None = "029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "core_instance",
        sa.Column("id", sa.SmallInteger(), nullable=False),
        sa.Column("instance_id", sa.String(length=64), nullable=False),
        sa.Column("demo", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("id = 1", name="ck_core_instance_single_row"),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("core_instance")
