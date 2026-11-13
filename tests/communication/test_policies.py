"""Unit tests of the pure communication rules (no database)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from src.modules.communication.policies import (
    COMMENT_HIDEABLE_ON,
    EDIT_WINDOW,
    HIDEABLE_POST_TYPES,
    can_publish,
    comment_editable_until,
    comment_is_editable,
    deletable_types,
    edit_window_closed,
    is_deletable,
    post_editable_until,
    post_is_editable,
    sees_all_targets,
    sees_hidden_text,
    target_problem,
    thread_author_apartment,
)
from src.modules.communication.schemas import PostType, TargetScope
from src.modules.property.schemas import BuildingRole

APARTMENT = uuid.uuid4()


@pytest.mark.parametrize(
    ("post_type", "role", "allowed"),
    [
        (PostType.EMERGENCY, BuildingRole.CHAIRMAN, True),
        (PostType.EMERGENCY, BuildingRole.BOARD, True),
        (PostType.EMERGENCY, BuildingRole.ACCOUNTANT, False),
        (PostType.EMERGENCY, BuildingRole.USER, False),
        (PostType.OFFICIAL_NOTICE, BuildingRole.CHAIRMAN, True),
        (PostType.OFFICIAL_NOTICE, BuildingRole.BOARD, True),
        (PostType.OFFICIAL_NOTICE, BuildingRole.ACCOUNTANT, False),
        (PostType.OFFICIAL_NOTICE, BuildingRole.USER, False),
        (PostType.FORUM_TOPIC, BuildingRole.USER, True),
        (PostType.FORUM_TOPIC, BuildingRole.ACCOUNTANT, True),
        (PostType.FORUM_TOPIC, BuildingRole.CHAIRMAN, True),
        # Membership of the thread's apartment is checked by the service.
        (PostType.APARTMENT_THREAD, BuildingRole.USER, True),
        (PostType.APARTMENT_THREAD, BuildingRole.ACCOUNTANT, True),
        (PostType.BOARD_TOPIC, BuildingRole.CHAIRMAN, True),
        (PostType.BOARD_TOPIC, BuildingRole.BOARD, True),
        (PostType.BOARD_TOPIC, BuildingRole.ACCOUNTANT, False),
        (PostType.BOARD_TOPIC, BuildingRole.USER, False),
    ],
)
def test_who_may_publish(post_type: PostType, role: BuildingRole, allowed: bool) -> None:
    assert can_publish(post_type, role) is allowed


def test_only_the_board_sees_every_target() -> None:
    assert sees_all_targets(BuildingRole.CHAIRMAN)
    assert sees_all_targets(BuildingRole.BOARD)
    assert not sees_all_targets(BuildingRole.ACCOUNTANT)
    assert not sees_all_targets(BuildingRole.USER)


@pytest.mark.parametrize(
    ("post_type", "scope", "entrance", "apartments"),
    [
        (PostType.EMERGENCY, TargetScope.ALL_BUILDING, None, None),
        (PostType.EMERGENCY, TargetScope.ALL_BUILDING, None, []),
        (PostType.EMERGENCY, TargetScope.ENTRANCE, 2, None),
        (PostType.EMERGENCY, TargetScope.APARTMENT_LIST, None, [APARTMENT]),
        (PostType.OFFICIAL_NOTICE, TargetScope.ENTRANCE, 1, None),
        (PostType.FORUM_TOPIC, TargetScope.ALL_BUILDING, None, None),
        (PostType.APARTMENT_THREAD, TargetScope.APARTMENT_LIST, None, [APARTMENT]),
        (PostType.BOARD_TOPIC, TargetScope.ALL_BUILDING, None, None),
    ],
)
def test_consistent_targets_pass(post_type, scope, entrance, apartments) -> None:
    assert target_problem(post_type, scope, entrance, apartments) is None


@pytest.mark.parametrize(
    ("post_type", "scope", "entrance", "apartments", "fragment"),
    [
        (PostType.FORUM_TOPIC, TargetScope.ENTRANCE, 2, None, "whole building"),
        (PostType.FORUM_TOPIC, TargetScope.APARTMENT_LIST, None, [APARTMENT], "whole building"),
        (PostType.EMERGENCY, TargetScope.ALL_BUILDING, 2, None, "ALL_BUILDING"),
        (PostType.EMERGENCY, TargetScope.ALL_BUILDING, None, [APARTMENT], "ALL_BUILDING"),
        (PostType.EMERGENCY, TargetScope.ENTRANCE, None, None, "needs target_entrance"),
        (PostType.EMERGENCY, TargetScope.ENTRANCE, 2, [APARTMENT], "does not take"),
        (PostType.EMERGENCY, TargetScope.APARTMENT_LIST, None, None, "at least one"),
        (PostType.EMERGENCY, TargetScope.APARTMENT_LIST, None, [], "at least one"),
        (PostType.EMERGENCY, TargetScope.APARTMENT_LIST, 2, [APARTMENT], "does not take"),
        (PostType.APARTMENT_THREAD, TargetScope.ALL_BUILDING, None, None, "exactly one"),
        (PostType.BOARD_TOPIC, TargetScope.ENTRANCE, 2, None, "Board topics take no target"),
        (PostType.APARTMENT_THREAD, TargetScope.ENTRANCE, 2, None, "exactly one"),
        (PostType.APARTMENT_THREAD, TargetScope.APARTMENT_LIST, None, None, "exactly one"),
        (
            PostType.APARTMENT_THREAD,
            TargetScope.APARTMENT_LIST,
            None,
            [APARTMENT, uuid.uuid4()],
            "exactly one",
        ),
    ],
)
def test_inconsistent_targets_are_explained(post_type, scope, entrance, apartments, fragment):
    problem = target_problem(post_type, scope, entrance, apartments)

    assert problem is not None
    assert fragment in problem


def test_only_forum_topics_are_deletable() -> None:
    assert is_deletable(PostType.FORUM_TOPIC)
    assert not is_deletable(PostType.EMERGENCY)
    assert not is_deletable(PostType.OFFICIAL_NOTICE)
    assert not is_deletable(PostType.APARTMENT_THREAD)
    assert is_deletable(PostType.BOARD_TOPIC)


def test_who_deletes_what() -> None:
    assert deletable_types(BuildingRole.CHAIRMAN) == {PostType.FORUM_TOPIC, PostType.BOARD_TOPIC}
    assert deletable_types(BuildingRole.BOARD) == {PostType.FORUM_TOPIC, PostType.BOARD_TOPIC}
    assert deletable_types(BuildingRole.ACCOUNTANT) == frozenset()
    assert deletable_types(BuildingRole.USER) == frozenset()


def test_a_member_writes_from_the_thread_apartment_and_anyone_else_as_the_board() -> None:
    other = uuid.uuid4()
    assert thread_author_apartment(APARTMENT, {APARTMENT, other}) == APARTMENT
    assert thread_author_apartment(APARTMENT, {other}) is None
    assert thread_author_apartment(APARTMENT, set()) is None


# --- Moderation (issue #135) ---------------------------------------------------------------------


@pytest.mark.parametrize("post_type", list(PostType))
def test_only_topics_people_wrote_are_editable_while_shown(post_type: PostType) -> None:
    topic = post_type in {PostType.FORUM_TOPIC, PostType.BOARD_TOPIC}
    assert post_is_editable(post_type, from_maintenance=False, hidden=False) is topic
    assert not post_is_editable(post_type, from_maintenance=True, hidden=False)
    assert not post_is_editable(post_type, from_maintenance=False, hidden=True)


@pytest.mark.parametrize("post_type", list(PostType))
def test_comments_are_editable_outside_threads_unless_hidden(post_type: PostType) -> None:
    outside_thread = post_type != PostType.APARTMENT_THREAD
    assert comment_is_editable(post_type, False, post_hidden=False, comment_hidden=False) is (
        outside_thread
    )
    assert not comment_is_editable(post_type, True, post_hidden=False, comment_hidden=False)
    assert not comment_is_editable(post_type, False, post_hidden=True, comment_hidden=False)
    assert not comment_is_editable(post_type, False, post_hidden=False, comment_hidden=True)


def test_what_the_board_hides() -> None:
    assert HIDEABLE_POST_TYPES == {PostType.FORUM_TOPIC}
    assert {PostType.APARTMENT_THREAD, PostType.BOARD_TOPIC}.isdisjoint(COMMENT_HIDEABLE_ON)


@pytest.mark.parametrize("role", list(BuildingRole))
def test_hidden_text_is_for_the_author_and_the_board(role: BuildingRole) -> None:
    board = role in {BuildingRole.CHAIRMAN, BuildingRole.BOARD}
    assert sees_hidden_text(role, is_author=False) is board
    assert sees_hidden_text(role, is_author=True)


@pytest.mark.parametrize("post_type", list(PostType))
def test_forum_topics_and_comments_are_edited_for_24_hours_board_topics_always(
    post_type: PostType,
) -> None:
    written = datetime(2026, 11, 13, 10, 0, tzinfo=UTC)
    expected = None if post_type == PostType.BOARD_TOPIC else written + timedelta(hours=24)
    assert post_editable_until(post_type, written) == expected
    assert (
        comment_editable_until(written)
        == written + EDIT_WINDOW
        == datetime(2026, 11, 14, 10, 0, tzinfo=UTC)
    )


def test_the_last_moment_of_the_window_still_counts() -> None:
    until = datetime(2026, 11, 14, 10, 0, tzinfo=UTC)
    assert not edit_window_closed(until, until)
    assert edit_window_closed(until, until + timedelta(microseconds=1))
    assert not edit_window_closed(None, until + timedelta(days=365))  # board topics
