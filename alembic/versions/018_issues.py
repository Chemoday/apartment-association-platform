"""The building issue tracker (epic E9, task I1).

docs/SCHEMA.md section 10: iss_issues, iss_followers and iss_status_changes.

Revision ID: 018
Revises: 017
Create Date: 2026-11-08
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "018"
down_revision: str | None = "017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UUID = sa.UUID(as_uuid=True)

CATEGORIES = (
    "'LIGHTING', 'DOORS_AND_LOCKS', 'LIFT', 'HEATING', 'WATER_AND_SEWAGE', 'ELECTRICITY', "
    "'CLEANING', 'WASTE', 'YARD', 'ROOF_AND_FACADE', 'OTHER'"
)
STATUSES = (
    "'REPORTED', 'IN_PROGRESS', 'WAITING_FOR_CONTRACTOR', 'RESOLVED', 'DUPLICATE', 'DECLINED', "
    "'WITHDRAWN'"
)
# Keep these texts identical to src/modules/issues/models.py: tests compare the catalogs.
ENDED_CHECK = (
    "(status IN ('RESOLVED', 'DUPLICATE', 'DECLINED', 'WITHDRAWN')) = (ended_at IS NOT NULL)"
)
DUPLICATE_CHECK = "(status = 'DUPLICATE') = (duplicate_of_id IS NOT NULL)"


def _timestamp(name: str) -> sa.Column:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now())


def upgrade() -> None:
    op.create_table(
        "iss_issues",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("building_id", UUID, sa.ForeignKey("property_buildings.id"), nullable=False),
        sa.Column("reporter_user_id", UUID, sa.ForeignKey("core_users.id"), nullable=False),
        sa.Column(
            "reporter_apartment_id", UUID, sa.ForeignKey("property_apartments.id"), nullable=True
        ),
        sa.Column("category", sa.String(32), nullable=False),
        sa.Column("entrance", sa.Integer(), nullable=True),
        sa.Column("place", sa.String(200), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("description", sa.Text(), nullable=False, server_default=""),
        sa.Column("urgent", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("duplicate_of_id", UUID, sa.ForeignKey("iss_issues.id"), nullable=True),
        _timestamp("created_at"),
        _timestamp("updated_at"),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(f"category IN ({CATEGORIES})", name="ck_iss_issues_category"),
        sa.CheckConstraint(f"status IN ({STATUSES})", name="ck_iss_issues_status"),
        sa.CheckConstraint(ENDED_CHECK, name="ck_iss_issues_ended"),
        sa.CheckConstraint(DUPLICATE_CHECK, name="ck_iss_issues_duplicate"),
        sa.CheckConstraint("entrance > 0", name="ck_iss_issues_entrance_positive"),
        sa.CheckConstraint("btrim(title) <> ''", name="ck_iss_issues_title_not_blank"),
        sa.CheckConstraint("btrim(place) <> ''", name="ck_iss_issues_place_not_blank"),
    )
    op.create_index("ix_iss_issues_building_status", "iss_issues", ["building_id", "status"])
    op.create_index(
        "ix_iss_issues_apartment_created", "iss_issues", ["reporter_apartment_id", "created_at"]
    )

    op.create_table(
        "iss_followers",
        sa.Column(
            "issue_id",
            UUID,
            sa.ForeignKey("iss_issues.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("user_id", UUID, sa.ForeignKey("core_users.id"), primary_key=True),
        _timestamp("created_at"),
    )

    op.create_table(
        "iss_status_changes",
        sa.Column("id", UUID, primary_key=True),
        sa.Column(
            "issue_id", UUID, sa.ForeignKey("iss_issues.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("from_status", sa.String(32), nullable=True),
        sa.Column("to_status", sa.String(32), nullable=False),
        sa.Column("changed_by_user_id", UUID, sa.ForeignKey("core_users.id"), nullable=False),
        _timestamp("changed_at"),
        sa.CheckConstraint(
            f"from_status IN ({STATUSES})", name="ck_iss_status_changes_from_status"
        ),
        sa.CheckConstraint(f"to_status IN ({STATUSES})", name="ck_iss_status_changes_to_status"),
    )
    op.create_index("ix_iss_status_changes_issue_id", "iss_status_changes", ["issue_id"])


def downgrade() -> None:
    op.drop_index("ix_iss_status_changes_issue_id", table_name="iss_status_changes")
    op.drop_table("iss_status_changes")
    op.drop_table("iss_followers")
    op.drop_index("ix_iss_issues_apartment_created", table_name="iss_issues")
    op.drop_index("ix_iss_issues_building_status", table_name="iss_issues")
    op.drop_table("iss_issues")
