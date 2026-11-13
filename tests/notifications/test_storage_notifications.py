"""STORAGE_ALMOST_FULL: the chairman and the board hear when the files reach a threshold."""

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.file_events import StorageUsageHigh
from src.modules.notifications.messages import compose
from src.modules.notifications.models import Delivery
from src.modules.notifications.schemas import Channel, NotificationEventType
from tests.issues.conftest import IssueWorld, build_issue_world


@pytest.fixture
async def world(db_session: AsyncSession) -> IssueWorld:
    return await build_issue_world(db_session)


async def test_the_chairman_and_the_board_get_it_once_in_the_app(
    db_app, db_session: AsyncSession, event_bus, world: IssueWorld
) -> None:
    event = StorageUsageHigh(building_id=world.building.id, threshold=80, used_percent=81)

    await event_bus.publish(event)
    await event_bus.publish(event)  # a redelivery adds nothing

    rows = list(
        await db_session.scalars(
            select(Delivery).where(
                Delivery.event_type == NotificationEventType.STORAGE_ALMOST_FULL,
                Delivery.channel == Channel.IN_APP,
            )
        )
    )
    assert {row.user_id for row in rows} == {world.chairman.id, world.board_15.id}
    assert all(row.params == {"threshold": 80, "used_percent": 81} for row in rows)
    assert all(row.subject_id == world.building.id for row in rows)


def test_the_message_says_how_full_the_storage_is() -> None:
    for locale in ("en", "ru", "et"):
        rendered = compose(
            NotificationEventType.STORAGE_ALMOST_FULL,
            locale,
            {"threshold": 95, "used_percent": 96},
            site_url="https://example.test",
            timezone="Europe/Tallinn",
        )
        assert "96%" in rendered.subject and "96%" in rendered.text
