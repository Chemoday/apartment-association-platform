"""Filling the building of a new installation (epic E13 R3; docs/API.md section 1, "Filling
the building of a new installation"): the layout rules, the CSV template, the draft and the two
operator commands against a real database."""

import io
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest
import structlog
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import Settings, get_settings
from src.core.filling.__main__ import (
    NO_REGISTER_BLOCK,
    building_template,
    configure_cli_logging,
    import_building,
)
from src.core.filling.compare import register_warnings
from src.core.filling.draft import (
    DraftApartmentRow,
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
from src.core.telemetry import configure_logging
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
        (b"apartment;nonsense\n", "header needs the columns"),
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
    # Without --entrances the entrances stay empty: the chairman must fill them in.
    assert lines[1:] == ["2;;1;48,46;COLD_WATER;m3;;;;", "14A;;4;33,10;COLD_WATER;m3;;;;"]


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


async def test_the_template_can_go_through_standard_output_and_input(
    db_session: AsyncSession, real_installation
) -> None:
    """--out - and --file -: how the installer runs the commands inside the backend container."""
    await create_building(db_session)
    await db_session.commit()
    messages, template_text = io.StringIO(), io.StringIO()

    code = await building_template(
        factory_of(db_session), get_settings(), out_path=None, out=messages,
        template_out=template_text, from_register_code=None, apartments=1, entrances=None,
        meters="COLD_WATER", building_meters=False,
    )  # fmt: skip

    assert code == 0
    assert messages.getvalue().startswith("template - written: 1 apartments")
    filled = template_text.getvalue().replace("1;;;;COLD_WATER", "1;1;;40;COLD_WATER")
    printed = io.StringIO()
    code = await import_building(
        factory_of(db_session), file_path=None, dry_run=True, out=printed,
        stdin=io.BytesIO(filled.encode("utf-8")),
    )  # fmt: skip
    assert (code, printed.getvalue()) == (
        0,
        "checked: 1 apartments, 1 apartment meters, 0 building meters, 0 areas rounded\n",
    )


def test_one_row_reports_all_its_problems() -> None:
    _, problems = check_layout(
        rows(apartment("9"), apartment("1", entrance="", resource="WATER", initial_value="x"))
    )

    assert [(p.ref, p.column) for p in problems] == [
        (3, "entrance"),
        (3, "resource"),
        (3, "initial_value"),
    ]


def test_the_logs_of_the_commands_never_reach_the_standard_output(capsys) -> None:
    """With --out - the standard output is the template: a log line there breaks the file."""
    try:
        configure_cli_logging(get_settings())
        structlog.get_logger("src.modules.property.registry").info("registry_proposal_fetched")
        captured = capsys.readouterr()
    finally:
        configure_logging(level="INFO", json_logs=True)

    assert captured.out == ""
    assert "registry_proposal_fetched" in captured.err


async def test_a_huge_file_is_never_read_whole(
    db_session: AsyncSession, real_installation, tmp_path: Path
) -> None:
    path = tmp_path / "huge.csv"
    with path.open("wb") as file:
        file.truncate(6 * 1024 * 1024)

    code, printed = await importing(db_session, path)

    assert (code, printed) == (2, "error: the file is larger than 5 MB\n")


def test_main_keeps_its_logs_and_messages_off_the_template_output(capsys, monkeypatch) -> None:
    """The blocker of the first review: main() itself must route every log line to stderr."""
    from src.core.filling import __main__ as cli
    from src.core.filling.service import FillingRefused

    async def refuse(session):
        structlog.get_logger("src.modules.property.registry").info("registry_proposal_fetched")
        raise FillingRefused("refused")

    class _Session:  # what transaction() touches when the work fails
        info: dict = {}

        async def rollback(self) -> None: ...

        async def commit(self) -> None: ...

    @asynccontextmanager
    async def no_session():
        yield _Session()

    monkeypatch.setattr(cli, "filling_target", refuse)
    try:
        code = cli.main(
            ["building-template", "--out", "-", "--apartments", "2"],
            session_factory=lambda: no_session,
        )
        captured = capsys.readouterr()
    finally:
        configure_logging(level="INFO", json_logs=True)

    assert code == 1
    assert captured.out == ""
    assert "registry_proposal_fetched" in captured.err
    assert "error: refused" in captured.err


def test_a_serial_number_a_spreadsheet_turned_into_an_exponent_is_refused() -> None:
    _, problems = check_layout(
        rows(apartment("1", resource="COLD_WATER", serial_number="1,23E+16"))
    )

    assert [(p.ref, p.column) for p in problems] == [(2, "serial_number")]
    assert "format the column as text" in problems[0].message


def test_a_building_meter_limit_grows_with_the_building() -> None:
    many = [apartment(str(n), resource="COLD_WATER") for n in range(1, 151)]
    layout, problems = check_layout(
        rows(
            *many,
            {"resource": "COLD_WATER", "location": "Basement"},
            {"resource": "HOT_WATER", "max_monthly_delta": "600"},  # given: kept as it is
        )
    )

    assert problems == []
    building = [m for m in layout.meters if m.apartment is None]
    assert [m.max_monthly_delta for m in building] == [D("7500.000"), D("600.000")]


def test_a_small_building_keeps_the_table_default_of_a_building_meter() -> None:
    layout, _ = check_layout(rows(apartment("1"), {"resource": "COLD_WATER"}))

    assert layout.meters[0].max_monthly_delta == D("500.000")


def test_register_numbers_with_control_characters_are_left_out() -> None:
    apartments, left_out = from_register(
        ApartmentDraft(apartments=[DraftApartment("5\x1b[2J", D("40"), 1)], left_out=[])
    )

    assert apartments == []
    assert [(p.number, p.reason) for p in left_out] == [(None, "NUMBER_NOT_TEXT")]


async def test_a_code_for_another_building_replaces_the_stored_block(
    db_session: AsyncSession, real_installation, tmp_path: Path, monkeypatch
) -> None:
    """The lookup picked the wrong building; the operator names the right one."""
    building_id = (await create_building(db_session)).id
    wrong = EEBuildingFacts(
        source=EESource(building_code="100000001", fetched_at=datetime(2026, 11, 20, tzinfo=UTC)),
        building=EEBuilding(),
        units=[EEUnit(number="1", kind=UnitKind.APARTMENT, area_m2=D("40"))],
    )
    db_session.add(BuildingRegistryRecord(building_id=building_id, proposal=dump_block(wrong)))
    await db_session.commit()

    async def fetch(self, code: str) -> EEBuildingFacts:
        return EEBuildingFacts(
            source=EESource(building_code=code, fetched_at=datetime(2026, 11, 21, tzinfo=UTC)),
            building=EEBuilding(),
            units=[EEUnit(number="9", kind=UnitKind.APARTMENT, area_m2=D("55"))],
        )

    monkeypatch.setattr(EEBuildingRegistry, "fetch", fetch)
    path = tmp_path / "building.csv"
    code, printed = await template(
        db_session, path, with_register(), from_register_code="100000002", building_meters=False
    )

    assert code == 0, printed
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    assert [line.split(";")[0] for line in lines[1:]] == ["9", "9"]
    record = await db_session.get(BuildingRegistryRecord, building_id)
    assert record.proposal["source"]["building_code"] == "100000002"


@pytest.mark.parametrize(("first", "second"), [("01", "1"), ("14 A", "14a"), ("007", "7")])
def test_numbers_that_differ_only_in_spelling_are_one_apartment(first: str, second: str) -> None:
    _, problems = check_layout(
        rows(apartment(first, resource="COLD_WATER"), apartment(second, resource="HOT_WATER"))
    )

    assert [(p.ref, p.column) for p in problems] == [(3, "apartment")]
    assert "the same number as row 2" in problems[0].message


def test_10_and_100_stay_two_apartments() -> None:
    layout, problems = check_layout(rows(apartment("10"), apartment("100"), apartment("1")))

    assert problems == [] and [a.number for a in layout.apartments] == ["10", "100", "1"]


async def test_the_import_warns_where_the_file_differs_from_the_register(
    db_session: AsyncSession, real_installation, tmp_path: Path
) -> None:
    building = await create_building(db_session)
    block = EEBuildingFacts(
        source=EESource(building_code="100000001", fetched_at=datetime(2026, 11, 20, tzinfo=UTC)),
        building=EEBuilding(),
        units=[
            EEUnit(number="1", kind=UnitKind.APARTMENT, area_m2=D("45.36")),
            EEUnit(number="2", kind=UnitKind.APARTMENT, area_m2=D("50.0")),
            EEUnit(number="3", kind=UnitKind.APARTMENT, area_m2=D("60.0")),
        ],
    )
    db_session.add(BuildingRegistryRecord(building_id=building.id, accepted=dump_block(block)))
    await db_session.commit()
    path = tmp_path / "building.csv"
    path.write_text(
        ";".join(COLUMNS)
        + ";notes\n"
        + "1;1;;4536;COLD_WATER;;;;;;typed in en-US\n"  # 45,36 read as 4536
        + "2;1;;50,4;COLD_WATER;;;;;;\n"  # within 1 m2: no warning
        + "K1;1;;80;COLD_WATER;;;;;;\n",  # a shop added by hand; apartment 3 deleted
        encoding="utf-8",
    )

    printed = io.StringIO()
    code = await import_building(
        factory_of(db_session), file_path=path, dry_run=True, out=printed,
        settings=with_register(),
    )  # fmt: skip

    assert code == 0
    assert printed.getvalue().splitlines() == [
        "warning: column(s) ignored: notes",
        "warning: the register lists apartments the file does not have: 3",
        "warning: the file has apartments the register does not list: K1",
        "warning: apartment 1: area 4536.00 m2, the register says 45.36 m2",
        "checked: 3 apartments, 3 apartment meters, 0 building meters, 0 areas rounded",
    ]


@pytest.mark.parametrize("name", ["Initial value", "INITIAL-VALUE", " initial_Value "])
def test_a_slightly_renamed_column_is_still_that_column(name: str) -> None:
    header = ";".join(name if c == "initial_value" else c for c in COLUMNS)

    (row,) = read_template((header + "\n1;1;;40;COLD_WATER;;;;12,5;\n").encode("utf-8"))

    assert row.cells["initial_value"] == "12,5"


@pytest.mark.parametrize(
    ("name", "known"),
    [
        ("initial_value (m3)", "initial_value"),
        ("max_monthly_delta m3", "max_monthly_delta"),
        ("Location 2", "location"),
        ("initial\u200bvalue", None),  # a zero-width space: still the column itself
    ],
)
def test_a_column_named_like_a_missing_known_one_is_refused_not_ignored(
    name: str, known: str | None
) -> None:
    if known is None:
        header = ";".join(name if c == "initial_value" else c for c in COLUMNS)
        (row,) = read_template((header + "\n1;1;;40;COLD_WATER;;;;12;\n").encode("utf-8"))
        assert row.cells["initial_value"] == "12"
        return
    header = ";".join(c for c in COLUMNS if c != known) + ";" + name

    with pytest.raises(TemplateError, match="looks like"):
        read_template((header + "\n1;1;;40;COLD_WATER;;;;5\n").encode("utf-8"))


@pytest.mark.parametrize("name", ["floor plan", "Apartment owner", "location comment", "Floors"])
def test_an_extra_column_beside_the_real_one_is_only_ignored(name: str) -> None:
    from src.core.filling.template import read_template_report

    read = read_template_report(
        (";".join(COLUMNS) + ";" + name + "\n1;1;;40;COLD_WATER;;;;;;x\n").encode("utf-8")
    )

    assert read.ignored_columns == [name]


def test_a_comma_file_with_another_column_is_refused() -> None:
    """A decimal comma could move a number into the ignored column without any problem."""
    header = ",".join(COLUMNS) + ",notes"

    with pytest.raises(TemplateError, match="separated by ','"):
        read_template((header + "\n1,1,,48.2,COLD_WATER,m3,,,1254,5,7\n").encode("utf-8"))


async def test_ignored_header_names_are_shown_printable_short_and_few(
    db_session: AsyncSession, real_installation, tmp_path: Path
) -> None:
    await create_building(db_session)
    await db_session.commit()
    extra = ["\x1b[31mred", "x" * 50] + [f"note{n}" for n in range(11)]
    path = tmp_path / "building.csv"
    path.write_text(
        ";".join([*COLUMNS, *extra]) + "\n1;1;;40;;;;;;" + ";" * len(extra) + "\n",
        encoding="utf-8",
    )

    code, printed = await importing(db_session, path, dry_run=True)

    assert code == 0, printed
    warning = printed.splitlines()[0]
    assert "\x1b" not in warning and "?[31mred" in warning
    assert "x" * 31 + "..." in warning and "x" * 32 not in warning
    assert warning.endswith(" and 3 more")


def test_zeros_after_a_digit_or_separator_keep_numbers_apart() -> None:
    layout, problems = check_layout(
        rows(apartment("1.05"), apartment("1.5"), apartment("2-01"), apartment("2-1"))
    )

    assert problems == [] and len(layout.apartments) == 4


def _layout(*numbers_and_areas: tuple[str, str]):
    layout, problems = check_layout(rows(*(apartment(n, area=a) for n, a in numbers_and_areas)))
    assert problems == []
    return layout


def test_the_register_check_needs_both_a_large_and_a_relative_difference() -> None:
    layout = _layout(("1", "121,5"), ("2", "40"), ("3", "10"))
    register = [
        DraftApartmentRow("1", D("120"), None),  # 1.5 m2 but 1.25 %: no warning
        DraftApartmentRow("2", D("40.9"), None),  # 2.2 % but 0.9 m2: no warning
        DraftApartmentRow("3", D("12"), None),  # 2 m2 and 20 %: a warning
    ]

    assert register_warnings(layout, register) == [
        "warning: apartment 3: area 10.00 m2, the register says 12.00 m2"
    ]


def test_the_register_check_matches_spellings_and_skips_missing_areas() -> None:
    layout = _layout(("14A", "40"), ("01", "50"))

    assert (
        register_warnings(
            layout, [DraftApartmentRow("14a", None, None), DraftApartmentRow("1", None, None)]
        )
        == []
    )


def test_the_register_check_limits_its_lines() -> None:
    layout = _layout(*((str(n), "10") for n in range(1, 31)))
    register = [DraftApartmentRow(str(n), D("50"), None) for n in range(1, 31)]
    register += [DraftApartmentRow(f"X{n}", None, None) for n in range(12)]

    warnings = register_warnings(layout, register)

    assert warnings[0].endswith("X9 and 2 more")
    assert len([w for w in warnings if "area" in w]) == 21  # 20 lines and one "and 10 more"
    assert warnings[-1] == "warning: and 10 more areas differ"
