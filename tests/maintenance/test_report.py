"""The yearly report of the maintenance log (issue #132; fixture: conftest.py)."""

import csv
import io
from datetime import date, timedelta

from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.maintenance.models import LogEntry
from tests.maintenance.conftest import MaintWorld, local_today
from tests.maintenance.test_api import API, act, as_user, created, done


async def _skip(client: AsyncClient, world: MaintWorld, task: dict, note: str) -> dict:
    response = await act(
        client,
        world.chairman,
        task,
        "skip",
        occurrence_id=task["current"]["occurrence_id"],
        note=note,
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _log_year(client: AsyncClient, world: MaintWorld) -> None:
    """Two tasks: B done twice (with costs) and skipped once; A done once without a cost."""
    due = (local_today() + timedelta(days=5)).isoformat()
    task_b = await created(
        client,
        world.board_15,
        title="B: clean the gutters",
        period_unit="DAY",
        period_count=7,
        lead_days=3,
        first_due_date=due,
    )
    task_b = (await done(client, world.board_15, task_b, cost="100.10"))["task"]
    task_b = (await done(client, world.board_15, task_b, cost="0.20", note="=SUM(A1)"))["task"]
    await _skip(client, world, task_b, "Rain all week")
    task_a = await created(client, world.chairman, title="@A: lift inspection", first_due_date=due)
    await done(client, world.chairman, task_a)


async def test_the_report_counts_and_sums_exactly_per_task_and_in_total(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    await _log_year(api_client, world)
    year = local_today().year

    response = await api_client.get(
        f"{API}/report", params={"year": year}, headers=as_user(world.accountant)
    )

    assert response.status_code == 200, response.text
    report = response.json()
    assert (report["year"], report["done_count"], report["skipped_count"]) == (year, 3, 1)
    assert report["total_cost"] == "100.30"  # 100.10 + 0.20 exactly, not a float sum
    assert [(t["task_title"], t["done_count"], t["skipped_count"], t["total_cost"])
            for t in report["tasks"]] == [
        ("@A: lift inspection", 1, 0, "0.00"),
        ("B: clean the gutters", 2, 1, "100.30"),
    ]  # fmt: skip


async def test_a_year_without_entries_is_empty(api_client: AsyncClient, world: MaintWorld) -> None:
    await _log_year(api_client, world)

    report = (
        await api_client.get(
            f"{API}/report",
            params={"year": local_today().year - 1},
            headers=as_user(world.chairman),
        )
    ).json()

    assert report == {
        "year": local_today().year - 1,
        "done_count": 0,
        "skipped_count": 0,
        "total_cost": "0.00",
        "tasks": [],
    }


async def test_who_may_read_the_report(api_client: AsyncClient, world: MaintWorld) -> None:
    await _log_year(api_client, world)
    params = {"year": local_today().year}

    for user, status in (
        (world.chairman, 200),
        (world.board_15, 200),
        (world.accountant, 200),
        (world.owner_14, 403),
        (world.tenant_2, 403),
    ):
        for path in ("/report", "/report/export-csv"):
            response = await api_client.get(f"{API}{path}", params=params, headers=as_user(user))
            assert response.status_code == status, (user.full_name, path)
    other = await api_client.get(
        f"{API}/report", params=params, headers=as_user(world.other_chairman)
    )
    assert other.json()["tasks"] == []  # another building sees nothing of this one
    other_csv = await api_client.get(
        f"{API}/report/export-csv", params=params, headers=as_user(world.other_chairman)
    )
    assert other_csv.content.decode("utf-8").count("\r\n") == 1  # only the header


async def test_the_year_must_be_sensible(api_client: AsyncClient, world: MaintWorld) -> None:
    for year in ("1999", "2101", "x", ""):
        response = await api_client.get(
            f"{API}/report", params={"year": year}, headers=as_user(world.chairman)
        )
        assert response.status_code == 422, year
    missing = await api_client.get(f"{API}/report", headers=as_user(world.chairman))
    assert missing.status_code == 422


async def test_the_csv_lists_the_entries_with_formulas_neutralized(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    await _log_year(api_client, world)
    year = local_today().year

    response = await api_client.get(
        f"{API}/report/export-csv", params={"year": year}, headers=as_user(world.board_15)
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert response.headers["content-disposition"] == (
        f'attachment; filename="maintenance-log-{year}.csv"'
    )
    text = response.content.decode("utf-8")
    assert text.startswith("﻿") and "\r\n" in text
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    assert rows[0] == [
        "closed_on", "task_title", "kind", "planned_date", "cost", "note", "recorded_by",
    ]  # fmt: skip
    body = rows[1:]
    assert len(body) == 4
    assert sorted(row[2] for row in body) == ["DONE", "DONE", "DONE", "SKIPPED"]
    costs = sorted(row[4] for row in body)
    assert costs == ["", "", "0.20", "100.10"]
    assert "'=SUM(A1)" in [row[5] for row in body]
    assert "'@A: lift inspection" in [row[1] for row in body]
    assert {"Peeter Saar"} <= {row[6] for row in body}  # the board sees who recorded it


async def test_the_year_runs_from_1_january_to_31_december(
    api_client: AsyncClient, world: MaintWorld, db_session: AsyncSession
) -> None:
    await _log_year(api_client, world)
    year = 2030
    entries = list(await db_session.scalars(select(LogEntry).order_by(LogEntry.created_at)))
    # B done 100.10, B done 0.20, B skipped, A done: move them around the year's edges.
    edges = (date(year - 1, 12, 31), date(year, 1, 1), date(year, 12, 31), date(year + 1, 1, 1))
    for entry, closed_on in zip(entries, edges, strict=True):
        await db_session.execute(
            update(LogEntry).where(LogEntry.id == entry.id).values(closed_on=closed_on)
        )
    task_b = entries[0].task_id
    archived = await api_client.post(
        f"{API}/tasks/{task_b}/archive", headers=as_user(world.chairman)
    )
    assert archived.status_code == 200, archived.text

    report = (
        await api_client.get(
            f"{API}/report", params={"year": year}, headers=as_user(world.chairman)
        )
    ).json()
    csv_text = (
        await api_client.get(
            f"{API}/report/export-csv", params={"year": year}, headers=as_user(world.chairman)
        )
    ).content.decode("utf-8")

    # Only 1 January and 31 December of the year count; an archived task is still reported.
    assert (report["done_count"], report["skipped_count"], report["total_cost"]) == (1, 1, "0.20")
    assert [t["task_title"] for t in report["tasks"]] == ["B: clean the gutters"]
    rows = list(csv.reader(io.StringIO(csv_text.lstrip("\ufeff"))))[1:]
    assert [(row[0], row[2]) for row in rows] == [
        (f"{year}-01-01", "DONE"),
        (f"{year}-12-31", "SKIPPED"),
    ]  # oldest first
