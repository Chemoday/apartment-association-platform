"""The issue tracker through the API (epic E9, task I1; fixture: conftest.py)."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import DEMO_USER_HEADER
from src.modules.issues.models import Issue
from src.modules.property.models import User
from src.modules.property.schemas import BuildingRole, RelationType
from tests.factories import create_membership, create_user
from tests.issues.conftest import IssueWorld

API = "/api/v1/issues"
SETTINGS = "/api/v1/settings"


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


def body(**overrides: Any) -> dict[str, Any]:
    return {
        "category": "LIGHTING",
        "entrance": 2,
        "place": "3rd floor landing",
        "title": "No light on the stairs",
        "description": "Went out yesterday evening.",
        **overrides,
    }


async def report(client: AsyncClient, user: User, **overrides: Any) -> Response:
    return await client.post(API, json=body(**overrides), headers=as_user(user))


async def reported(client: AsyncClient, user: User, **overrides: Any) -> dict:
    response = await report(client, user, **overrides)
    assert response.status_code == 201, response.text
    return response.json()


async def get(client: AsyncClient, user: User, issue_id: str) -> Response:
    return await client.get(f"{API}/{issue_id}", headers=as_user(user))


async def listing(client: AsyncClient, user: User, **params: Any) -> list[dict]:
    response = await client.get(API, params=params, headers=as_user(user))
    assert response.status_code == 200, response.text
    return response.json()


async def set_settings(client: AsyncClient, chairman: User, **values: Any) -> None:
    response = await client.put(
        SETTINGS,
        json={"values": {f"issues.{key}": value for key, value in values.items()}},
        headers=as_user(chairman),
    )
    assert response.status_code == 200, response.text


# --- Reporting -----------------------------------------------------------------------------------


async def test_a_resident_reports_an_issue_and_follows_it(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)

    assert issue["status"] == "REPORTED" and issue["ended_at"] is None
    assert (issue["category"], issue["entrance"], issue["place"]) == (
        "LIGHTING",
        2,
        "3rd floor landing",
    )
    assert (issue["followers"], issue["i_reported"], issue["i_follow"]) == (1, True, True)
    assert (issue["can_edit"], issue["can_follow"], issue["urgent"]) == (True, False, False)
    assert [entry["status"] for entry in issue["timeline"]] == ["REPORTED"]
    assert issue["reporter"] is None, "residents never see who reported"


async def test_the_whole_building_sees_it_and_only_the_board_sees_the_reporter(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)

    neighbour = (await get(api_client, world.tenant_2, issue["id"])).json()
    board = (await get(api_client, world.board_15, issue["id"])).json()

    assert (neighbour["reporter"], neighbour["i_reported"], neighbour["can_follow"]) == (
        None,
        False,
        True,
    )
    assert board["reporter"] == {
        "badge": {"display_label": "Apt. 14", "role_badge": "OWNER"},
        "apartment_id": str(world.apt_14.id),
    }
    chairman_list = await listing(api_client, world.chairman)
    assert chairman_list[0]["reporter"]["apartment_id"] == str(world.apt_14.id)
    assert "description" not in chairman_list[0] and "timeline" not in chairman_list[0]


async def test_who_cannot_use_the_tracker(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)

    for call in (
        api_client.get(API, headers=as_user(world.accountant)),
        api_client.get(f"{API}/form", headers=as_user(world.accountant)),
        report(api_client, world.accountant),
        get(api_client, world.accountant, issue["id"]),
    ):
        response = await call
        assert (response.status_code, response.json()["error_code"]) == (403, "FORBIDDEN")
    other = await get(api_client, world.other_resident, issue["id"])
    assert (other.status_code, other.json()["error_code"]) == (404, "ISSUE_NOT_FOUND")
    assert await listing(api_client, world.other_resident) == []

    await create_membership(db_session, world.accountant, world.apt_15, RelationType.TENANT)
    assert len(await listing(api_client, world.accountant)) == 1, "a member of an apartment"


async def test_the_form_tells_what_the_report_needs(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    tenant = (await api_client.get(f"{API}/form", headers=as_user(world.tenant_2))).json()
    chairman = (await api_client.get(f"{API}/form", headers=as_user(world.chairman))).json()

    assert tenant["urgent_enabled"] is False
    assert sorted(tenant["apartment_ids"]) == sorted([str(world.apt_2.id), str(world.apt_3.id)])
    assert tenant["entrances"] == [1, 2]
    assert chairman["apartment_ids"] == []


async def test_the_apartment_of_a_report(api_client: AsyncClient, world: IssueWorld) -> None:
    missing = await report(api_client, world.tenant_2)
    foreign = await report(api_client, world.tenant_2, apartment_id=str(world.apt_14.id))
    chosen = await reported(api_client, world.tenant_2, apartment_id=str(world.apt_3.id))
    chairman = await reported(api_client, world.chairman, entrance=None)

    assert (missing.status_code, missing.json()["errors"][0]["loc"]) == (
        422,
        ["body", "apartment_id"],
    )
    assert (foreign.status_code, foreign.json()["error_code"]) == (
        422,
        "INVALID_AUTHOR_APARTMENT",
    )
    board_view = (await get(api_client, world.board_15, chosen["id"])).json()
    assert board_view["reporter"]["apartment_id"] == str(world.apt_3.id)
    chairman_view = (await get(api_client, world.board_15, chairman["id"])).json()
    assert chairman_view["reporter"] == {
        "badge": {"display_label": "Chairman", "role_badge": "BOARD"},
        "apartment_id": None,
    }


@pytest.mark.parametrize(
    ("overrides", "status", "code"),
    [
        ({"entrance": 7}, 422, "INVALID_LOCATION"),
        ({"category": "BALCONY"}, 422, "VALIDATION_ERROR"),
        ({"title": "   "}, 422, "VALIDATION_ERROR"),
        ({"title": "x" * 121}, 422, "VALIDATION_ERROR"),
        ({"place": ""}, 422, "VALIDATION_ERROR"),
        ({"description": "x" * 2001}, 422, "VALIDATION_ERROR"),
        ({"title": "bad\u0000"}, 422, "VALIDATION_ERROR"),
        ({"urgent": True}, 422, "VALIDATION_ERROR"),
        ({"reporter_user_id": str(uuid.uuid4())}, 422, "VALIDATION_ERROR"),
    ],
)
async def test_a_report_that_does_not_fit_is_refused(
    api_client: AsyncClient, world: IssueWorld, overrides: dict, status: int, code: str
) -> None:
    response = await report(api_client, world.owner_14, **overrides)

    assert (response.status_code, response.json()["error_code"]) == (status, code)


async def test_an_issue_outside_any_entrance(api_client: AsyncClient, world: IssueWorld) -> None:
    issue = await reported(
        api_client, world.owner_14, entrance=None, category="YARD", place="Playground"
    )

    assert issue["entrance"] is None
    assert [i["id"] for i in await listing(api_client, world.tenant_2, entrance=0)] == [issue["id"]]
    assert await listing(api_client, world.tenant_2, entrance=2) == []


# --- Limits and the urgent flag ------------------------------------------------------------------


async def test_an_apartment_may_report_three_times_a_day_by_default(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    for user in (world.owner_14, world.family_14, world.owner_14):
        await reported(api_client, user)
    first = (await listing(api_client, world.owner_14))[-1]
    await api_client.post(f"{API}/{first['id']}/withdraw", headers=as_user(world.owner_14))

    over = await report(api_client, world.family_14)

    assert (over.status_code, over.json()["error_code"]) == (429, "RATE_LIMITED")
    wait = over.json()["retry_after_seconds"]
    assert 23 * 3600 < wait <= 24 * 3600, "withdrawn reports still count"
    assert over.headers["Retry-After"] == str(wait)
    await reported(api_client, world.tenant_2, apartment_id=str(world.apt_2.id))
    await reported(api_client, world.board_15)  # the board is never limited


async def test_the_chairman_sets_the_limit(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    await set_settings(api_client, world.chairman, reports_per_apartment_per_day=1)
    first = await reported(api_client, world.owner_14)

    assert (await report(api_client, world.family_14)).status_code == 429
    await db_session.execute(
        update(Issue)
        .where(Issue.id == uuid.UUID(first["id"]))
        .values(created_at=datetime.now(UTC) - timedelta(hours=24, minutes=1))
    )
    await reported(api_client, world.family_14)  # the old report left the 24-hour window


async def test_urgent_reports_only_when_the_chairman_allows_them(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    await set_settings(api_client, world.chairman, urgent_enabled=True)

    form = (await api_client.get(f"{API}/form", headers=as_user(world.owner_14))).json()
    urgent = await reported(api_client, world.owner_14, urgent=True)
    second = await report(api_client, world.family_14, urgent=True)
    normal = await report(api_client, world.family_14)

    assert form["urgent_enabled"] is True and urgent["urgent"] is True
    assert (second.status_code, second.json()["error_code"]) == (429, "RATE_LIMITED")
    assert normal.status_code == 201, "the urgent limit does not stop normal reports"


# --- Editing and withdrawing ---------------------------------------------------------------------


async def test_the_reporter_fixes_the_text_while_it_is_reported(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)

    fixed = await api_client.patch(
        f"{API}/{issue['id']}",
        json={"title": "No light on the 4th floor", "entrance": None, "description": None},
        headers=as_user(world.owner_14),
    )
    neighbour = await api_client.patch(
        f"{API}/{issue['id']}", json={"title": "Mine"}, headers=as_user(world.family_14)
    )
    bad = await api_client.patch(
        f"{API}/{issue['id']}", json={"entrance": 9}, headers=as_user(world.owner_14)
    )
    urgent = await api_client.patch(
        f"{API}/{issue['id']}", json={"urgent": True}, headers=as_user(world.owner_14)
    )

    assert fixed.status_code == 200, fixed.text
    view = fixed.json()
    assert (view["title"], view["entrance"], view["description"]) == (
        "No light on the 4th floor",
        None,
        "",
    )
    assert view["place"] == "3rd floor landing", "fields not given stay"
    assert (neighbour.status_code, neighbour.json()["error_code"]) == (403, "FORBIDDEN")
    assert (bad.status_code, bad.json()["error_code"]) == (422, "INVALID_LOCATION")
    assert urgent.status_code == 422


async def test_a_withdrawn_issue_is_seen_by_its_reporter_and_the_board_only(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)

    withdrawn = await api_client.post(
        f"{API}/{issue['id']}/withdraw", headers=as_user(world.owner_14)
    )

    assert withdrawn.status_code == 200, withdrawn.text
    view = withdrawn.json()
    assert (view["status"], view["can_edit"], view["can_follow"]) == ("WITHDRAWN", False, False)
    assert view["ended_at"] is not None
    assert [entry["status"] for entry in view["timeline"]] == ["REPORTED", "WITHDRAWN"]
    family = await get(api_client, world.family_14, issue["id"])
    assert (family.status_code, family.json()["error_code"]) == (404, "ISSUE_NOT_FOUND")
    assert await listing(api_client, world.family_14) == []
    assert [i["status"] for i in await listing(api_client, world.chairman)] == ["WITHDRAWN"]
    again = await api_client.post(f"{API}/{issue['id']}/withdraw", headers=as_user(world.owner_14))
    edit = await api_client.patch(
        f"{API}/{issue['id']}", json={"title": "Again"}, headers=as_user(world.owner_14)
    )
    for response in (again, edit):
        assert (response.status_code, response.json()["error_code"]) == (409, "ISSUE_NOT_EDITABLE")
        assert response.json()["status"] == "WITHDRAWN"


# --- Following -----------------------------------------------------------------------------------


async def test_plus_one_and_taking_it_back(api_client: AsyncClient, world: IssueWorld) -> None:
    issue = await reported(api_client, world.owner_14)
    url = f"{API}/{issue['id']}/follow"

    first = await api_client.put(url, headers=as_user(world.tenant_2))
    twice = await api_client.put(url, headers=as_user(world.tenant_2))
    board = await api_client.put(url, headers=as_user(world.board_15))
    reporter = await api_client.put(url, headers=as_user(world.owner_14))

    assert (first.json()["followers"], first.json()["i_follow"]) == (2, True)
    assert first.json()["can_follow"] is False
    assert twice.json()["followers"] == 2, "idempotent"
    assert board.json()["followers"] == 3
    assert reporter.json()["followers"] == 3, "the reporter already follows"

    back = await api_client.delete(url, headers=as_user(world.tenant_2))
    again = await api_client.delete(url, headers=as_user(world.tenant_2))
    assert (back.json()["followers"], back.json()["i_follow"], back.json()["can_follow"]) == (
        2,
        False,
        True,
    )
    assert again.status_code == 200 and again.json()["followers"] == 2


async def test_an_ended_issue_cannot_be_followed(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    await api_client.post(f"{API}/{issue['id']}/withdraw", headers=as_user(world.owner_14))

    follow = await api_client.put(f"{API}/{issue['id']}/follow", headers=as_user(world.chairman))
    stop = await api_client.delete(f"{API}/{issue['id']}/follow", headers=as_user(world.owner_14))

    assert (follow.status_code, follow.json()["error_code"]) == (409, "ISSUE_ENDED")
    assert stop.status_code == 200 and stop.json()["i_follow"] is False


# --- The list ------------------------------------------------------------------------------------


async def end(session: AsyncSession, issue_id: str, days_ago: float, status: str = "RESOLVED"):
    await session.execute(
        update(Issue)
        .where(Issue.id == uuid.UUID(issue_id))
        .values(status=status, ended_at=datetime.now(UTC) - timedelta(days=days_ago))
    )


async def test_ended_issues_stay_in_the_list_for_30_days(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    recent = await reported(api_client, world.owner_14, title="Recent")
    old = await reported(api_client, world.owner_14, title="Old")
    still_open = await reported(api_client, world.family_14, title="Open")
    await end(db_session, recent["id"], 29)
    await end(db_session, old["id"], 31)

    resident = await listing(api_client, world.tenant_2)
    board = await listing(api_client, world.board_15)
    board_all = await listing(api_client, world.board_15, include_old="true")
    resident_all = await listing(api_client, world.tenant_2, include_old="true")

    assert [i["title"] for i in resident] == ["Open", "Recent"], "open first"
    assert [i["title"] for i in board] == ["Open", "Recent"]
    assert [i["title"] for i in board_all] == ["Open", "Recent", "Old"]
    assert [i["title"] for i in resident_all] == ["Open", "Recent"], "include_old is the board's"
    assert (await get(api_client, world.tenant_2, old["id"])).status_code == 404
    assert (await get(api_client, world.board_15, old["id"])).status_code == 200
    assert still_open["status"] == "REPORTED"


async def test_the_list_filters(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    light = await reported(api_client, world.owner_14)
    yard = await reported(api_client, world.family_14, category="YARD", entrance=None)
    ended = await reported(api_client, world.board_15, category="LIFT")
    await end(db_session, ended["id"], 1, status="DECLINED")

    async def ids(**params: Any) -> list[str]:
        return [i["id"] for i in await listing(api_client, world.tenant_2, **params)]

    assert await ids(status="OPEN") == [yard["id"], light["id"]], "newest first"
    assert await ids(status="ENDED") == [ended["id"]]
    assert await ids(status="DECLINED") == [ended["id"]]
    assert await ids(category="LIGHTING") == [light["id"]]
    assert await ids(entrance=2) == [light["id"], ended["id"]]
    bad = await api_client.get(API, params={"status": "LOST"}, headers=as_user(world.tenant_2))
    assert bad.status_code == 422


async def test_access_follows_the_current_role(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    await reported(api_client, world.owner_14)
    await db_session.execute(
        update(User).where(User.id == world.chairman.id).values(building_role=BuildingRole.USER)
    )

    response = await api_client.get(API, headers=as_user(world.chairman))

    assert response.status_code == 403, "a former chairman without an apartment loses access"
    assert len(await listing(api_client, world.board_15)) == 1


# --- Review findings (E9/I1) ---------------------------------------------------------------------


async def test_a_board_report_counts_for_its_apartment(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    neighbour = await create_user(db_session, world.building, "Tiit Saar")
    await create_membership(db_session, neighbour, world.apt_15, RelationType.RESIDENT)
    await set_settings(api_client, world.chairman, reports_per_apartment_per_day=1)

    await reported(api_client, world.board_15)  # from Apt 15, the board member's only apartment
    over = await report(api_client, neighbour)
    board_again = await report(api_client, world.board_15)

    assert (over.status_code, over.json()["error_code"]) == (429, "RATE_LIMITED")
    assert board_again.status_code == 201, "the board itself is never limited"


async def test_the_board_may_report_without_its_apartment(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    neighbour = await create_user(db_session, world.building, "Tiit Saar")
    await create_membership(db_session, neighbour, world.apt_15, RelationType.RESIDENT)
    await set_settings(api_client, world.chairman, reports_per_apartment_per_day=1)

    issue = await reported(api_client, world.board_15, apartment_id=None)
    resident = await report(api_client, world.owner_14, apartment_id=None)

    view = (await get(api_client, world.chairman, issue["id"])).json()
    assert view["reporter"]["apartment_id"] is None
    assert view["reporter"]["badge"]["display_label"] == "Board"
    await reported(api_client, neighbour)  # the board's report did not use Apt 15's slot
    assert resident.status_code == 201, "a resident's null means their one apartment"


async def test_a_patch_cannot_empty_a_required_field(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)

    for field in ("title", "place", "category"):
        response = await api_client.patch(
            f"{API}/{issue['id']}", json={field: None}, headers=as_user(world.owner_14)
        )
        assert response.status_code == 422, field
        assert response.json()["errors"][0]["loc"] == ["body", field]
    empty = await api_client.patch(f"{API}/{issue['id']}", json={}, headers=as_user(world.owner_14))
    assert empty.status_code == 200 and empty.json()["updated_at"] == issue["updated_at"]


async def test_a_withdrawn_issue_leaves_the_lists_after_30_days(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    await api_client.post(f"{API}/{issue['id']}/withdraw", headers=as_user(world.owner_14))
    await end(db_session, issue["id"], 31, status="WITHDRAWN")

    assert await listing(api_client, world.owner_14) == []
    assert await listing(api_client, world.chairman) == []
    assert len(await listing(api_client, world.chairman, include_old="true")) == 1
    assert (await get(api_client, world.owner_14, issue["id"])).status_code == 200, "by link"
    assert (await get(api_client, world.family_14, issue["id"])).status_code == 404


async def test_a_reporter_who_stopped_following_may_follow_again(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = await reported(api_client, world.owner_14)
    url = f"{API}/{issue['id']}/follow"

    stopped = await api_client.delete(url, headers=as_user(world.owner_14))
    again = await api_client.put(url, headers=as_user(world.owner_14))

    assert (stopped.json()["followers"], stopped.json()["can_follow"]) == (0, True)
    assert (again.json()["followers"], again.json()["i_follow"]) == (1, True)
