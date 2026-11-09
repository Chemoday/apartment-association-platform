"""Monthly periods that open themselves, and the month a resident's reading belongs to
(docs/API.md section 2; fixture: tests/meters/conftest.py, periods 2026-07..09 LOCKED, 2026-10
OPEN, no 2026-10 readings yet).
"""

import asyncio
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from alembic import command
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.core.database import build_engine
from src.core.domain_events import DomainEventRecord
from src.core.event_bus import DomainEvent, InMemoryEventBus
from src.core.migrations import alembic_config
from src.core.security import DEMO_USER_HEADER
from src.modules.meters.events import ReadingPeriodOpened
from src.modules.meters.models import MeterDevice, ReadingPeriod
from src.modules.meters.opener import PeriodOpener
from src.modules.meters.policies import (
    PreviousPeriod,
    next_period_code,
    period_due_date,
    previous_period_code,
    submission_target,
)
from src.modules.meters.schemas import PeriodStatus, ReadingSource, ResourceType
from src.modules.property.models import Apartment, ApartmentMembership, User
from tests.db_utils import scratch_database
from tests.factories import (
    create_building,
    create_membership,
    create_meter,
    create_period,
    create_reading,
)
from tests.meters.conftest import MetersWorld

D = Decimal
ZONE = ZoneInfo(get_settings().INSTANCE_TIMEZONE)
READINGS = "/api/v1/meters/readings"
DASHBOARD = "/api/v1/meters/my-dashboard"


def local(year: int, month: int, day: int, hour: int = 12, minute: int = 0) -> datetime:
    """A local time in the instance time zone, as UTC."""
    return datetime.combine(
        datetime(year, month, day).date(), time(hour, minute), tzinfo=ZONE
    ).astimezone(UTC)


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


async def submit(client: AsyncClient, user: User, meter: MeterDevice, period: str, value: str):
    return await client.post(
        READINGS,
        json={"meter_id": str(meter.id), "period_code": period, "value": value},
        headers=as_user(user),
    )


async def dashboard_meter(client: AsyncClient, user: User) -> tuple[dict, dict]:
    response = await client.get(DASHBOARD, headers=as_user(user))
    assert response.status_code == 200, response.text
    body = response.json()
    (apartment,) = body["apartments"]
    (meter,) = apartment["meters"]
    return body["period"], meter


@pytest.fixture
async def november(db_session: AsyncSession, world: MetersWorld) -> ReadingPeriod:
    return await create_period(db_session, world.building, "2026-11")


# --- The pure rule -------------------------------------------------------------------------------


def test_period_codes_cross_the_year() -> None:
    assert next_period_code("2026-12") == "2027-01"
    assert previous_period_code("2027-01") == "2026-12"
    assert next_period_code("2026-10") == "2026-11"
    assert previous_period_code("2026-10") == "2026-09"


def test_a_deadline_day_past_the_months_end_is_its_last_day() -> None:
    # "2027-01" is due in February: day 31 becomes 28 (29 in a leap year).
    assert period_due_date("2027-01", 31, ZONE.key) == local(2027, 2, 28, 23, 59) + timedelta(
        seconds=59
    )
    assert period_due_date("2028-01", 31, ZONE.key).astimezone(ZONE).day == 29


def test_the_previous_month_until_its_due_date_then_the_current_one() -> None:
    due = period_due_date("2026-10", 4, ZONE.key)  # 4 Nov 23:59:59 local
    october = PreviousPeriod(status=PeriodStatus.OPEN_FOR_RESIDENTS, due_date=due)

    def target(now: datetime, previous=october, has_reading=False) -> tuple[str, bool]:
        result = submission_target(now, ZONE, previous, has_reading)
        return result.period_code, result.final

    assert target(local(2026, 11, 1, 0, 0)) == ("2026-10", True)
    assert target(due) == ("2026-10", True)
    assert target(due + timedelta(seconds=1)) == ("2026-11", False)
    assert target(local(2026, 11, 2), has_reading=True) == ("2026-11", False)
    assert target(local(2026, 11, 2), previous=None) == ("2026-11", False)
    in_review = PreviousPeriod(status=PeriodStatus.REVIEW_BY_BOARD, due_date=due)
    assert target(local(2026, 11, 2), previous=in_review) == ("2026-11", False)


def test_the_month_is_the_local_month() -> None:
    # 31 October 22:30 UTC is already 1 November in Tallinn (UTC+2 in winter).
    now = datetime(2026, 10, 31, 22, 30, tzinfo=UTC)
    assert submission_target(now, ZONE, None, False).period_code == "2026-11"
    assert submission_target(now, ZoneInfo("UTC"), None, False).period_code == "2026-10"


# --- Submitting ----------------------------------------------------------------------------------


async def test_inside_the_month_the_reading_is_the_months_and_can_change(
    api_client: AsyncClient, world: MetersWorld
) -> None:
    # The test clock stands on 15 October 2026.
    period, meter = await dashboard_meter(api_client, world.owner_14)
    assert period["period_code"] == "2026-10"
    assert meter["next_submission"] == {
        "period_code": "2026-10",
        "due_date": "2026-11-04T21:59:59Z",
        "final": False,
        "previous_value": "115.000",
        "average_delta": "5.000",
        "reading": None,
    }
    assert (await submit(api_client, world.owner_14, world.meter_14, "2026-10", "118")).is_success
    assert (await submit(api_client, world.owner_14, world.meter_14, "2026-10", "119")).is_success
    _, meter = await dashboard_meter(api_client, world.owner_14)
    assert meter["reading"]["value"] == "119.000"
    assert meter["next_submission"]["period_code"] == "2026-10"


async def test_a_late_reading_closes_the_previous_month_and_the_next_goes_to_the_new_one(
    api_client: AsyncClient,
    world: MetersWorld,
    november: ReadingPeriod,
    meters_now: Callable[[datetime], None],
) -> None:
    meters_now(local(2026, 11, 3))
    period, meter = await dashboard_meter(api_client, world.owner_14)
    assert period["period_code"] == "2026-10"
    assert meter["next_submission"] == {
        "period_code": "2026-10",
        "due_date": "2026-11-04T21:59:59Z",
        "final": True,
        "previous_value": "115.000",
        "average_delta": "5.000",
        "reading": None,
    }

    wrong = await submit(api_client, world.owner_14, world.meter_14, "2026-11", "120")
    assert wrong.status_code == 409
    assert wrong.json()["error_code"] == "WRONG_PERIOD"
    assert wrong.json()["target_period_code"] == "2026-10"

    late = await submit(api_client, world.owner_14, world.meter_14, "2026-10", "120")
    assert late.status_code == 200, late.text
    assert late.json()["period_code"] == "2026-10"

    # October is final now: the next reading is November's, and it can change all month.
    period, meter = await dashboard_meter(api_client, world.owner_14)
    assert period["period_code"] == "2026-11"
    assert meter["next_submission"]["period_code"] == "2026-11"
    assert meter["next_submission"]["final"] is False
    again = await submit(api_client, world.owner_14, world.meter_14, "2026-10", "121")
    assert again.status_code == 409
    assert again.json()["target_period_code"] == "2026-11"
    first = await submit(api_client, world.owner_14, world.meter_14, "2026-11", "124")
    assert first.status_code == 200, first.text
    assert first.json()["consumption_delta"] == "4.000"  # from October's 120
    assert (await submit(api_client, world.owner_14, world.meter_14, "2026-11", "125")).is_success


async def test_after_the_due_date_the_missing_month_is_skipped(
    api_client: AsyncClient,
    world: MetersWorld,
    november: ReadingPeriod,
    meters_now: Callable[[datetime], None],
) -> None:
    meters_now(local(2026, 11, 5))
    _, meter = await dashboard_meter(api_client, world.owner_14)
    assert meter["next_submission"]["period_code"] == "2026-11"
    response = await submit(api_client, world.owner_14, world.meter_14, "2026-10", "120")
    assert response.status_code == 409
    assert response.json()["error_code"] == "WRONG_PERIOD"
    response = await submit(api_client, world.owner_14, world.meter_14, "2026-11", "120")
    assert response.status_code == 200, response.text
    assert response.json()["consumption_delta"] == "5.000"  # from September's 115


async def test_a_reading_from_october_keeps_november_for_the_next_one(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: MetersWorld,
    november: ReadingPeriod,
    meters_now: Callable[[datetime], None],
) -> None:
    await create_reading(
        db_session, world.meter_14, world.periods["2026-10"], D("118.000"), D("115.000")
    )
    meters_now(local(2026, 11, 2))
    period, meter = await dashboard_meter(api_client, world.owner_14)
    assert period["period_code"] == "2026-11"
    assert meter["next_submission"]["final"] is False


async def test_the_previous_month_under_review_sends_residents_to_the_new_one(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: MetersWorld,
    november: ReadingPeriod,
    meters_now: Callable[[datetime], None],
) -> None:
    world.periods["2026-10"].status = PeriodStatus.REVIEW_BY_BOARD
    await db_session.flush()
    meters_now(local(2026, 11, 2))
    _, meter = await dashboard_meter(api_client, world.owner_14)
    assert meter["next_submission"]["period_code"] == "2026-11"


async def test_an_estimate_does_not_count_as_the_previous_months_reading(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: MetersWorld,
    november: ReadingPeriod,
    meters_now: Callable[[datetime], None],
) -> None:
    await create_reading(
        db_session,
        world.meter_14,
        world.periods["2026-10"],
        D("120.000"),
        D("115.000"),
        source=ReadingSource.AUTO_ESTIMATED,
    )
    meters_now(local(2026, 11, 2))
    _, meter = await dashboard_meter(api_client, world.owner_14)
    target = meter["next_submission"]
    assert (target["period_code"], target["final"]) == ("2026-10", True)
    assert target["reading"]["source"] == "AUTO_ESTIMATED"
    response = await submit(api_client, world.owner_14, world.meter_14, "2026-10", "119")
    assert response.status_code == 200, response.text
    assert response.json()["source"] == "RESIDENT"


async def test_no_next_submission_without_the_period_or_the_right_to_submit(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: MetersWorld,
    meters_now: Callable[[datetime], None],
) -> None:
    await create_reading(
        db_session, world.meter_14, world.periods["2026-10"], D("118.000"), D("115.000")
    )
    meters_now(local(2026, 11, 2))  # November is not open yet (the opener has not run)
    period, meter = await dashboard_meter(api_client, world.owner_14)
    assert meter["next_submission"] is None
    assert period["period_code"] == "2026-10"  # the latest period open for residents
    response = await submit(api_client, world.owner_14, world.meter_14, "2026-11", "120")
    assert response.status_code == 404
    assert response.json()["error_code"] == "PERIOD_NOT_FOUND"

    await db_session.execute(
        update(ApartmentMembership)
        .where(ApartmentMembership.id == world.tenant_2_membership.id)
        .values(can_submit_readings=False)
    )
    _, meter = await dashboard_meter(api_client, world.tenant_2)
    assert meter["next_submission"] is None


async def test_a_chairman_living_in_the_building_writes_as_the_board_outside_the_target(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: MetersWorld,
    november: ReadingPeriod,
    meters_now: Callable[[datetime], None],
) -> None:
    apartment_5 = await db_session.get(Apartment, world.meter_5.apartment_id)
    assert apartment_5 is not None
    await create_membership(db_session, world.chairman, apartment_5)
    meters_now(local(2026, 11, 2))

    # The meter's target is October (no October reading yet): November is written as the board.
    board = await submit(api_client, world.chairman, world.meter_5, "2026-11", "13")
    assert board.status_code == 200, board.text
    assert board.json()["source"] == "ADMIN_OVERRIDE"


async def test_a_chairman_living_in_the_building_submits_the_target_as_a_resident(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: MetersWorld,
    november: ReadingPeriod,
    meters_now: Callable[[datetime], None],
) -> None:
    apartment_5 = await db_session.get(Apartment, world.meter_5.apartment_id)
    assert apartment_5 is not None
    await create_membership(db_session, world.chairman, apartment_5)
    meters_now(local(2026, 11, 2))

    own = await submit(api_client, world.chairman, world.meter_5, "2026-10", "12")
    assert own.status_code == 200, own.text
    assert own.json()["source"] == "RESIDENT"


async def test_staff_are_not_limited_to_the_target(
    api_client: AsyncClient,
    world: MetersWorld,
    november: ReadingPeriod,
    meters_now: Callable[[datetime], None],
) -> None:
    meters_now(local(2026, 11, 2))
    response = await submit(api_client, world.accountant, world.meter_14, "2026-11", "120")
    assert response.status_code == 200, response.text
    assert response.json()["source"] == "ADMIN_OVERRIDE"


async def test_each_meters_form_uses_its_own_target_month(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: MetersWorld,
    november: ReadingPeriod,
    meters_now: Callable[[datetime], None],
) -> None:
    # Apt 14 gets a hot water meter: cold water is done for October, hot water is not.
    apartment = await db_session.get(Apartment, world.meter_14.apartment_id)
    hot = await create_meter(
        db_session, world.building, apartment, ResourceType.HOT_WATER, initial_value=D("20.000")
    )
    await create_reading(
        db_session, world.meter_14, world.periods["2026-10"], D("118.000"), D("115.000")
    )
    await create_reading(db_session, world.meter_14, november, D("121.000"), D("118.000"))
    meters_now(local(2026, 11, 2))

    response = await api_client.get(DASHBOARD, headers=as_user(world.owner_14))
    body = response.json()
    assert body["period"]["period_code"] == "2026-10"  # hot water is still due for October
    meters = {m["meter_id"]: m for m in body["apartments"][0]["meters"]}
    cold, hot_water = meters[str(world.meter_14.id)], meters[str(hot.id)]
    assert (hot_water["next_submission"]["period_code"], hot_water["next_submission"]["final"]) == (
        "2026-10",
        True,
    )
    assert hot_water["next_submission"]["previous_value"] == "20.000"
    # Cold water's form is November's: its floor is October's 118, its reading November's.
    assert cold["previous_value"] == "115.000"  # the shown period (October)
    target = cold["next_submission"]
    assert (target["period_code"], target["final"]) == ("2026-11", False)
    assert target["previous_value"] == "118.000"
    assert target["reading"]["value"] == "121.000"


async def test_a_retried_final_reading_is_not_an_error(
    api_client: AsyncClient,
    world: MetersWorld,
    november: ReadingPeriod,
    meters_now: Callable[[datetime], None],
) -> None:
    meters_now(local(2026, 11, 3))
    first = await submit(api_client, world.owner_14, world.meter_14, "2026-10", "120")
    retry = await submit(api_client, world.owner_14, world.meter_14, "2026-10", "120")
    assert (first.status_code, retry.status_code) == (200, 200), retry.text
    assert retry.json()["reading_id"] == first.json()["reading_id"]
    changed = await submit(api_client, world.owner_14, world.meter_14, "2026-10", "121")
    assert changed.status_code == 409
    assert changed.json()["error_code"] == "WRONG_PERIOD"


async def test_no_next_submission_while_the_target_is_under_review(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: MetersWorld,
) -> None:
    world.periods["2026-10"].status = PeriodStatus.REVIEW_BY_BOARD
    await db_session.flush()
    _, meter = await dashboard_meter(api_client, world.owner_14)  # 15 October
    assert meter["next_submission"] is None
    response = await submit(api_client, world.owner_14, world.meter_14, "2026-10", "118")
    assert response.status_code == 409
    assert response.json()["error_code"] == "PERIOD_CLOSED"


async def test_the_year_turns_from_december_to_january(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: MetersWorld,
    meters_now: Callable[[datetime], None],
) -> None:
    for code in ("2026-11", "2026-12", "2027-01"):
        await create_period(db_session, world.building, code)
    meters_now(local(2027, 1, 3))
    _, meter = await dashboard_meter(api_client, world.owner_14)
    assert meter["next_submission"]["period_code"] == "2026-12"
    assert meter["next_submission"]["due_date"] == "2027-01-04T21:59:59Z"
    meters_now(local(2027, 1, 5))
    _, meter = await dashboard_meter(api_client, world.owner_14)
    assert meter["next_submission"]["period_code"] == "2027-01"


# --- Estimates -----------------------------------------------------------------------------------


async def test_the_estimate_skips_meters_with_a_later_reading(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: MetersWorld,
    november: ReadingPeriod,
) -> None:
    # Apt 14 skipped October and already submitted November (from September's 115).
    await create_reading(db_session, world.meter_14, november, D("125.000"), D("115.000"))
    world.periods["2026-10"].status = PeriodStatus.REVIEW_BY_BOARD
    await db_session.flush()

    response = await api_client.post(
        "/api/v1/meters/periods/2026-10/estimate-missing", headers=as_user(world.chairman)
    )
    assert response.status_code == 200, response.text
    estimated = {row["meter_id"] for row in response.json()["estimated"]}
    assert str(world.meter_14.id) not in estimated
    assert {str(world.meter_2.id), str(world.meter_5.id)} <= estimated


# --- The opener ----------------------------------------------------------------------------------


@pytest.fixture
def opener(db_app: FastAPI) -> PeriodOpener:
    return db_app.state.meters_period_opener


async def test_the_opener_opens_the_new_month_once(
    opener: PeriodOpener,
    db_session: AsyncSession,
    world: MetersWorld,
    published_events: list[DomainEvent],
) -> None:
    before = await opener.tick(now=local(2026, 10, 31, 23, 50))
    assert before.opened == 0  # October exists already

    first = await opener.tick(now=local(2026, 11, 1, 0, 5))
    again = await opener.tick(now=local(2026, 11, 1, 0, 15))
    assert (first.opened, again.opened) == (1, 0)

    period = await db_session.scalar(
        select(ReadingPeriod).where(
            ReadingPeriod.building_id == world.building.id, ReadingPeriod.period_code == "2026-11"
        )
    )
    assert period is not None
    assert period.status == PeriodStatus.OPEN_FOR_RESIDENTS
    assert period.due_date == datetime(2026, 12, 4, 21, 59, 59, tzinfo=UTC)
    opened = [event for event in published_events if isinstance(event, ReadingPeriodOpened)]
    assert [(e.period_id, e.period_code) for e in opened] == [(period.id, "2026-11")]


async def test_the_opener_never_fills_in_missed_months(
    opener: PeriodOpener, db_session: AsyncSession, world: MetersWorld
) -> None:
    await opener.tick(now=local(2027, 2, 10))
    codes = set(
        await db_session.scalars(
            select(ReadingPeriod.period_code).where(ReadingPeriod.building_id == world.building.id)
        )
    )
    assert "2027-02" in codes
    assert not codes & {"2026-11", "2026-12", "2027-01"}


async def test_the_opener_opens_every_building_with_its_own_deadline(
    opener: PeriodOpener, db_session: AsyncSession, world: MetersWorld
) -> None:
    other = await create_building(db_session, "KÜ Other")
    other.reading_deadline_day = 10
    await db_session.flush()
    result = await opener.tick(now=local(2026, 11, 1, 1, 0))
    assert result.opened == 2
    due = await db_session.scalar(
        select(ReadingPeriod.due_date).where(
            ReadingPeriod.building_id == other.id, ReadingPeriod.period_code == "2026-11"
        )
    )
    assert due == datetime(2026, 12, 10, 21, 59, 59, tzinfo=UTC)


async def test_one_broken_building_never_stops_the_others(
    opener: PeriodOpener, db_session: AsyncSession, world: MetersWorld
) -> None:
    broken = await create_building(db_session, "KÜ Broken")
    broken.reading_deadline_day = 0  # no such day: opening its period fails
    # Commit the setup (releases the test's savepoint), so the broken building's rollback in the
    # shared test session cannot take the other buildings with it.
    await db_session.commit()
    building_id = world.building.id  # the failing building's rollback expires loaded objects
    result = await opener.tick(now=local(2026, 11, 1, 1, 0))
    assert (result.opened, result.failed) == (1, 1)
    opened = await db_session.scalar(
        select(ReadingPeriod.id).where(
            ReadingPeriod.building_id == building_id, ReadingPeriod.period_code == "2026-11"
        )
    )
    assert opened is not None


async def test_two_openers_at_once_open_the_month_once(database_url: str) -> None:
    async with scratch_database(database_url) as url:
        await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
        engine = build_engine(url)
        try:
            async with AsyncSession(engine, expire_on_commit=False) as session:
                await create_building(session)
                await session.commit()

            @asynccontextmanager
            async def factory():
                async with AsyncSession(engine, expire_on_commit=False) as session:
                    yield session

            bus = InMemoryEventBus()
            opener = PeriodOpener(lambda: factory, lambda: bus)
            now = local(2026, 11, 1, 0, 5)
            first, second = await asyncio.gather(opener.tick(now=now), opener.tick(now=now))

            assert first.opened + second.opened == 1
            assert first.failed + second.failed == 0
            async with AsyncSession(engine) as check:
                periods = await check.scalar(select(func.count()).select_from(ReadingPeriod))
                events = await check.scalar(
                    select(func.count())
                    .select_from(DomainEventRecord)
                    .where(DomainEventRecord.event_type == "ReadingPeriodOpened")
                )
            assert (periods, events) == (1, 1)
        finally:
            await engine.dispose()
