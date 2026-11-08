"""The board's work on issues (epic E9, task I2; fixture: conftest.py)."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.issues.models import Issue
from src.modules.property.models import User
from tests.issues.conftest import IssueWorld
from tests.issues.test_api import API, as_user, get, reported, set_settings


async def move(client: AsyncClient, user: User, issue: dict, status: str, **extra: Any) -> Response:
    return await client.post(
        f"{API}/{issue['id']}/status", json={"status": status, **extra}, headers=as_user(user)
    )


async def moved(client: AsyncClient, user: User, issue: dict, status: str, **extra: Any) -> dict:
    response = await move(client, user, issue, status, **extra)
    assert response.status_code == 200, response.text
    return response.json()


async def age(session: AsyncSession, issue: dict, days: float) -> None:
    """Pretend the issue ended `days` ago."""
    await session.execute(
        update(Issue)
        .where(Issue.id == uuid.UUID(issue["id"]))
        .values(ended_at=datetime.now(UTC) - timedelta(days=days))
    )


def statuses(view: dict) -> list[str]:
    return [entry["status"] for entry in view["timeline"]]


async def test_the_board_moves_an_issue_to_resolved(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)

    await moved(api_client, world.board_15, issue, "IN_PROGRESS")
    await moved(api_client, world.chairman, issue, "WAITING_FOR_CONTRACTOR")
    resolved = await moved(api_client, world.board_15, issue, "RESOLVED")

    assert (resolved["status"], resolved["can_follow"]) == ("RESOLVED", False)
    assert resolved["ended_at"] is not None
    assert statuses(resolved) == ["REPORTED", "IN_PROGRESS", "WAITING_FOR_CONTRACTOR", "RESOLVED"]
    # Badges without an apartment context: the role label (section 0 of docs/API.md).
    assert [entry["changed_by"]["role_badge"] for entry in resolved["timeline"]] == [
        "RESIDENT",
        "BOARD",
        "BOARD",
        "BOARD",
    ]
    resident = (await get(api_client, world.tenant_2, issue["id"])).json()
    assert statuses(resident) == statuses(resolved)
    assert {(e["action"], e["changed_by"]) for e in resident["timeline"]} == {("STATUS", None)}
    edit = await api_client.patch(
        f"{API}/{issue['id']}", json={"title": "Too late"}, headers=as_user(world.owner_14)
    )
    assert (edit.status_code, edit.json()["error_code"]) == (409, "ISSUE_NOT_EDITABLE")


async def test_only_the_board_changes_statuses(api_client: AsyncClient, world: IssueWorld) -> None:
    issue = await reported(api_client, world.owner_14)

    for user in (world.owner_14, world.tenant_2):
        response = await move(api_client, user, issue, "IN_PROGRESS")
        assert (response.status_code, response.json()["error_code"]) == (403, "FORBIDDEN")
        clear = await api_client.post(f"{API}/{issue['id']}/urgent/clear", headers=as_user(user))
        assert clear.status_code == 403
    other = await move(api_client, world.other_resident, issue, "IN_PROGRESS")
    assert (other.status_code, other.json()["error_code"]) == (404, "ISSUE_NOT_FOUND")


@pytest.mark.parametrize(
    "payload",
    [
        {"status": "REPORTED"},
        {"status": "WITHDRAWN"},
        {"status": "DUPLICATE"},
        {"status": "RESOLVED", "duplicate_of": str(uuid.uuid4())},
        {"status": "RESOLVED", "note": "Fixed"},
    ],
)
async def test_a_status_the_board_cannot_set_is_refused(
    api_client: AsyncClient, world: IssueWorld, payload: dict
) -> None:
    issue = await reported(api_client, world.owner_14)

    response = await api_client.post(
        f"{API}/{issue['id']}/status", json=payload, headers=as_user(world.chairman)
    )

    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


async def test_the_current_status_again_changes_nothing(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    await moved(api_client, world.chairman, issue, "IN_PROGRESS")

    again = await moved(api_client, world.board_15, issue, "IN_PROGRESS")

    assert statuses(again) == ["REPORTED", "IN_PROGRESS"]


async def test_an_ended_issue_reopens_within_30_days_only(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    await moved(api_client, world.chairman, issue, "RESOLVED")

    other = await move(api_client, world.chairman, issue, "WAITING_FOR_CONTRACTOR")
    reopened = await moved(api_client, world.chairman, issue, "IN_PROGRESS")

    assert (other.status_code, other.json()["error_code"]) == (409, "INVALID_ISSUE_TRANSITION")
    assert other.json()["status"] == "RESOLVED"
    assert (reopened["status"], reopened["ended_at"], reopened["can_follow"]) == (
        "IN_PROGRESS",
        None,
        True,
    )
    await moved(api_client, world.chairman, issue, "DECLINED")
    await age(db_session, issue, 31)
    late = await move(api_client, world.chairman, issue, "IN_PROGRESS")
    assert (late.status_code, late.json()["error_code"]) == (409, "INVALID_ISSUE_TRANSITION")


async def test_a_withdrawn_issue_never_changes(api_client: AsyncClient, world: IssueWorld) -> None:
    issue = await reported(api_client, world.owner_14)
    await api_client.post(f"{API}/{issue['id']}/withdraw", headers=as_user(world.owner_14))

    response = await move(api_client, world.chairman, issue, "IN_PROGRESS")

    assert (response.status_code, response.json()["error_code"]) == (
        409,
        "INVALID_ISSUE_TRANSITION",
    )


# --- Duplicates ----------------------------------------------------------------------------------


async def test_a_duplicate_brings_its_followers_to_the_original(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    original = await reported(api_client, world.owner_14)
    duplicate = await reported(api_client, world.tenant_2, apartment_id=str(world.apt_2.id))
    await api_client.put(f"{API}/{duplicate['id']}/follow", headers=as_user(world.family_14))
    await api_client.put(f"{API}/{original['id']}/follow", headers=as_user(world.family_14))

    marked = await moved(
        api_client, world.board_15, duplicate, "DUPLICATE", duplicate_of=original["id"]
    )

    assert (marked["status"], marked["duplicate_of"]) == ("DUPLICATE", original["id"])
    assert marked["ended_at"] is not None
    joined = (await get(api_client, world.tenant_2, original["id"])).json()
    assert (joined["followers"], joined["i_follow"]) == (3, True), "each follower once"
    assert (await get(api_client, world.tenant_2, duplicate["id"])).json()["i_follow"] is True

    reopened = await moved(api_client, world.board_15, duplicate, "IN_PROGRESS")
    assert (reopened["duplicate_of"], reopened["ended_at"]) == (None, None)
    assert (await get(api_client, world.tenant_2, original["id"])).json()["i_follow"] is True


async def test_marking_the_same_duplicate_again_changes_nothing(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    first = await reported(api_client, world.owner_14)
    second = await reported(api_client, world.family_14)
    duplicate = await reported(api_client, world.tenant_2, apartment_id=str(world.apt_2.id))
    await moved(api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=first["id"])

    again = await moved(
        api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=first["id"]
    )
    elsewhere = await move(
        api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=second["id"]
    )

    assert statuses(again) == ["REPORTED", "DUPLICATE"]
    assert (elsewhere.status_code, elsewhere.json()["error_code"]) == (
        409,
        "INVALID_ISSUE_TRANSITION",
    )


async def test_what_cannot_be_the_original(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    await set_settings(api_client, world.chairman, reports_per_apartment_per_day=20)
    issue = await reported(api_client, world.owner_14)
    withdrawn = await reported(api_client, world.owner_14)
    await api_client.post(f"{API}/{withdrawn['id']}/withdraw", headers=as_user(world.owner_14))
    old = await reported(api_client, world.owner_14)
    await moved(api_client, world.chairman, old, "RESOLVED")
    await age(db_session, old, 31)
    merged = await reported(api_client, world.owner_14)
    target = await reported(api_client, world.owner_14)
    await moved(api_client, world.chairman, merged, "DUPLICATE", duplicate_of=target["id"])
    foreign = await reported(api_client, world.other_resident, entrance=None)

    for original in (issue["id"], withdrawn["id"], old["id"], merged["id"], foreign["id"]):
        response = await move(api_client, world.chairman, issue, "DUPLICATE", duplicate_of=original)
        assert (response.status_code, response.json()["error_code"]) == (
            422,
            "INVALID_DUPLICATE",
        ), original
    unknown = await move(
        api_client, world.chairman, issue, "DUPLICATE", duplicate_of=str(uuid.uuid4())
    )
    assert unknown.status_code == 422


# --- Urgent --------------------------------------------------------------------------------------


async def test_the_board_clears_a_false_urgent_flag(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await set_settings(api_client, world.chairman, urgent_enabled=True)
    issue = await reported(api_client, world.owner_14, urgent=True)
    url = f"{API}/{issue['id']}/urgent/clear"

    cleared = await api_client.post(url, headers=as_user(world.board_15))
    again = await api_client.post(url, headers=as_user(world.board_15))

    assert cleared.status_code == 200 and cleared.json()["urgent"] is False
    log = [(e["action"], e["status"]) for e in again.json()["timeline"]]
    assert log == [("STATUS", "REPORTED"), ("URGENT_CLEARED", "REPORTED")], "logged once"
    resident = (await get(api_client, world.tenant_2, issue["id"])).json()
    assert statuses(resident) == ["REPORTED"], "residents do not see the board's flag log"
    await moved(api_client, world.chairman, issue, "RESOLVED")
    ended = await api_client.post(url, headers=as_user(world.board_15))
    assert (ended.status_code, ended.json()["error_code"]) == (409, "ISSUE_ENDED")


async def test_a_cleared_false_alarm_still_counts_for_the_urgent_limit(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await set_settings(api_client, world.chairman, urgent_enabled=True)
    issue = await reported(api_client, world.owner_14, urgent=True)
    await api_client.post(f"{API}/{issue['id']}/urgent/clear", headers=as_user(world.chairman))

    again = await api_client.post(
        API,
        json={"category": "LIFT", "entrance": 2, "place": "Lift", "title": "Stuck", "urgent": True},
        headers=as_user(world.family_14),
    )

    assert (again.status_code, again.json()["error_code"]) == (429, "RATE_LIMITED")


# --- Review findings (E9/I2) ---------------------------------------------------------------------


async def test_merging_freezes_a_reported_original(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    original = await reported(api_client, world.owner_14)
    duplicate = await reported(api_client, world.tenant_2, apartment_id=str(world.apt_2.id))

    await moved(api_client, world.board_15, duplicate, "DUPLICATE", duplicate_of=original["id"])

    view = (await get(api_client, world.chairman, original["id"])).json()
    assert statuses(view) == ["REPORTED", "IN_PROGRESS"]
    assert view["timeline"][1]["changed_by"]["role_badge"] == "BOARD"
    for call in (
        api_client.post(f"{API}/{original['id']}/withdraw", headers=as_user(world.owner_14)),
        api_client.patch(
            f"{API}/{original['id']}", json={"title": "Other"}, headers=as_user(world.owner_14)
        ),
    ):
        response = await call
        assert (response.status_code, response.json()["error_code"]) == (409, "ISSUE_NOT_EDITABLE")
    assert (await get(api_client, world.tenant_2, original["id"])).status_code == 200


async def test_a_refused_or_repeated_merge_never_looks_at_the_original(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    original = await reported(api_client, world.owner_14)
    duplicate = await reported(api_client, world.tenant_2, apartment_id=str(world.apt_2.id))
    await moved(api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=original["id"])
    await moved(api_client, world.chairman, original, "RESOLVED")
    await age(db_session, original, 31)  # the original is no longer a valid one

    again = await move(
        api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=original["id"]
    )
    withdrawn = await reported(api_client, world.family_14)
    await api_client.post(f"{API}/{withdrawn['id']}/withdraw", headers=as_user(world.family_14))
    refused = await move(
        api_client, world.chairman, withdrawn, "DUPLICATE", duplicate_of=str(uuid.uuid4())
    )

    assert again.status_code == 200 and statuses(again.json()) == ["REPORTED", "DUPLICATE"]
    assert (refused.status_code, refused.json()["error_code"]) == (409, "INVALID_ISSUE_TRANSITION")


async def test_a_merged_original_merged_again_takes_its_followers_along(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    first = await reported(api_client, world.owner_14)
    middle = await reported(api_client, world.tenant_2, apartment_id=str(world.apt_2.id))
    last = await reported(api_client, world.board_15)
    await moved(api_client, world.chairman, first, "DUPLICATE", duplicate_of=middle["id"])

    await moved(api_client, world.chairman, middle, "DUPLICATE", duplicate_of=last["id"])

    final = (await get(api_client, world.owner_14, last["id"])).json()
    assert (final["followers"], final["i_follow"]) == (3, True), "owner_14 came via the middle"
