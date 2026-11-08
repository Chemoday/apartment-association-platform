"""QA additions for the issue tracker API (epic E9, task I1; docs/API.md section 10)."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.issues.models import Issue
from src.modules.property.models import ApartmentMembership, User
from src.modules.property.schemas import BuildingRole, DisplayMode, RelationType
from tests.factories import create_membership, create_user
from tests.issues.conftest import IssueWorld
from tests.issues.test_api import (
    API,
    as_user,
    get,
    listing,
    report,
    reported,
    set_settings,
)
from tests.issues.test_board import moved

SUMMARY_FIELDS = {
    "id",
    "category",
    "entrance",
    "place",
    "title",
    "status",
    "urgent",
    "duplicate_of",
    "followers",
    "i_reported",
    "i_follow",
    "can_edit",
    "can_follow",
    "created_at",
    "updated_at",
    "ended_at",
    "reporter",
}


async def patch(client: AsyncClient, user: User, issue: dict, **fields: Any) -> Response:
    return await client.patch(f"{API}/{issue['id']}", json=fields, headers=as_user(user))


async def set_times(session: AsyncSession, issue: dict, **values: Any) -> None:
    await session.execute(update(Issue).where(Issue.id == uuid.UUID(issue["id"])).values(**values))


# --- Pagination ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "params",
    [
        {"limit": 0},
        {"limit": 101},
        {"offset": -1},
        {"offset": 100_001},
        {"limit": "many"},
        {"entrance": -1},
        {"category": "BALCONY"},
    ],
)
async def test_list_parameters_out_of_range_are_refused(
    api_client: AsyncClient, world: IssueWorld, params: dict
) -> None:
    response = await api_client.get(API, params=params, headers=as_user(world.owner_14))

    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


async def test_the_list_pages_with_limit_and_offset(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await set_settings(api_client, world.chairman, reports_per_apartment_per_day=20)
    titles = [f"Issue {n}" for n in range(5)]
    for title in titles:
        await reported(api_client, world.owner_14, title=title)

    first = await listing(api_client, world.tenant_2, limit=2)
    second = await listing(api_client, world.tenant_2, limit=2, offset=2)
    rest = await listing(api_client, world.tenant_2, limit=100, offset=4)
    beyond = await listing(api_client, world.tenant_2, offset=100_000)

    newest_first = list(reversed(titles))
    assert [i["title"] for i in first] == newest_first[:2]
    assert [i["title"] for i in second] == newest_first[2:4]
    assert [i["title"] for i in rest] == newest_first[4:]
    assert beyond == []
    assert len(await listing(api_client, world.tenant_2, limit=1)) == 1
    assert len(await listing(api_client, world.tenant_2, limit=100)) == 5


# --- Order and filters ---------------------------------------------------------------------------


async def test_open_issues_come_first_even_when_an_ended_one_is_newer(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    now = datetime.now(UTC)
    old_open = await reported(api_client, world.owner_14, title="Old open")
    early_end = await reported(api_client, world.owner_14, title="Ended early")
    late_end = await reported(api_client, world.family_14, title="Ended late")
    await set_times(db_session, old_open, created_at=now - timedelta(days=10))
    # Created first but ended last: ended issues are ordered by ended_at, not created_at.
    await set_times(
        db_session,
        late_end,
        status="RESOLVED",
        created_at=now - timedelta(days=9),
        ended_at=now - timedelta(minutes=1),
    )
    await set_times(
        db_session,
        early_end,
        status="DECLINED",
        created_at=now - timedelta(days=1),
        ended_at=now - timedelta(days=2),
    )

    titles = [i["title"] for i in await listing(api_client, world.tenant_2)]

    assert titles == ["Old open", "Ended late", "Ended early"]


async def test_include_old_is_ignored_for_residents_also_with_filters(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    old = await reported(api_client, world.owner_14, title="Old")
    withdrawn = await reported(api_client, world.family_14, title="Withdrawn")
    await api_client.post(f"{API}/{withdrawn['id']}/withdraw", headers=as_user(world.family_14))
    await set_times(
        db_session, old, status="RESOLVED", ended_at=datetime.now(UTC) - timedelta(days=40)
    )

    for params in (
        {"status": "ENDED"},
        {"status": "RESOLVED"},
        {"status": "WITHDRAWN"},
        {"entrance": 2},
        {"category": "LIGHTING"},
    ):
        resident = await listing(api_client, world.tenant_2, include_old="true", **params)
        assert resident == [], params
    board = await listing(api_client, world.board_15, include_old="true", status="ENDED")
    assert sorted(i["title"] for i in board) == ["Old", "Withdrawn"]


async def test_a_reporter_filters_their_own_withdrawn_issues(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    mine = await reported(api_client, world.family_14, title="Mine")
    await api_client.post(f"{API}/{mine['id']}/withdraw", headers=as_user(world.family_14))
    other = await reported(api_client, world.owner_14, title="His")
    await api_client.post(f"{API}/{other['id']}/withdraw", headers=as_user(world.owner_14))

    own = await listing(api_client, world.family_14, status="WITHDRAWN")
    board = await listing(api_client, world.chairman, status="WITHDRAWN")

    assert [i["title"] for i in own] == ["Mine"]
    assert sorted(i["title"] for i in board) == ["His", "Mine"]


async def test_the_entrance_filter_0_combines_with_the_status(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    open_yard = await reported(api_client, world.owner_14, entrance=None, title="Open yard")
    ended_yard = await reported(api_client, world.owner_14, entrance=None, title="Ended yard")
    await reported(api_client, world.family_14, entrance=2, title="Stairs")
    await set_times(
        db_session, ended_yard, status="RESOLVED", ended_at=datetime.now(UTC) - timedelta(days=1)
    )

    open_outside = await listing(api_client, world.tenant_2, entrance=0, status="OPEN")
    ended_outside = await listing(api_client, world.tenant_2, entrance=0, status="ENDED")
    all_outside = await listing(api_client, world.tenant_2, entrance=0)

    assert [i["id"] for i in open_outside] == [open_yard["id"]]
    assert [i["id"] for i in ended_outside] == [ended_yard["id"]]
    assert [i["title"] for i in all_outside] == ["Open yard", "Ended yard"]


# --- Who uses the tracker ------------------------------------------------------------------------


async def test_an_accountant_with_an_apartment_reports_but_sees_nobody(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    neighbour = await reported(api_client, world.owner_14)
    await create_membership(db_session, world.accountant, world.apt_15, RelationType.TENANT)

    mine = await reported(api_client, world.accountant, entrance=2)
    seen = (await get(api_client, world.accountant, neighbour["id"])).json()
    board_view = (await get(api_client, world.chairman, mine["id"])).json()

    assert mine["reporter"] is None and mine["i_reported"] is True
    assert seen["reporter"] is None
    assert {(e["action"], e["changed_by"]) for e in seen["timeline"]} == {("STATUS", None)}
    assert board_view["reporter"]["apartment_id"] == str(world.apt_15.id)
    status = await api_client.post(
        f"{API}/{neighbour['id']}/status",
        json={"status": "IN_PROGRESS"},
        headers=as_user(world.accountant),
    )
    clear = await api_client.post(
        f"{API}/{neighbour['id']}/urgent/clear", headers=as_user(world.accountant)
    )
    assert (status.status_code, status.json()["error_code"]) == (403, "FORBIDDEN")
    assert (clear.status_code, clear.json()["error_code"]) == (403, "FORBIDDEN")


async def test_a_deactivated_user_cannot_report_or_follow(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    await db_session.execute(
        update(User).where(User.id == world.tenant_2.id).values(is_active=False)
    )

    for response in (
        await report(api_client, world.tenant_2, apartment_id=str(world.apt_2.id)),
        await api_client.put(f"{API}/{issue['id']}/follow", headers=as_user(world.tenant_2)),
        await get(api_client, world.tenant_2, issue["id"]),
    ):
        assert (response.status_code, response.json()["error_code"]) == (401, "UNKNOWN_USER")


async def test_a_resident_who_moved_out_loses_the_tracker(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    await db_session.execute(
        update(ApartmentMembership)
        .where(ApartmentMembership.user_id == world.family_14.id)
        .values(ended_at=func.now())
    )

    for response in (
        await api_client.get(API, headers=as_user(world.family_14)),
        await get(api_client, world.family_14, issue["id"]),
        await report(api_client, world.family_14),
        await api_client.put(f"{API}/{issue['id']}/follow", headers=as_user(world.family_14)),
    ):
        assert (response.status_code, response.json()["error_code"]) == (403, "FORBIDDEN")


async def test_the_form_shows_only_the_callers_building(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    form = (await api_client.get(f"{API}/form", headers=as_user(world.other_resident))).json()
    board = (await api_client.get(f"{API}/form", headers=as_user(world.board_15))).json()

    assert form["entrances"] == [1] and len(form["apartment_ids"]) == 1
    assert board["apartment_ids"] == [str(world.apt_15.id)]


# --- Flags across the statuses -------------------------------------------------------------------


async def bring_to(client: AsyncClient, world: IssueWorld, issue: dict, status: str) -> None:
    if status == "REPORTED":
        return
    if status == "WITHDRAWN":
        response = await client.post(
            f"{API}/{issue['id']}/withdraw", headers=as_user(world.owner_14)
        )
        assert response.status_code == 200, response.text
        return
    extra = {}
    if status == "DUPLICATE":
        original = await reported(client, world.board_15, title="Original")
        extra = {"duplicate_of": original["id"]}
    await moved(client, world.chairman, issue, status, **extra)


@pytest.mark.parametrize(
    ("status", "is_open"),
    [
        ("REPORTED", True),
        ("IN_PROGRESS", True),
        ("WAITING_FOR_CONTRACTOR", True),
        ("RESOLVED", False),
        ("DECLINED", False),
        ("DUPLICATE", False),
        ("WITHDRAWN", False),
    ],
)
async def test_can_edit_and_can_follow_in_every_status(
    api_client: AsyncClient, world: IssueWorld, status: str, is_open: bool
) -> None:
    issue = await reported(api_client, world.owner_14)
    await bring_to(api_client, world, issue, status)

    reporter = (await get(api_client, world.owner_14, issue["id"])).json()
    board = (await get(api_client, world.board_15, issue["id"])).json()

    assert reporter["status"] == status
    assert reporter["can_edit"] is (status == "REPORTED")
    assert reporter["can_follow"] is False, "the reporter follows from the start"
    assert board["can_edit"] is False, "only the reporter edits"
    assert board["can_follow"] is is_open
    assert (reporter["ended_at"] is None) is is_open
    if status != "WITHDRAWN":
        neighbour = (await get(api_client, world.tenant_2, issue["id"])).json()
        assert (neighbour["can_edit"], neighbour["can_follow"]) == (False, is_open)
    if not is_open:
        follow = await api_client.put(
            f"{API}/{issue['id']}/follow", headers=as_user(world.board_15)
        )
        assert (follow.status_code, follow.json()["error_code"]) == (409, "ISSUE_ENDED")
        assert follow.json()["status"] == status


# --- Editing -------------------------------------------------------------------------------------


async def test_only_the_reporter_edits_not_even_the_board(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)

    for user in (world.board_15, world.chairman):
        edit = await patch(api_client, user, issue, title="Board text")
        withdraw = await api_client.post(f"{API}/{issue['id']}/withdraw", headers=as_user(user))
        assert (edit.status_code, edit.json()["error_code"]) == (403, "FORBIDDEN")
        assert (withdraw.status_code, withdraw.json()["error_code"]) == (403, "FORBIDDEN")
    other = await patch(api_client, world.other_resident, issue, title="Elsewhere")
    assert (other.status_code, other.json()["error_code"]) == (404, "ISSUE_NOT_FOUND")
    unchanged = (await get(api_client, world.owner_14, issue["id"])).json()
    assert (unchanged["title"], unchanged["status"]) == ("No light on the stairs", "REPORTED")


async def test_a_patch_of_the_category_only_keeps_the_rest(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    await set_times(db_session, issue, updated_at=datetime.now(UTC) - timedelta(hours=1))

    response = await patch(api_client, world.owner_14, issue, category="ELECTRICITY")

    assert response.status_code == 200, response.text
    view = response.json()
    assert view["category"] == "ELECTRICITY"
    for field in ("entrance", "place", "title", "description", "status", "urgent", "created_at"):
        assert view[field] == issue[field], field
    assert view["updated_at"] > issue["updated_at"]
    assert [e["status"] for e in view["timeline"]] == ["REPORTED"], "an edit is no status change"


@pytest.mark.parametrize(
    "fields",
    [
        {"place": "bad\u0000place"},
        {"description": "bad\u0000text"},
        {"title": "bad\u0000"},
        {"place": ""},
        {"place": "x" * 201},
        {"title": "x" * 121},
        {"title": "   "},
        {"description": "x" * 2001},
        {"category": "BALCONY"},
        {"entrance": "2"},
        {"apartment_id": None},
        {"status": "RESOLVED"},
    ],
)
async def test_a_patch_that_does_not_fit_changes_nothing(
    api_client: AsyncClient, world: IssueWorld, fields: dict
) -> None:
    issue = await reported(api_client, world.owner_14)

    response = await patch(api_client, world.owner_14, issue, **fields)

    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")
    after = (await get(api_client, world.owner_14, issue["id"])).json()
    assert after == issue


# --- Timeline ------------------------------------------------------------------------------------


async def test_the_timeline_keeps_every_change_oldest_first(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    steps = [
        "IN_PROGRESS",
        "WAITING_FOR_CONTRACTOR",
        "IN_PROGRESS",
        "RESOLVED",
        "IN_PROGRESS",
        "DECLINED",
        "IN_PROGRESS",
    ]
    for step in steps:
        await moved(api_client, world.chairman, issue, step)

    for user in (world.tenant_2, world.board_15):
        timeline = (await get(api_client, user, issue["id"])).json()["timeline"]
        assert [e["status"] for e in timeline] == ["REPORTED", *steps]
        times = [datetime.fromisoformat(e["at"]) for e in timeline]
        assert times == sorted(times)


# --- Privacy -------------------------------------------------------------------------------------


def assert_no_identity(raw: str, *people: User) -> None:
    for person in people:
        assert str(person.id) not in raw, person.full_name
        assert person.full_name not in raw
        for contact in (person.email, person.phone):
            if contact:
                assert contact not in raw, contact


async def test_no_resident_facing_response_names_the_reporter_or_the_board(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await set_settings(api_client, world.chairman, urgent_enabled=True)
    created = await report(api_client, world.owner_14, urgent=True)
    issue = created.json()
    url = f"{API}/{issue['id']}"
    await api_client.put(f"{url}/follow", headers=as_user(world.board_15))
    await moved(api_client, world.chairman, issue, "IN_PROGRESS")
    await api_client.post(f"{url}/urgent/clear", headers=as_user(world.board_15))
    people = (world.owner_14, world.chairman, world.board_15)

    resident_calls = [
        await api_client.get(API, headers=as_user(world.tenant_2)),
        await api_client.get(API, params={"include_old": "true"}, headers=as_user(world.tenant_2)),
        await get(api_client, world.tenant_2, issue["id"]),
        await api_client.put(f"{url}/follow", headers=as_user(world.tenant_2)),
        await api_client.delete(f"{url}/follow", headers=as_user(world.tenant_2)),
        await api_client.get(f"{API}/form", headers=as_user(world.tenant_2)),
    ]
    for response in resident_calls:
        assert response.status_code == 200, response.text
        assert_no_identity(response.text, *people)
    # The reporter's own responses carry no id either, only "i_reported".
    own = await get(api_client, world.owner_14, issue["id"])
    for response in (created, own):
        assert_no_identity(response.text, *people)
        assert response.json()["reporter"] is None
    summary = resident_calls[0].json()[0]
    assert set(summary) == SUMMARY_FIELDS
    detail = resident_calls[2].json()
    assert set(detail) == SUMMARY_FIELDS | {"description", "timeline"}
    for entry in detail["timeline"]:
        assert set(entry) == {"status", "at", "action", "changed_by"}


async def test_the_board_sees_badges_never_raw_names_or_contacts(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    await moved(api_client, world.board_15, issue, "IN_PROGRESS")

    for response in (
        await get(api_client, world.chairman, issue["id"]),
        await api_client.get(API, headers=as_user(world.chairman)),
    ):
        raw = response.text
        for person in (world.owner_14, world.board_15):
            assert person.full_name not in raw
            for contact in (person.email, person.phone):
                if contact:
                    assert contact not in raw
        assert str(world.owner_14.id) not in raw, "the reporter is a badge, not a user id"


async def test_a_reporter_with_a_full_name_mode_shows_the_name_to_the_board_only(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    named = await create_user(db_session, world.building, "Kadri Mets", role=BuildingRole.USER)
    await create_membership(
        db_session, named, world.apt_14, RelationType.RESIDENT, mode=DisplayMode.FULL_NAME
    )
    issue = await reported(api_client, named)

    board = (await get(api_client, world.chairman, issue["id"])).json()
    resident = await get(api_client, world.tenant_2, issue["id"])

    assert board["reporter"]["badge"]["display_label"] == "Kadri Mets (Apt. 14)"
    assert "Kadri Mets" not in resident.text and resident.json()["reporter"] is None


async def test_urgent_reports_of_the_board_are_not_limited_but_count_for_the_apartment(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    neighbour = await create_user(db_session, world.building, "Tiit Saar")
    await create_membership(db_session, neighbour, world.apt_15, RelationType.RESIDENT)
    await set_settings(api_client, world.chairman, urgent_enabled=True)

    first = await report(api_client, world.board_15, urgent=True)
    second = await report(api_client, world.board_15, urgent=True)
    resident = await report(api_client, neighbour, urgent=True)
    third = await report(api_client, neighbour)
    fourth = await report(api_client, neighbour)

    assert (first.status_code, second.status_code) == (201, 201), "the board is never limited"
    assert (resident.status_code, resident.json()["error_code"]) == (429, "RATE_LIMITED")
    assert third.status_code == 201, "the board's two reports took two of the three slots"
    assert (fourth.status_code, fourth.json()["error_code"]) == (429, "RATE_LIMITED")
