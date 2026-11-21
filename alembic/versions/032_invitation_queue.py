"""The language and the send queue of invitations (epic E13 R4a, issue #171).

docs/SCHEMA.md section 7: auth_invitations gets locale (the language picked for it), send_due_at
(set while its e-mail is queued) and send_attempts; auth_attempts.kind gets BULK_INVITATION (the
building limit of bulk invitations) and INVITATION_MAIL (the pacing of the queue). Existing
invitations were sent at once, so they stay send_due_at NULL (delivered).

After a rollback the previous release sends invitations at once as before and never reads the
queue: an invitation still queued at that moment stays unsent until it is resent.

Revision ID: 032
Revises: 031
Create Date: 2026-11-21
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "032"
down_revision: str | None = "031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("auth_invitations", sa.Column("locale", sa.String(length=8), nullable=True))
    op.create_check_constraint(
        "ck_auth_invitations_locale", "auth_invitations", "locale IN ('et', 'ru', 'en')"
    )
    op.add_column(
        "auth_invitations", sa.Column("send_due_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column(
        "auth_invitations",
        sa.Column("send_attempts", sa.SmallInteger(), nullable=False, server_default=sa.text("0")),
    )
    op.create_index(
        "ix_auth_invitations_send_due",
        "auth_invitations",
        ["send_due_at"],
        postgresql_where=sa.text("send_due_at IS NOT NULL"),
    )
    op.drop_constraint("ck_auth_attempts_kind", "auth_attempts", type_="check")
    op.create_check_constraint(
        "ck_auth_attempts_kind",
        "auth_attempts",
        "kind IN ('MAGIC_LINK', 'REDEEM', 'PASSWORD', 'INVITATION', 'BULK_INVITATION', "
        "'INVITATION_MAIL')",
    )


def downgrade() -> None:
    op.execute("DELETE FROM auth_attempts WHERE kind IN ('BULK_INVITATION', 'INVITATION_MAIL')")
    op.drop_constraint("ck_auth_attempts_kind", "auth_attempts", type_="check")
    op.create_check_constraint(
        "ck_auth_attempts_kind",
        "auth_attempts",
        "kind IN ('MAGIC_LINK', 'REDEEM', 'PASSWORD', 'INVITATION')",
    )
    op.drop_index("ix_auth_invitations_send_due", table_name="auth_invitations")
    op.drop_column("auth_invitations", "send_attempts")
    op.drop_column("auth_invitations", "send_due_at")
    op.drop_constraint("ck_auth_invitations_locale", "auth_invitations", type_="check")
    op.drop_column("auth_invitations", "locale")
