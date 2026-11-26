"""Objects of several kinds: apartments, parking spaces and garages (epic E14, task K1).

docs/SCHEMA.md section 2: property_apartments.kind is APARTMENT, PARKING or GARAGE, and every
existing row becomes an APARTMENT (the server default keeps the previous release working: it
inserts apartments without the column). entrance, floor and area_m2 become nullable and lose
the default of 1, so an object written without them never becomes "entrance 1, floor 1"; an
apartment still has all three (the check of the fields by kind, which every existing row
passes). The number is unique per building and kind. The downgrade refuses while an object of
another kind exists, because the previous release would take it for an apartment.

Revision ID: 037
Revises: 036
Create Date: 2026-11-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "037"
down_revision: str | None = "036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The texts of the model (src/modules/property/models.py), written out: migrations never change.
_KIND_FIELDS = (
    "(kind = 'APARTMENT' AND entrance IS NOT NULL AND floor IS NOT NULL "
    "AND area_m2 IS NOT NULL) OR (kind <> 'APARTMENT' AND entrance IS NULL)"
)


def upgrade() -> None:
    op.add_column(
        "property_apartments",
        sa.Column("kind", sa.String(32), nullable=False, server_default="APARTMENT"),
    )
    op.create_check_constraint(
        "ck_property_apartments_kind",
        "property_apartments",
        "kind IN ('APARTMENT', 'PARKING', 'GARAGE')",
    )
    for column, kind in (
        ("entrance", sa.Integer()),
        ("floor", sa.Integer()),
        ("area_m2", sa.Numeric(8, 2)),
    ):
        op.alter_column(
            "property_apartments", column, existing_type=kind, nullable=True, server_default=None
        )
    op.create_check_constraint(
        "ck_property_apartments_kind_fields", "property_apartments", _KIND_FIELDS
    )
    op.drop_constraint(
        "uq_property_apartments_building_number", "property_apartments", type_="unique"
    )
    op.create_unique_constraint(
        "uq_property_apartments_building_kind_number",
        "property_apartments",
        ["building_id", "kind", "number"],
    )


def downgrade() -> None:
    others = op.get_bind().scalar(
        sa.text("SELECT count(*) FROM property_apartments WHERE kind <> 'APARTMENT'")
    )
    if others:
        raise RuntimeError(
            f"{others} parking spaces or garages exist: the previous release would take them for "
            "apartments. Remove them before downgrading below migration 037."
        )
    op.drop_constraint(
        "uq_property_apartments_building_kind_number", "property_apartments", type_="unique"
    )
    op.create_unique_constraint(
        "uq_property_apartments_building_number", "property_apartments", ["building_id", "number"]
    )
    op.drop_constraint("ck_property_apartments_kind_fields", "property_apartments", type_="check")
    op.alter_column(
        "property_apartments",
        "entrance",
        existing_type=sa.Integer(),
        nullable=False,
        server_default=sa.text("1"),
    )
    op.alter_column(
        "property_apartments",
        "floor",
        existing_type=sa.Integer(),
        nullable=False,
        server_default=sa.text("1"),
    )
    op.alter_column(
        "property_apartments", "area_m2", existing_type=sa.Numeric(8, 2), nullable=False
    )
    op.drop_constraint("ck_property_apartments_kind", "property_apartments", type_="check")
    op.drop_column("property_apartments", "kind")
