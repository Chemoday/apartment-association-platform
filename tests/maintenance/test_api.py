"""The maintenance calendar through the API (epic E10, task M1; fixture: conftest.py)."""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from httpx import AsyncClient, Response

from src.core.security import DEMO_USER_HEADER
from src.modules.maintenance.policies import add_months
from src.modules.property.models import User
from tests.maintenance.conftest import MaintWorld, local_today

API = "/api/v1/maintenance"


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


def task_body(**overrides: Any) -> dict[str, Any]:
    return {
        "title": "Inspect the fire extinguishers",
        "instructions": "Basement and every landing.",
        "period_unit": "MONTH",
        "period_count": 12,
        "lead_days": 14,
        "first_due_date": (local_today() + timedelta(days=60)).isoformat(),
        **overrides,
    }


async def create(client: AsyncClient, user: User, **overrides: Any) -> Response:
    return await client.post(f"{API}/tasks", json=task_body(**overrides), headers=as_user(user))


async def created(client: AsyncClient, user: User, **overrides: Any) -> dict:
    response = await create(client, user, **overrides)
    assert response.status_code == 201, response.text
    return response.json()


async def act(client: AsyncClient, user: User, task: dict, action: str, **body: Any) -> Response:
    return await client.post(
        f"{API}/tasks/{task['id']}/{action}", json=body or None, headers=as_user(user)
    )


async def done(client: AsyncClient, user: User, task: dict, **body: Any) -> dict:
    payload = {
        "occurrence_id": task["current"]["occurrence_id"],
        "done_on": local_today().isoformat(),
        **body,
    }
    response = await act(client, user, task, "done", **payload)
    assert response.status_code == 201, response.text
    return response.json()


# --- Tasks ---------------------------------------------------------------------------------------


async def test_the_board_creates_a_task_with_its_first_occurrence(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=60)

    task = await created(api_client, world.board_15, first_due_date=due.isoformat())

    assert (task["status"], task["anchor_date"], task["last_closed_on"]) == (
        "ACTIVE",
        due.isoformat(),
        None,
    )
    assert task["current"]["due_date"] == due.isoformat()
    assert task["current"]["publish_on"] == (due - timedelta(days=14)).isoformat()
    assert task["current"]["state"] == "UPCOMING"
    assert task["notice"] is None
    same = await api_client.get(f"{API}/tasks/{task['id']}", headers=as_user(world.chairman))
    assert same.json() == task


async def test_who_may_use_the_calendar(api_client: AsyncClient, world: MaintWorld) -> None:
    task = await created(api_client, world.chairman)

    for user in (world.owner_14, world.tenant_2, world.accountant):
        for response in (
            await api_client.get(f"{API}/tasks", headers=as_user(user)),
            await create(api_client, user),
            await api_client.get(f"{API}/tasks/{task['id']}", headers=as_user(user)),
        ):
            assert (response.status_code, response.json()["error_code"]) == (403, "FORBIDDEN")
    resident_log = await api_client.get(f"{API}/log", headers=as_user(world.owner_14))
    accountant_log = await api_client.get(f"{API}/log", headers=as_user(world.accountant))
    other = await api_client.get(f"{API}/tasks/{task['id']}", headers=as_user(world.other_chairman))

    assert resident_log.status_code == 403
    assert accountant_log.status_code == 200
    assert (other.status_code, other.json()["error_code"]) == (404, "MAINTENANCE_TASK_NOT_FOUND")
    assert (
        await api_client.get(f"{API}/tasks", headers=as_user(world.other_chairman))
    ).json() == []


@pytest.mark.parametrize(
    "overrides",
    [
        {"period_unit": "DAY", "period_count": 5, "lead_days": 0},
        {"period_unit": "MONTH", "period_count": 1, "lead_days": 28},
        {"period_unit": "YEAR", "period_count": 11},
        {"period_unit": "WEEK"},
        {"first_due_date": "2000-01-01"},
        {"lead_days": 91},
        {"title": "  "},
        {"title": "x" * 121},
        {"instructions": "x" * 4001},
        {"extra": True},
    ],
)
async def test_a_task_that_does_not_fit_is_refused(
    api_client: AsyncClient, world: MaintWorld, overrides: dict
) -> None:
    response = await create(api_client, world.chairman, **overrides)

    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


async def test_a_task_overdue_from_the_start(api_client: AsyncClient, world: MaintWorld) -> None:
    due = local_today() - timedelta(days=10)

    task = await created(api_client, world.chairman, first_due_date=due.isoformat())

    assert task["current"]["state"] == "OVERDUE"


async def test_a_notice_for_residents(api_client: AsyncClient, world: MaintWorld) -> None:
    notice = {
        "title": "Gutters are cleaned",
        "body": "Please move cars from the yard.",
        "target_scope": "ENTRANCE",
        "target_entrance": 2,
    }

    task = await created(api_client, world.chairman, notice=notice)
    bad_entrance = await create(api_client, world.chairman, notice={**notice, "target_entrance": 9})
    foreign = await create(
        api_client,
        world.chairman,
        notice={
            **notice,
            "target_scope": "APARTMENT_LIST",
            "target_entrance": None,
            "target_apartment_ids": [str(world.other_apartment.id)],
        },
    )
    inconsistent = await create(
        api_client, world.chairman, notice={**notice, "target_scope": "ALL_BUILDING"}
    )

    assert task["notice"] == {
        **notice,
        "category": "MAINTENANCE",
        "target_apartment_ids": None,
        "comments_enabled": False,
    }
    for response in (bad_entrance, foreign, inconsistent):
        assert (response.status_code, response.json()["error_code"]) == (422, "INVALID_TARGET")


# --- Done and skip -------------------------------------------------------------------------------


async def test_done_writes_the_log_and_keeps_the_rhythm(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    today = local_today()
    due = today - timedelta(days=3)
    task = await created(
        api_client, world.chairman, first_due_date=due.isoformat(), period_count=1, lead_days=7
    )

    closed = await done(api_client, world.board_15, task, note="All 14 checked.", cost="145.5")

    entry, after = closed["entry"], closed["task"]
    assert (entry["kind"], entry["planned_date"], entry["closed_on"]) == (
        "DONE",
        due.isoformat(),
        today.isoformat(),
    )
    assert (entry["note"], entry["cost"]) == ("All 14 checked.", "145.50")
    assert entry["recorded_by"] == {"display_label": "Peeter Saar", "role_badge": "BOARD"}
    assert entry["updated_by"] is None and entry["task_title"] == task["title"]
    assert after["current"]["due_date"] == add_months(due, 1).isoformat()
    assert after["current"]["occurrence_id"] != task["current"]["occurrence_id"]
    assert after["last_closed_on"] == today.isoformat()


async def test_a_task_done_very_late_leaves_no_missed_dates(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    today = local_today()
    due = add_months(today, -3)
    task = await created(
        api_client, world.chairman, first_due_date=due.isoformat(), period_count=1, lead_days=7
    )

    after = (await done(api_client, world.chairman, task))["task"]

    expected = next(add_months(due, k) for k in range(1, 6) if add_months(due, k) > today)
    assert after["current"]["due_date"] == expected.isoformat()
    assert after["current"]["state"] in {"UPCOMING", "DUE"}


async def test_skip_needs_a_note_and_has_no_cost(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    task = await created(api_client, world.chairman)
    occurrence = task["current"]["occurrence_id"]

    no_note = await act(api_client, world.chairman, task, "skip", occurrence_id=occurrence)
    with_cost = await act(
        api_client, world.chairman, task, "skip", occurrence_id=occurrence, note="Roof", cost="1"
    )
    skipped = await act(
        api_client, world.chairman, task, "skip", occurrence_id=occurrence, note="Roof works"
    )

    assert no_note.status_code == 422 and with_cost.status_code == 422
    assert skipped.status_code == 201, skipped.text
    entry = skipped.json()["entry"]
    assert (entry["kind"], entry["cost"], entry["note"]) == ("SKIPPED", None, "Roof works")
    assert entry["closed_on"] == local_today().isoformat()


async def test_closing_a_closed_occurrence_names_the_current_one(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    task = await created(api_client, world.chairman)
    after = (await done(api_client, world.chairman, task))["task"]

    again = await act(
        api_client,
        world.board_15,
        task,
        "done",
        occurrence_id=task["current"]["occurrence_id"],
        done_on=local_today().isoformat(),
    )

    assert (again.status_code, again.json()["error_code"]) == (409, "OCCURRENCE_CLOSED")
    assert again.json()["current_occurrence_id"] == after["current"]["occurrence_id"]


@pytest.mark.parametrize(
    "extra",
    [
        {"cost": "1.234"},
        {"cost": "-1"},
        {"cost": 145},
        {"cost": "1e3"},
        {"done_on": (local_today() + timedelta(days=5)).isoformat()},
        {"note": "x" * 1001},
    ],
)
async def test_a_done_that_does_not_fit_is_refused(
    api_client: AsyncClient, world: MaintWorld, extra: dict
) -> None:
    task = await created(api_client, world.chairman)

    body = {
        "occurrence_id": task["current"]["occurrence_id"],
        "done_on": local_today().isoformat(),
        **extra,
    }
    response = await act(api_client, world.chairman, task, "done", **body)

    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


# --- Edit, pause, resume, archive ----------------------------------------------------------------


async def test_a_new_period_or_date_continues_the_rhythm_from_it(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    due = local_today() + timedelta(days=40)
    task = await created(api_client, world.chairman, first_due_date=due.isoformat())
    url = f"{API}/tasks/{task['id']}"

    period = await api_client.patch(
        url, json={"period_unit": "MONTH", "period_count": 3}, headers=as_user(world.chairman)
    )
    moved_to = due + timedelta(days=5)
    moved = await api_client.patch(
        url, json={"next_due_date": moved_to.isoformat()}, headers=as_user(world.board_15)
    )
    after = (await done(api_client, world.chairman, moved.json()))["task"]

    assert period.status_code == 200 and period.json()["anchor_date"] == due.isoformat()
    assert moved.json()["anchor_date"] == moved_to.isoformat()
    assert moved.json()["current"]["due_date"] == moved_to.isoformat()
    assert after["current"]["due_date"] == add_months(moved_to, 3).isoformat()


async def test_an_edit_changes_only_what_is_given(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    task = await created(
        api_client,
        world.chairman,
        notice={"title": "Works", "body": "On the stairs.", "target_scope": "ALL_BUILDING"},
    )
    url = f"{API}/tasks/{task['id']}"

    renamed = await api_client.patch(
        url, json={"title": "Renamed"}, headers=as_user(world.chairman)
    )
    no_notice = await api_client.patch(url, json={"notice": None}, headers=as_user(world.chairman))
    half_period = await api_client.patch(
        url, json={"period_unit": "DAY"}, headers=as_user(world.chairman)
    )
    null_title = await api_client.patch(url, json={"title": None}, headers=as_user(world.chairman))
    too_long_lead = await api_client.patch(
        url,
        json={"lead_days": 90, "period_unit": "MONTH", "period_count": 1},
        headers=as_user(world.chairman),
    )

    assert renamed.json()["title"] == "Renamed" and renamed.json()["notice"] is not None
    assert renamed.json()["instructions"] == task["instructions"]
    assert no_notice.json()["notice"] is None
    for response in (half_period, null_title, too_long_lead):
        assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


async def test_pause_resume_and_archive(api_client: AsyncClient, world: MaintWorld) -> None:
    task = await created(api_client, world.chairman)

    paused = await act(api_client, world.chairman, task, "pause")
    again = await act(api_client, world.chairman, task, "pause")
    resumed_to = local_today() + timedelta(days=100)
    resumed = await act(
        api_client, world.chairman, task, "resume", next_due_date=resumed_to.isoformat()
    )
    archived = await act(api_client, world.board_15, task, "archive")

    assert (paused.json()["status"], paused.json()["current"]["state"]) == ("PAUSED", "PAUSED")
    assert (again.status_code, again.json()["error_code"]) == (409, "INVALID_TASK_TRANSITION")
    assert again.json()["status"] == "PAUSED"
    assert resumed.json()["status"] == "ACTIVE"
    assert resumed.json()["current"]["due_date"] == resumed_to.isoformat()
    assert (archived.json()["status"], archived.json()["current"]) == ("ARCHIVED", None)
    assert archived.json()["archived_at"] is not None
    url = f"{API}/tasks/{task['id']}"
    edit = await api_client.patch(url, json={"title": "X"}, headers=as_user(world.chairman))
    closing = await act(
        api_client,
        world.chairman,
        task,
        "done",
        occurrence_id=task["current"]["occurrence_id"],
        done_on=local_today().isoformat(),
    )
    for response in (edit, closing):
        assert (response.status_code, response.json()["error_code"]) == (409, "TASK_ARCHIVED")
    unarchive = await act(api_client, world.chairman, task, "resume")
    assert unarchive.status_code == 409


async def test_a_paused_task_may_still_be_done(api_client: AsyncClient, world: MaintWorld) -> None:
    task = await created(api_client, world.chairman)
    await act(api_client, world.chairman, task, "pause")

    after = (await done(api_client, world.chairman, task))["task"]

    assert (after["status"], after["current"]["state"]) == ("PAUSED", "PAUSED")


# --- The list ------------------------------------------------------------------------------------


async def test_the_list_by_due_date_and_state(api_client: AsyncClient, world: MaintWorld) -> None:
    today = local_today()
    overdue = await created(
        api_client,
        world.chairman,
        title="Overdue",
        first_due_date=(today - timedelta(days=2)).isoformat(),
    )
    due = await created(
        api_client,
        world.chairman,
        title="Due",
        first_due_date=(today + timedelta(days=5)).isoformat(),
    )
    upcoming = await created(
        api_client,
        world.chairman,
        title="Upcoming",
        first_due_date=(today + timedelta(days=90)).isoformat(),
    )
    paused = await created(
        api_client,
        world.chairman,
        title="Paused",
        first_due_date=(today + timedelta(days=1)).isoformat(),
    )
    await act(api_client, world.chairman, paused, "pause")
    archived = await created(api_client, world.chairman, title="Archived")
    await act(api_client, world.chairman, archived, "archive")

    async def titles(**params: Any) -> list[str]:
        response = await api_client.get(
            f"{API}/tasks", params=params, headers=as_user(world.board_15)
        )
        assert response.status_code == 200, response.text
        return [item["title"] for item in response.json()]

    assert await titles() == ["Overdue", "Paused", "Due", "Upcoming"]
    assert await titles(state="OVERDUE") == ["Overdue"]
    assert await titles(state="DUE") == ["Due"]
    assert await titles(state="UPCOMING") == ["Upcoming"]
    assert await titles(state="PAUSED") == ["Paused"]
    assert await titles(status="ARCHIVED") == ["Archived"]
    assert await titles(limit=1, offset=1) == ["Paused"]
    assert {due["id"], upcoming["id"], overdue["id"]}


# --- The log -------------------------------------------------------------------------------------


async def test_the_log_newest_first_with_filters_and_edits(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    today = local_today()
    first = await created(api_client, world.chairman, title="First", period_count=1, lead_days=0)
    second = await created(api_client, world.chairman, title="Second", period_count=1, lead_days=0)
    old = await done(
        api_client,
        world.chairman,
        first,
        done_on=(today - timedelta(days=10)).isoformat(),
        cost="80.5",
    )
    await done(api_client, world.board_15, second)

    log = (await api_client.get(f"{API}/log", headers=as_user(world.accountant))).json()
    only_first = await api_client.get(
        f"{API}/log", params={"task_id": first["id"]}, headers=as_user(world.chairman)
    )
    window = await api_client.get(
        f"{API}/log",
        params={
            "from": (today - timedelta(days=11)).isoformat(),
            "to": (today - timedelta(days=9)).isoformat(),
        },
        headers=as_user(world.chairman),
    )
    entry_url = f"{API}/log/{old['entry']['id']}"
    edited = await api_client.patch(
        entry_url, json={"note": "Invoice 17", "cost": None}, headers=as_user(world.board_15)
    )
    accountant_edit = await api_client.patch(
        entry_url, json={"note": "x"}, headers=as_user(world.accountant)
    )

    assert [entry["task_title"] for entry in log] == ["Second", "First"]
    assert log[1]["cost"] == "80.50", "the accountant reads the costs"
    assert [entry["task_title"] for entry in only_first.json()] == ["First"]
    assert [entry["task_title"] for entry in window.json()] == ["First"]
    assert (edited.json()["note"], edited.json()["cost"]) == ("Invoice 17", None)
    assert edited.json()["updated_by"] == {"display_label": "Peeter Saar", "role_badge": "BOARD"}
    assert accountant_edit.status_code == 403
    missing = await api_client.patch(
        f"{API}/log/{uuid.uuid4()}", json={"note": "x"}, headers=as_user(world.chairman)
    )
    assert (missing.status_code, missing.json()["error_code"]) == (404, "LOG_ENTRY_NOT_FOUND")


async def test_a_skipped_entry_keeps_a_note_and_never_gets_a_cost(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    task = await created(api_client, world.chairman)
    skipped = await act(
        api_client,
        world.chairman,
        task,
        "skip",
        occurrence_id=task["current"]["occurrence_id"],
        note="Roof works",
    )
    url = f"{API}/log/{skipped.json()['entry']['id']}"

    cost = await api_client.patch(url, json={"cost": "10"}, headers=as_user(world.chairman))
    empty = await api_client.patch(url, json={"note": ""}, headers=as_user(world.chairman))

    assert cost.status_code == 422 and empty.status_code == 422
