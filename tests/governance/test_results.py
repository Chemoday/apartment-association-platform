"""Poll results through the API (epic E3 part A, task V2; fixture: conftest.py).

The default draft asks for Saturdays (dates, pick up to two), a number of bags (own number) and
anything else (own text, optional). Every apartment of the building has an eligible member, so a
poll per apartment has 3 units: Apt 14, Apt 2 and Apt 15.
"""

import uuid
from datetime import UTC, datetime, timedelta

from httpx import AsyncClient, Response
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.governance.models import Poll
from src.modules.property.models import User
from tests.governance.conftest import PollWorld
from tests.governance.test_api import API, answer, answers_for, as_user, create, opened


async def results(client: AsyncClient, user: User, poll: dict) -> Response:
    return await client.get(f"{API}/{poll['id']}/results", headers=as_user(user))


def ballot(poll: dict, dates: list[int], bags: str, text: str | None = None) -> dict:
    answers = answers_for(poll, dates=dates, bags=bags)
    if text is not None:
        answers.append({"question_id": poll["questions"][2]["id"], "value": text})
    return {"answers": answers}


async def close(client: AsyncClient, poll: dict, board: User) -> None:
    response = await client.post(f"{API}/{poll['id']}/close", headers=as_user(board))
    assert response.status_code == 200, response.text


async def answered_poll(client: AsyncClient, world: PollWorld) -> dict:
    poll = await opened(client, world.chairman)
    for user, body in (
        (world.owner_14, ballot(poll, [0, 1], "3", "Not before 10")),
        (world.tenant_2, ballot(poll, [0], "2", "Bring gloves")),
        (world.board_15, ballot(poll, [2], "2.5", "Bring gloves")),
    ):
        response = await answer(client, user, poll, body)
        assert response.status_code == 200, response.text
    return poll


async def test_the_board_sees_live_totals_and_everyone_else_after_closing(
    api_client: AsyncClient, world: PollWorld
) -> None:
    poll = await answered_poll(api_client, world)
    dates, bags, notes = poll["questions"]

    live = await results(api_client, world.board_15, poll)
    early = await results(api_client, world.owner_14, poll)

    assert live.status_code == 200, live.text
    assert (early.status_code, early.json()["error_code"]) == (409, "RESULTS_NOT_AVAILABLE")
    assert early.json()["status"] == "OPEN"
    body = live.json()
    assert (body["status"], body["unit"]) == ("OPEN", "APARTMENT")
    assert body["participation"] == {"answered": 3, "electorate": 3}
    first, second, third = body["questions"]
    assert first == {
        "question_id": dates["id"],
        "answered": 3,
        "options": [
            {"option_id": dates["options"][0]["id"], "count": 2},
            {"option_id": dates["options"][1]["id"], "count": 1},
            {"option_id": dates["options"][2]["id"], "count": 1},
        ],
        "number": None,
        "dates": None,
        "texts": None,
    }
    assert (second["question_id"], second["answered"]) == (bags["id"], 3)
    assert second["number"] == {"min": "2", "max": "3", "average": "2.5"}
    assert second["options"] is None
    assert (third["question_id"], third["answered"]) == (notes["id"], 3)
    assert third["texts"] == [
        {"value": "Bring gloves", "count": 2},
        {"value": "Not before 10", "count": 1},
    ], "the board reads the texts alphabetically, never in the answer order"

    await close(api_client, poll, world.chairman)
    after = await results(api_client, world.owner_14, poll)

    assert after.status_code == 200, after.text
    resident_view = after.json()
    assert resident_view["status"] == "CLOSED"
    assert resident_view["questions"][:2] == body["questions"][:2]
    assert resident_view["questions"][2] == {**third, "texts": None}, "texts are for the board"


async def test_the_last_answer_of_an_apartment_counts_once(
    api_client: AsyncClient, world: PollWorld
) -> None:
    poll = await opened(api_client, world.chairman)
    await answer(api_client, world.owner_14, poll, ballot(poll, [0], "3"))
    await answer(api_client, world.family_14, poll, ballot(poll, [1], "1"))

    body = (await results(api_client, world.chairman, poll)).json()

    assert body["participation"] == {"answered": 1, "electorate": 3}
    first, second, third = body["questions"]
    assert [option["count"] for option in first["options"]] == [0, 1, 0]
    assert second["number"] == {"min": "1", "max": "1", "average": "1"}
    assert (third["answered"], third["texts"]) == (0, [])


async def test_a_poll_per_person_counts_people(api_client: AsyncClient, world: PollWorld) -> None:
    poll = await opened(api_client, world.chairman, unit="PERSON")
    await answer(api_client, world.owner_14, poll, ballot(poll, [0], "3"))
    await answer(api_client, world.family_14, poll, ballot(poll, [0], "1"))

    body = (await results(api_client, world.chairman, poll)).json()

    assert (body["unit"], body["participation"]) == ("PERSON", {"answered": 2, "electorate": 4})
    assert body["questions"][0]["options"][0]["count"] == 2


async def test_a_tenant_sees_the_totals_of_an_owners_only_poll_after_closing(
    api_client: AsyncClient, world: PollWorld
) -> None:
    poll = await opened(api_client, world.chairman, eligibility="OWNERS")
    await answer(api_client, world.owner_14, poll, ballot(poll, [0], "3"))
    await close(api_client, poll, world.chairman)

    response = await results(api_client, world.tenant_2, poll)

    assert response.status_code == 200, response.text
    # Apt 2 has no owner in the app, so the snapshot has Apt 14 and Apt 15 only.
    assert response.json()["participation"] == {"answered": 1, "electorate": 2}


async def test_nobody_sees_results_of_a_draft_or_a_cancelled_poll(
    api_client: AsyncClient, world: PollWorld
) -> None:
    draft = await create(api_client, world.chairman)
    cancelled = await answered_poll(api_client, world)
    response = await api_client.post(
        f"{API}/{cancelled['id']}/cancel", headers=as_user(world.chairman)
    )
    assert response.status_code == 200, response.text

    for poll, status, users in (
        (draft, "DRAFT", (world.chairman,)),
        (cancelled, "CANCELLED", (world.chairman, world.board_15, world.owner_14)),
    ):
        for user in users:
            response = await results(api_client, user, poll)
            assert response.status_code == 409, (status, user.full_name)
            assert response.json() == {
                "error_code": "RESULTS_NOT_AVAILABLE",
                "message": "The results of this poll are not available now.",
                "status": status,
            }


async def test_results_follow_who_sees_the_poll(api_client: AsyncClient, world: PollWorld) -> None:
    poll = await opened(api_client, world.chairman, target_scope="ENTRANCE", target_entrance=2)
    await close(api_client, poll, world.chairman)

    for user in (world.tenant_2, world.other_resident, world.other_chairman):
        response = await results(api_client, user, poll)
        assert (response.status_code, response.json()["error_code"]) == (404, "POLL_NOT_FOUND")
    assert (await results(api_client, world.owner_14, poll)).status_code == 200


async def test_the_poll_says_when_its_results_are_available(
    api_client: AsyncClient, world: PollWorld
) -> None:
    poll = await opened(api_client, world.chairman)

    def flags(listing: Response) -> bool:
        return next(item for item in listing.json() if item["id"] == poll["id"])[
            "results_available"
        ]

    async def available(user: User) -> tuple[bool, bool]:
        view = await api_client.get(f"{API}/{poll['id']}", headers=as_user(user))
        listing = await api_client.get(API, headers=as_user(user))
        return view.json()["results_available"], flags(listing)

    assert await available(world.board_15) == (True, True)
    assert await available(world.owner_14) == (False, False)
    await close(api_client, poll, world.chairman)
    assert await available(world.owner_14) == (True, True)
    assert poll["results_available"] is True, "the board opened it"


async def test_a_passed_deadline_opens_the_results_without_a_write(
    api_client: AsyncClient, db_session: AsyncSession, world: PollWorld
) -> None:
    poll = await answered_poll(api_client, world)
    await db_session.execute(
        update(Poll)
        .where(Poll.id == uuid.UUID(poll["id"]))
        .values(closes_at=datetime.now(UTC) - timedelta(minutes=1))
    )

    response = await results(api_client, world.owner_14, poll)
    view = await api_client.get(f"{API}/{poll['id']}", headers=as_user(world.owner_14))
    listing = await api_client.get(API, headers=as_user(world.owner_14))

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "CLOSED"
    assert response.json()["participation"] == {"answered": 3, "electorate": 3}
    assert view.json()["results_available"] is True
    assert next(item for item in listing.json() if item["id"] == poll["id"])["results_available"]
