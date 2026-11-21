"""Filling the building of a new installation (epic E13 R3; docs/API.md section 1, "Filling
the building of a new installation"): the layout rules, the CSV template, the draft and the two
operator commands against a real database."""

import io
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import Settings, get_settings
from src.core.filling.__main__ import NO_REGISTER_BLOCK, building_template, import_building
from src.core.filling.draft import (
    DraftError,
    from_count,
    from_register,
    parse_entrances,
    parse_meters,
    template_rows,
)
from src.core.filling.layout import COLUMNS, RowInput, check_layout, unguard
from src.core.filling.template import TemplateError, TemplateRow, read_template, write_template
from src.core.instance import InstanceRecord
from src.modules.meters.models import MeterDevice
from src.modules.meters.schemas import MeterUnit, ResourceType
from src.modules.property.models import Apartment, Building, BuildingRegistryRecord
from src.modules.property.registry import dump_block
from src.plugins.countries.ee.building_registry import EEBuildingRegistry
from src.plugins.countries.ee.facts import EEBuilding, EEBuildingFacts, EESource, EEUnit, UnitKind
from src.plugins.registry import ApartmentDraft, DraftApartment, LeftOutPart
from tests.factories import create_apartment, create_building

D = Decimal


def rows(*cells: dict[str, str]) -> list[RowInput]:
    return [RowInput(ref=index, cells=row) for index, row in enumerate(cells, start=2)]


def apartment(number: str, entrance: str = "1", area: str = "48,20", **meter: str) -> dict:
    return {"apartment": number, "entrance": entrance, "area_m2": area, **meter}


# --- The layout rules ---------------------------------------------------------------------------


def test_a_layout_takes_defaults_for_every_optional_meter_column() -> None:
    layout, problems = check_layout(
        rows(
            apartment("1", resource="COLD_WATER"),
            apartment("1", resource="HOT_WATER", location="Kitchen", initial_value="12,5"),
            apartment("2", area="54.304", floor="-1"),  # no meters; the area is rounded
            {"resource": "COLD_WATER", "location": "Basement"},
            {"resource": "ELECTRICITY", "unit": "MWh"},
        )
    )

    assert problems == []
    assert [(a.number, a.entrance, a.floor, a.area_m2) for a in layout.apartments] == [
        ("1", 1, 1, D("48.20")),
        ("2", 1, -1, D("54.30")),
    ]
    assert layout.rounded_areas == 1
    assert [
        (m.apartment, m.resource, m.unit, m.location, m.serial_number, m.initial_value)
        for m in layout.meters
    ] == [
        ("1", ResourceType.COLD_WATER, MeterUnit.M3, "Main", None, None),
        ("1", ResourceType.HOT_WATER, MeterUnit.M3, "Kitchen", None, D("12.500")),
        (None, ResourceType.COLD_WATER, MeterUnit.M3, "Basement", None, None),
        (None, ResourceType.ELECTRICITY, MeterUnit.MWH, "Main", None, None),
    ]
    assert [m.max_monthly_delta for m in layout.meters] == [
        D("25.000"),  # apartment cold water
        D("15.000"),  # apartment hot water
        D("500.000"),  # building cold water
        D("20.000"),  # building electricity in MWh: 20000 kWh / 1000
    ]
    assert (layout.apartment_meters, layout.building_meters) == (2, 2)


@pytest.mark.parametrize(
    ("row", "column", "message"),
    [
        (apartment("1", entrance="", resource="COLD_WATER"), "entrance", "required"),
        (apartment("1", entrance="0", resource="COLD_WATER"), "entrance", "from 1 to 99"),
        (apartment("1", area="", resource="COLD_WATER"), "area_m2", "required"),
        (apartment("1", area="1.200,5", resource="COLD_WATER"), "area_m2", "decimal point"),
        (apartment("1", area="0,001", resource="COLD_WATER"), "area_m2", "greater than 0"),
        (apartment("1", floor="2.5", resource="COLD_WATER"), "floor", "whole number"),
        (apartment("1", resource="WATER"), "resource", "one of"),
        (apartment("1", resource="COLD_WATER", unit="kWh"), "unit", "allows m3"),
        (apartment("1", resource="COLD_WATER", initial_value="1,2345"), "initial_value", "3 dec"),
        (apartment("1", resource="COLD_WATER", max_monthly_delta="0"), "max_monthly_delta", "> 0"),
        (apartment("1", serial_number="SN-1"), "resource", "required"),
        (apartment("1\n2", resource="COLD_WATER"), "apartment", "one line"),
        (apartment("1" * 33, resource="COLD_WATER"), "apartment", "at most 32"),
        ({"area_m2": "10", "resource": "COLD_WATER"}, "area_m2", "empty for a building meter"),
        ({"location": "Basement"}, "resource", "required"),
    ],
)
def test_a_wrong_cell_is_a_problem_of_its_row(row: dict, column: str, message: str) -> None:
    _, problems = check_layout(rows(apartment("9"), row))

    assert len(problems) == 1
    (problem,) = problems
    assert (problem.ref, problem.column) == (3, column)
    expected = message.replace("> 0", "greater than 0").replace("3 dec", "3 decimal places")
    assert expected in problem.message


def test_two_meters_of_a_type_at_one_place_need_different_locations() -> None:
    _, problems = check_layout(
        rows(
            apartment("1", resource="COLD_WATER"),
            apartment("1", resource="COLD_WATER", location="main"),  # "Main" is the default
        )
    )

    assert [(p.ref, p.column) for p in problems] == [(3, "location")]
    assert "see row 2" in problems[0].message


def test_the_rows_of_one_apartment_must_agree() -> None:
    _, problems = check_layout(
        rows(apartment("1", resource="COLD_WATER"), apartment("1", "2", resource="HOT_WATER"))
    )

    assert [(p.ref, p.column) for p in problems] == [(3, "apartment")]
    assert "differ from row 2" in problems[0].message


def test_a_layout_without_apartments_is_refused() -> None:
    _, problems = check_layout(rows({"resource": "COLD_WATER"}))

    assert [(p.ref, p.column) for p in problems] == [(0, "apartment")]


def test_the_formula_guard_of_the_template_is_undone() -> None:
    assert unguard("'=SUM(A1)") == "=SUM(A1)"
    assert unguard("'-1") == "-1"
    assert unguard("'quoted") == "'quoted"  # a quote the guard would not have added stays


# --- The CSV template ---------------------------------------------------------------------------


def test_the_template_round_trips_through_a_spreadsheet_format() -> None:
    written = write_template(
        [
            TemplateRow({"apartment": "14A", "entrance": "2", "area_m2": "48,20"}),
            TemplateRow({"apartment": "1", "floor": "-1", "location": "=cmd"}),
        ]
    )

    assert written.startswith("﻿apartment;entrance;")
    assert "\r\n" in written
    assert "'=cmd" in written and "'-1" in written  # guarded against formulas
    read = read_template(written.encode("utf-8"))
    assert [(row.ref, unguard(row.cells["location"])) for row in read] == [(2, ""), (3, "=cmd")]
    assert read[0].cells["area_m2"] == "48,20"


def test_a_comma_separated_file_is_read_too() -> None:
    text = ",".join(COLUMNS) + "\n" + '1,1,,"48,2",COLD_WATER,,,,,\n\n'

    (row,) = read_template(text.encode("utf-8"))

    assert (row.cells["apartment"], row.cells["area_m2"]) == ("1", "48,2")


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"", "empty"),
        (b"apartment;nonsense\n", "header must be exactly"),
        (
            (",".join(COLUMNS) + "\n1,1,,48,2,COLD_WATER,,,,,\n").encode(),
            "11 cells instead of 10 (a decimal comma needs ';'",
        ),
        ((";".join(COLUMNS) + "\n1;1;;48;COLD_WATER;;;Köök;;\n").encode("cp1257"), "CSV UTF-8"),
    ],
)
def test_a_file_that_is_no_template_is_refused(data: bytes, message: str) -> None:
    with pytest.raises(TemplateError) as refused:
        read_template(data)

    assert message in str(refused.value)


# --- The draft ----------------------------------------------------------------------------------


def test_meters_and_entrances_are_parsed() -> None:
    assert parse_meters("cold_water:2, HOT_WATER") == [
        (ResourceType.COLD_WATER, 2),
        (ResourceType.HOT_WATER, 1),
    ]
    assert parse_entrances("1-2,3,4-5", 5) == [1, 1, 2, 3, 3]


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("1-3,3-5", "position 3 is in two ranges"),
        ("1-2,4-5", "position 3 is in no range"),
        ("1-6", "goes past the last apartment (5)"),
        ("2-1", "not a range"),
        ("a-b", "not a position"),
    ],
)
def test_wrong_entrance_ranges_are_refused(text: str, message: str) -> None:
    with pytest.raises(DraftError, match=message.replace("(", r"\(").replace(")", r"\)")):
        parse_entrances(text, 5)


@pytest.mark.parametrize(
    ("text", "message"),
    [("COLD_WATER:5", "from 1 to 4"), ("WATER", "is not one of"), ("HEAT,HEAT", "twice")],
)
def test_wrong_meter_types_are_refused(text: str, message: str) -> None:
    with pytest.raises(DraftError, match=message):
        parse_meters(text)


def test_the_register_draft_leaves_out_what_the_app_cannot_hold() -> None:
    apartments, left_out = from_register(
        ApartmentDraft(
            apartments=[
                DraftApartment("1", D("48.25"), 2),
                DraftApartment("1", D("30"), 2),
                DraftApartment("x" * 40, None, None),
            ],
            left_out=[LeftOutPart("K1", "NON_RESIDENTIAL")],
        )
    )

    assert [a.number for a in apartments] == ["1"]
    assert [(p.number, p.reason) for p in left_out] == [
        ("K1", "NON_RESIDENTIAL"),
        ("1", "NUMBER_REPEATED"),
        ("x" * 40, "NUMBER_TOO_LONG"),
    ]


def test_the_template_rows_list_every_meter_then_the_building_meters() -> None:
    written = template_rows(
        from_count(2),
        [1, 2],
        [(ResourceType.COLD_WATER, 2), (ResourceType.HOT_WATER, 1)],
        building_meters=True,
    )

    assert [(r.cells.get("apartment"), r.cells["resource"]) for r in written] == [
        ("1", "COLD_WATER"),
        ("1", "COLD_WATER"),
        ("1", "HOT_WATER"),
        ("2", "COLD_WATER"),
        ("2", "COLD_WATER"),
        ("2", "HOT_WATER"),
        (None, "COLD_WATER"),
        (None, "HOT_WATER"),
    ]
    assert written[3].cells["entrance"] == "2"
    assert all(r.cells["unit"] == "m3" for r in written)


# --- The commands -------------------------------------------------------------------------------


@pytest.fixture
async def real_installation(db_session: AsyncSession) -> None:
    db_session.add(InstanceRecord(id=1, instance_id="assoc-1", demo=False))
    await db_session.commit()


def factory_of(session: AsyncSession):
    @asynccontextmanager
    async def factory():
        yield session

    return factory


def with_register() -> Settings:
    return get_settings().model_copy(
        update={"ENABLED_PLUGINS": "common.csv_export,countries.ee.building_registry"}
    )


async def template(
    session: AsyncSession, out: Path, settings: Settings | None = None, **options
) -> tuple[int, str]:
    printed = io.StringIO()
    arguments = {
        "from_register_code": None,
        "apartments": None,
        "entrances": None,
        "meters": "COLD_WATER,HOT_WATER",
        "building_meters": True,
        **options,
    }
    code = await building_template(
        factory_of(session), settings or get_settings(), out_path=out, out=printed, **arguments
    )
    return code, printed.getvalue()


async def importing(session: AsyncSession, path: Path, dry_run: bool = False) -> tuple[int, str]:
    printed = io.StringIO()
    code = await import_building(factory_of(session), file_path=path, dry_run=dry_run, out=printed)
    return code, printed.getvalue()


def fill_in(path: Path, area: str = "50,10") -> None:
    """What the chairman does: an area for every apartment, a serial for one meter."""
    lines = path.read_text(encoding="utf-8").splitlines()
    filled = [lines[0]]
    for line in lines[1:]:
        cells = line.split(";")
        if cells[0]:
            cells[3] = area
        filled.append(";".join(cells))
    filled[1] = filled[1].replace(";m3;;", ";m3;SN-7;", 1)
    path.write_text("\r\n".join(filled) + "\r\n", encoding="utf-8")


async def test_a_counted_building_is_drafted_filled_in_and_imported(
    db_session: AsyncSession, real_installation, tmp_path: Path
) -> None:
    building = await create_building(db_session)
    await db_session.commit()
    path = tmp_path / "building.csv"

    code, printed = await template(db_session, path, apartments=3, entrances="1-2,3")
    assert (code, printed) == (
        0,
        f"template {path} written: 3 apartments, 8 meters (6 apartment, 2 building)\n",
    )
    fill_in(path)

    checked = await importing(db_session, path, dry_run=True)
    assert checked == (
        0,
        "checked: 3 apartments, 6 apartment meters, 2 building meters, 0 areas rounded\n",
    )
    assert await db_session.scalar(select(Apartment.id)) is None  # a dry run writes nothing

    imported = await importing(db_session, path)
    assert imported[0] == 0 and imported[1].startswith("imported: 3 apartments")
    apartments = list(await db_session.scalars(select(Apartment).order_by(Apartment.number)))
    assert [(a.number, a.entrance, a.area_m2) for a in apartments] == [
        ("1", 1, D("50.10")),
        ("2", 1, D("50.10")),
        ("3", 2, D("50.10")),
    ]
    meters = list(await db_session.scalars(select(MeterDevice)))
    assert len(meters) == 8 and all(m.building_id == building.id for m in meters)
    assert all(m.initial_value is None for m in meters)  # each starts with its first reading
    assert sorted(m.serial_number or "" for m in meters)[-1] == "SN-7"

    # A new building is filled once.
    assert (await importing(db_session, path))[0] == 1


async def test_the_register_draft_comes_from_the_stored_block(
    db_session: AsyncSession, real_installation, tmp_path: Path
) -> None:
    building = await create_building(db_session)
    block = EEBuildingFacts(
        source=EESource(building_code="100000001", fetched_at=datetime(2026, 11, 20, tzinfo=UTC)),
        building=EEBuilding(),
        units=[
            EEUnit(number="1", kind=UnitKind.NON_RESIDENTIAL, area_m2=D("20.0")),
            EEUnit(number="2", kind=UnitKind.APARTMENT, area_m2=D("48.456"), entrance_floor=1),
            EEUnit(number="14A", kind=UnitKind.APARTMENT, area_m2=D("33.1"), entrance_floor=4),
        ],
    )
    db_session.add(BuildingRegistryRecord(building_id=building.id, proposal=dump_block(block)))
    await db_session.commit()
    path = tmp_path / "building.csv"

    code, printed = await template(
        db_session, path, with_register(), from_register_code=NO_REGISTER_BLOCK,
        meters="COLD_WATER", building_meters=False,
    )  # fmt: skip

    assert code == 0, printed
    assert printed.splitlines()[1:] == ["left out: part 1 (NON_RESIDENTIAL)"]
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    assert lines[1:] == ["2;1;1;48,46;COLD_WATER;m3;;;;", "14A;1;4;33,10;COLD_WATER;m3;;;;"]


async def test_without_a_block_the_register_needs_a_building_code(
    db_session: AsyncSession, real_installation, tmp_path: Path, monkeypatch
) -> None:
    building_id = (await create_building(db_session)).id
    await db_session.commit()
    path = tmp_path / "building.csv"

    code, printed = await template(
        db_session, path, with_register(), from_register_code=NO_REGISTER_BLOCK
    )
    assert code == 2 and "needs the register's building code" in printed

    fetched: list[str] = []

    async def fetch(self, code: str) -> EEBuildingFacts:
        fetched.append(code)
        return EEBuildingFacts(
            source=EESource(building_code=code, fetched_at=datetime(2026, 11, 20, tzinfo=UTC)),
            building=EEBuilding(),
            units=[EEUnit(number="5", kind=UnitKind.APARTMENT, area_m2=D("40"))],
        )

    monkeypatch.setattr(EEBuildingRegistry, "fetch", fetch)
    code, printed = await template(
        db_session, path, with_register(), from_register_code="100000001"
    )

    assert code == 0, printed
    assert fetched == ["100000001"]
    record = await db_session.get(BuildingRegistryRecord, building_id)
    assert record is not None and record.proposal is not None  # kept like a chairman's proposal
    assert record.proposal_by_user_id is None


async def test_the_template_refuses_what_it_cannot_do(
    db_session: AsyncSession, real_installation, tmp_path: Path
) -> None:
    path = tmp_path / "building.csv"
    assert (await template(db_session, path, apartments=2))[0] == 1  # no building yet

    building = await create_building(db_session)
    building_id = building.id
    await db_session.commit()
    no_provider = await template(db_session, path, from_register_code=NO_REGISTER_BLOCK)
    assert no_provider[0] == 4 and "no register provider of EE" in no_provider[1]
    assert (await template(db_session, path, apartments=2, entrances="1-3"))[0] == 2
    assert (await template(db_session, path, apartments=2, meters="WATER"))[0] == 2

    path.write_text("mine", encoding="utf-8")
    assert (await template(db_session, path, apartments=2))[0] == 1  # never overwritten
    assert path.read_text(encoding="utf-8") == "mine"

    building = await db_session.get(Building, building_id)
    await create_apartment(db_session, building, "1")
    await db_session.commit()
    filled = await template(db_session, tmp_path / "other.csv", apartments=2)
    assert filled[0] == 1 and "already has apartments or meters" in filled[1]


async def test_the_import_reports_every_problem_and_writes_nothing(
    db_session: AsyncSession, real_installation, tmp_path: Path
) -> None:
    await create_building(db_session)
    await db_session.commit()
    path = tmp_path / "building.csv"
    path.write_text(
        ";".join(COLUMNS) + "\n1;;;;COLD_WATER;;;;;\n2;1;;abc;HOT_WATER;;;;;\n", encoding="utf-8"
    )

    code, printed = await importing(db_session, path)

    assert code == 2
    assert printed.splitlines() == [
        "row 2: entrance: required",
        "row 2: area_m2: required",
        "row 3: area_m2: a number with a decimal point or comma is needed",
        "error: 3 problems, nothing written",
    ]
    assert await db_session.scalar(select(Apartment.id)) is None


async def test_a_demo_installation_is_never_filled(db_session: AsyncSession, tmp_path) -> None:
    db_session.add(InstanceRecord(id=1, instance_id="demo-1", demo=True))
    await create_building(db_session)
    await db_session.commit()
    path = tmp_path / "building.csv"
    path.write_text(";".join(COLUMNS) + "\n1;1;;40;;;;;;\n", encoding="utf-8")

    code, printed = await importing(db_session, path)

    assert code == 1 and "not marked as a real one" in printed
