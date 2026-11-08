"""The new-poll notification (epic E3, task V3; fixture: conftest.py).

Apt 14: owner Ivan Petrov. Apt 15: board member Peeter Saar. Apt 16: an inactive owner.
Apt 2: tenant Mari Tamm. Staff without apartments: the chairman and an accountant.
"""

import uuid
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Any

from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import DEMO_USER_HEADER
from src.modules.governance.events import PollOpened
from src.modules.notifications.models import Delivery
from src.modules.notifications.service import NotificationsSubscriber
from src.modules.property.models import User
from src.modules.property.schemas import RelationType
from tests.factories import create_membership
from tests.notifications.conftest import NotifWorld

POLLS = "/api/v1/governance/polls"
FEED = "/api/v1/notifications/feed"


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


def poll_body(**overrides: Any) -> dict[str, Any]:
    return {
        "title": "Debt collection company",
        "eligibility": "RESIDENTS",
        "unit": "APARTMENT",
        "closes_at": (datetime.now(UTC) + timedelta(days=7)).isoformat(),
        "questions": [
            {
                "text": "Agree?",
                "answer_mode": "SINGLE_CHOICE",
                "value_type": "TEXT",
                "options": ["Yes", "No"],
            }
        ],
        **overrides,
    }


async def open_poll(client: AsyncClient, author: User, **overrides: Any) -> dict:
    created = await client.post(POLLS, json=poll_body(**overrides), headers=as_user(author))
    assert created.status_code == 201, created.text
    opened = await client.post(f"{POLLS}/{created.json()['id']}/open", headers=as_user(author))
    assert opened.status_code == 200, opened.text
    return opened.json()


async def poll_notices(client: AsyncClient, user: User) -> list[dict]:
    response = await client.get(FEED, headers=as_user(user))
    assert response.status_code == 200, response.text
    return [item for item in response.json() if item["event_type"] == "POLL_OPENED"]


async def test_everyone_who_may_answer_is_told_once(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    poll = await open_poll(api_client, world.chairman)

    (notice,) = await poll_notices(api_client, world.owner_14)
    assert (notice["subject_type"], notice["subject_id"]) == ("poll", poll["id"])
    assert notice["params"] == {"closes_at": poll["closes_at"].replace("Z", "+00:00")}
    for user in (world.tenant_2, world.board_15):
        assert len(await poll_notices(api_client, user)) == 1
    # Never the opener; nobody without an apartment; nobody in another building.
    for user in (world.chairman, world.accountant, world.other_resident):
        assert await poll_notices(api_client, user) == []


async def test_an_inactive_owner_is_not_told(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    await open_poll(api_client, world.chairman)

    rows = await db_session.scalar(
        select(func.count()).select_from(Delivery).where(Delivery.user_id == world.inactive_16.id)
    )
    assert rows == 0


async def test_a_poll_per_person_tells_a_person_with_two_apartments_once(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    await create_membership(db_session, world.owner_14, world.apt_2, RelationType.TENANT)

    await open_poll(api_client, world.chairman, unit="PERSON")

    assert len(await poll_notices(api_client, world.owner_14)) == 1
    assert len(await poll_notices(api_client, world.tenant_2)) == 1


async def test_an_owners_only_poll_tells_owners_only(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    await open_poll(api_client, world.chairman, eligibility="OWNERS")

    assert len(await poll_notices(api_client, world.owner_14)) == 1
    assert await poll_notices(api_client, world.tenant_2) == [], "a tenant cannot answer"


async def test_the_board_member_who_opens_it_is_not_told(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    await open_poll(api_client, world.board_15, target_scope="ENTRANCE", target_entrance=2)

    assert await poll_notices(api_client, world.board_15) == []
    assert len(await poll_notices(api_client, world.owner_14)) == 1
    assert await poll_notices(api_client, world.tenant_2) == [], "entrance 1 is not targeted"


async def test_a_poll_for_listed_apartments_tells_their_people_only(
    api_client: AsyncClient, world: NotifWorld
) -> None:
    await open_poll(
        api_client,
        world.chairman,
        target_scope="APARTMENT_LIST",
        target_apartment_ids=[str(world.apt_2.id)],
    )

    assert len(await poll_notices(api_client, world.tenant_2)) == 1
    for user in (world.owner_14, world.board_15):
        assert await poll_notices(api_client, user) == []


def _subscriber(db_session: AsyncSession) -> NotificationsSubscriber:
    @asynccontextmanager
    async def factory():
        yield db_session

    return NotificationsSubscriber(lambda: factory, "et")


async def _rows(db_session: AsyncSession, poll_id: str) -> int:
    return await db_session.scalar(
        select(func.count())
        .select_from(Delivery)
        .where(Delivery.dedup_key == f"poll_opened:{poll_id}")
    )


async def test_an_event_delivered_twice_notifies_once(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    poll = await open_poll(api_client, world.chairman)
    before = await _rows(db_session, poll["id"])
    event = PollOpened(
        poll_id=uuid.UUID(poll["id"]),
        building_id=world.building.id,
        opened_by_user_id=world.chairman.id,
    )

    await _subscriber(db_session).on_poll_opened(event)

    assert before > 0 and await _rows(db_session, poll["id"]) == before


async def test_a_poll_cancelled_before_the_event_notifies_nobody(
    api_client: AsyncClient, db_session: AsyncSession, world: NotifWorld
) -> None:
    poll = await open_poll(api_client, world.chairman)
    await db_session.execute(
        Delivery.__table__.delete().where(Delivery.dedup_key == f"poll_opened:{poll['id']}")
    )
    await api_client.post(f"{POLLS}/{poll['id']}/cancel", headers=as_user(world.chairman))
    event = PollOpened(
        poll_id=uuid.UUID(poll["id"]),
        building_id=world.building.id,
        opened_by_user_id=world.chairman.id,
    )

    await _subscriber(db_session).on_poll_opened(event)

    assert await _rows(db_session, poll["id"]) == 0


async def test_an_unknown_poll_notifies_nobody(db_session: AsyncSession, world: NotifWorld) -> None:
    poll_id = uuid.uuid4()
    event = PollOpened(
        poll_id=poll_id, building_id=world.building.id, opened_by_user_id=world.chairman.id
    )

    await _subscriber(db_session).on_poll_opened(event)

    assert await _rows(db_session, str(poll_id)) == 0
