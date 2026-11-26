"""Targets by kind of object: everything (ALL_OBJECTS) and kinds (KINDS) (epic E14, task K2).

docs/SCHEMA.md sections 4, 10 and 12: comm_posts and gov_polls get target_kinds and
maint_tasks gets notice_target_kinds, a non-empty JSON array of known kinds exactly for KINDS
and NULL otherwise. The scope checks take the two new scopes, the target checks are rebuilt to
validate the kinds (one unknown string would break every read of the row), and a forum topic may
be addressed to everything or to kinds (the service allows that with task K3). Every existing
row passes the new checks, and the previous release's inserts (without the new columns) too. The
downgrade refuses while a post, a poll or a maintenance notice is addressed to everything or to
kinds: the previous release cannot load such a row.

Revision ID: 038
Revises: 037
Create Date: 2026-11-26
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "038"
down_revision: str | None = "037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The texts of the models, written out: migrations never change. Posts and polls share one text.
_UUIDS = (
    " AND NOT jsonb_path_exists(target_apartment_ids,"
    ' \'$[*] ? (!(@.type() == "string"'
    ' && @ like_regex "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"))\'))'
)
_OLD_TARGET = (
    "(target_scope = 'ALL_BUILDING' AND target_entrance IS NULL"
    " AND target_apartment_ids IS NULL)"
    " OR (target_scope = 'ENTRANCE' AND target_entrance IS NOT NULL"
    " AND target_apartment_ids IS NULL)"
    " OR (target_scope = 'APARTMENT_LIST' AND target_entrance IS NULL"
    " AND target_apartment_ids IS NOT NULL"
    " AND jsonb_typeof(target_apartment_ids) = 'array'"
    " AND target_apartment_ids <> '[]'::jsonb" + _UUIDS
)
_NEW_TARGET = (
    "(target_scope IN ('ALL_BUILDING', 'ALL_OBJECTS') AND target_entrance IS NULL"
    " AND target_apartment_ids IS NULL AND target_kinds IS NULL)"
    " OR (target_scope = 'ENTRANCE' AND target_entrance IS NOT NULL"
    " AND target_apartment_ids IS NULL AND target_kinds IS NULL)"
    " OR (target_scope = 'KINDS' AND target_entrance IS NULL"
    " AND target_apartment_ids IS NULL AND target_kinds IS NOT NULL"
    " AND jsonb_typeof(target_kinds) = 'array' AND target_kinds <> '[]'::jsonb"
    " AND NOT jsonb_path_exists(target_kinds,"
    """ '$[*] ? (!(@.type() == "string" && (@ == "APARTMENT" || @ == "PARKING" """
    """|| @ == "GARAGE")))'))"""
    " OR (target_scope = 'APARTMENT_LIST' AND target_entrance IS NULL AND target_kinds IS NULL"
    " AND target_apartment_ids IS NOT NULL"
    " AND jsonb_typeof(target_apartment_ids) = 'array'"
    " AND target_apartment_ids <> '[]'::jsonb" + _UUIDS
)
_OLD_NOTICE = (
    "notice_target_scope IS NULL"
    " OR (notice_target_scope = 'ALL_BUILDING' AND notice_target_entrance IS NULL"
    " AND notice_target_apartment_ids IS NULL)"
    " OR (notice_target_scope = 'ENTRANCE' AND notice_target_entrance IS NOT NULL"
    " AND notice_target_apartment_ids IS NULL)"
    " OR (notice_target_scope = 'APARTMENT_LIST' AND notice_target_entrance IS NULL"
    " AND notice_target_apartment_ids IS NOT NULL"
    " AND jsonb_typeof(notice_target_apartment_ids) = 'array'"
    " AND notice_target_apartment_ids <> '[]'::jsonb)"
)
_NEW_NOTICE = (
    "notice_target_scope IS NULL"
    " OR (notice_target_scope IN ('ALL_BUILDING', 'ALL_OBJECTS')"
    " AND notice_target_entrance IS NULL"
    " AND notice_target_apartment_ids IS NULL AND notice_target_kinds IS NULL)"
    " OR (notice_target_scope = 'ENTRANCE' AND notice_target_entrance IS NOT NULL"
    " AND notice_target_apartment_ids IS NULL AND notice_target_kinds IS NULL)"
    " OR (notice_target_scope = 'KINDS' AND notice_target_entrance IS NULL"
    " AND notice_target_apartment_ids IS NULL AND notice_target_kinds IS NOT NULL"
    " AND jsonb_typeof(notice_target_kinds) = 'array' AND notice_target_kinds <> '[]'::jsonb"
    " AND NOT jsonb_path_exists(notice_target_kinds,"
    """ '$[*] ? (!(@.type() == "string" && (@ == "APARTMENT" || @ == "PARKING" """
    """|| @ == "GARAGE")))'))"""
    " OR (notice_target_scope = 'APARTMENT_LIST' AND notice_target_entrance IS NULL"
    " AND notice_target_kinds IS NULL"
    " AND notice_target_apartment_ids IS NOT NULL"
    " AND jsonb_typeof(notice_target_apartment_ids) = 'array'"
    " AND notice_target_apartment_ids <> '[]'::jsonb)"
)
_OLD_SCOPES = "target_scope IN ('ALL_BUILDING', 'ENTRANCE', 'APARTMENT_LIST')"
_NEW_SCOPES = (
    "target_scope IN ('ALL_BUILDING', 'ENTRANCE', 'APARTMENT_LIST', 'ALL_OBJECTS', 'KINDS')"
)
_OLD_FORUM = "post_type <> 'FORUM_TOPIC' OR target_scope = 'ALL_BUILDING'"
_NEW_FORUM = (
    "post_type <> 'FORUM_TOPIC' OR target_scope IN ('ALL_BUILDING', 'ALL_OBJECTS', 'KINDS')"
)


def _replace(name: str, table: str, condition: str) -> None:
    op.drop_constraint(name, table, type_="check")
    op.create_check_constraint(name, table, condition)


def upgrade() -> None:
    for table, column in (
        ("comm_posts", "target_kinds"),
        ("gov_polls", "target_kinds"),
        ("maint_tasks", "notice_target_kinds"),
    ):
        op.add_column(table, sa.Column(column, JSONB(none_as_null=True), nullable=True))
    for table in ("comm_posts", "gov_polls"):
        prefix = "ck_comm_posts" if table == "comm_posts" else "ck_gov_polls"
        _replace(f"{prefix}_target_scope", table, _NEW_SCOPES)
        _replace(f"{prefix}_target_consistent", table, _NEW_TARGET)
    _replace("ck_comm_posts_forum_whole_building", "comm_posts", _NEW_FORUM)
    _replace("ck_maint_tasks_notice_target", "maint_tasks", _NEW_NOTICE)


def downgrade() -> None:
    bind = op.get_bind()
    by_kind = sum(
        bind.scalar(
            sa.text(f"SELECT count(*) FROM {table} WHERE {column} IN ('ALL_OBJECTS', 'KINDS')")
        )
        for table, column in (
            ("comm_posts", "target_scope"),
            ("gov_polls", "target_scope"),
            ("maint_tasks", "notice_target_scope"),
        )
    )
    if by_kind:
        raise RuntimeError(
            f"{by_kind} posts, polls or maintenance notices are addressed to everything or to "
            "kinds: the previous release cannot load them. Remove them before downgrading below "
            "migration 038."
        )
    _replace("ck_maint_tasks_notice_target", "maint_tasks", _OLD_NOTICE)
    _replace("ck_comm_posts_forum_whole_building", "comm_posts", _OLD_FORUM)
    for table in ("comm_posts", "gov_polls"):
        prefix = "ck_comm_posts" if table == "comm_posts" else "ck_gov_polls"
        _replace(f"{prefix}_target_consistent", table, _OLD_TARGET)
        _replace(f"{prefix}_target_scope", table, _OLD_SCOPES)
    op.drop_column("maint_tasks", "notice_target_kinds")
    op.drop_column("gov_polls", "target_kinds")
    op.drop_column("comm_posts", "target_kinds")
