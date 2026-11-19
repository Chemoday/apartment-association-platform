"""The dashboard loads a meter's history once (issue #168, the load test of one installation).

It used to ask per meter, in separate queries and some twice, for the previous value, the previous
delta and the last 3 history deltas, and it loaded the readings of the whole building. The answers
must stay exactly those of the per-meter queries, and the number of queries must not grow with
the meters of the user or the size of the building.
"""

from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.event_bus import EventOutbox, InMemoryEventBus
from src.core.security import DEMO_USER_HEADER
from src.modules.meters.models import MeterReading, ReadingPeriod
from src.modules.meters.schemas import PeriodStatus, ReadingSource, ResourceType
from src.modules.meters.service import MetersService
from src.modules.property.service import PropertyService
from tests import factories

CODES = [f"2026-{month:02d}" for month in range(1, 11)]  # 2026-10 is open, the rest locked
SOURCES = [
    ReadingSource.RESIDENT,
    ReadingSource.AUTO_ESTIMATED,
    ReadingSource.RESIDENT,
    ReadingSource.ADMIN_OVERRIDE,
    ReadingSource.RESIDENT,
    ReadingSource.IOT_WEBHOOK,
    ReadingSource.RESIDENT,
    ReadingSource.AUTO_ESTIMATED,
    ReadingSource.RESIDENT,
]


async def _building(session: AsyncSession, meters: int, neighbours: int = 0):
    building = await factories.create_building(session)
    apartment = await factories.create_apartment(session, building, "1")
    owner = await factories.create_user(session, building, "Owner One")
    await factories.create_membership(session, owner, apartment)
    periods = {
        code: await factories.create_period(
            session,
            building,
            code,
            PeriodStatus.OPEN_FOR_RESIDENTS if code == CODES[-1] else PeriodStatus.LOCKED,
        )
        for code in CODES
    }
    own = []
    for index in range(meters):
        meter = await factories.create_meter(
            session, building, apartment, ResourceType.COLD_WATER, initial_value=Decimal("10.000")
        )
        value = Decimal("10.000")
        # A hole in the history (no reading for 2026-05) for every second meter.
        for code, source in zip(CODES[:-1], SOURCES, strict=True):
            if index % 2 and code == "2026-05":
                continue
            delta = Decimal(index + 2) + Decimal(len(own)) / 10
            reading = await factories.create_reading(
                session, meter, periods[code], value + delta, value, source=source
            )
            if code == "2026-07":
                reading.is_anomaly_confirmed = True  # never counts as history
            value += delta
        own.append(meter)
    for number in range(2, neighbours + 2):  # other apartments with readings this month
        neighbour = await factories.create_apartment(session, building, str(number))
        meter = await factories.create_meter(session, building, neighbour)
        await factories.create_reading(
            session, meter, periods[CODES[-1]], Decimal("5.000"), Decimal("0.000")
        )
    await session.flush()
    return owner, own, periods


async def test_the_batched_history_answers_like_the_per_meter_queries(db_session: AsyncSession):
    owner, meters, periods = await _building(db_session, meters=2)
    service = MetersService(
        db_session, PropertyService(db_session), EventOutbox(InMemoryEventBus())
    )
    histories = await service._meter_histories([meter.id for meter in meters])

    for meter in meters:
        for period in [None, *periods.values()]:
            assert histories.previous_value(meter, period) == await service._previous_value(
                meter, period
            )
            if period is None:
                continue
            assert histories.history_deltas(meter.id, period) == await service._history_deltas(
                meter.id, period
            )
            previous_delta = await db_session.scalar(  # the dashboard's former query
                select(MeterReading.consumption_delta)
                .join(ReadingPeriod, ReadingPeriod.id == MeterReading.period_id)
                .where(
                    MeterReading.meter_id == meter.id,
                    ReadingPeriod.period_code < period.period_code,
                )
                .order_by(ReadingPeriod.period_code.desc())
                .limit(1)
            )
            assert histories.previous_delta(meter.id, period) == previous_delta


async def _dashboard_queries(api_client: AsyncClient, db_session: AsyncSession, owner) -> int:
    statements: list[str] = []

    def count(_conn, _cursor, statement, *_args) -> None:
        statements.append(statement)

    sync_connection = (await db_session.connection()).sync_connection
    event.listen(sync_connection, "before_cursor_execute", count)
    try:
        response = await api_client.get(
            "/api/v1/meters/my-dashboard", headers={DEMO_USER_HEADER: str(owner.id)}
        )
    finally:
        event.remove(sync_connection, "before_cursor_execute", count)
    assert response.status_code == 200, response.text
    return len(statements)


async def test_the_dashboard_loads_only_the_readings_of_the_user_meters(db_session: AsyncSession):
    """The dashboard used to load the readings of the whole building for the period."""
    _, own, periods = await _building(db_session, meters=1, neighbours=5)
    service = MetersService(
        db_session, PropertyService(db_session), EventOutbox(InMemoryEventBus())
    )
    current = periods[CODES[-1]]

    assert len(await service._readings_by_meter(current)) == 5  # the neighbours' readings
    assert await service._readings_by_meter(current, [own[0].id]) == {}
    previous = await service._readings_by_meter(periods[CODES[-2]], [own[0].id])
    assert list(previous) == [own[0].id]


@pytest.mark.parametrize(("meters", "neighbours"), [(4, 0), (1, 30)])
async def test_the_dashboard_queries_do_not_grow_with_meters_or_the_building(
    api_client: AsyncClient, db_session: AsyncSession, meters: int, neighbours: int
):
    owner, _, _ = await _building(db_session, meters=1)
    one_meter = await _dashboard_queries(api_client, db_session, owner)

    other, _, _ = await _building(db_session, meters=meters, neighbours=neighbours)
    assert await _dashboard_queries(api_client, db_session, other) == one_meter
