"""A meter without a start (epic E13 R3b, docs/API.md section 2 "A meter without a start").

A meter imported without an initial value has no known start until its first reading: the
resident may give the reading of the last bill (SUBMITTED), else the first reading starts the
meter (START: no consumption, no anomaly check, never counted in averages or consumption).
Fixture: tests/meters/conftest.py (2026-07..09 LOCKED, 2026-10 OPEN, the clock on 15 October).
"""

from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import DEMO_USER_HEADER
from src.modules.meters.models import MeterDevice, MeterReading, ReadingPeriod
from src.modules.meters.schemas import PeriodStatus, PreviousOrigin
from src.modules.property.models import User
from tests.factories import (
    create_apartment,
    create_membership,
    create_meter,
    create_period,
    create_user,
)
from tests.meters.conftest import MetersWorld

D = Decimal
API = "/api/v1/meters"


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


async def submit(
    client: AsyncClient,
    user: User,
    meter: MeterDevice,
    value: str,
    previous: str | None = None,
    period: str = "2026-10",
    **extra,
):
    body = {"meter_id": str(meter.id), "period_code": period, "value": value, **extra}
    if previous is not None:
        body["previous_value"] = previous
    return await client.post(f"{API}/readings", json=body, headers=as_user(user))


@pytest.fixture
async def fresh(db_session: AsyncSession, world: MetersWorld) -> tuple[User, MeterDevice]:
    """Apartment 7 with a cold water meter imported without an initial value and its owner."""
    apartment = await create_apartment(db_session, world.building, "7", entrance=1, floor=3)
    owner = await create_user(db_session, world.building, "Kadri Mets")
    await create_membership(db_session, owner, apartment)
    meter = await create_meter(
        db_session, world.building, apartment, initial_value=None, serial_number=None
    )
    return owner, meter


async def reading_of(db_session: AsyncSession, meter: MeterDevice) -> MeterReading:
    return await db_session.scalar(
        select(MeterReading)
        .where(MeterReading.meter_id == meter.id)
        .execution_options(populate_existing=True)
    )


async def test_the_dashboard_asks_for_a_start(api_client: AsyncClient, fresh) -> None:
    owner, meter = fresh

    response = await api_client.get(f"{API}/my-dashboard", headers=as_user(owner))

    assert response.status_code == 200, response.text
    (dashboard_meter,) = response.json()["apartments"][0]["meters"]
    assert dashboard_meter["serial_number"] is None
    assert dashboard_meter["previous_value"] is None
    assert dashboard_meter["needs_start"] is True
    assert dashboard_meter["next_submission"]["previous_value"] is None
    assert dashboard_meter["next_submission"]["needs_start"] is True


async def test_the_reading_of_the_last_bill_gives_the_first_consumption(
    api_client: AsyncClient, db_session: AsyncSession, fresh
) -> None:
    owner, meter = fresh

    response = await submit(api_client, owner, meter, "125.500", previous="120.000")

    assert response.status_code == 200, response.text
    assert response.json()["consumption_delta"] == "5.500"
    assert response.json()["previous_origin"] == "SUBMITTED"
    reading = await reading_of(db_session, meter)
    assert reading.previous_value == D("120.000")
    assert reading.previous_origin == PreviousOrigin.SUBMITTED


async def test_without_the_bill_the_first_reading_starts_the_meter(
    api_client: AsyncClient, db_session: AsyncSession, fresh
) -> None:
    owner, meter = fresh

    # Far above max_monthly_delta, yet no popup: a start has no consumption to check.
    response = await submit(api_client, owner, meter, "98765.000")

    assert response.status_code == 200, response.text
    assert response.json()["consumption_delta"] == "0.000"
    assert response.json()["previous_origin"] == "START"
    assert response.json()["is_anomaly_confirmed"] is False
    reading = await reading_of(db_session, meter)
    assert reading.previous_value == D("98765.000")


async def test_a_given_start_still_goes_through_the_anomaly_check(
    api_client: AsyncClient, fresh
) -> None:
    owner, meter = fresh

    response = await submit(api_client, owner, meter, "500.000", previous="100.000")

    assert response.status_code == 409
    assert response.json()["error_code"] == "ANOMALY_CONFIRMATION_STEP_1"


async def test_the_bill_reading_may_not_be_above_the_current_one(
    api_client: AsyncClient, fresh
) -> None:
    owner, meter = fresh

    response = await submit(api_client, owner, meter, "100.000", previous="120.000")

    assert response.status_code == 422
    assert response.json()["error_code"] == "READING_BELOW_PREVIOUS"


async def test_a_previous_value_is_refused_where_the_start_is_known(
    api_client: AsyncClient, world: MetersWorld
) -> None:
    # meter_14 has readings in earlier periods; meter_5 has an initial value but no reading.
    with_history = await submit(api_client, world.owner_14, world.meter_14, "120.000", "115.000")
    with_initial = await submit(api_client, world.owner_5, world.meter_5, "20.000", "10.000")

    for response in (with_history, with_initial):
        assert response.status_code == 422
        assert response.json()["error_code"] == "PREVIOUS_VALUE_NOT_ALLOWED"


async def test_the_first_reading_can_be_corrected_with_the_bill(
    api_client: AsyncClient, db_session: AsyncSession, fresh
) -> None:
    owner, meter = fresh
    assert (await submit(api_client, owner, meter, "125.000")).status_code == 200

    response = await submit(api_client, owner, meter, "125.000", previous="121.000")

    assert response.status_code == 200, response.text
    assert response.json()["previous_origin"] == "SUBMITTED"
    assert response.json()["consumption_delta"] == "4.000"

    # And back again: dropping the bill's reading makes it a start once more.
    response = await submit(api_client, owner, meter, "125.000")
    assert response.json()["previous_origin"] == "START"
    assert (await reading_of(db_session, meter)).consumption_delta == D("0.000")


async def test_the_board_may_give_the_start_too(
    api_client: AsyncClient, world: MetersWorld, fresh
) -> None:
    _, meter = fresh

    response = await submit(api_client, world.chairman, meter, "130.000", previous="124.000")

    assert response.status_code == 200, response.text
    assert response.json()["source"] == "ADMIN_OVERRIDE"
    assert response.json()["previous_origin"] == "SUBMITTED"


async def test_the_month_after_a_start_counts_from_it_but_no_average_yet(
    api_client: AsyncClient, db_session: AsyncSession, world: MetersWorld, fresh
) -> None:
    owner, meter = fresh
    assert (await submit(api_client, owner, meter, "125.000")).status_code == 200
    await db_session.execute(
        update(ReadingPeriod)
        .where(ReadingPeriod.id == world.periods["2026-10"].id)
        .values(status=PeriodStatus.LOCKED)
    )
    await create_period(db_session, world.building, "2026-11", PeriodStatus.OPEN_FOR_RESIDENTS)

    response = await api_client.get(
        f"{API}/my-dashboard", params={"period_code": "2026-11"}, headers=as_user(owner)
    )

    (dashboard_meter,) = response.json()["apartments"][0]["meters"]
    assert dashboard_meter["needs_start"] is False
    assert dashboard_meter["previous_value"] == "125.000"
    # The start is no consumption: neither the average nor last month's consumption.
    assert dashboard_meter["average_delta"] is None
    assert dashboard_meter["previous_delta"] is None


async def test_an_estimate_skips_a_meter_without_a_start(
    api_client: AsyncClient, db_session: AsyncSession, world: MetersWorld, fresh
) -> None:
    _, meter = fresh
    await db_session.execute(
        update(ReadingPeriod)
        .where(ReadingPeriod.id == world.periods["2026-10"].id)
        .values(status=PeriodStatus.REVIEW_BY_BOARD)
    )

    response = await api_client.post(
        f"{API}/periods/2026-10/estimate-missing", headers=as_user(world.chairman)
    )

    assert response.status_code == 200, response.text
    assert response.json()["skipped_without_start"] == [str(meter.id)]
    assert str(meter.id) not in {row["meter_id"] for row in response.json()["estimated"]}
    assert await reading_of(db_session, meter) is None


async def test_the_matrix_counts_starting_meters_and_shows_the_origin(
    api_client: AsyncClient, world: MetersWorld, fresh
) -> None:
    owner, meter = fresh
    assert (await submit(api_client, owner, meter, "125.000")).status_code == 200

    response = await api_client.get(
        f"{API}/periods/2026-10/matrix", headers=as_user(world.chairman)
    )

    body = response.json()
    (balance,) = body["balances"]
    assert balance["starting_meters"] == 1
    (row,) = [row for row in body["apartments"] if row["apartment_number"] == "7"]
    assert row["meters"][0]["reading"]["previous_origin"] == "START"
    assert body["master_meters"][0]["needs_start"] is False


async def test_a_start_shows_no_consumption_in_the_chart(
    api_client: AsyncClient, world: MetersWorld, fresh
) -> None:
    owner, meter = fresh
    assert (await submit(api_client, owner, meter, "125.000")).status_code == 200
    apartment_id = meter.apartment_id

    response = await api_client.get(
        f"{API}/apartments/{apartment_id}/consumption", headers=as_user(owner)
    )

    (series,) = response.json()["resources"]
    october = next(month for month in series["months"] if month["period_code"] == "2026-10")
    assert october["consumption"] is None


async def test_the_export_carries_the_origin_and_an_empty_serial(
    api_client: AsyncClient, world: MetersWorld, fresh
) -> None:
    owner, meter = fresh
    assert (await submit(api_client, owner, meter, "125.000")).status_code == 200

    response = await api_client.get(
        f"{API}/periods/2026-10/export-csv", headers=as_user(world.chairman)
    )

    assert response.status_code == 200, response.text
    lines = response.text.lstrip("﻿").splitlines()
    assert lines[0].endswith(",previous_origin")
    (row,) = [line for line in lines if str(meter.id) in line]
    cells = row.split(",")
    assert cells[5] == ""  # serial_number not set yet
    assert cells[-1] == "START"


async def test_after_the_first_reading_the_start_may_still_be_corrected(
    api_client: AsyncClient, fresh
) -> None:
    owner, meter = fresh
    assert (await submit(api_client, owner, meter, "125.000")).status_code == 200

    response = await api_client.get(f"{API}/my-dashboard", headers=as_user(owner))

    (dashboard_meter,) = response.json()["apartments"][0]["meters"]
    assert dashboard_meter["needs_start"] is True  # no reading BEFORE this month yet
    assert dashboard_meter["previous_value"] == "125.000"  # the start's own value
    assert dashboard_meter["next_submission"]["needs_start"] is True


async def test_a_late_start_resent_with_the_bill_is_no_silent_retry(
    api_client: AsyncClient, db_session: AsyncSession, world: MetersWorld, fresh, meters_now
) -> None:
    from tests.meters.test_monthly_periods import local

    owner, meter = fresh
    meters_now(local(2026, 11, 3))  # October's reading is a late, final one
    await create_period(db_session, world.building, "2026-11", PeriodStatus.OPEN_FOR_RESIDENTS)
    assert (await submit(api_client, owner, meter, "125.000")).status_code == 200
    meters_now(local(2026, 11, 20))  # the target moved on to November

    response = await submit(api_client, owner, meter, "125.000", previous="121.000")

    # Not "unchanged": adding the bill's reading is a change, here of a closed month's reading.
    assert response.status_code == 409
    assert response.json()["error_code"] == "WRONG_PERIOD"


async def test_a_building_meter_without_a_start_leaves_the_balance_open(
    api_client: AsyncClient, db_session: AsyncSession, world: MetersWorld
) -> None:
    master = await create_meter(
        db_session, world.building, None, initial_value=None, max_monthly_delta=D("500.000")
    )
    matrix = await api_client.get(f"{API}/periods/2026-10/matrix", headers=as_user(world.chairman))
    (row,) = [m for m in matrix.json()["master_meters"] if m["meter_id"] == str(master.id)]
    assert (row["needs_start"], row["previous_value"]) == (True, None)

    for meter, value in ((world.master, "1040.000"), (master, "500.000")):
        assert (await submit(api_client, world.chairman, meter, value)).status_code == 200
    matrix = await api_client.get(f"{API}/periods/2026-10/matrix", headers=as_user(world.chairman))

    (balance,) = matrix.json()["balances"]
    assert (balance["master_total"], balance["unallocated_loss"]) == (None, None)


async def test_a_start_is_left_out_of_the_building_consumption(
    api_client: AsyncClient, world: MetersWorld, fresh
) -> None:
    owner, meter = fresh
    assert (await submit(api_client, owner, meter, "98765.000")).status_code == 200

    response = await api_client.get(f"{API}/consumption", headers=as_user(world.chairman))

    (series,) = response.json()["resources"]
    october = next(month for month in series["months"] if month["period_code"] == "2026-10")
    assert october["total"] is None  # nobody else submitted for October; the start counts not


async def test_the_matrix_tells_the_board_which_apartment_meters_need_a_start(
    api_client: AsyncClient, world: MetersWorld, fresh
) -> None:
    _, meter = fresh

    response = await api_client.get(
        f"{API}/periods/2026-10/matrix", headers=as_user(world.chairman)
    )

    cells = {
        cell["meter_id"]: cell for row in response.json()["apartments"] for cell in row["meters"]
    }
    assert (cells[str(meter.id)]["needs_start"], cells[str(meter.id)]["previous_value"]) == (
        True,
        None,
    )
    assert (
        cells[str(world.meter_14.id)]["needs_start"],
        cells[str(world.meter_14.id)]["previous_value"],
    ) == (
        False,
        "115.000",
    )


async def test_a_reading_written_without_its_origin_counts_as_history(
    db_session: AsyncSession, world: MetersWorld
) -> None:
    """What a rollback to the release before 031 does: it inserts without previous_origin."""
    from sqlalchemy import text

    await db_session.execute(
        text(
            "INSERT INTO meters_readings (id, building_id, meter_id, period_id, value, "
            "previous_value, consumption_delta, source) VALUES (gen_random_uuid(), :building, "
            ":meter, :period, 120, 115, 5, 'RESIDENT')"
        ),
        {
            "building": world.building.id,
            "meter": world.meter_14.id,
            "period": world.periods["2026-10"].id,
        },
    )

    assert (await reading_of(db_session, world.meter_14)).previous_origin is not None
    origin = await db_session.scalar(
        text("SELECT previous_origin FROM meters_readings WHERE period_id = :period"),
        {"period": world.periods["2026-10"].id},
    )
    assert origin == "HISTORY"
