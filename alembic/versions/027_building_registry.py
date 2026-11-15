"""The building passport from a public register (epic E12, tasks X1 and X2).

docs/SCHEMA.md section 2: property_building_registry holds the proposal the chairman fetched and
the accepted block, one row per building.

Revision ID: 027
Revises: 026
Create Date: 2026-11-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "027"
down_revision: str | None = "026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "property_building_registry",
        sa.Column("building_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("proposal", postgresql.JSONB(), nullable=True),
        sa.Column("proposal_fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("proposal_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("accepted", postgresql.JSONB(), nullable=True),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("accepted_by_user_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["building_id"], ["property_buildings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["proposal_by_user_id"], ["core_users.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["accepted_by_user_id"], ["core_users.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("building_id"),
    )


def downgrade() -> None:
    op.drop_table("property_building_registry")
