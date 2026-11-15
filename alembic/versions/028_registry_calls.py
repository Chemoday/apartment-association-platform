"""The daily quota of register calls (epic E12, S-10, issue #152).

docs/SCHEMA.md section 2: property_registry_calls counts the calls of the installation per UTC
day.

Revision ID: 028
Revises: 027
Create Date: 2026-11-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "028"
down_revision: str | None = "027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "property_registry_calls",
        sa.Column("day", sa.Date(), nullable=False),
        sa.Column("calls", sa.Integer(), nullable=False),
        sa.CheckConstraint("calls >= 1", name="ck_property_registry_calls_positive"),
        sa.PrimaryKeyConstraint("day"),
    )


def downgrade() -> None:
    op.drop_table("property_registry_calls")
