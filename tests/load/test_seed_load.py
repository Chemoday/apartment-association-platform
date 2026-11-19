"""The data generator of the load tests (tests/load/seed_load.py, issue #168).

It must fill an empty demo installation correctly and never write to anything else.
"""

import random
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.instance import InstanceRecord
from src.modules.meters.models import MeterDevice, MeterReading, ReadingPeriod
from src.modules.property.models import ApartmentMembership, Building, User
from tests import factories
from tests.load.seed_load import HISTORY_MONTHS, Refused, month_codes, seed


async def _count(session: AsyncSession, model: type) -> int:
    return await session.scalar(select(func.count()).select_from(model)) or 0


async def test_an_empty_demo_installation_gets_one_larger_building(db_session: AsyncSession):
    db_session.add(InstanceRecord(id=1, instance_id="load-1", demo=True))
    await db_session.flush()

    data = await seed(db_session, 6, random.Random(1), "Europe/Tallinn")

    assert await _count(db_session, Building) == 1
    assert data["apartments"] == 6
    assert len(data["residents"]) == 9  # an owner each, a tenant in every second apartment
    assert await _count(db_session, ApartmentMembership) == 9
    assert await _count(db_session, User) == 9 + 2 + 2  # residents, chairman and accountant, board
    assert await _count(db_session, MeterDevice) == 6 * 2 + 2  # two per apartment, two masters
    assert await _count(db_session, ReadingPeriod) == HISTORY_MONTHS + 1
    assert await _count(db_session, MeterReading) == 6 * 2 * HISTORY_MONTHS
    users = (await db_session.scalars(select(User))).all()
    assert all(user.email is None and user.phone is None for user in users)


async def test_the_readings_only_grow(db_session: AsyncSession):
    db_session.add(InstanceRecord(id=1, instance_id="load-1", demo=True))
    await db_session.flush()
    await seed(db_session, 2, random.Random(1), "Europe/Tallinn")

    readings = (await db_session.scalars(select(MeterReading))).all()
    assert readings
    assert all(r.value > r.previous_value and r.consumption_delta > 0 for r in readings)


@pytest.mark.parametrize("marker", [None, False])
async def test_a_database_that_is_not_a_demo_is_refused(db_session: AsyncSession, marker):
    if marker is not None:
        db_session.add(InstanceRecord(id=1, instance_id="assoc-1", demo=marker))
        await db_session.flush()

    with pytest.raises(Refused, match="not marked as a demo"):
        await seed(db_session, 2, random.Random(1), "Europe/Tallinn")
    assert await _count(db_session, Building) == 0


async def test_a_demo_that_already_holds_a_building_is_refused(db_session: AsyncSession):
    db_session.add(InstanceRecord(id=1, instance_id="load-1", demo=True))
    await factories.create_building(db_session)

    with pytest.raises(Refused, match="already holds a building"):
        await seed(db_session, 2, random.Random(1), "Europe/Tallinn")
    assert await _count(db_session, Building) == 1


def test_the_history_ends_before_the_current_month():
    past, current = month_codes(datetime(2026, 1, 15, 12, tzinfo=UTC), "Europe/Tallinn")

    assert current == "2026-01"
    assert past[0] == "2025-01" and past[-1] == "2025-12"
    assert len(past) == HISTORY_MONTHS
