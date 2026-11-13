"""Author edits and hiding by the board (issue #135; docs/API.md section 4; see conftest.py)."""

import uuid
from dataclasses import fields
from typing import Any

from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.communication.events import (
    CommentHidden,
    CommentUnhidden,
    PostHidden,
    PostUnhidden,
)
from src.modules.communication.models import Post
from tests.communication.conftest import CommWorld
from tests.communication.test_api import API, as_user, emergency, feed_ids, publish

REASON = "Personal attack on a neighbour"


async def topic(client: AsyncClient, user, **overrides: Any) -> dict:
    response = await publish(client, user, **overrides)
    assert response.status_code == 201, response.text
    return response.json()


async def comment(client: AsyncClient, user, post: dict, body: str = "I agree") -> dict:
    response = await client.post(
        f"{API}/posts/{post['id']}/comments", json={"body": body}, headers=as_user(user)
    )
    assert response.status_code == 201, response.text
    return response.json()


async def thread(client: AsyncClient, world: CommWorld) -> dict:
    return await topic(
        client,
        world.owner_14,
        post_type="APARTMENT_THREAD",
        target_scope="APARTMENT_LIST",
        target_apartment_ids=[str(world.apt_14.id)],
        title="The radiator is cold",
    )


def edit(client: AsyncClient, user, post: dict, **body: Any):
    return client.patch(f"{API}/posts/{post['id']}", json=body, headers=as_user(user))


def edit_comment(client: AsyncClient, user, post: dict, item: dict, body: str):
    return client.patch(
        f"{API}/posts/{post['id']}/comments/{item['id']}",
        json={"body": body},
        headers=as_user(user),
    )


def hide(client: AsyncClient, user, post: dict, reason: str = REASON):
    return client.post(
        f"{API}/posts/{post['id']}/hide", json={"reason": reason}, headers=as_user(user)
    )


def hide_comment(client: AsyncClient, user, post: dict, item: dict, reason: str = REASON):
    return client.post(
        f"{API}/posts/{post['id']}/comments/{item['id']}/hide",
        json={"reason": reason},
        headers=as_user(user),
    )


async def detail(client: AsyncClient, user, post: dict) -> dict:
    response = await client.get(f"{API}/posts/{post['id']}", headers=as_user(user))
    assert response.status_code == 200, response.text
    return response.json()


# --- Author edits ------------------------------------------------------------------------------


async def test_the_author_edits_a_topic_and_the_edit_is_visible(
    api_client: AsyncClient, world: CommWorld
) -> None:
    post = await topic(api_client, world.owner_14)
    assert post["edited_at"] is None

    response = await edit(api_client, world.owner_14, post, title="  A bike rack by the door ")

    assert response.status_code == 200, response.text
    edited = response.json()
    assert edited["title"] == "A bike rack by the door"  # trimmed like a new post
    assert edited["body"] == post["body"] and edited["edited_at"] is not None
    seen = await detail(api_client, world.tenant_2, post)
    assert (seen["title"], seen["edited_at"]) == ("A bike rack by the door", edited["edited_at"])

    again = (await edit(api_client, world.owner_14, post, title="A bike rack by the door")).json()
    assert again["edited_at"] == edited["edited_at"]  # the same text changes nothing


async def test_only_the_author_edits_and_only_what_they_can_see(
    api_client: AsyncClient, world: CommWorld
) -> None:
    post = await topic(api_client, world.owner_14)

    for user in (world.tenant_2, world.chairman, world.board):
        response = await edit(api_client, user, post, body="Changed by someone else")
        assert response.status_code == 403, user.full_name
        assert response.json()["error_code"] == "FORBIDDEN"
    for user, target in ((world.other_chairman, post), (world.owner_14, {"id": uuid.uuid4()})):
        response = await edit(api_client, user, target, body="x")
        assert response.status_code == 404
        assert response.json()["error_code"] == "POST_NOT_FOUND"
    assert (await detail(api_client, world.owner_14, post))["body"] == post["body"]


async def test_records_are_never_edited(
    api_client: AsyncClient, db_session: AsyncSession, world: CommWorld
) -> None:
    alert = await emergency(api_client, world.chairman)
    notice = await topic(api_client, world.chairman, post_type="OFFICIAL_NOTICE")
    talk = await thread(api_client, world)
    reminder = await topic(api_client, world.board, post_type="BOARD_TOPIC")
    await db_session.execute(
        update(Post).where(Post.id == uuid.UUID(reminder["id"])).values(origin="MAINTENANCE")
    )

    for user, post, post_type in (
        (world.chairman, alert, "EMERGENCY"),
        (world.chairman, notice, "OFFICIAL_NOTICE"),
        (world.owner_14, talk, "APARTMENT_THREAD"),
        (world.board, reminder, "BOARD_TOPIC"),  # published by the maintenance calendar
    ):
        response = await edit(api_client, user, post, body="A new text")
        assert response.status_code == 409, post_type
        assert response.json()["error_code"] == "POST_NOT_EDITABLE"
        assert response.json()["post_type"] == post_type


async def test_a_board_member_edits_their_own_board_topic(
    api_client: AsyncClient, world: CommWorld
) -> None:
    post = await topic(api_client, world.board, post_type="BOARD_TOPIC", title="Keys")

    response = await edit(api_client, world.board, post, body="The keys are in the boiler room.")

    assert response.status_code == 200, response.text
    assert response.json()["author_badge"]["display_label"] == "Peeter Saar"  # still by name
    assert (await edit(api_client, world.chairman, post, body="x")).status_code == 403


async def test_edit_input_is_validated(api_client: AsyncClient, world: CommWorld) -> None:
    post = await topic(api_client, world.owner_14)
    for body in ({}, {"title": None}, {"title": "   "}, {"body": "x" * 10_001}, {"pinned": True}):
        response = await edit(api_client, world.owner_14, post, **body)
        assert response.status_code == 422, body
        assert response.json()["error_code"] == "VALIDATION_ERROR"


async def test_the_author_edits_a_comment(api_client: AsyncClient, world: CommWorld) -> None:
    post = await topic(api_client, world.owner_14)
    mine = await comment(api_client, world.tenant_2, post)

    response = await edit_comment(api_client, world.tenant_2, post, mine, "I agree, by the door")

    assert response.status_code == 200, response.text
    assert response.json()["body"] == "I agree, by the door"
    assert response.json()["edited_at"] is not None
    (seen,) = (await detail(api_client, world.owner_14, post))["comments"]
    assert seen["body"] == "I agree, by the door" and seen["edited_at"] is not None

    for user in (world.owner_14, world.chairman):
        assert (await edit_comment(api_client, user, post, mine, "x")).status_code == 403
    other_post = await topic(api_client, world.owner_14, title="Another topic")
    wrong = await edit_comment(api_client, world.tenant_2, other_post, mine, "x")
    assert (wrong.status_code, wrong.json()["error_code"]) == (404, "COMMENT_NOT_FOUND")


async def test_a_reply_in_a_thread_is_a_record(api_client: AsyncClient, world: CommWorld) -> None:
    talk = await thread(api_client, world)
    reply = await comment(api_client, world.owner_14, talk, "Still cold today")

    response = await edit_comment(api_client, world.owner_14, talk, reply, "Fine now")

    assert response.status_code == 409
    assert response.json()["error_code"] == "COMMENT_NOT_EDITABLE"


# --- Hiding a topic ----------------------------------------------------------------------------


async def test_a_hidden_topic_is_seen_only_by_its_author_and_the_board(
    api_client: AsyncClient, world: CommWorld, published_events
) -> None:
    post = await topic(api_client, world.owner_14)
    await comment(api_client, world.tenant_2, post)

    response = await hide(api_client, world.board, post)

    assert response.status_code == 200, response.text
    hidden = response.json()
    assert hidden["hidden_at"] is not None and hidden["hidden_reason"] == REASON
    for user in (world.tenant_2, world.accountant):
        assert post["id"] not in await feed_ids(api_client, user)
        gone = await api_client.get(f"{API}/posts/{post['id']}", headers=as_user(user))
        assert (gone.status_code, gone.json()["error_code"]) == (404, "POST_NOT_FOUND")
    assert post["id"] in await feed_ids(api_client, world.chairman)
    own = await detail(api_client, world.owner_14, post)
    assert own["hidden_reason"] == REASON and own["comments_count"] == 1

    blocked = await api_client.post(
        f"{API}/posts/{post['id']}/comments", json={"body": "Why?"}, headers=as_user(world.owner_14)
    )
    assert (blocked.status_code, blocked.json()["error_code"]) == (409, "POST_HIDDEN")
    frozen = await edit(api_client, world.owner_14, post, body="Sorry")
    assert (frozen.status_code, frozen.json()["error_code"]) == (409, "POST_NOT_EDITABLE")

    (event,) = published_events
    assert isinstance(event, PostHidden)
    assert (str(event.post_id), event.moderator_user_id) == (post["id"], world.board.id)
    assert REASON not in repr(event)
    assert {"reason", "hidden_reason", "title", "body"}.isdisjoint(f.name for f in fields(event))


async def test_hiding_twice_keeps_the_first_reason_and_unhiding_shows_it_again(
    api_client: AsyncClient, world: CommWorld, published_events
) -> None:
    post = await topic(api_client, world.owner_14)
    first = (await hide(api_client, world.chairman, post)).json()

    second = (await hide(api_client, world.board, post, "Another reason")).json()
    assert (second["hidden_at"], second["hidden_reason"]) == (first["hidden_at"], REASON)

    unhide = await api_client.post(f"{API}/posts/{post['id']}/unhide", headers=as_user(world.board))
    assert unhide.status_code == 200, unhide.text
    assert (unhide.json()["hidden_at"], unhide.json()["hidden_reason"]) == (None, None)
    assert post["id"] in await feed_ids(api_client, world.tenant_2)
    again = await api_client.post(f"{API}/posts/{post['id']}/unhide", headers=as_user(world.board))
    assert again.status_code == 200

    assert [type(event) for event in published_events] == [PostHidden, PostUnhidden]


async def test_only_the_board_hides_and_only_forum_topics(
    api_client: AsyncClient, world: CommWorld
) -> None:
    post = await topic(api_client, world.owner_14)
    for user in (world.owner_14, world.tenant_2, world.accountant):
        response = await hide(api_client, user, post)
        assert (response.status_code, response.json()["error_code"]) == (403, "FORBIDDEN")
    assert (await hide(api_client, world.other_chairman, post)).status_code == 404

    alert = await emergency(api_client, world.chairman)
    board_topic = await topic(api_client, world.board, post_type="BOARD_TOPIC")
    for target, post_type in ((alert, "EMERGENCY"), (board_topic, "BOARD_TOPIC")):
        response = await hide(api_client, world.chairman, target)
        assert response.status_code == 409
        assert response.json() | {"message": ""} == {
            "error_code": "POST_NOT_HIDEABLE",
            "message": "",
            "post_type": post_type,
        }


async def test_the_reason_is_required_and_bounded(
    api_client: AsyncClient, world: CommWorld
) -> None:
    post = await topic(api_client, world.owner_14)
    for body in ({}, {"reason": "  "}, {"reason": "x" * 501}, {"reason": "ok\x00"}):
        response = await api_client.post(
            f"{API}/posts/{post['id']}/hide", json=body, headers=as_user(world.chairman)
        )
        assert response.status_code == 422, body
    assert (await hide(api_client, world.chairman, post, "x" * 500)).status_code == 200


async def test_the_chairman_still_deletes_a_hidden_topic(
    api_client: AsyncClient, world: CommWorld
) -> None:
    post = await topic(api_client, world.owner_14)
    await hide(api_client, world.board, post)

    deleted = await api_client.delete(f"{API}/posts/{post['id']}", headers=as_user(world.chairman))

    assert deleted.status_code == 204
    gone = await api_client.get(f"{API}/posts/{post['id']}", headers=as_user(world.owner_14))
    assert gone.status_code == 404


# --- Hiding a comment --------------------------------------------------------------------------


async def test_a_hidden_comment_stays_as_a_placeholder(
    api_client: AsyncClient, world: CommWorld, published_events
) -> None:
    post = await topic(api_client, world.chairman, post_type="OFFICIAL_NOTICE")
    rude = await comment(api_client, world.tenant_2, post, "You are all thieves")
    await comment(api_client, world.owner_14, post, "Thanks for the notice")

    response = await hide_comment(api_client, world.board, post, rude)

    assert response.status_code == 200, response.text
    assert response.json()["body"] == "You are all thieves"  # the board still reads it
    neighbour = await detail(api_client, world.owner_14, post)
    assert neighbour["comments_count"] == 2
    placeholder, kept = neighbour["comments"]
    assert placeholder["id"] == rude["id"]
    assert (placeholder["body"], placeholder["hidden_reason"]) == (None, None)
    assert placeholder["hidden_at"] is not None
    assert kept["body"] == "Thanks for the notice" and kept["hidden_at"] is None
    assert "You are all thieves" not in str(neighbour)
    for user in (world.tenant_2, world.chairman):
        (seen, _) = (await detail(api_client, user, post))["comments"]
        assert (seen["body"], seen["hidden_reason"]) == ("You are all thieves", REASON)

    frozen = await edit_comment(api_client, world.tenant_2, post, rude, "Sorry")
    assert (frozen.status_code, frozen.json()["error_code"]) == (409, "COMMENT_NOT_EDITABLE")

    shown = await api_client.post(
        f"{API}/posts/{post['id']}/comments/{rude['id']}/unhide", headers=as_user(world.chairman)
    )
    assert shown.status_code == 200 and shown.json()["hidden_at"] is None
    (back, _) = (await detail(api_client, world.owner_14, post))["comments"]
    assert back["body"] == "You are all thieves"

    hidden_event, shown_event = [
        e for e in published_events if isinstance(e, CommentHidden | CommentUnhidden)
    ]
    assert isinstance(hidden_event, CommentHidden) and isinstance(shown_event, CommentUnhidden)
    assert (str(hidden_event.comment_id), str(hidden_event.post_id)) == (rude["id"], post["id"])
    assert REASON not in repr(hidden_event)


async def test_comments_of_threads_and_board_topics_are_not_hidden(
    api_client: AsyncClient, world: CommWorld
) -> None:
    talk = await thread(api_client, world)
    reply = await comment(api_client, world.owner_14, talk, "Still cold")
    board_topic = await topic(api_client, world.board, post_type="BOARD_TOPIC")
    note = await comment(api_client, world.chairman, board_topic, "Noted")

    for post, item in ((talk, reply), (board_topic, note)):
        response = await hide_comment(api_client, world.chairman, post, item)
        assert response.status_code == 409
        assert response.json()["error_code"] == "COMMENT_NOT_HIDEABLE"

    forum = await topic(api_client, world.owner_14)
    wrong = await hide_comment(api_client, world.chairman, forum, reply)
    assert (wrong.status_code, wrong.json()["error_code"]) == (404, "COMMENT_NOT_FOUND")
    resident = await hide_comment(api_client, world.owner_14, talk, reply)
    assert resident.status_code == 403


# --- Review round 1: the remaining rules ---------------------------------------------------------


async def test_hiding_a_comment_twice_keeps_the_first_reason_once(
    api_client: AsyncClient, world: CommWorld, published_events
) -> None:
    alert = await emergency(api_client, world.chairman)
    rude = await comment(api_client, world.tenant_2, alert, "Fake news")

    first = (await hide_comment(api_client, world.chairman, alert, rude)).json()
    second = (await hide_comment(api_client, world.board, alert, rude, "Other")).json()

    assert (second["hidden_at"], second["hidden_reason"]) == (first["hidden_at"], REASON)
    hides = [e for e in published_events if isinstance(e, CommentHidden | CommentUnhidden)]
    assert [type(e) for e in hides] == [CommentHidden]
    (placeholder,) = (await detail(api_client, world.accountant, alert))["comments"]
    assert (placeholder["body"], placeholder["hidden_reason"]) == (None, None)


async def test_only_the_board_hides_or_shows_comments_and_topics(
    api_client: AsyncClient, world: CommWorld
) -> None:
    post = await topic(api_client, world.owner_14)
    item = await comment(api_client, world.tenant_2, post)
    await hide(api_client, world.chairman, post)
    await hide_comment(api_client, world.chairman, post, item)

    for user in (world.owner_14, world.tenant_2, world.accountant):
        for path, body in (
            (f"/posts/{post['id']}/unhide", None),
            (f"/posts/{post['id']}/comments/{item['id']}/hide", {"reason": REASON}),
            (f"/posts/{post['id']}/comments/{item['id']}/unhide", None),
        ):
            response = await api_client.post(f"{API}{path}", json=body, headers=as_user(user))
            assert response.status_code == 403, (user.full_name, path)

    board_view = await detail(api_client, world.board, post)
    assert board_view["hidden_reason"] == REASON
    assert board_view["comments"][0]["body"] == "I agree"


async def test_unhide_follows_the_type_rules_of_hide(
    api_client: AsyncClient, world: CommWorld
) -> None:
    alert = await emergency(api_client, world.chairman)
    response = await api_client.post(
        f"{API}/posts/{alert['id']}/unhide", headers=as_user(world.chairman)
    )
    assert (response.status_code, response.json()["error_code"]) == (409, "POST_NOT_HIDEABLE")


async def test_comments_on_a_hidden_topic_or_a_maintenance_post_are_not_edited(
    api_client: AsyncClient, db_session: AsyncSession, world: CommWorld
) -> None:
    post = await topic(api_client, world.owner_14)
    own = await comment(api_client, world.owner_14, post, "Who has a drill?")
    await hide(api_client, world.board, post)
    response = await edit_comment(api_client, world.owner_14, post, own, "Who has a saw?")
    assert (response.status_code, response.json()["error_code"]) == (409, "COMMENT_NOT_EDITABLE")

    reminder = await topic(api_client, world.board, post_type="BOARD_TOPIC")
    record = await comment(api_client, world.board, reminder, "Done on 13 Nov 2026")
    await db_session.execute(
        update(Post).where(Post.id == uuid.UUID(reminder["id"])).values(origin="MAINTENANCE")
    )
    response = await edit_comment(api_client, world.board, reminder, record, "Never done")
    assert (response.status_code, response.json()["error_code"]) == (409, "COMMENT_NOT_EDITABLE")


async def test_comments_of_forum_topics_are_hidden_too(
    api_client: AsyncClient, world: CommWorld
) -> None:
    post = await topic(api_client, world.tenant_2)
    rude = await comment(api_client, world.owner_14, post, "Nonsense")

    assert (await hide_comment(api_client, world.board, post, rude)).status_code == 200

    (seen,) = (await detail(api_client, world.tenant_2, post))["comments"]
    assert seen["body"] is None and seen["hidden_at"] is not None
    (own,) = (await detail(api_client, world.owner_14, post))["comments"]
    assert (own["body"], own["hidden_reason"]) == ("Nonsense", REASON)
