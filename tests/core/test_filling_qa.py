"""QA pass over filling a new building (epic E13 R3; docs/API.md section 1, "Filling the building
of a new installation"; docs/epics/E13_ROLLOUT.md section 6a).

What a chairman's spreadsheet really saves (Excel, LibreOffice, Google Sheets in Estonian and
Russian locales), the boundaries of every column, the refusals of both commands, the register
draft, repeat runs and two imports at the same moment. Helpers and the marker fixture come from
tests/core/test_filling.py.
"""

import asyncio
import io
import time
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from src.core.config import get_settings
from src.core.database import build_engine
from src.core.filling.__main__ import (
    NO_REGISTER_BLOCK,
    building_template,
    import_building,
    main,
)
from src.core.filling.layout import COLUMNS, RowInput, check_layout
from src.core.filling.service import filling_target, lay_out
from src.core.filling.template import (
    MAX_FILE_BYTES,
    MAX_ROWS,
    TemplateError,
    read_template,
)
from src.core.instance import InstanceRecord
from src.core.migrations import alembic_config
from src.modules.meters.models import MeterDevice
from src.modules.meters.schemas import MeterUnit, ResourceType
from src.modules.property.models import Apartment, Building, BuildingRegistryRecord
from src.modules.property.registry import dump_block
from src.plugins.countries.ee.building_registry import EEBuildingRegistry
from src.plugins.countries.ee.facts import EEBuilding, EEBuildingFacts, EESource, EEUnit, UnitKind
from src.plugins.registry import RegistryBuildingNotFound, RegistryUnavailable
from tests.core.test_filling import (
    apartment,
    factory_of,
    importing,
    real_installation,  # noqa: F401
    rows,
    template,
    with_register,
)
from tests.db_utils import scratch_database
from tests.factories import create_building, create_meter

D = Decimal
HEADER = ";".join(COLUMNS)
FILLED = pytest.mark.usefixtures("real_installation")


def csv_bytes(*lines: str, separator: str = ";", newline: str = "\r\n", bom: bool = True) -> bytes:
    """A file as a spreadsheet saves it: the template's header, then the given lines."""
    header = separator.join(COLUMNS)
    text = newline.join([header, *lines]) + newline
    return (("\ufeff" if bom else "") + text).encode("utf-8")


def one_meter_row(**cells: str) -> str:
    """One `;` line of the template, every column empty unless given."""
    return ";".join(cells.get(column, "") for column in COLUMNS)


def layout_of(**cells: str):
    """The layout and problems of one apartment meter row with the given cells changed."""
    base = {"apartment": "1", "entrance": "1", "area_m2": "48,2", "resource": "COLD_WATER"}
    return check_layout([RowInput(ref=2, cells={**base, **cells})])


def facts(*units: EEUnit) -> EEBuildingFacts:
    return EEBuildingFacts(
        source=EESource(building_code="100000001", fetched_at=datetime.now(UTC)),
        building=EEBuilding(),
        units=list(units),
    )


def block(*units: EEUnit) -> dict:
    return dump_block(facts(*units))


def flat(number: str, area: str | None = "40", floor: int | None = 1) -> EEUnit:
    return EEUnit(
        number=number,
        kind=UnitKind.APARTMENT,
        area_m2=None if area is None else D(area),
        entrance_floor=floor,
    )


async def import_bytes(
    session: AsyncSession, tmp_path: Path, data: bytes, dry_run: bool = False
) -> tuple[int, str]:
    path = tmp_path / "filled.csv"
    path.write_bytes(data)
    return await importing(session, path, dry_run=dry_run)


async def template_to_text(session: AsyncSession, settings=None, **options) -> tuple[int, str, str]:
    """building-template with --out -: (exit code, messages, the template text)."""
    messages, text = io.StringIO(), io.StringIO()
    arguments = {
        "from_register_code": None,
        "apartments": None,
        "entrances": None,
        "meters": "COLD_WATER,HOT_WATER",
        "building_meters": True,
        **options,
    }
    code = await building_template(
        factory_of(session),
        settings or get_settings(),
        out_path=None,
        out=messages,
        template_out=text,
        **arguments,
    )
    return code, messages.getvalue(), text.getvalue()


# --- What a spreadsheet saves -------------------------------------------------------------------


def test_an_excel_csv_utf8_file_with_estonian_settings_is_read() -> None:
    """Excel "CSV UTF-8" in an Estonian locale: BOM, ';', decimal commas, CRLF, quoted cells."""
    data = csv_bytes(
        '14A;2;4;48,2;COLD_WATER;m3;"SN;7";"K\u00f6\u00f6k, vasak";12,5;',
        '"14A";"2";"4";"48,20";"HOT_WATER";"";"";"";"";""',
    )

    read = read_template(data)
    layout, problems = check_layout(read)

    assert problems == []
    assert [(a.number, a.entrance, a.floor, a.area_m2) for a in layout.apartments] == [
        ("14A", 2, 4, D("48.20"))
    ]
    assert [(m.serial_number, m.location, m.initial_value) for m in layout.meters] == [
        ("SN;7", "K\u00f6\u00f6k, vasak", D("12.500")),
        (None, "Main", None),
    ]


def test_a_google_sheets_export_with_commas_and_quoted_decimal_commas_is_read() -> None:
    """Google Sheets: ',' separated, no BOM, LF; a decimal comma is quoted by the exporter."""
    data = csv_bytes('1,1,,"48,2",COLD_WATER,,,,"0,5",', separator=",", newline="\n", bom=False)

    layout, problems = check_layout(read_template(data))

    assert problems == []
    assert layout.apartments[0].area_m2 == D("48.20")
    assert layout.meters[0].initial_value == D("0.500")


def test_a_file_with_old_mac_line_endings_is_read() -> None:
    data = csv_bytes("1;1;;48,2;COLD_WATER;;;;;", "2;1;;40;COLD_WATER;;;;;", newline="\r")

    read = read_template(data)

    assert [(row.ref, row.cells["apartment"]) for row in read] == [(2, "1"), (3, "2")]


def test_empty_rows_in_the_middle_are_skipped_and_problems_keep_the_spreadsheet_row() -> None:
    """Rows a spreadsheet leaves empty (also as bare separators) are skipped, and a problem
    after them still names the row the chairman sees in the spreadsheet."""
    data = csv_bytes(
        "1;1;;48,2;COLD_WATER;;;;;", "", ";;;;;;;;;", "  ;  ;;;;;;;;", "2;1;;;HOT_WATER;;;;;"
    )

    read = read_template(data)
    _, problems = check_layout(read)

    assert [row.ref for row in read] == [2, 6]
    assert [str(p) for p in problems] == ["row 6: area_m2: required"]


def test_header_cells_may_be_quoted_padded_and_in_any_order() -> None:
    header = ";".join(f'" {column} "' for column in reversed(COLUMNS))
    line = ";".join(reversed(["1", "1", "", "48,2", "COLD_WATER", "", "", "", "", ""]))
    data = ("\ufeff" + header + "\r\n" + line + "\r\n").encode("utf-8")

    (row,) = read_template(data)

    assert (row.cells["apartment"], row.cells["resource"], row.cells["area_m2"]) == (
        "1",
        "COLD_WATER",
        "48,2",
    )


@pytest.mark.parametrize(
    ("header", "ignored"),
    [
        (HEADER.upper(), []),  # another case (owner, 2026-11-21: found by name)
        (" Apartment ;Entrance;floor;AREA_M2;resource;unit;serial_number;location;initial_value;"
         "max_monthly_delta", []),
        (HEADER + ";notes", ["notes"]),  # another column: ignored, named in a warning
    ],
)  # fmt: skip
def test_a_header_is_matched_by_name_without_case(header: str, ignored: list[str]) -> None:
    from src.core.filling.template import read_template_report

    read = read_template_report((header + "\r\n1;1;;48,2;COLD_WATER;;;;;\r\n").encode("utf-8"))

    (row,) = read.rows
    assert (row.cells["apartment"], row.cells["area_m2"]) == ("1", "48,2")
    assert read.ignored_columns == ignored


def test_optional_columns_may_be_left_out() -> None:
    header = "apartment;entrance;area_m2;resource"

    (row,) = read_template((header + "\r\n1;2;48,2;COLD_WATER\r\n").encode("utf-8"))
    layout, problems = check_layout([row])

    assert problems == []
    assert (layout.apartments[0].entrance, layout.meters[0].location) == (2, "Main")


def test_thousands_grouped_by_spaces_are_numbers() -> None:
    layout, problems = check_layout(
        [
            RowInput(
                ref=2,
                cells={
                    "apartment": "1",
                    "entrance": "1",
                    "area_m2": "1 200,5",
                    "resource": "HEAT",
                    "initial_value": "12\u00a0345,5",
                },
            ),
            RowInput(ref=3, cells={"resource": "COLD_WATER", "max_monthly_delta": "7\u202f500"}),
        ]
    )

    assert problems == []
    assert layout.apartments[0].area_m2 == D("1200.50")
    assert layout.meters[0].initial_value == D("12345.500")
    assert layout.meters[1].max_monthly_delta == D("7500.000")


@pytest.mark.parametrize(
    "header",
    [
        HEADER.replace(";area_m2", ""),  # a required column missing
        HEADER.replace("location", "unit"),  # a column twice
        "\t".join(COLUMNS),  # tab separated ("Unicode text")
        "sep=;\r\n" + HEADER,  # the Excel separator hint line
    ],
)
def test_a_header_without_its_required_columns_is_refused(header: str) -> None:
    data = (header + "\r\n1;1;;48,2;COLD_WATER;;;;;\r\n").encode("utf-8")

    with pytest.raises(TemplateError) as refused:
        read_template(data)

    message = str(refused.value)
    assert message.startswith("row 1: the ")
    assert "header needs the columns" in message or "separator must be ; or ," in message


def test_trailing_empty_columns_a_spreadsheet_keeps_are_ignored() -> None:
    """A chairman typed a note in an eleventh column and deleted it again: the spreadsheet
    still saves that column, empty, as a trailing separator on every line."""
    data = csv_bytes("1;1;;48,2;COLD_WATER;;;;;;").replace(HEADER.encode(), (HEADER + ";").encode())

    layout, problems = check_layout(read_template(data))

    assert problems == []
    assert [a.number for a in layout.apartments] == ["1"]


def test_a_line_break_inside_a_quoted_cell_keeps_the_row_numbers_of_the_spreadsheet() -> None:
    """Alt+Enter in a cell saves a quoted line break. The spreadsheet shows the cell in row 2
    and the next apartment in row 3; the problems must name those rows."""
    data = csv_bytes('1;1;;48,2;COLD_WATER;;;"Kitchen\nleft";;', "2;1;;;HOT_WATER;;;;;")

    _, problems = check_layout(read_template(data))

    assert [str(p) for p in problems] == [
        "row 2: location: one line of visible text",
        "row 3: area_m2: required",
    ]


@pytest.mark.parametrize(
    ("text", "encoding"),
    [
        (HEADER + "\r\n1;1;;48;COLD_WATER;;;K\u00fcche;;\r\n", "cp1252"),  # Excel "CSV", German
        (HEADER + "\r\n1;1;;48;COLD_WATER;;;K\u00f6\u00f6k;;\r\n", "cp1257"),  # Estonian
        (HEADER + "\r\n1;1;;48;COLD_WATER;;;\u041a\u0443\u0445\u043d\u044f;;\r\n", "cp1251"),
        ("\ufeff" + HEADER + "\r\n1;1;;48;COLD_WATER;;;;;\r\n", "utf-16"),  # "Unicode text"
    ],
)
async def test_a_file_saved_in_a_code_page_or_utf16_says_how_to_save_it(
    db_session: AsyncSession, tmp_path: Path, text: str, encoding: str
) -> None:
    code, printed = await import_bytes(db_session, tmp_path, text.encode(encoding))

    assert (code, printed) == (2, 'error: the file is not UTF-8: save it as "CSV UTF-8"\n')


def test_a_code_page_file_with_only_ascii_letters_is_read_as_utf8() -> None:
    data = (HEADER + "\r\n1;1;;48;COLD_WATER;;;Kitchen;;\r\n").encode("cp1257")

    (row,) = read_template(data)

    assert row.cells["location"] == "Kitchen"


def test_a_cell_beyond_the_csv_field_limit_is_a_refusal_and_not_a_crash() -> None:
    data = csv_bytes("1;1;;48,2;COLD_WATER;;;" + "x" * 200_000 + ";;")

    with pytest.raises(TemplateError) as refused:
        read_template(data)

    assert str(refused.value).startswith("row 2: ")
    assert "x" * 20 not in str(refused.value)


def test_an_unclosed_quote_is_a_refusal_of_the_file() -> None:
    data = csv_bytes('1;1;;"48,2;COLD_WATER;;;;;', "2;1;;40;COLD_WATER;;;;;")

    with pytest.raises(TemplateError) as refused:
        read_template(data)

    assert str(refused.value).startswith("row ")


def test_a_short_row_is_a_refusal_with_its_row_number() -> None:
    data = csv_bytes("1;1;;48,2;COLD_WATER")

    with pytest.raises(TemplateError) as refused:
        read_template(data)

    assert str(refused.value) == "row 2: 5 cells instead of 10"


def test_a_file_of_exactly_5_mb_is_read_and_one_byte_more_is_refused() -> None:
    body = csv_bytes("1;1;;48,2;COLD_WATER;;;;;")
    exact = body + b"\r\n" * ((MAX_FILE_BYTES - len(body)) // 2)
    exact += b" " * (MAX_FILE_BYTES - len(exact))
    assert len(exact) == MAX_FILE_BYTES

    assert len(read_template(exact)) == 1
    with pytest.raises(TemplateError, match="larger than 5 MB"):
        read_template(exact + b"\n")


def _meter_lines(count: int) -> list[str]:
    """`count` distinct meter rows: up to 4 locations of 2 water types per apartment."""
    lines = []
    for index in range(count):
        number, slot = divmod(index, 8)
        resource = "COLD_WATER" if slot % 2 == 0 else "HOT_WATER"
        lines.append(f"{number + 1};1;;48,2;{resource};;;L{slot // 2};;")
    return lines


def test_ten_thousand_rows_are_read_and_one_more_is_refused() -> None:
    lines = _meter_lines(MAX_ROWS)
    with_blanks = csv_bytes(*lines[:10], "", "", *lines[10:])  # empty lines are no rows

    assert len(read_template(with_blanks)) == MAX_ROWS
    with pytest.raises(TemplateError, match="more than 10000 rows"):
        read_template(csv_bytes(*_meter_lines(MAX_ROWS + 1)))


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (b"", ["error: the file is empty"]),
        ("\ufeff".encode(), ["error: the file is empty"]),
        (
            b"\r\n\r\n",
            [
                "error: row 1: the header needs the columns apartment, entrance, area_m2, "
                "resource and may have floor, unit, serial_number, location, initial_value, "
                "max_monthly_delta"
            ],
        ),
        (
            csv_bytes(),
            ["error: the layout has no apartments", "error: 1 problems, nothing written"],
        ),
        (
            csv_bytes("", ";;;;;;;;;"),
            ["error: the layout has no apartments", "error: 1 problems, nothing written"],
        ),
    ],
)
@FILLED
async def test_an_empty_file_or_only_a_header_is_refused_with_exit_2(
    db_session: AsyncSession, tmp_path: Path, data: bytes, expected: list[str]
) -> None:
    await create_building(db_session)
    await db_session.commit()

    code, printed = await import_bytes(db_session, tmp_path, data)

    assert (code, printed.splitlines()) == (2, expected)
    assert await db_session.scalar(select(func.count()).select_from(Apartment)) == 0


# --- The cells ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "area", "rounded"),
    [
        ("48,2", "48.20", 0),
        ("48.20", "48.20", 0),
        (" 48,2 ", "48.20", 0),
        ("48,2\u00a0", "48.20", 0),  # a non-breaking space a locale left at the end
        ("48,445", "48.45", 1),  # half up, not to even
        ("48,005", "48.01", 1),
        ("0,005", "0.01", 1),
        ("999999,994", "999999.99", 1),
    ],
)
def test_areas_as_a_spreadsheet_writes_them_are_rounded_half_up(
    text: str, area: str, rounded: int
) -> None:
    layout, problems = layout_of(area_m2=text)

    assert problems == []
    assert (layout.apartments[0].area_m2, layout.rounded_areas) == (D(area), rounded)


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("1.200,5", "a number with a decimal point or comma is needed"),  # dot thousands
        ("12 34,5", "a number with a decimal point or comma is needed"),  # not groups of 3
        ("48,2 m2", "a number with a decimal point or comma is needed"),
        ("1e2", "a number with a decimal point or comma is needed"),
        ("48,", "a number with a decimal point or comma is needed"),
        ("+48", "a number with a decimal point or comma is needed"),
        ("\u0664\u0668", "a number with a decimal point or comma is needed"),  # unicode digits
        ("\uff14\uff18", "a number with a decimal point or comma is needed"),  # full width
        ("0,004", "must be greater than 0"),
        ("999999,995", "at most 999999.99"),
    ],
)
def test_areas_that_are_no_plain_number_are_a_problem_of_their_row(text: str, message: str) -> None:
    layout, problems = layout_of(area_m2=text)

    assert [str(p) for p in problems] == [f"row 2: area_m2: {message}"]
    assert layout.apartments == [] and layout.meters == []


@pytest.mark.parametrize(
    ("column", "text", "value"),
    [
        ("floor", "-1", -1),
        ("floor", "'-1", -1),  # the template's formula guard
        ("floor", "-5", -5),
        ("floor", "200", 200),
        ("floor", "01", 1),
        ("floor", "", 1),
        ("entrance", "01", 1),
        ("entrance", "99", 99),
    ],
)
def test_whole_numbers_at_their_bounds_are_taken(column: str, text: str, value: int) -> None:
    layout, problems = layout_of(**{column: text})

    assert problems == []
    assert getattr(layout.apartments[0], column) == value


@pytest.mark.parametrize(
    ("column", "text", "message"),
    [
        ("floor", "-6", "must be from -5 to 200"),
        ("floor", "201", "must be from -5 to 200"),
        ("floor", "+1", "a whole number is needed"),
        ("floor", "1,0", "a whole number is needed"),
        ("floor", "\u0663", "a whole number is needed"),
        ("entrance", "100", "must be from 1 to 99"),
        ("entrance", "1.0", "a whole number is needed"),
    ],
)
def test_whole_numbers_out_of_bounds_are_a_problem(column: str, text: str, message: str) -> None:
    _, problems = layout_of(**{column: text})

    assert [str(p) for p in problems] == [f"row 2: {column}: {message}"]


@pytest.mark.parametrize(
    ("column", "text", "value"),
    [
        ("initial_value", "0", "0.000"),
        ("initial_value", "0,000", "0.000"),
        ("initial_value", "1,234", "1.234"),
        ("initial_value", "999999999,999", "999999999.999"),
        ("max_monthly_delta", "0,001", "0.001"),
        ("max_monthly_delta", "999999999.999", "999999999.999"),
    ],
)
def test_meter_values_at_their_bounds_are_kept_exactly(column: str, text: str, value: str) -> None:
    layout, problems = layout_of(**{column: text})

    assert problems == []
    kept = getattr(layout.meters[0], column)
    assert isinstance(kept, Decimal) and str(kept) == value


@pytest.mark.parametrize(
    ("column", "text", "message"),
    [
        ("initial_value", "1,2345", "at most 3 decimal places"),
        ("initial_value", "1000000000", "at most 999999999.999"),
        ("initial_value", "999999999999,5", "at most 999999999.999"),
        ("initial_value", "-5", "a number with a decimal point or comma is needed"),
        ("initial_value", "1.5e3", "a number with a decimal point or comma is needed"),
        ("max_monthly_delta", "0", "must be greater than 0"),
        ("max_monthly_delta", "0,000", "must be greater than 0"),
        ("max_monthly_delta", "0,0001", "at most 3 decimal places"),
        ("max_monthly_delta", "1000000000", "at most 999999999.999"),
    ],
)
def test_meter_values_out_of_bounds_are_a_problem(column: str, text: str, message: str) -> None:
    layout, problems = layout_of(**{column: text})

    assert [str(p) for p in problems] == [f"row 2: {column}: {message}"]
    assert layout.meters == []


@pytest.mark.parametrize(
    ("resource", "unit", "expected", "limit"),
    [
        ("COLD_WATER", "M3", MeterUnit.M3, "25.000"),
        ("cold_water", " m3 ", MeterUnit.M3, "25.000"),
        ("ELECTRICITY", "kwh", MeterUnit.KWH, "1000.000"),
        ("electricity", "MWH", MeterUnit.MWH, "1.000"),
        ("HEAT", "mwh", MeterUnit.MWH, "2.000"),
        ("GAS", "", MeterUnit.M3, "50.000"),
    ],
)
def test_units_and_types_are_taken_in_any_case(
    resource: str, unit: str, expected: MeterUnit, limit: str
) -> None:
    layout, problems = layout_of(resource=resource, unit=unit)

    assert problems == []
    (meter,) = layout.meters
    assert (meter.unit, str(meter.max_monthly_delta)) == (expected, limit)


@pytest.mark.parametrize(
    ("resource", "unit", "column", "message"),
    [
        ("COLD_WATER", "m\u00b3", "unit", "COLD_WATER allows m3"),
        ("COLD_WATER", "kWh", "unit", "COLD_WATER allows m3"),
        ("HEAT", "GJ", "unit", "HEAT allows kWh, MWh"),
        ("Cold Water", "", "resource", "one of COLD_WATER, HOT_WATER, ELECTRICITY, HEAT, GAS"),
    ],
)
def test_a_unit_or_type_the_app_does_not_know_is_a_problem(
    resource: str, unit: str, column: str, message: str
) -> None:
    _, problems = layout_of(resource=resource, unit=unit)

    assert [str(p) for p in problems] == [f"row 2: {column}: {message}"]


def test_a_building_meter_row_with_apartment_cells_names_each_of_them() -> None:
    _, problems = check_layout(
        rows(apartment("1"), {"entrance": "1", "floor": "-1", "area_m2": "10", "resource": "GAS"})
    )

    assert [str(p) for p in problems] == [
        "row 3: entrance: must be empty for a building meter",
        "row 3: floor: must be empty for a building meter",
        "row 3: area_m2: must be empty for a building meter",
    ]


@pytest.mark.parametrize(
    "column", ["unit", "serial_number", "location", "initial_value", "max_monthly_delta"]
)
def test_an_apartment_row_with_some_meter_cells_but_no_type_is_a_problem(column: str) -> None:
    value = "5" if column in ("initial_value", "max_monthly_delta") else "m3"
    _, problems = check_layout(rows(apartment("1", **{column: value})))

    assert [str(p) for p in problems] == ["row 2: resource: required"]


def test_rows_of_one_apartment_agree_after_rounding_and_defaults() -> None:
    layout, problems = check_layout(
        rows(
            apartment("1", area="48,2", resource="COLD_WATER"),
            apartment("1", area="48.20", floor="1", resource="HOT_WATER"),
            apartment("1", area="48,204"),  # the same apartment without a meter
        )
    )

    assert problems == []
    assert [(a.number, a.area_m2) for a in layout.apartments] == [("1", D("48.20"))]
    assert layout.apartment_meters == 2


def test_the_same_apartment_with_two_areas_is_a_problem_of_the_later_row() -> None:
    _, problems = check_layout(
        rows(apartment("1", area="48,2", resource="COLD_WATER"), apartment("1", area="48,3"))
    )

    assert [str(p) for p in problems] == [
        "row 3: apartment: entrance, floor or area differ from row 2"
    ]


def test_locations_tell_meters_apart_without_case_and_per_place() -> None:
    layout, problems = check_layout(
        rows(
            apartment("1", resource="COLD_WATER", location="Kitchen"),
            apartment("1", resource="COLD_WATER", location="Bathroom"),
            apartment("1", resource="HOT_WATER"),  # Main
            {"resource": "COLD_WATER"},  # the building's Main is another place
            apartment("2", resource="COLD_WATER"),  # Main of another apartment
        )
    )
    assert problems == []
    assert layout.apartment_meters == 4 and layout.building_meters == 1

    _, problems = check_layout(
        rows(
            apartment("1", resource="COLD_WATER", location="K\u00f6\u00f6k"),
            apartment("1", resource="COLD_WATER", location="K\u00d6\u00d6K "),
            {"resource": "HOT_WATER"},
            {"resource": "HOT_WATER", "location": " MAIN"},
        )
    )
    assert [(p.ref, p.column) for p in problems] == [(3, "location"), (5, "location")]
    assert "see row 4" in problems[1].message


@pytest.mark.parametrize(
    "number",
    [
        "12/14",
        "14 A",
        "x" * 32,
        "\u00c4" * 32,  # 32 letters, more bytes
        "'=1+1",  # guarded by the template, stored as =1+1
    ],
)
def test_apartment_numbers_are_text_of_up_to_32_characters(number: str) -> None:
    layout, problems = check_layout(rows(apartment(number)))

    assert problems == []
    assert layout.apartments[0].number == number.removeprefix("'")


@pytest.mark.parametrize(
    "number",
    [
        "1\u200b4",  # a zero-width space
        "\u202e41",  # a right-to-left override
        "14\t",  # a tab inside the trimmed text would stay; here it is trimmed
        "1\x004",
    ],
)
def test_apartment_numbers_with_invisible_characters_are_a_problem(number: str) -> None:
    _, problems = check_layout(rows(apartment(number)))

    if number == "14\t":
        assert problems == []  # trimmed like any cell
    else:
        assert [str(p) for p in problems] == ["row 2: apartment: one line of visible text"]


def test_numbers_that_differ_only_around_them_are_one_apartment() -> None:
    layout, problems = check_layout(
        rows(apartment(" 14 ", resource="COLD_WATER"), apartment("14", resource="HOT_WATER"))
    )

    assert problems == []
    assert [a.number for a in layout.apartments] == ["14"]


def test_one_apartment_typed_in_two_cases_is_not_silently_split_in_two() -> None:
    layout, problems = check_layout(
        rows(apartment("14A", resource="COLD_WATER"), apartment("14a", resource="HOT_WATER"))
    )

    assert problems or len(layout.apartments) == 1


def test_the_formula_guard_is_undone_in_every_text_and_number_column() -> None:
    layout, problems = check_layout(
        rows(
            apartment(
                "'-1",
                floor="'-2",
                resource="COLD_WATER",
                serial_number="'+372-55",
                location="'=SUM(A1)",
            ),
            apartment("2", resource="HOT_WATER", location="'@home"),
        )
    )

    assert problems == []
    assert (layout.apartments[0].number, layout.apartments[0].floor) == ("-1", -2)
    assert [(m.serial_number, m.location) for m in layout.meters] == [
        ("+372-55", "=SUM(A1)"),
        (None, "@home"),
    ]


def test_text_at_its_length_limit_passes_and_one_more_character_is_a_problem() -> None:
    layout, problems = check_layout(
        rows(apartment("1", resource="GAS", serial_number="\u00e9" * 100, location="L" * 100))
    )
    assert problems == [] and layout.meters[0].serial_number == "\u00e9" * 100

    _, problems = check_layout(
        rows(apartment("1", resource="GAS", serial_number="s" * 101, location="L" * 101))
    )
    assert [str(p) for p in problems] == [
        "row 2: serial_number: at most 100 characters",
        "row 2: location: at most 100 characters",
    ]


# --- The import command -------------------------------------------------------------------------


@FILLED
async def test_the_import_output_never_carries_a_cell_value(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """Only row numbers, column names and counts: a chairman may type a person into a cell."""
    await create_building(db_session)
    await db_session.commit()
    private = ["Mari Tamm", "mari.tamm@example.ee", "+372 5555 1234", "Kadri"]
    data = csv_bytes(
        one_meter_row(apartment="Mari Tamm", area_m2="mari.tamm@example.ee", resource="GAS"),
        one_meter_row(
            apartment="2",
            entrance="1",
            area_m2="40",
            resource="+372 5555 1234",
            unit="Kadri",
            location="Kadri " * 30,
            initial_value="Mari Tamm",
        ),
    )

    code, printed = await import_bytes(db_session, tmp_path, data)

    assert code == 2
    for value in private:
        assert value not in printed
    assert printed.splitlines()[-1].startswith("error: ")


@pytest.mark.parametrize("dry_run", [False, True])
async def test_an_installation_without_a_marker_is_never_filled(
    db_session: AsyncSession, tmp_path: Path, dry_run: bool
) -> None:
    await create_building(db_session)
    await db_session.commit()

    code, printed = await import_bytes(
        db_session, tmp_path, csv_bytes("1;1;;40;;;;;;"), dry_run=dry_run
    )

    assert code == 1 and printed.startswith("error: the installation is not marked as a real one")
    assert await db_session.scalar(select(func.count()).select_from(Apartment)) == 0


@FILLED
async def test_an_import_without_a_building_says_to_create_it_first(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    code, printed = await import_bytes(db_session, tmp_path, csv_bytes("1;1;;40;;;;;;"))

    assert (code, printed) == (
        1,
        "error: the installation has no building yet: run create-building first\n",
    )


@FILLED
async def test_a_building_with_only_a_building_meter_is_filled_already(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    building = await create_building(db_session)
    await create_meter(db_session, building, None)
    await db_session.commit()

    imported = await import_bytes(db_session, tmp_path, csv_bytes("1;1;;40;;;;;;"), dry_run=True)
    drafted = await template(db_session, tmp_path / "t.csv", apartments=1)

    for code, printed in (imported, drafted):
        assert code == 1 and "already has apartments or meters" in printed
    assert not (tmp_path / "t.csv").exists()


@FILLED
async def test_a_dry_run_then_the_same_file_imports_the_same_counts_and_only_once(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await create_building(db_session)
    await db_session.commit()
    data = csv_bytes(
        "1;1;;48,445;COLD_WATER;;;;;",
        "1;1;;48,445;HOT_WATER;;;;;",
        "2;2;3;50;;;;;;",
        ";;;;COLD_WATER;;;Basement;1000;",
    )
    counts = "2 apartments, 2 apartment meters, 1 building meters, 1 areas rounded"

    assert await import_bytes(db_session, tmp_path, data, dry_run=True) == (
        0,
        f"checked: {counts}\n",
    )
    assert await import_bytes(db_session, tmp_path, data, dry_run=True) == (
        0,
        f"checked: {counts}\n",
    )
    assert await import_bytes(db_session, tmp_path, data) == (0, f"imported: {counts}\n")

    again = await import_bytes(db_session, tmp_path, data)
    dry_again = await import_bytes(db_session, tmp_path, data, dry_run=True)
    for code, printed in (again, dry_again):
        assert code == 1 and "a new building is filled once" in printed
    assert await db_session.scalar(select(func.count()).select_from(Apartment)) == 2
    assert await db_session.scalar(select(func.count()).select_from(MeterDevice)) == 3


@FILLED
async def test_after_an_import_a_new_template_is_refused_and_no_file_is_written(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await create_building(db_session)
    await db_session.commit()
    assert (await import_bytes(db_session, tmp_path, csv_bytes("1;1;;40;;;;;;")))[0] == 0

    code, printed, text = await template_to_text(db_session, apartments=3)

    assert code == 1 and "already has apartments or meters" in printed
    assert text == ""


@pytest.mark.parametrize("kind", ["missing", "directory"])
async def test_a_file_that_cannot_be_read_is_exit_2(
    db_session: AsyncSession, tmp_path: Path, kind: str
) -> None:
    path = tmp_path / "nothing.csv" if kind == "missing" else tmp_path

    assert await importing(db_session, path) == (2, "error: --file cannot be read\n")


@FILLED
async def test_the_import_writes_exactly_what_the_file_says(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    building = await create_building(db_session)
    await db_session.commit()
    long_number, shower = "\u00c4" * 32, "\U0001f6bf" * 100
    data = csv_bytes(
        f"{long_number};3;'-1;48,445;cold_water;M3;'+372-55;'=SUM(A1);0;0,001",
        f"{long_number};3;'-1;48.45;HOT_WATER;;;{shower};999999999,999;",
        "2;1;;50;ELECTRICITY;mwh;;;;",
        ";;;;HEAT;kwh;;;;",
    )

    code, printed = await import_bytes(db_session, tmp_path, data)

    assert code == 0, printed
    apartments = {
        a.number: a
        for a in await db_session.scalars(
            select(Apartment).execution_options(populate_existing=True)
        )
    }
    first = apartments[long_number]
    assert (first.entrance, first.floor, first.area_m2) == (3, -1, D("48.45"))
    assert all(a.building_id == building.id for a in apartments.values())
    meters = {
        (m.apartment_id, m.resource_type): m
        for m in await db_session.scalars(
            select(MeterDevice).execution_options(populate_existing=True)
        )
    }
    cold = meters[(first.id, ResourceType.COLD_WATER)]
    assert (cold.unit, cold.serial_number, cold.location_label) == ("m3", "+372-55", "=SUM(A1)")
    assert (cold.initial_value, cold.max_monthly_delta) == (D("0.000"), D("0.001"))
    hot = meters[(first.id, ResourceType.HOT_WATER)]
    assert (hot.serial_number, hot.location_label) == (None, shower)
    assert (hot.initial_value, hot.max_monthly_delta) == (D("999999999.999"), D("15.000"))
    power = meters[(apartments["2"].id, ResourceType.ELECTRICITY)]
    assert (power.unit, power.initial_value, power.max_monthly_delta) == (
        "MWh",
        None,
        D("1.000"),
    )
    heat = meters[(None, ResourceType.HEAT)]
    assert (heat.unit, heat.location_label, heat.max_monthly_delta) == (
        "kWh",
        "Main",
        D("100000.000"),
    )
    assert all(m.is_active for m in meters.values())


@FILLED
async def test_ten_thousand_rows_are_imported_in_one_go(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await create_building(db_session)
    await db_session.commit()
    data = csv_bytes(*_meter_lines(MAX_ROWS))

    started = time.monotonic()
    code, printed = await import_bytes(db_session, tmp_path, data)
    elapsed = time.monotonic() - started

    assert (code, printed) == (
        0,
        "imported: 1250 apartments, 10000 apartment meters, 0 building meters, 0 areas rounded\n",
    )
    assert await db_session.scalar(select(func.count()).select_from(MeterDevice)) == MAX_ROWS
    assert elapsed < 60, f"10,000 rows took {elapsed:.1f} s"


# --- Two imports at once ------------------------------------------------------------------------


async def test_two_imports_at_the_same_moment_fill_the_building_once(
    database_url: str, tmp_path: Path
) -> None:
    """Real sessions on committed data: the second import waits for the filling lock, then sees
    the apartments of the first and refuses; the building is never filled twice."""
    path = tmp_path / "filled.csv"
    path.write_bytes(
        csv_bytes("1;1;;40;COLD_WATER;;;;;", "2;1;;40;COLD_WATER;;;;;", ";;;;COLD_WATER;;;;;")
    )
    async with scratch_database(database_url) as url:
        await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
        engine = build_engine(url)
        try:
            sessions = async_sessionmaker(engine, expire_on_commit=False)
            async with sessions() as setup:
                setup.add(InstanceRecord(id=1, instance_id="assoc-1", demo=False))
                setup.add(Building(name="K\u00dc Proov 1", address="Proovi 1, Tallinn"))
                await setup.commit()

            # A first import holds the lock; a second one started meanwhile must wait.
            async with sessions() as first:
                target = await filling_target(first)
                printed = io.StringIO()
                waiting = asyncio.create_task(
                    import_building(sessions, file_path=path, dry_run=False, out=printed)
                )
                await asyncio.sleep(0.5)
                assert not waiting.done(), "the second import waits for the filling lock"
                layout, problems = check_layout(read_template(path.read_bytes()))
                assert problems == []
                await lay_out(first, target, layout)
                await first.commit()
            assert await waiting == 1
            assert "a new building is filled once" in printed.getvalue()

            # And two plain runs at once on a fresh building: one fills it, one refuses.
            async with sessions() as reset:
                await reset.execute(MeterDevice.__table__.delete())
                await reset.execute(Apartment.__table__.delete())
                await reset.commit()
            outs = [io.StringIO(), io.StringIO()]
            codes = await asyncio.gather(
                *(import_building(sessions, file_path=path, dry_run=False, out=out) for out in outs)
            )
            assert sorted(codes) == [0, 1], [out.getvalue() for out in outs]
            async with sessions() as check:
                apartments = await check.scalar(select(func.count()).select_from(Apartment))
                meters = await check.scalar(select(func.count()).select_from(MeterDevice))
            assert (apartments, meters) == (2, 3)
        finally:
            await engine.dispose()


# --- building-template --------------------------------------------------------------------------


async def test_a_template_without_a_marker_or_on_a_demo_is_refused_and_writes_nothing(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await create_building(db_session)
    await db_session.commit()
    path = tmp_path / "t.csv"

    unmarked = await template(db_session, path, apartments=2)
    db_session.add(InstanceRecord(id=1, instance_id="demo-1", demo=True))
    await db_session.commit()
    demo = await template(db_session, path, apartments=2)

    for code, printed in (unmarked, demo):
        assert code == 1 and printed.startswith("error: the installation is not marked")
    assert not path.exists()


@FILLED
async def test_a_register_that_does_not_answer_is_exit_3_and_keeps_and_writes_nothing(
    db_session: AsyncSession, monkeypatch
) -> None:
    building_id = (await create_building(db_session)).id
    await db_session.commit()

    async def fetch(self, code: str):
        raise RegistryUnavailable()

    monkeypatch.setattr(EEBuildingRegistry, "fetch", fetch)
    code, printed, text = await template_to_text(
        db_session, with_register(), from_register_code="101036416"
    )

    assert (code, printed) == (3, "error: the register does not answer usably; try again later\n")
    assert text == ""  # the installer's file stays empty, so it keeps none
    assert await db_session.get(BuildingRegistryRecord, building_id) is None


@FILLED
async def test_a_code_the_register_does_not_know_is_exit_2(
    db_session: AsyncSession, monkeypatch
) -> None:
    await create_building(db_session)
    await db_session.commit()

    async def fetch(self, code: str):
        raise RegistryBuildingNotFound()

    monkeypatch.setattr(EEBuildingRegistry, "fetch", fetch)
    code, printed, text = await template_to_text(
        db_session, with_register(), from_register_code="101036416"
    )

    assert (code, printed, text) == (
        2,
        "error: --from-register the register does not know this building\n",
        "",
    )


@pytest.mark.parametrize("code_given", ["12ab5678", "12345", "1234567890123", "", "-1"])
@FILLED
async def test_a_code_of_the_wrong_form_is_exit_2_and_never_fetched(
    db_session: AsyncSession, monkeypatch, code_given: str
) -> None:
    await create_building(db_session)
    await db_session.commit()
    fetched: list[str] = []

    async def fetch(self, code: str):
        fetched.append(code)
        raise AssertionError("never fetched")

    monkeypatch.setattr(EEBuildingRegistry, "fetch", fetch)
    code, printed, _ = await template_to_text(
        db_session, with_register(), from_register_code=code_given
    )

    assert (code, printed) == (2, "error: --from-register the building code has the wrong form\n")
    assert fetched == []


@FILLED
async def test_a_code_with_spaces_around_it_is_fetched_trimmed(
    db_session: AsyncSession, monkeypatch
) -> None:
    await create_building(db_session)
    await db_session.commit()
    fetched: list[str] = []

    async def fetch(self, code: str) -> EEBuildingFacts:
        fetched.append(code)
        return facts(flat("1"))

    monkeypatch.setattr(EEBuildingRegistry, "fetch", fetch)
    code, printed, _ = await template_to_text(
        db_session, with_register(), from_register_code=" 101036416 "
    )

    assert code == 0, printed
    assert fetched == ["101036416"]


@FILLED
async def test_the_accepted_block_wins_over_a_newer_proposal(db_session: AsyncSession) -> None:
    building = await create_building(db_session)
    db_session.add(
        BuildingRegistryRecord(
            building_id=building.id,
            accepted=block(flat("1"), flat("2")),
            proposal=block(flat("99")),
        )
    )
    await db_session.commit()

    code, printed, text = await template_to_text(
        db_session, with_register(), from_register_code=NO_REGISTER_BLOCK, meters="GAS",
        building_meters=False,
    )  # fmt: skip

    assert code == 0, printed
    numbers = [line.split(";")[0] for line in text.lstrip("\ufeff").splitlines()[1:]]
    assert numbers == ["1", "2"]


@FILLED
async def test_a_register_without_apartments_is_exit_1_and_writes_no_file(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    building = await create_building(db_session)
    db_session.add(
        BuildingRegistryRecord(
            building_id=building.id,
            proposal=block(
                EEUnit(number="K1", kind=UnitKind.NON_RESIDENTIAL, area_m2=D("20")),
                EEUnit(number=None, kind=UnitKind.APARTMENT, area_m2=D("20")),
                EEUnit(number="Y", kind=UnitKind.COMMON),
            ),
        )
    )
    await db_session.commit()
    path = tmp_path / "t.csv"

    code, printed = await template(
        db_session, path, with_register(), from_register_code=NO_REGISTER_BLOCK
    )

    assert code == 1
    assert printed.splitlines()[-1] == (
        "error: the register lists no apartments for this building: use --apartments <N>"
    )
    assert not path.exists()


@FILLED
async def test_the_register_draft_names_every_part_it_leaves_out(db_session: AsyncSession) -> None:
    building = await create_building(db_session)
    db_session.add(
        BuildingRegistryRecord(
            building_id=building.id,
            proposal=block(
                flat("1"),
                flat("1"),
                flat("x" * 33),
                EEUnit(number=None, kind=UnitKind.APARTMENT, area_m2=D("20")),
                EEUnit(number="K1", kind=UnitKind.NON_RESIDENTIAL, area_m2=D("20")),
            ),
        )
    )
    await db_session.commit()

    code, printed, _ = await template_to_text(
        db_session, with_register(), from_register_code=NO_REGISTER_BLOCK, meters="GAS",
        building_meters=False,
    )  # fmt: skip

    assert code == 0, printed
    assert printed.splitlines() == [
        "template - written: 1 apartments, 1 meters (1 apartment, 0 building)",
        "left out: part without a number (NO_NUMBER)",
        "left out: part K1 (NON_RESIDENTIAL)",
        "left out: part 1 (NUMBER_REPEATED)",
        f"left out: part {'x' * 33} (NUMBER_TOO_LONG)",
    ]


@FILLED
async def test_an_unedited_register_template_imports_as_it_is(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """Register areas rounded half up, a basement floor guarded and unguarded again, entrances
    by positions in the natural order of the numbers."""
    building = await create_building(db_session)
    db_session.add(
        BuildingRegistryRecord(
            building_id=building.id,
            proposal=block(
                flat("1", "48.445", -1),
                flat("2", "40.4", 1),
                flat("10", "33", 2),
                flat("14", "60.005", 4),
                flat("14A", "20", 4),
            ),
        )
    )
    await db_session.commit()
    path = tmp_path / "t.csv"

    code, printed = await template(
        db_session, path, with_register(), from_register_code=NO_REGISTER_BLOCK,
        entrances="1-3,4-5", meters="COLD_WATER", building_meters=True,
    )  # fmt: skip
    assert code == 0, printed
    lines = path.read_bytes().decode("utf-8-sig").split("\r\n")
    assert lines[1:4] == [
        "1;1;'-1;48,45;COLD_WATER;m3;;;;",
        "2;1;1;40,40;COLD_WATER;m3;;;;",
        "10;1;2;33,00;COLD_WATER;m3;;;;",
    ]

    code, printed = await importing(db_session, path)

    assert (code, printed) == (
        0,
        "imported: 5 apartments, 5 apartment meters, 1 building meters, 0 areas rounded\n",
    )
    stored = {
        a.number: (a.entrance, a.floor, a.area_m2)
        for a in await db_session.scalars(select(Apartment))
    }
    assert stored == {
        "1": (1, -1, D("48.45")),
        "2": (1, 1, D("40.40")),
        "10": (1, 2, D("33.00")),
        "14": (2, 4, D("60.01")),
        "14A": (2, 4, D("20.00")),
    }


@FILLED
async def test_an_unedited_counted_template_asks_for_every_entrance_and_area(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await create_building(db_session)
    await db_session.commit()
    path = tmp_path / "t.csv"
    assert (await template(db_session, path, apartments=2, meters="COLD_WATER"))[0] == 0

    code, printed = await importing(db_session, path, dry_run=True)

    assert (code, printed.splitlines()) == (
        2,
        [
            "row 2: entrance: required",
            "row 2: area_m2: required",
            "row 3: entrance: required",
            "row 3: area_m2: required",
            "error: 4 problems, nothing written",
        ],
    )


@FILLED
async def test_two_meters_of_a_type_in_the_template_get_locations_1_and_2(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await create_building(db_session)
    await db_session.commit()
    path = tmp_path / "t.csv"
    drafted = await template(
        db_session, path, apartments=1, entrances="1", meters="COLD_WATER:2", building_meters=False
    )
    assert drafted[0] == 0
    text = path.read_text(encoding="utf-8-sig").replace(";;COLD_WATER", ";40;COLD_WATER")
    path.write_text(text, encoding="utf-8")

    code, printed = await importing(db_session, path, dry_run=True)

    # Prefilled "1" and "2" tell the two apart until the chairman names them.
    assert ";COLD_WATER;m3;;1;" in text and ";COLD_WATER;m3;;2;" in text
    assert (code, printed) == (
        0,
        "checked: 1 apartments, 2 apartment meters, 0 building meters, 0 areas rounded\n",
    )


@pytest.mark.parametrize(
    ("options", "message"),
    [
        ({"apartments": 0}, "error: --apartments must be from 1 to 1000"),
        ({"apartments": 1001}, "error: --apartments must be from 1 to 1000"),
        ({"apartments": -3}, "error: --apartments must be from 1 to 1000"),
        ({"apartments": 3, "entrances": "1-2,,3"}, "error: --entrances '' is not a position"),
        ({"apartments": 3, "entrances": "0-3"}, "error: --entrances '0-3' is not a range"),
        ({"apartments": 3, "meters": ""}, "error: --meters '' is not TYPE or TYPE:count"),
        ({"apartments": 3, "meters": "GAS:0"}, "error: --meters the count of GAS must be from"),
        ({"apartments": 3, "meters": "GAS,"}, "error: --meters '' is not TYPE or TYPE:count"),
        ({"apartments": 3, "meters": "GAS: 2"}, "error: --meters 'GAS: 2' is not TYPE"),
    ],
)
@FILLED
async def test_wrong_template_options_are_exit_2_and_write_no_file(
    db_session: AsyncSession, tmp_path: Path, options: dict, message: str
) -> None:
    await create_building(db_session)
    await db_session.commit()
    path = tmp_path / "t.csv"

    code, printed = await template(db_session, path, **options)

    assert code == 2 and printed.startswith(message), printed
    assert not path.exists()


@FILLED
async def test_the_largest_counted_template_and_its_options(db_session: AsyncSession) -> None:
    await create_building(db_session)
    await db_session.commit()

    code, printed, text = await template_to_text(
        db_session, apartments=1000, entrances="1-500, 501-1000", meters="electricity",
        building_meters=False,
    )  # fmt: skip

    assert code == 0, printed
    assert (
        printed == "template - written: 1000 apartments, 1000 meters (1000 apartment, 0 building)\n"
    )
    lines = text.lstrip("\ufeff").split("\r\n")[1:-1]
    assert len(lines) == 1000
    assert lines[0] == "1;1;;;ELECTRICITY;kWh;;;;"
    assert lines[-1] == "1000;2;;;ELECTRICITY;kWh;;;;"
    assert all(not line.startswith(";") for line in lines)  # --no-building-meters


@pytest.mark.parametrize(
    "argv",
    [
        ["building-template", "--out", "-", "--apartments", "2", "--from-register"],
        ["building-template", "--out", "-"],
        ["building-template", "--out", "-", "--apartments", "two"],
        ["import-building"],
    ],
)
def test_a_wrong_command_line_is_exit_2_before_anything_runs(argv: list[str], capsys) -> None:
    with pytest.raises(SystemExit) as stopped:
        main(argv, session_factory=lambda: pytest.fail("no session is opened"))

    assert stopped.value.code == 2
    assert "error:" in capsys.readouterr().err


@FILLED
async def test_an_out_file_in_a_missing_directory_is_an_error_line_not_a_traceback(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await create_building(db_session)
    await db_session.commit()

    code, printed = await template(db_session, tmp_path / "missing" / "t.csv", apartments=1)

    assert code in (1, 2)
    assert printed.startswith("error: ")


@pytest.mark.parametrize(
    ("data", "message"),
    [
        (b"x" * (MAX_FILE_BYTES + 10), "error: the file is larger than 5 MB\n"),
        (b"", "error: the file is empty\n"),
    ],
)
async def test_standard_input_has_the_same_limits_as_a_file(
    db_session: AsyncSession, data: bytes, message: str
) -> None:
    printed = io.StringIO()

    code = await import_building(
        factory_of(db_session), file_path=None, dry_run=True, out=printed, stdin=io.BytesIO(data)
    )

    assert (code, printed.getvalue()) == (2, message)


@FILLED
async def test_a_building_of_a_country_without_a_register_is_exit_4(
    db_session: AsyncSession,
) -> None:
    building = await create_building(db_session)
    building.country_code = "LV"
    await db_session.commit()

    code, printed, text = await template_to_text(
        db_session, with_register(), from_register_code="101036416"
    )

    assert (code, printed, text) == (4, "error: no register provider of LV is enabled\n", "")
