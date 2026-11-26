"""QA pass: a building filled by `import-building`, as the app then shows it and as its first
readings start the meters (docs/API.md section 1 "Filling the building of a new installation",
section 2 "A meter without a start", section 3 matrix and estimate-missing).

The building is laid out through the operator command itself (tests/core/test_filling.py
helpers), with the period of the meters clock open (2026-10, the clock on 15 October): the
contract says new meters are due a reading in the month they were imported in.
"""

from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.filling.layout import COLUMNS as ALL_COLUMNS
from src.modules.meters.models import MeterDevice, MeterReading, ReadingPeriod
from src.modules.meters.schemas import PeriodStatus, ResourceType
from src.modules.property.models import Apartment, Building, User
from src.modules.property.schemas import BuildingRole
from tests.core.test_filling import importing, real_installation  # noqa: F401
from tests.factories import create_building, create_membership, create_period, create_user
from tests.meters.test_monthly_periods import local

D = Decimal
API = "/api/v1/meters"
COLD, HOT = ResourceType.COLD_WATER, ResourceType.HOT_WATER
PRIVATE = ("Kadri Mets", "kadri.mets@example.ee", "+372 5000 0001", "Jaan Tamm", "jaan@example.ee")

COLUMNS = ALL_COLUMNS[:10]
FILLED_BUILDING = "\r\n".join(
    [
        ";".join(COLUMNS),  # a template before epic E14, without the kind column
        "1;1;2;48,445;COLD_WATER;;;Kitchen;;",
        "1;1;2;48,445;HOT_WATER;;;;;",
        "2;2;3;50,10;COLD_WATER;;;;0;",
        "2;2;3;50,10;HOT_WATER;;;;12,5;",
        "3;2;1;30;;;;;;",  # an apartment without meters
        "4;1;1;40;COLD_WATER;;;;;",  # a paper apartment: nobody in the app
        ";;;;COLD_WATER;;;Basement;;",
    ]
)


@dataclass
class Filled:
    building: Building
    chairman: User
    accountant: User
    board: User
    owner_1: User
    owner_2: User
    apartments: dict[str, Apartment]
    meters: dict[tuple[str | None, ResourceType], MeterDevice]


@pytest.fixture
async def filled(db_session: AsyncSession, real_installation, tmp_path: Path) -> Filled:  # noqa: F811
    building = await create_building(db_session)
    await create_period(db_session, building, "2026-10", PeriodStatus.OPEN_FOR_RESIDENTS)
    await db_session.commit()
    path = tmp_path / "building.csv"
    path.write_text("\ufeff" + FILLED_BUILDING + "\r\n", encoding="utf-8")
    code, printed = await importing(db_session, path)
    assert code == 0, printed

    apartments = {a.number: a for a in await db_session.scalars(select(Apartment))}
    number_of = {a.id: a.number for a in apartments.values()}
    meters = {
        (number_of.get(m.apartment_id), m.resource_type): m
        for m in await db_session.scalars(select(MeterDevice))
    }
    owner_1 = await create_user(
        db_session, building, "Kadri Mets", email="kadri.mets@example.ee", phone="+372 5000 0001"
    )
    owner_2 = await create_user(db_session, building, "Jaan Tamm", email="jaan@example.ee")
    await create_membership(db_session, owner_1, apartments["1"])
    await create_membership(db_session, owner_2, apartments["2"])
    return Filled(
        building=building,
        chairman=await create_user(db_session, building, "Chair", role=BuildingRole.CHAIRMAN),
        accountant=await create_user(db_session, building, "Acc", role=BuildingRole.ACCOUNTANT),
        board=await create_user(db_session, building, "Board", role=BuildingRole.BOARD),
        owner_1=owner_1,
        owner_2=owner_2,
        apartments=apartments,
        meters=meters,
    )


def as_user(user: User) -> dict[str, str]:
    return {"X-Demo-User-Id": str(user.id)}


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


async def move_on_to_november(
    db_session: AsyncSession, building: Building, november: PeriodStatus
) -> None:
    """October closed (LOCKED), November opened with the given status."""
    await db_session.execute(
        update(ReadingPeriod)
        .where(ReadingPeriod.building_id == building.id, ReadingPeriod.period_code == "2026-10")
        .values(status=PeriodStatus.LOCKED)
    )
    await create_period(db_session, building, "2026-11", november)


def assert_no_people(text: str) -> None:
    for private in PRIVATE:
        assert private not in text


# --- What the app shows after the import --------------------------------------------------------


async def test_imported_meters_are_due_in_the_month_they_were_imported_in(
    api_client: AsyncClient, filled: Filled
) -> None:
    response = await api_client.get(
        f"{API}/periods/2026-10/matrix", headers=as_user(filled.chairman)
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["period"]["status"] == "OPEN_FOR_RESIDENTS"
    rows = {row["apartment_number"]: row for row in body["apartments"]}
    assert sorted(rows) == ["1", "2", "4"]  # apartment 3 has no meters
    assert (rows["1"]["entrance"], rows["1"]["floor"], rows["1"]["status"]) == (1, 2, "MISSING")
    assert (rows["2"]["entrance"], rows["2"]["floor"]) == (2, 3)
    assert {m["location_label"] for m in rows["1"]["meters"]} == {"Kitchen", "Main"}
    assert all(m["status"] == "MISSING" for row in rows.values() for m in row["meters"])
    (master,) = body["master_meters"]
    assert (master["location_label"], master["unit"], master["status"]) == (
        "Basement",
        "m3",
        "MISSING",
    )
    assert (master["needs_start"], master["previous_value"], master["reading"]) == (
        True,
        None,
        None,
    )
    (balance,) = body["balances"]
    assert (balance["resource_type"], balance["master_total"], balance["starting_meters"]) == (
        "COLD_WATER",
        None,
        0,
    )
    assert_no_people(response.text)


async def test_the_building_header_counts_the_imported_apartments(
    api_client: AsyncClient, filled: Filled
) -> None:
    response = await api_client.get("/api/v1/property/building", headers=as_user(filled.owner_1))

    assert response.status_code == 200, response.text
    body = response.json()
    # 48.445 is stored rounded half up: 48.45 + 50.10 + 30.00 + 40.00.
    assert (body["apartment_count"], body["entrance_count"], body["heated_area_m2"]) == (
        4,
        2,
        "168.55",
    )
    assert_no_people(response.text)


async def test_a_resident_sees_the_imported_meters_and_whether_they_need_a_start(
    api_client: AsyncClient, filled: Filled
) -> None:
    first = await api_client.get(f"{API}/my-dashboard", headers=as_user(filled.owner_1))
    second = await api_client.get(f"{API}/my-dashboard", headers=as_user(filled.owner_2))

    assert first.status_code == second.status_code == 200
    assert first.json()["period"]["period_code"] == "2026-10"
    (apartment_1,) = first.json()["apartments"]
    assert apartment_1["apartment_number"] == "1"
    for meter in apartment_1["meters"]:
        assert (meter["needs_start"], meter["previous_value"], meter["serial_number"]) == (
            True,
            None,
            None,
        )
        assert meter["unit"] == "m3"
        upcoming = meter["next_submission"]
        assert (upcoming["period_code"], upcoming["final"], upcoming["needs_start"]) == (
            "2026-10",
            False,
            True,
        )
        assert (upcoming["previous_value"], upcoming["reading"]) == (None, None)
    (apartment_2,) = second.json()["apartments"]
    starts = {m["resource_type"]: m for m in apartment_2["meters"]}
    assert (starts["COLD_WATER"]["needs_start"], starts["COLD_WATER"]["previous_value"]) == (
        False,
        "0.000",
    )
    assert (starts["HOT_WATER"]["needs_start"], starts["HOT_WATER"]["previous_value"]) == (
        False,
        "12.500",
    )
    # Each resident sees only the own apartment, and nobody's name or contact.
    assert "Kadri Mets" not in second.text and "Jaan Tamm" not in first.text
    assert_no_people(first.text + second.text)


# --- The first reading --------------------------------------------------------------------------


async def test_an_initial_value_of_zero_is_a_known_start(
    api_client: AsyncClient, filled: Filled
) -> None:
    meter = filled.meters[("2", COLD)]

    with_bill = await submit(api_client, filled.owner_2, meter, "3.000", previous="1.000")
    plain = await submit(api_client, filled.owner_2, meter, "3.000")

    assert with_bill.status_code == 422
    assert with_bill.json()["error_code"] == "PREVIOUS_VALUE_NOT_ALLOWED"
    assert plain.status_code == 200, plain.text
    assert (plain.json()["consumption_delta"], plain.json()["previous_origin"]) == (
        "3.000",
        "INITIAL",
    )


async def test_the_bill_reading_may_equal_the_current_one(
    api_client: AsyncClient, filled: Filled
) -> None:
    response = await submit(
        api_client, filled.owner_1, filled.meters[("1", COLD)], "120.000", previous="120.000"
    )

    assert response.status_code == 200, response.text
    assert (response.json()["consumption_delta"], response.json()["previous_origin"]) == (
        "0.000",
        "SUBMITTED",
    )


@pytest.mark.parametrize("previous", ["119.0001", "-1.000"])
async def test_a_bill_reading_with_four_decimals_or_below_zero_is_refused(
    api_client: AsyncClient, db_session: AsyncSession, filled: Filled, previous: str
) -> None:
    meter = filled.meters[("1", COLD)]

    response = await submit(api_client, filled.owner_1, meter, "120.000", previous=previous)

    assert response.status_code == 422, response.text
    stored = await db_session.scalar(select(MeterReading).where(MeterReading.meter_id == meter.id))
    assert stored is None


async def test_a_start_may_be_corrected_below_itself(
    api_client: AsyncClient, filled: Filled
) -> None:
    meter = filled.meters[("1", COLD)]
    assert (await submit(api_client, filled.owner_1, meter, "125.000")).status_code == 200

    response = await submit(api_client, filled.owner_1, meter, "120.000")

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["value"], body["consumption_delta"], body["previous_origin"]) == (
        "120.000",
        "0.000",
        "START",
    )


async def test_a_correction_below_the_bill_reading_is_refused_with_that_reading(
    api_client: AsyncClient, filled: Filled
) -> None:
    meter = filled.meters[("1", COLD)]
    first = await submit(api_client, filled.owner_1, meter, "125.000", previous="120.000")
    assert first.status_code == 200, first.text

    response = await submit(api_client, filled.owner_1, meter, "119.000", previous="120.000")

    assert response.status_code == 422
    body = response.json()
    assert (body["error_code"], body["previous_value"], body["submitted_value"]) == (
        "READING_BELOW_PREVIOUS",
        "120.000",
        "119.000",
    )


async def test_the_board_corrects_a_residents_start_with_a_reason_and_it_stays(
    api_client: AsyncClient, filled: Filled
) -> None:
    meter = filled.meters[("1", COLD)]
    assert (await submit(api_client, filled.owner_1, meter, "125.000")).status_code == 200

    no_reason = await submit(api_client, filled.chairman, meter, "125.000", previous="121.000")
    corrected = await submit(
        api_client, filled.chairman, meter, "125.000", previous="121.000", reason="Last bill"
    )
    resident_again = await submit(api_client, filled.owner_1, meter, "126.000")

    assert no_reason.status_code == 422
    assert no_reason.json()["error_code"] == "REASON_REQUIRED"
    assert corrected.status_code == 200, corrected.text
    assert (
        corrected.json()["source"],
        corrected.json()["previous_origin"],
        corrected.json()["consumption_delta"],
    ) == ("ADMIN_OVERRIDE", "SUBMITTED", "4.000")
    assert resident_again.status_code == 409
    assert resident_again.json()["error_code"] == "READING_SET_BY_BOARD"


async def test_the_board_enters_the_start_of_a_paper_apartment(
    api_client: AsyncClient, filled: Filled
) -> None:
    meter = filled.meters[("4", COLD)]

    by_board_member = await submit(api_client, filled.board, meter, "333.000")
    by_chairman = await submit(api_client, filled.chairman, meter, "333.000")
    by_accountant = await submit(
        api_client, filled.accountant, meter, "333.000", previous="330.000", reason="Last bill"
    )

    assert by_board_member.status_code == 403
    assert by_board_member.json()["error_code"] == "FORBIDDEN"
    assert by_chairman.status_code == 200, by_chairman.text
    assert (
        by_chairman.json()["source"],
        by_chairman.json()["previous_origin"],
        by_chairman.json()["consumption_delta"],
    ) == ("ADMIN_OVERRIDE", "START", "0.000")
    assert by_accountant.status_code == 200, by_accountant.text
    assert by_accountant.json()["previous_origin"] == "SUBMITTED"


async def test_a_neighbour_cannot_start_another_apartments_meter(
    api_client: AsyncClient, filled: Filled
) -> None:
    response = await submit(api_client, filled.owner_2, filled.meters[("1", COLD)], "125.000")

    assert response.status_code == 404
    assert response.json()["error_code"] == "METER_NOT_FOUND"


# --- The next month -----------------------------------------------------------------------------


async def test_the_month_after_a_bill_start_counts_its_consumption(
    api_client: AsyncClient, db_session: AsyncSession, filled: Filled, meters_now
) -> None:
    meter = filled.meters[("1", COLD)]
    started = await submit(api_client, filled.owner_1, meter, "125.500", previous="120.000")
    assert started.status_code == 200, started.text
    await move_on_to_november(db_session, filled.building, PeriodStatus.OPEN_FOR_RESIDENTS)

    dashboard = await api_client.get(
        f"{API}/my-dashboard", params={"period_code": "2026-11"}, headers=as_user(filled.owner_1)
    )
    (kitchen,) = [
        m for m in dashboard.json()["apartments"][0]["meters"] if m["meter_id"] == str(meter.id)
    ]
    assert (kitchen["needs_start"], kitchen["previous_value"], kitchen["previous_delta"]) == (
        False,
        "125.500",
        "5.500",  # a start given with the bill is a consumption; only a START is none
    )

    meters_now(local(2026, 11, 15))
    with_bill = await submit(
        api_client, filled.owner_1, meter, "130.000", previous="125.500", period="2026-11"
    )
    plain = await submit(api_client, filled.owner_1, meter, "130.000", period="2026-11")

    assert with_bill.status_code == 422
    assert with_bill.json()["error_code"] == "PREVIOUS_VALUE_NOT_ALLOWED"
    assert plain.status_code == 200, plain.text
    assert (plain.json()["consumption_delta"], plain.json()["previous_origin"]) == (
        "4.500",
        "HISTORY",
    )


async def test_the_month_after_a_start_is_checked_against_the_meter_limit(
    api_client: AsyncClient, db_session: AsyncSession, filled: Filled, meters_now
) -> None:
    meter = filled.meters[("1", COLD)]  # an apartment cold water meter: limit 25 by default
    assert (await submit(api_client, filled.owner_1, meter, "125.000")).status_code == 200
    await move_on_to_november(db_session, filled.building, PeriodStatus.OPEN_FOR_RESIDENTS)
    meters_now(local(2026, 11, 15))

    response = await submit(api_client, filled.owner_1, meter, "160.000", period="2026-11")

    assert response.status_code == 409
    body = response.json()
    assert (body["error_code"], body["consumption_delta"], body["max_reasonable_delta"]) == (
        "ANOMALY_CONFIRMATION_STEP_1",
        "35.000",
        "25.000",
    )


async def test_an_estimate_skips_every_imported_meter_without_a_start_and_estimates_the_rest(
    api_client: AsyncClient, filled: Filled
) -> None:
    review = await api_client.patch(
        f"{API}/periods/2026-10/status",
        json={"status": "REVIEW_BY_BOARD"},
        headers=as_user(filled.chairman),
    )
    assert review.status_code == 200, review.text

    response = await api_client.post(
        f"{API}/periods/2026-10/estimate-missing", headers=as_user(filled.accountant)
    )

    assert response.status_code == 200, response.text
    body = response.json()
    without_start = {filled.meters[key].id for key in (("1", COLD), ("1", HOT), ("4", COLD))}
    assert set(body["skipped_without_start"]) == {str(i) for i in without_start}
    estimated = {
        row["meter_id"]: (row["value"], row["consumption_delta"]) for row in body["estimated"]
    }
    assert estimated == {
        str(filled.meters[("2", COLD)].id): ("0.000", "0.000"),
        str(filled.meters[("2", HOT)].id): ("12.500", "0.000"),
    }
    assert body["estimated_count"] == 2
    again = await api_client.post(
        f"{API}/periods/2026-10/estimate-missing", headers=as_user(filled.accountant)
    )
    assert again.json()["estimated_count"] == 0


async def test_after_a_start_the_next_estimate_continues_from_it(
    api_client: AsyncClient, db_session: AsyncSession, filled: Filled
) -> None:
    meter = filled.meters[("1", COLD)]
    assert (await submit(api_client, filled.owner_1, meter, "125.000")).status_code == 200
    await move_on_to_november(db_session, filled.building, PeriodStatus.REVIEW_BY_BOARD)

    response = await api_client.post(
        f"{API}/periods/2026-11/estimate-missing", headers=as_user(filled.chairman)
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert str(meter.id) not in body["skipped_without_start"]
    (row,) = [row for row in body["estimated"] if row["meter_id"] == str(meter.id)]
    assert (row["value"], row["consumption_delta"]) == ("125.000", "0.000")
    assert str(filled.meters[("1", HOT)].id) in body["skipped_without_start"]


async def test_the_matrix_counts_a_start_but_not_a_start_with_the_bill(
    api_client: AsyncClient, filled: Filled
) -> None:
    given = await submit(
        api_client, filled.owner_1, filled.meters[("1", COLD)], "125.500", previous="120.000"
    )
    started = await submit(api_client, filled.chairman, filled.meters[("4", COLD)], "333.000")
    assert given.status_code == started.status_code == 200

    response = await api_client.get(
        f"{API}/periods/2026-10/matrix", headers=as_user(filled.accountant)
    )

    body = response.json()
    (balance,) = body["balances"]
    assert balance["starting_meters"] == 1
    rows = {row["apartment_number"]: row for row in body["apartments"]}
    assert rows["1"]["status"] == "MISSING"  # its hot water meter has no reading yet
    assert rows["4"]["status"] == "SUBMITTED"
    origins = {
        m["location_label"]: m["reading"]["previous_origin"]
        for m in rows["1"]["meters"]
        if m["reading"]
    }
    assert origins == {"Kitchen": "SUBMITTED"}
    assert rows["4"]["meters"][0]["reading"]["previous_origin"] == "START"


async def test_a_building_meter_imported_without_a_start_balances_from_the_next_month(
    api_client: AsyncClient, db_session: AsyncSession, filled: Filled
) -> None:
    master = filled.meters[(None, COLD)]
    assert (await submit(api_client, filled.chairman, master, "5000.000")).status_code == 200
    october = await api_client.get(
        f"{API}/periods/2026-10/matrix", headers=as_user(filled.chairman)
    )
    (balance,) = october.json()["balances"]
    assert (balance["master_total"], balance["unallocated_loss"]) == (None, None)

    await move_on_to_november(db_session, filled.building, PeriodStatus.OPEN_FOR_RESIDENTS)
    nov = await submit(api_client, filled.chairman, master, "5100.000", period="2026-11")
    assert nov.status_code == 200, nov.text
    november = await api_client.get(
        f"{API}/periods/2026-11/matrix", headers=as_user(filled.chairman)
    )

    (balance,) = november.json()["balances"]
    assert balance["master_total"] == "100.000"
    (row,) = november.json()["master_meters"]
    assert (row["needs_start"], row["previous_value"]) == (False, "5000.000")


async def test_a_building_filled_on_the_2nd_starts_its_meters_in_last_month(
    api_client: AsyncClient, db_session: AsyncSession, filled: Filled, meters_now
) -> None:
    """The rule of the month (docs/API.md section 2): until October's due date a meter without
    an October reading submits for October, also one imported after October ended."""
    await create_period(db_session, filled.building, "2026-11", PeriodStatus.OPEN_FOR_RESIDENTS)
    meters_now(local(2026, 11, 2))

    response = await api_client.get(f"{API}/my-dashboard", headers=as_user(filled.owner_1))

    upcoming = [m["next_submission"] for m in response.json()["apartments"][0]["meters"]]
    assert [(u["period_code"], u["final"], u["needs_start"]) for u in upcoming] == [
        ("2026-10", True, True),
        ("2026-10", True, True),
    ]
