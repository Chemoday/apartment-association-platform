"""A maintenance notice addressed by kind of object (epic E14, task K2): published to the people
of that kind only, and failed when the building no longer has an object of the kind."""

import uuid
from datetime import timedelta

from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.maintenance.models import Task
from src.modules.maintenance.publisher import Publisher
from tests.factories import create_mixed_building
from tests.maintenance.conftest import MaintWorld, local_today
from tests.maintenance.test_api import API, as_user, created
from tests.maintenance.test_publisher import at, calendar_task, notices, publisher  # noqa: F401

GATE = {
    "title": "The garage gate is serviced",
    "body": "Keep it open.",
    "target_scope": "KINDS",
    "target_kinds": ["GARAGE"],
}


async def test_a_notice_to_the_garages_reaches_the_garages_only(
    api_client: AsyncClient,
    db_session: AsyncSession,
    publisher: Publisher,  # noqa: F811
) -> None:
    mixed = await create_mixed_building(db_session)
    due = local_today() + timedelta(days=10)
    task = await created(api_client, mixed.chairman, **calendar_task(due, notice=GATE))
    assert task["notice"]["target_kinds"] == ["GARAGE"]

    result = await publisher.tick(now=at(due - timedelta(days=14)))

    assert result.published >= 1
    titles_of = {
        name: [n["title"] for n in await notices(api_client, mixed.people[name])]
        for name in ("A", "B", "board member")
    }
    assert titles_of == {
        "A": [],  # Apt. 14 and P1, no garage
        "B": [GATE["title"]],
        "board member": [GATE["title"]],
    }


async def test_a_notice_to_a_kind_the_building_no_longer_has_fails(
    api_client: AsyncClient,
    db_session: AsyncSession,
    publisher: Publisher,  # noqa: F811
    world: MaintWorld,
) -> None:
    due = local_today() + timedelta(days=10)
    task = await created(
        api_client,
        world.chairman,
        **calendar_task(due, notice={**GATE, "target_kinds": ["APARTMENT"]}),
    )
    await db_session.execute(
        update(Task).where(Task.id == uuid.UUID(task["id"])).values(notice_target_kinds=["GARAGE"])
    )

    await publisher.tick(now=at(due - timedelta(days=14)))

    view = (
        await api_client.get(f"{API}/tasks/{task['id']}", headers=as_user(world.chairman))
    ).json()
    assert (view["current"]["notice_failed"], view["current"]["notice_post_id"]) == (True, None)


async def test_a_notice_to_a_kind_the_building_lacks_is_refused(
    api_client: AsyncClient, world: MaintWorld
) -> None:
    response = await api_client.post(
        f"{API}/tasks",
        json={
            "title": "Gate",
            "period_unit": "MONTH",
            "period_count": 12,
            "lead_days": 14,
            "first_due_date": (local_today() + timedelta(days=60)).isoformat(),
            "notice": GATE,
        },
        headers=as_user(world.chairman),
    )

    assert (response.status_code, response.json()["error_code"]) == (422, "INVALID_TARGET")
    assert response.json()["unknown_kinds"] == ["GARAGE"]
