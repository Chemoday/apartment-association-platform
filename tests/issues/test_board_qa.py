"""QA additions for the board's work on issues (epic E9, task I2; docs/API.md section 10)."""

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.property.models import Building, User
from src.modules.property.schemas import BuildingRole
from tests.factories import create_user
from tests.issues.conftest import IssueWorld
from tests.issues.test_api import API, as_user, get, reported, set_settings
from tests.issues.test_api_qa import bring_to
from tests.issues.test_board import age, move, moved, statuses

BOARD_STATUSES = ["IN_PROGRESS", "WAITING_FOR_CONTRACTOR", "RESOLVED", "DUPLICATE", "DECLINED"]
OPEN = {"REPORTED", "IN_PROGRESS", "WAITING_FOR_CONTRACTOR"}


def expected(current: str, target: str) -> str:
    """ALLOWED, UNCHANGED or REFUSED, as docs/API.md section 10 words the rules."""
    if current == target:
        return "UNCHANGED"
    if current == "WITHDRAWN":
        return "REFUSED"
    if current in OPEN:
        return "ALLOWED"
    return "ALLOWED" if target == "IN_PROGRESS" else "REFUSED"


@pytest.mark.parametrize("target", BOARD_STATUSES)
@pytest.mark.parametrize(
    "current",
    [
        "REPORTED",
        "IN_PROGRESS",
        "WAITING_FOR_CONTRACTOR",
        "RESOLVED",
        "DECLINED",
        "DUPLICATE",
        "WITHDRAWN",
    ],
)
async def test_every_transition_through_the_api(
    api_client: AsyncClient, world: IssueWorld, current: str, target: str
) -> None:
    await set_settings(api_client, world.chairman, reports_per_apartment_per_day=20)
    issue = await reported(api_client, world.owner_14)
    await bring_to(api_client, world, issue, current)
    before = (await get(api_client, world.chairman, issue["id"])).json()
    extra = {}
    if target == "DUPLICATE":
        # The same original again for a duplicate (a repeat), a fresh open one otherwise.
        original = before["duplicate_of"] or (await reported(api_client, world.family_14))["id"]
        extra = {"duplicate_of": original}

    response = await move(api_client, world.board_15, issue, target, **extra)

    verdict = expected(current, target)
    after = (await get(api_client, world.chairman, issue["id"])).json()
    if verdict == "REFUSED":
        assert response.status_code == 409, response.text
        assert response.json()["error_code"] == "INVALID_ISSUE_TRANSITION"
        assert response.json()["status"] == current
        assert after == before, "a refused change changes nothing"
        return
    assert response.status_code == 200, response.text
    view = response.json()
    if verdict == "UNCHANGED":
        assert statuses(view) == statuses(before), "the current status again: no entry"
        assert view["updated_at"] == before["updated_at"]
        return
    assert view["status"] == target
    assert statuses(view) == [*statuses(before), target]
    assert view["timeline"][-1]["changed_by"]["role_badge"] == "BOARD"
    assert (view["ended_at"] is None) is (target in OPEN)
    assert view["duplicate_of"] == (extra["duplicate_of"] if target == "DUPLICATE" else None)


async def test_a_former_board_member_cannot_change_statuses(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    await set_settings(api_client, world.chairman, urgent_enabled=True)
    issue = await reported(api_client, world.owner_14, urgent=True)
    await db_session.execute(
        update(User).where(User.id == world.board_15.id).values(building_role=BuildingRole.USER)
    )

    status = await move(api_client, world.board_15, issue, "IN_PROGRESS")
    clear = await api_client.post(
        f"{API}/{issue['id']}/urgent/clear", headers=as_user(world.board_15)
    )
    view = (await get(api_client, world.board_15, issue["id"])).json()

    assert (status.status_code, status.json()["error_code"]) == (403, "FORBIDDEN")
    assert (clear.status_code, clear.json()["error_code"]) == (403, "FORBIDDEN")
    assert (view["status"], view["urgent"]) == ("REPORTED", True)
    assert view["reporter"] is None, "a resident again: no reporter"
    assert {(e["action"], e["changed_by"]) for e in view["timeline"]} == {("STATUS", None)}


async def test_the_board_of_another_building_does_not_see_the_issue(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    other_board = await create_user(
        db_session,
        await _other_building(db_session, world),
        "Kalle Kask",
        role=BuildingRole.CHAIRMAN,
    )

    for response in (
        await move(api_client, other_board, issue, "IN_PROGRESS"),
        await api_client.post(f"{API}/{issue['id']}/urgent/clear", headers=as_user(other_board)),
        await get(api_client, other_board, issue["id"]),
    ):
        assert (response.status_code, response.json()["error_code"]) == (404, "ISSUE_NOT_FOUND")


async def _other_building(db_session: AsyncSession, world: IssueWorld) -> Building:
    return await db_session.get(Building, world.other_resident.building_id)


async def test_a_resident_gets_404_not_403_for_an_issue_they_no_longer_see(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    await moved(api_client, world.chairman, issue, "RESOLVED")
    await age(db_session, issue, 31)

    response = await move(api_client, world.tenant_2, issue, "IN_PROGRESS")

    assert (response.status_code, response.json()["error_code"]) == (404, "ISSUE_NOT_FOUND")


async def test_the_board_sees_who_cleared_the_urgent_flag_residents_do_not(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await set_settings(api_client, world.chairman, urgent_enabled=True)
    issue = await reported(api_client, world.owner_14, urgent=True)
    await moved(api_client, world.chairman, issue, "IN_PROGRESS")
    await api_client.post(f"{API}/{issue['id']}/urgent/clear", headers=as_user(world.board_15))

    board = (await get(api_client, world.chairman, issue["id"])).json()
    reporter = (await get(api_client, world.owner_14, issue["id"])).json()

    log = [(e["status"], e["action"], e["changed_by"]["role_badge"]) for e in board["timeline"]]
    assert log == [
        ("REPORTED", "STATUS", "RESIDENT"),
        ("IN_PROGRESS", "STATUS", "BOARD"),
        ("IN_PROGRESS", "URGENT_CLEARED", "BOARD"),
    ], "the cleared flag keeps the current status"
    assert [(e["status"], e["action"]) for e in reporter["timeline"]] == [
        ("REPORTED", "STATUS"),
        ("IN_PROGRESS", "STATUS"),
    ]
    assert all(e["changed_by"] is None for e in reporter["timeline"])
    assert reporter["urgent"] is False


async def test_clearing_a_flag_that_is_not_set_changes_nothing(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)

    response = await api_client.post(
        f"{API}/{issue['id']}/urgent/clear", headers=as_user(world.chairman)
    )

    assert response.status_code == 200, response.text
    assert response.json()["urgent"] is False
    assert [e["action"] for e in response.json()["timeline"]] == ["STATUS"]
    assert response.json()["updated_at"] == issue["updated_at"]


@pytest.mark.parametrize("original_status", ["WAITING_FOR_CONTRACTOR", "RESOLVED", "DECLINED"])
async def test_merging_into_an_original_that_is_not_reported_keeps_its_status(
    api_client: AsyncClient, world: IssueWorld, original_status: str
) -> None:
    original = await reported(api_client, world.owner_14)
    await moved(api_client, world.chairman, original, original_status)
    duplicate = await reported(api_client, world.tenant_2, apartment_id=str(world.apt_2.id))

    marked = await moved(
        api_client, world.board_15, duplicate, "DUPLICATE", duplicate_of=original["id"]
    )

    assert marked["duplicate_of"] == original["id"]
    view = (await get(api_client, world.chairman, original["id"])).json()
    assert view["status"] == original_status
    assert statuses(view) == ["REPORTED", original_status], "no extra entry on the original"
    joined = (await get(api_client, world.tenant_2, original["id"])).json()
    assert (joined["followers"], joined["i_follow"]) == (2, True)


async def test_someone_who_stopped_following_the_duplicate_is_not_moved(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    original = await reported(api_client, world.owner_14)
    duplicate = await reported(api_client, world.tenant_2, apartment_id=str(world.apt_2.id))
    follow = f"{API}/{duplicate['id']}/follow"
    await api_client.put(follow, headers=as_user(world.family_14))
    await api_client.delete(follow, headers=as_user(world.family_14))

    await moved(api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=original["id"])

    family = (await get(api_client, world.family_14, original["id"])).json()
    assert (family["followers"], family["i_follow"]) == (2, False)


async def test_a_duplicate_reopened_too_late_is_refused(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    original = await reported(api_client, world.owner_14)
    duplicate = await reported(api_client, world.tenant_2, apartment_id=str(world.apt_2.id))
    await moved(api_client, world.chairman, duplicate, "DUPLICATE", duplicate_of=original["id"])
    await age(db_session, duplicate, 31)

    late = await move(api_client, world.chairman, duplicate, "IN_PROGRESS")

    assert (late.status_code, late.json()["error_code"]) == (409, "INVALID_ISSUE_TRANSITION")
    assert late.json()["status"] == "DUPLICATE"
    view = (await get(api_client, world.chairman, duplicate["id"])).json()
    assert view["duplicate_of"] == original["id"], "the link stays"


async def test_a_board_member_with_an_apartment_still_sees_the_reporter_of_their_own_report(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.board_15)

    view = (await get(api_client, world.board_15, issue["id"])).json()

    assert view["i_reported"] is True
    assert view["reporter"] == {
        "badge": {"display_label": "Apt. 15", "role_badge": "BOARD"},
        "apartment_id": str(world.apt_15.id),
    }
