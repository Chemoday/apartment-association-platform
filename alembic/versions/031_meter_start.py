"""A meter without a start (epic E13 R3b, issue #170).

docs/SCHEMA.md section 3: meters_devices.serial_number and initial_value become nullable (a
building imported without them), and meters_readings.previous_origin records where a reading's
previous_value came from. Existing readings: each meter's earliest reading took the meter's
initial value (INITIAL), every later one the reading before it (HISTORY).

The downgrade gives a meter without a start an initial value of 0 and an unset serial number an
empty one, so a meter that never had a reading would count its whole value as its first
consumption after a downgrade; downgrades are not part of a rollback (the migrations stay).

Revision ID: 031
Revises: 030
Create Date: 2026-11-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "031"
down_revision: str | None = "030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("meters_devices", "serial_number", existing_type=sa.String(100), nullable=True)
    op.alter_column(
        "meters_devices",
        "initial_value",
        existing_type=sa.Numeric(12, 3),
        nullable=True,
        server_default=None,
    )
    op.add_column(
        "meters_readings", sa.Column("previous_origin", sa.String(length=16), nullable=True)
    )
    op.execute(
        """
        UPDATE meters_readings AS r
        SET previous_origin = CASE WHEN ranked.position = 1 THEN 'INITIAL' ELSE 'HISTORY' END
        FROM (
            SELECT mr.id,
                   row_number() OVER (PARTITION BY mr.meter_id ORDER BY p.period_code) AS position
            FROM meters_readings mr
            JOIN meters_periods p ON p.id = mr.period_id
        ) AS ranked
        WHERE ranked.id = r.id
        """
    )
    # The default keeps the previous release working after a rollback: it inserts readings
    # without this column. Its readings then count as HISTORY, which is right for every meter
    # that already had a reading or an initial value (docs/DEPLOYMENT.md "Rollback").
    op.alter_column(
        "meters_readings",
        "previous_origin",
        existing_type=sa.String(16),
        nullable=False,
        server_default=sa.text("'HISTORY'"),
    )
    op.create_check_constraint(
        "ck_meters_readings_previous_origin",
        "meters_readings",
        "previous_origin IN ('HISTORY', 'INITIAL', 'SUBMITTED', 'START')",
    )
    op.create_check_constraint(
        "ck_meters_readings_start_without_consumption",
        "meters_readings",
        "previous_origin <> 'START' OR previous_value = value",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_meters_readings_start_without_consumption", "meters_readings", type_="check"
    )
    op.drop_constraint("ck_meters_readings_previous_origin", "meters_readings", type_="check")
    op.drop_column("meters_readings", "previous_origin")
    # A meter without a start gets the old default back; an unset serial number an empty one.
    op.execute("UPDATE meters_devices SET initial_value = 0 WHERE initial_value IS NULL")
    op.execute("UPDATE meters_devices SET serial_number = '' WHERE serial_number IS NULL")
    op.alter_column(
        "meters_devices",
        "initial_value",
        existing_type=sa.Numeric(12, 3),
        nullable=False,
        server_default=sa.text("0.000"),
    )
    op.alter_column("meters_devices", "serial_number", existing_type=sa.String(100), nullable=False)
