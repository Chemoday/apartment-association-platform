"""Pure rules of the communication module (no database access; unit-tested directly)."""

from collections.abc import Collection
from datetime import datetime, timedelta
from uuid import UUID

from src.modules.communication.schemas import PostType, TargetScope
from src.modules.property.schemas import (
    BuildingRole,
    CurrentUserDTO,
    ObjectKind,
    TargetDTO,
    target_consistency_problem,
)

# Publish emergencies and official notices, resolve emergencies, and see every targeted post.
PUBLISHER_ROLES = frozenset({BuildingRole.CHAIRMAN, BuildingRole.BOARD})

_BOARD_ONLY_TYPES = frozenset({PostType.EMERGENCY, PostType.OFFICIAL_NOTICE, PostType.BOARD_TOPIC})

# Private types: listed only when asked for by post_type, never in the forum feed.
FEED_HIDDEN_TYPES = frozenset({PostType.APARTMENT_THREAD, PostType.BOARD_TOPIC})

# Conversations listed by their newest activity rather than by creation.
ACTIVITY_SORTED_TYPES = frozenset({PostType.APARTMENT_THREAD, PostType.BOARD_TOPIC})

# Who may delete which type: forum topics and the board's own topics by the chairman and any
# board member (owner decisions, E8 and 2026-11-13). Every other type is a record.
_DELETERS = {
    PostType.FORUM_TOPIC: PUBLISHER_ROLES,
    PostType.BOARD_TOPIC: PUBLISHER_ROLES,
}


def can_publish(post_type: PostType, building_role: BuildingRole) -> bool:
    """Emergencies, official notices and board topics come from the board; anyone may open a
    forum topic.

    Anyone may start a thread too; that a non-board author is a member of the thread's
    apartment is checked by the service against their memberships.
    """
    return post_type not in _BOARD_ONLY_TYPES or building_role in PUBLISHER_ROLES


def user_kinds(user: CurrentUserDTO) -> frozenset[ObjectKind]:
    """The kinds of the objects the user holds an active membership of."""
    return frozenset(m.apartment_kind for m in user.memberships)


def may_address(
    post_type: PostType,
    target: TargetDTO,
    building_role: BuildingRole,
    held: frozenset[ObjectKind],
) -> bool:
    """Whether the author may address this target, checked before the target itself (epic E14,
    section 3.2). The board addresses any target. Anyone else writes a forum topic to the whole
    building only with an apartment, and to kinds only of which they hold an object; everything
    (ALL_OBJECTS) is for the board. Other post types have their own rules."""
    if building_role in PUBLISHER_ROLES or post_type != PostType.FORUM_TOPIC:
        return True
    if target.scope == TargetScope.ALL_BUILDING:
        return ObjectKind.APARTMENT in held
    if target.scope == TargetScope.KINDS:  # no kinds: the target check answers 422
        return target.kinds <= held
    return target.scope != TargetScope.ALL_OBJECTS


def sees_all_targets(building_role: BuildingRole) -> bool:
    """The board sees every post of the building, including alerts targeted elsewhere."""
    return building_role in PUBLISHER_ROLES


def target_problem(post_type: PostType, target: TargetDTO) -> str | None:
    """Why the target of a new post is inconsistent, or None when it is fine: the rules of the
    post type, then the shared consistency of a target.

    Whether the entrance or the apartments exist in the building is checked by the service.
    """
    if post_type == PostType.FORUM_TOPIC and target.scope != TargetScope.ALL_BUILDING:
        return "Forum topics are always visible to the whole building."
    if post_type == PostType.BOARD_TOPIC and target.scope != TargetScope.ALL_BUILDING:
        return "Board topics take no target: the board sees them (ALL_BUILDING)."
    if post_type == PostType.APARTMENT_THREAD and (
        target.scope != TargetScope.APARTMENT_LIST or len(target.apartment_ids) != 1
    ):
        return "A thread with the board targets exactly one apartment (APARTMENT_LIST)."
    return target_consistency_problem(target)


def is_deletable(post_type: PostType) -> bool:
    """Only forum topics and board topics are deleted. Emergencies are resolved instead, and
    official notices and threads stay as the board's record."""
    return post_type in _DELETERS


def deletable_types(building_role: BuildingRole) -> frozenset[PostType]:
    """The post types this role may delete."""
    return frozenset(t for t, roles in _DELETERS.items() if building_role in roles)


def thread_author_apartment(
    thread_apartment_id: UUID, member_apartment_ids: Collection[UUID]
) -> UUID | None:
    """Who writes as whom in a thread: a member of its apartment writes from it, anyone else
    (the board) without an apartment. The server decides; the client cannot choose."""
    return thread_apartment_id if thread_apartment_id in member_apartment_ids else None


# --- Moderation (issue #135, docs/API.md section 4) ----------------------------------------------

# Hide and show again: the chairman and the board (owner decision 2026-11-09).
HIDER_ROLES = PUBLISHER_ROLES

# Authors edit their own topics; everything else is a record (the emergency text has been sent).
EDITABLE_POST_TYPES = frozenset({PostType.FORUM_TOPIC, PostType.BOARD_TOPIC})

# The board hides forum topics only; its own topics are deleted, emergencies resolved.
HIDEABLE_POST_TYPES = frozenset({PostType.FORUM_TOPIC})

# Comments the board hides: on the public posts, never in threads or the board's micro-forum.
COMMENT_HIDEABLE_ON = frozenset(
    {PostType.FORUM_TOPIC, PostType.OFFICIAL_NOTICE, PostType.EMERGENCY}
)


# Forum topics and comments are edited only this long after they were written, so neighbours never
# find an old post rewritten; board topics are notes kept up to date (owner decision 2026-11-13).
EDIT_WINDOW = timedelta(hours=24)
_TIMELESS_EDIT_TYPES = frozenset({PostType.BOARD_TOPIC})


def post_editable_until(post_type: PostType, created_at: datetime) -> datetime | None:
    """Until when the author may edit the post itself; None means no time limit."""
    return None if post_type in _TIMELESS_EDIT_TYPES else created_at + EDIT_WINDOW


def comment_editable_until(created_at: datetime) -> datetime:
    """Until when the author may edit a comment (any post type)."""
    return created_at + EDIT_WINDOW


def edit_window_closed(editable_until: datetime | None, now: datetime) -> bool:
    """Too late to edit: the limit has passed (the moment itself still counts as open)."""
    return editable_until is not None and now > editable_until


def post_is_editable(post_type: PostType, from_maintenance: bool, hidden: bool) -> bool:
    """A forum or board topic a person wrote, while it is not hidden."""
    return post_type in EDITABLE_POST_TYPES and not from_maintenance and not hidden


def comment_is_editable(
    post_type: PostType, on_maintenance_post: bool, post_hidden: bool, comment_hidden: bool
) -> bool:
    """Any comment outside the records (threads, and the maintenance calendar's posts, whose
    comments it writes as "done", "skipped" or "moved"), unless it or its topic is hidden."""
    return (
        post_type != PostType.APARTMENT_THREAD
        and not on_maintenance_post
        and not post_hidden
        and not comment_hidden
    )


def sees_hidden_text(building_role: BuildingRole, is_author: bool) -> bool:
    """Who reads a hidden comment's text and the reason: its author and the board."""
    return is_author or building_role in HIDER_ROLES
