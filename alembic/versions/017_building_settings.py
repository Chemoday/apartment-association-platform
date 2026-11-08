"""Building settings changed by the chairman (epic E9, task I0).

docs/SCHEMA.md section 9: core_building_settings (only changed values; a missing row is the
default) and core_building_setting_changes (the log).

Revision ID: 017
Revises: 016
Create Date: 2026-11-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "017"
down_revision: str | None = "016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UUID = sa.UUID(as_uuid=True)


def upgrade() -> None:
    op.create_table(
        "core_building_settings",
        sa.Column(
            "building_id",
            UUID,
            sa.ForeignKey("property_buildings.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("key", sa.String(64), primary_key=True),
        sa.Column("value", JSONB(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "updated_by_user_id",
            UUID,
            sa.ForeignKey("core_users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_table(
        "core_building_setting_changes",
        sa.Column("id", UUID, primary_key=True),
        sa.Column(
            "building_id",
            UUID,
            sa.ForeignKey("property_buildings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("old_value", JSONB(), nullable=True),
        sa.Column("new_value", JSONB(), nullable=True),
        sa.Column(
            "changed_by_user_id",
            UUID,
            sa.ForeignKey("core_users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "changed_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index(
        "ix_core_building_setting_changes_building_time",
        "core_building_setting_changes",
        ["building_id", "changed_at"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_core_building_setting_changes_building_time",
        table_name="core_building_setting_changes",
    )
    op.drop_table("core_building_setting_changes")
    op.drop_table("core_building_settings")
