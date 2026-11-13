"""Consumption per month for charts (issue #133; fixture: tests/meters/conftest.py).

The world: apartment 14 used 4, 5, 6 m3 in 2026-07..09, apartment 2 used 3, 3, 3, apartment 5
has a meter without readings, the master meter used 10 a month; 2026-10 is open and empty.
Every apartment has 54.30 m2.
"""

import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import DEMO_USER_HEADER
from src.modules.meters.models import MeterDevice
from src.modules.meters.policies import (
    average_per_apartment,
    consumption_per_area,
    total_consumption,
)
from src.modules.meters.schemas import ReadingSource, ResourceType
from src.modules.property.models import Apartment, ApartmentMembership, User
from src.modules.property.schemas import BuildingRole
from tests.factories import (
    create_apartment,
    create_building,
    create_meter,
    create_period,
    create_reading,
    create_user,
)
from tests.meters.conftest import MetersWorld

D = Decimal
BUILDING_URL = "/api/v1/meters/consumption"


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


def apartment_url(apartment_id: uuid.UUID | None) -> str:
    return f"/api/v1/meters/apartments/{apartment_id}/consumption"


def series(body: dict, resource_type: str = "COLD_WATER") -> list[dict]:
    (found,) = [s for s in body["resources"] if s["resource_type"] == resource_type]
    return found["months"]


# --- One apartment ---------------------------------------------------------------------------


async def test_an_apartments_consumption_per_month_oldest_first(
    api_client: AsyncClient, world: MetersWorld
) -> None:
    for viewer in (world.owner_14, world.chairman, world.board, world.accountant):
        response = await api_client.get(
            apartment_url(world.meter_14.apartment_id), headers=as_user(viewer)
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["apartment_number"] == "14"
        assert [(p["period_code"], p["status"]) for p in body["periods"]] == [
            ("2026-07", "LOCKED"),
            ("2026-08", "LOCKED"),
            ("2026-09", "LOCKED"),
            ("2026-10", "OPEN_FOR_RESIDENTS"),
        ]
        (only,) = body["resources"]
        assert (only["resource_type"], only["unit"]) == ("COLD_WATER", "m3")
        assert [(m["period_code"], m["consumption"], m["estimated"]) for m in only["months"]] == [
            ("2026-07", "4.000", False),
            ("2026-08", "5.000", False),
            ("2026-09", "6.000", False),
            ("2026-10", None, False),  # not submitted yet: a gap, never 0
        ]


async def test_a_replaced_meter_counts_with_both_readings_and_estimates_are_marked(
    api_client: AsyncClient, db_session: AsyncSession, world: MetersWorld
) -> None:
    apartment_id = world.meter_14.apartment_id
    replacement = await create_meter(db_session, world.building, None)
    hot = await create_meter(db_session, world.building, None, ResourceType.HOT_WATER)
    await db_session.execute(
        update(MeterDevice)
        .where(MeterDevice.id.in_([replacement.id, hot.id]))
        .values(apartment_id=apartment_id)
    )
    await db_session.execute(
        update(MeterDevice).where(MeterDevice.id == world.meter_14.id).values(is_active=False)
    )
    await create_reading(
        db_session,
        replacement,
        world.periods["2026-09"],
        D("1.500"),
        D("0.000"),
        source=ReadingSource.AUTO_ESTIMATED,
    )

    body = (
        await api_client.get(apartment_url(apartment_id), headers=as_user(world.owner_14))
    ).json()

    assert [s["resource_type"] for s in body["resources"]] == ["COLD_WATER", "HOT_WATER"]
    assert [(m["consumption"], m["estimated"]) for m in series(body)] == [
        ("4.000", False),
        ("5.000", False),
        ("7.500", True),  # 6.000 on the old meter + 1.500 estimated on the new one
        (None, False),
    ]
    assert [m["consumption"] for m in series(body, "HOT_WATER")] == [None] * 4


async def test_a_resident_sees_only_their_own_apartments_consumption(
    api_client: AsyncClient, db_session: AsyncSession, world: MetersWorld
) -> None:
    other = await create_building(db_session, "Other Association")
    foreign = await create_apartment(db_session, other, "1")

    for user, apartment_id in (
        (world.tenant_2, world.meter_14.apartment_id),
        (world.owner_5, world.meter_2.apartment_id),
        (world.chairman, foreign.id),
        (world.chairman, uuid.uuid4()),
    ):
        response = await api_client.get(apartment_url(apartment_id), headers=as_user(user))
        assert response.status_code == 404
        assert response.json()["error_code"] == "APARTMENT_NOT_FOUND"


async def test_months_picks_the_latest_periods(api_client: AsyncClient, world: MetersWorld) -> None:
    url = apartment_url(world.meter_14.apartment_id)

    two = (await api_client.get(url, params={"months": 2}, headers=as_user(world.owner_14))).json()
    many = await api_client.get(url, params={"months": 24}, headers=as_user(world.owner_14))

    assert [p["period_code"] for p in two["periods"]] == ["2026-09", "2026-10"]
    assert [m["period_code"] for m in series(two)] == ["2026-09", "2026-10"]
    assert len(many.json()["periods"]) == 4  # the building has only four periods
    for months in ("0", "25", "-1", "x", "1.5"):
        for target in (url, BUILDING_URL):
            response = await api_client.get(
                target, params={"months": months}, headers=as_user(world.chairman)
            )
            assert response.status_code == 422, (target, months)
            assert response.json()["error_code"] == "VALIDATION_ERROR"


async def test_the_apartment_payload_has_no_people(
    api_client: AsyncClient, world: MetersWorld
) -> None:
    raw = (
        await api_client.get(
            apartment_url(world.meter_14.apartment_id), headers=as_user(world.chairman)
        )
    ).text

    for secret in ("Ivan", "Petrov", "+372 5555 1234", str(world.owner_14.id)):
        assert secret not in raw


# --- The building ----------------------------------------------------------------------------


async def test_the_building_totals_and_averages_leave_the_master_meter_out(
    api_client: AsyncClient, world: MetersWorld
) -> None:
    for viewer in (world.chairman, world.board, world.accountant):
        response = await api_client.get(BUILDING_URL, headers=as_user(viewer))
        assert response.status_code == 200, response.text
        body = response.json()
        assert [p["period_code"] for p in body["periods"]] == [
            "2026-07",
            "2026-08",
            "2026-09",
            "2026-10",
        ]
        (only,) = body["resources"]
        assert (only["resource_type"], only["unit"]) == ("COLD_WATER", "m3")
        assert [
            (
                m["total"],
                m["apartments_counted"],
                m["average_per_apartment"],
                m["average_per_m2"],
                m["estimated_readings"],
            )
            for m in only["months"]
        ] == [
            ("7.000", 2, "3.500", "0.0645", 0),  # 7 / 108.60 m2 = 0.06445...
            ("8.000", 2, "4.000", "0.0737", 0),
            ("9.000", 2, "4.500", "0.0829", 0),
            (None, 0, None, None, 0),  # a gap; the master's 10 m3 a month are not in here
        ]


async def test_averages_count_only_the_apartments_with_a_reading(
    api_client: AsyncClient, db_session: AsyncSession, world: MetersWorld
) -> None:
    await create_reading(
        db_session,
        world.meter_5,
        world.periods["2026-10"],
        D("12.000"),
        D("10.000"),
        source=ReadingSource.AUTO_ESTIMATED,
    )
    # A master meter of another resource gives no series of its own.
    await create_meter(db_session, world.building, None, ResourceType.HEAT)

    october = series((await api_client.get(BUILDING_URL, headers=as_user(world.chairman))).json())[
        -1
    ]
    assert october == {
        "period_code": "2026-10",
        "total": "2.000",
        "apartments_counted": 1,
        "average_per_apartment": "2.000",
        "average_per_m2": "0.0368",  # 2 / 54.30
        "estimated_readings": 1,
    }

    await db_session.execute(
        update(Apartment)
        .where(Apartment.id == world.meter_5.apartment_id)
        .values(area_m2=D("0.00"))
    )
    body = (await api_client.get(BUILDING_URL, headers=as_user(world.chairman))).json()
    assert [s["resource_type"] for s in body["resources"]] == ["COLD_WATER"]
    assert series(body)[-1]["average_per_m2"] is None  # no recorded area to divide by


async def test_residents_never_get_building_averages(
    api_client: AsyncClient, world: MetersWorld
) -> None:
    for resident in (world.owner_14, world.tenant_2, world.owner_5):
        response = await api_client.get(BUILDING_URL, headers=as_user(resident))
        assert response.status_code == 403
        assert response.json()["error_code"] == "FORBIDDEN"


async def test_buildings_never_mix(
    api_client: AsyncClient, db_session: AsyncSession, world: MetersWorld
) -> None:
    other = await create_building(db_session, "Other Association")
    other_chairman = await create_user(db_session, other, "Kalle Kask", role=BuildingRole.CHAIRMAN)

    empty = (await api_client.get(BUILDING_URL, headers=as_user(other_chairman))).json()
    assert empty == {"periods": [], "resources": []}

    # The other building's readings never reach this building's totals.
    period = await create_period(db_session, other, "2026-09", world.periods["2026-09"].status)
    flat = await create_apartment(db_session, other, "1")
    meter = await create_meter(db_session, other, flat)
    await create_reading(db_session, meter, period, D("20.000"), D("0.000"))
    ours = series((await api_client.get(BUILDING_URL, headers=as_user(world.chairman))).json())
    assert ours[2]["total"] == "9.000" and ours[2]["apartments_counted"] == 2
    theirs = series((await api_client.get(BUILDING_URL, headers=as_user(other_chairman))).json())
    assert [(m["period_code"], m["total"]) for m in theirs] == [("2026-09", "20.000")]


async def test_two_meters_corrections_and_units_on_both_endpoints(
    api_client: AsyncClient, db_session: AsyncSession, world: MetersWorld
) -> None:
    apartment_14 = world.meter_14.apartment_id
    kitchen = await create_meter(db_session, world.building, None)
    heat_kwh = await create_meter(db_session, world.building, None, ResourceType.HEAT)
    heat_mwh = await create_meter(db_session, world.building, None, ResourceType.HEAT)
    await db_session.execute(
        update(MeterDevice)
        .where(MeterDevice.id.in_([kitchen.id, heat_kwh.id, heat_mwh.id]))
        .values(apartment_id=apartment_14)
    )
    await db_session.execute(
        update(MeterDevice).where(MeterDevice.id == heat_kwh.id).values(unit="kWh")
    )
    await db_session.execute(
        update(MeterDevice).where(MeterDevice.id == heat_mwh.id).values(unit="MWh")
    )
    october = world.periods["2026-10"]
    # The kitchen meter: an estimate, then the bathroom meter corrected downwards.
    await create_reading(
        db_session, kitchen, october, D("2.000"), D("0.000"), source=ReadingSource.AUTO_ESTIMATED
    )
    await create_reading(db_session, world.meter_14, october, D("114.000"), D("115.000"))
    await create_reading(db_session, heat_kwh, october, D("150.000"), D("0.000"))

    flat = (
        await api_client.get(apartment_url(apartment_14), headers=as_user(world.owner_14))
    ).json()
    building = (await api_client.get(BUILDING_URL, headers=as_user(world.board))).json()

    assert [(s["resource_type"], s["unit"]) for s in flat["resources"]] == [
        ("COLD_WATER", "m3"),
        ("HEAT", "MWh"),
        ("HEAT", "kWh"),
    ]
    assert series(flat)[-1] == {"period_code": "2026-10", "consumption": "1.000", "estimated": True}
    by_unit = {s["unit"]: s["months"][-1]["consumption"] for s in flat["resources"][1:]}
    assert by_unit == {"MWh": None, "kWh": "150.000"}
    assert series(building)[-1] == {
        "period_code": "2026-10",
        "total": "1.000",  # -1.000 + 2.000: a correction is summed as it is
        "apartments_counted": 1,  # two meters, one apartment
        "average_per_apartment": "1.000",
        "average_per_m2": "0.0184",  # 1 / 54.30
        "estimated_readings": 1,
    }
    assert [(s["resource_type"], s["unit"]) for s in building["resources"]] == [
        ("COLD_WATER", "m3"),
        ("HEAT", "MWh"),
        ("HEAT", "kWh"),
    ]


async def test_a_former_resident_loses_the_chart(
    api_client: AsyncClient, db_session: AsyncSession, world: MetersWorld
) -> None:
    await db_session.execute(
        update(ApartmentMembership)
        .where(ApartmentMembership.id == world.tenant_2_membership.id)
        .values(ended_at=datetime.now(UTC) - timedelta(minutes=1))
    )

    response = await api_client.get(
        apartment_url(world.meter_2.apartment_id), headers=as_user(world.tenant_2)
    )

    assert response.status_code == 404
    assert response.json()["error_code"] == "APARTMENT_NOT_FOUND"


# --- The arithmetic (pure) ---------------------------------------------------------------------


def test_totals_are_exact_and_never_negative_zero() -> None:
    assert str(total_consumption([])) == "0.000"
    assert str(total_consumption([D("0.100"), D("0.200")])) == "0.300"
    assert str(total_consumption([D("1.000"), D("-1.000")])) == "0.000"
    assert str(total_consumption([D("-2.500"), D("1.000")])) == "-1.500"  # a correction


def test_averages_round_half_up() -> None:
    assert str(average_per_apartment(D("10.000"), 3)) == "3.333"
    assert str(average_per_apartment(D("0.005"), 2)) == "0.003"  # 0.0025 -> 0.003
    assert average_per_apartment(D("5.000"), 0) is None
    assert str(consumption_per_area(D("1.000"), D("8.00"))) == "0.1250"
    assert str(consumption_per_area(D("0.001"), D("20.00"))) == "0.0001"  # 0.00005 -> 0.0001
    assert str(consumption_per_area(D("-0.001"), D("30.00"))) == "0.0000"  # never -0
    assert consumption_per_area(D("1.000"), D("0.00")) is None


def test_floats_never_enter_the_arithmetic() -> None:
    with pytest.raises(TypeError):
        total_consumption([1.5])  # type: ignore[list-item]
    with pytest.raises(TypeError):
        average_per_apartment(1.5, 2)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        consumption_per_area(D("1.000"), 54.3)  # type: ignore[arg-type]
