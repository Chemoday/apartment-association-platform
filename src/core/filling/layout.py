"""The rules of a building's layout: rows in, a checked BuildingLayout or problems out.

docs/API.md section 1, "Filling the building of a new installation", is binding. The rows are
plain text cells by column name, whatever front end produced them (the CSV template today, the
setup wizard of epic E13 R7 later), so every rule lives here once. Pure: no I/O, no database.
"""

import re
import unicodedata
from dataclasses import dataclass, field, replace
from decimal import ROUND_HALF_UP, Decimal

from src.core.csv_safety import neutralize_formula
from src.modules.meters.schemas import METER_VALUE_MAX, MeterUnit, ResourceType
from src.modules.property.schemas import ObjectKind, ObjectRef, object_label, parse_object_ref

COLUMNS = (
    "apartment",
    "entrance",
    "floor",
    "area_m2",
    "resource",
    "unit",
    "serial_number",
    "location",
    "initial_value",
    "max_monthly_delta",
    # Epic E14: after the meter columns, which older tooling may take by position; optional.
    "kind",
)
APARTMENT_COLUMNS = ("apartment", "entrance", "floor", "area_m2")
REQUIRED_COLUMNS = ("apartment", "entrance", "area_m2", "resource")
METER_COLUMNS = COLUMNS[4:10]
KINDS = ", ".join(kind.value for kind in ObjectKind)

NUMBER_MAX_LENGTH = 32  # property_apartments.number
TEXT_MAX_LENGTH = 100  # serial_number, location_label
DEFAULT_LOCATION = "Main"
ENTRANCE_RANGE = (1, 99)
FLOOR_RANGE = (-5, 200)
DEFAULT_FLOOR = 1
AREA_PRECISION = Decimal("0.01")
AREA_MAX = Decimal("999999.99")  # NUMERIC(8, 2)
METER_PRECISION = Decimal("0.001")

# The units each type allows (the first is the default) and the default max_monthly_delta of an
# apartment meter and of a building meter, in the default unit.
UNITS: dict[ResourceType, tuple[MeterUnit, ...]] = {
    ResourceType.COLD_WATER: (MeterUnit.M3,),
    ResourceType.HOT_WATER: (MeterUnit.M3,),
    ResourceType.GAS: (MeterUnit.M3,),
    ResourceType.ELECTRICITY: (MeterUnit.KWH, MeterUnit.MWH),
    ResourceType.HEAT: (MeterUnit.KWH, MeterUnit.MWH),
}
LIMITS: dict[ResourceType, tuple[Decimal, Decimal]] = {
    ResourceType.COLD_WATER: (Decimal("25.000"), Decimal("500.000")),
    ResourceType.HOT_WATER: (Decimal("15.000"), Decimal("500.000")),
    ResourceType.GAS: (Decimal("50.000"), Decimal("1000.000")),
    ResourceType.ELECTRICITY: (Decimal("1000.000"), Decimal("20000.000")),
    ResourceType.HEAT: (Decimal("2000.000"), Decimal("100000.000")),
}

_NOT_ONE_LINE = frozenset({"Cc", "Cf", "Zl", "Zp"})  # the rule of create-building
_INTEGER = re.compile(r"-?[0-9]{1,6}")
_DECIMAL = re.compile(r"[0-9]{1,12}([.,][0-9]+)?")
# Thousands grouped by spaces as a spreadsheet shows them: "12 345,5" (also no-break spaces).
_GROUPED = re.compile(r"[0-9]{1,3}([ \u00a0\u202f][0-9]{3})+([.,][0-9]+)?")
_SPACES = re.compile(r"[ \u00a0\u202f]")
# What a spreadsheet makes of a long number typed into a General cell: "1,23457E+16".
_SPREADSHEET_EXPONENT = re.compile(r"[0-9]+([.,][0-9]+)?[eE][+-]?[0-9]+")
# A building meter's default limit grows with the building: the apartment default per apartment,
# twice over (one month may run high everywhere), but never below the table's building default.
BUILDING_LIMIT_FACTOR = 2


@dataclass(frozen=True)
class RowInput:
    """One row of a layout: `ref` names it in problems (the CSV line number)."""

    ref: int
    cells: dict[str, str]


@dataclass(frozen=True)
class Problem:
    ref: int
    column: str
    message: str

    def __str__(self) -> str:
        return f"row {self.ref}: {self.column}: {self.message}"


@dataclass(frozen=True)
class LayoutApartment:
    """An object of any kind (epic E14): only an apartment has an entrance, and a floor and an
    area are required for it only."""

    number: str
    entrance: int | None
    floor: int | None
    area_m2: Decimal | None
    kind: ObjectKind = ObjectKind.APARTMENT

    @property
    def ref(self) -> ObjectRef:
        return ObjectRef(self.kind, self.number)


@dataclass(frozen=True)
class LayoutMeter:
    apartment: ObjectRef | None  # None: a building meter
    resource: ResourceType
    unit: MeterUnit
    serial_number: str | None
    location: str
    initial_value: Decimal | None
    max_monthly_delta: Decimal


@dataclass
class BuildingLayout:
    apartments: list[LayoutApartment] = field(default_factory=list)
    meters: list[LayoutMeter] = field(default_factory=list)
    rounded_areas: int = 0

    def objects_of(self, kind: ObjectKind) -> int:
        return sum(1 for apartment in self.apartments if apartment.kind == kind)

    @property
    def apartment_meters(self) -> int:
        return sum(1 for meter in self.meters if meter.apartment is not None)

    @property
    def building_meters(self) -> int:
        return sum(1 for meter in self.meters if meter.apartment is None)


def unguard(cell: str) -> str:
    """Undo the template's formula guard: a cell that neutralize_formula would quote again."""
    if cell.startswith("'") and neutralize_formula(cell[1:]) == cell:
        return cell[1:]
    return cell


def one_line(text: str) -> bool:
    return not any(unicodedata.category(char) in _NOT_ONE_LINE for char in text)


# Leading zeros of the number or of a part after a letter or a space ("01", "A01"); never after a
# digit or a separator, so "1.05" and "1.5" or "2-01" and "2-1" stay two numbers.
_LEADING_ZEROS = re.compile(r"(?<![0-9.,/\-])0+(?=[0-9])")
_ANY_SPACE = re.compile(r"\s+")


def same_number(number: str) -> str:
    """The key under which two spellings are one apartment: "14 A" = "14a", "01" = "1"."""
    return _LEADING_ZEROS.sub("", _ANY_SPACE.sub("", number.casefold()))


def round_area(value: Decimal) -> Decimal:
    return value.quantize(AREA_PRECISION, rounding=ROUND_HALF_UP)


def default_limit(resource: ResourceType, unit: MeterUnit, building: bool) -> Decimal:
    limit = LIMITS[resource][1 if building else 0]
    if unit == MeterUnit.MWH:
        limit = limit / 1000
    return limit.quantize(METER_PRECISION)


class _Checker:
    """Collects the problems of one layout while building it."""

    def __init__(self) -> None:
        self.problems: list[Problem] = []
        self.layout = BuildingLayout()
        self._apartments: dict[ObjectRef, tuple[int, LayoutApartment]] = {}
        self._meter_keys: dict[tuple[ObjectRef | None, ResourceType, str], int] = {}
        # (kind, same_number()) -> its first row: two spellings are one object within a kind.
        self._spellings: dict[tuple[ObjectKind, str], tuple[int, str]] = {}
        # (kind, same_number(label)) -> its first row: "1", "P1" and "P 01" are all P1.
        self._labels: dict[tuple[ObjectKind, str], int] = {}
        self._scaled: list[int] = []  # building meters whose limit took the default

    def scale_building_limits(self) -> None:
        """A building meter carries the whole building: its default limit grows with the count
        of objects of every kind (the master meter measures them all), so a large building is
        not flagged as an anomaly every month."""
        count = len(self.layout.apartments)
        for index in self._scaled:
            meter = self.layout.meters[index]
            apartment_default = default_limit(meter.resource, meter.unit, building=False)
            scaled = (apartment_default * count * BUILDING_LIMIT_FACTOR).quantize(METER_PRECISION)
            if scaled > meter.max_monthly_delta:
                self.layout.meters[index] = replace(
                    meter, max_monthly_delta=min(scaled, METER_VALUE_MAX)
                )

    def problem(self, ref: int, column: str, message: str) -> None:
        self.problems.append(Problem(ref, column, message))

    # --- cells ----------------------------------------------------------------------------------

    def integer(self, ref: int, column: str, text: str, bounds: tuple[int, int]) -> int | None:
        if not _INTEGER.fullmatch(text):
            self.problem(ref, column, "a whole number is needed")
            return None
        value = int(text)
        if not bounds[0] <= value <= bounds[1]:
            self.problem(ref, column, f"must be from {bounds[0]} to {bounds[1]}")
            return None
        return value

    def decimal(self, ref: int, column: str, text: str) -> Decimal | None:
        if _GROUPED.fullmatch(text):
            text = _SPACES.sub("", text)
        if not _DECIMAL.fullmatch(text):
            self.problem(ref, column, "a number with a decimal point or comma is needed")
            return None
        return Decimal(text.replace(",", "."))

    def meter_value(self, ref: int, column: str, text: str, positive: bool) -> Decimal | None:
        value = self.decimal(ref, column, text)
        if value is None:
            return None
        if value != value.quantize(METER_PRECISION):
            self.problem(ref, column, "at most 3 decimal places")
            return None
        if value > METER_VALUE_MAX:
            self.problem(ref, column, f"at most {METER_VALUE_MAX}")
            return None
        if positive and value <= 0:
            self.problem(ref, column, "must be greater than 0")
            return None
        return value.quantize(METER_PRECISION)

    def text(self, ref: int, column: str, text: str, max_length: int) -> str | None:
        if not one_line(text):
            self.problem(ref, column, "one line of visible text")
            return None
        if len(text) > max_length:
            self.problem(ref, column, f"at most {max_length} characters")
            return None
        return text

    # --- rows -----------------------------------------------------------------------------------

    def row(self, row: RowInput) -> None:
        """Every cell of the row is checked, so one run reports all its problems."""
        cells = {column: unguard(row.cells.get(column, "").strip()) for column in COLUMNS}
        number = cells["apartment"]
        has_meter = any(cells[column] for column in METER_COLUMNS)
        if number:
            placed = self.apartment(row.ref, cells)
            if has_meter:
                self.meter(row.ref, cells, placed, add=placed is not None)
            return
        for column in ("entrance", "floor", "area_m2", "kind"):
            if cells[column]:
                self.problem(row.ref, column, "must be empty for a building meter")
        self.meter(row.ref, cells, None, add=True)

    def apartment(self, ref: int, cells: dict[str, str]) -> ObjectRef | None:
        """The object of the row, or None when the row has a problem (every cell is checked)."""
        before = len(self.problems)
        number = self.text(ref, "apartment", cells["apartment"], NUMBER_MAX_LENGTH)
        try:
            kind: ObjectKind | None = parse_object_ref(cells["kind"], "").kind
        except ValueError:
            self.problem(ref, "kind", f"one of {KINDS}")
            kind = None
        # An unknown kind reports only itself: what the row would need depends on the kind.
        flat = kind == ObjectKind.APARTMENT
        entrance = None
        if cells["entrance"]:
            if kind in (ObjectKind.APARTMENT, None):
                entrance = self.integer(ref, "entrance", cells["entrance"], ENTRANCE_RANGE)
            else:
                self.problem(ref, "entrance", "a parking space or a garage has no entrance")
        elif flat:
            self.problem(ref, "entrance", "required")
        floor = (
            self.integer(ref, "floor", cells["floor"], FLOOR_RANGE)
            if cells["floor"]
            else (DEFAULT_FLOOR if flat else None)  # another kind's empty floor stays empty
        )
        area = raw = None
        if not cells["area_m2"]:
            if flat:
                self.problem(ref, "area_m2", "required")
        else:
            raw = self.decimal(ref, "area_m2", cells["area_m2"])
            if raw is not None:
                area = round_area(raw)
                if area <= 0:
                    self.problem(ref, "area_m2", "must be greater than 0")
                elif area > AREA_MAX:
                    self.problem(ref, "area_m2", f"at most {AREA_MAX}")
        if len(self.problems) > before or number is None or kind is None:
            return None
        apartment = LayoutApartment(
            number=number, entrance=entrance, floor=floor, area_m2=area, kind=kind
        )
        first = self._apartments.get(apartment.ref)
        if first is None:
            other = self._spellings.get((kind, same_number(number)))
            if other is not None:
                self.problem(
                    ref, "apartment", f"the same number as row {other[0]}, written differently"
                )
                return None
            label = object_label(kind, number)
            # Compared as two spellings are: "P 1" and "P01" are P1 too.
            clash = self._labels.get((kind, same_number(label)))
            if clash is not None and kind != ObjectKind.APARTMENT:
                self.problem(ref, "apartment", f"the same label {label} as row {clash}")
                return None
            self._spellings[(kind, same_number(number))] = (ref, number)
            self._labels[(kind, same_number(label))] = ref
            self._apartments[apartment.ref] = (ref, apartment)
            self.layout.apartments.append(apartment)
            if area != raw:
                self.layout.rounded_areas += 1
            return apartment.ref
        if first[1] != apartment:
            self.problem(ref, "apartment", f"entrance, floor or area differ from row {first[0]}")
            return None
        return apartment.ref

    def meter(
        self, ref: int, cells: dict[str, str], apartment: ObjectRef | None, add: bool
    ) -> None:
        """Checks every meter cell; adds the meter only when they and its apartment are right."""
        before = len(self.problems)
        resource = None
        if not cells["resource"]:
            self.problem(ref, "resource", "required")
        else:
            try:
                resource = ResourceType(cells["resource"].upper())
            except ValueError:
                self.problem(ref, "resource", "one of " + ", ".join(t.value for t in ResourceType))
        unit = None
        if resource is not None:
            allowed = UNITS[resource]
            unit = allowed[0]
            if cells["unit"]:
                unit = next((u for u in allowed if u.value.lower() == cells["unit"].lower()), None)
                if unit is None:
                    self.problem(
                        ref,
                        "unit",
                        f"{resource.value} allows " + ", ".join(u.value for u in allowed),
                    )
        serial = (
            self.text(ref, "serial_number", cells["serial_number"], TEXT_MAX_LENGTH)
            if cells["serial_number"]
            else None
        )
        if serial is not None and _SPREADSHEET_EXPONENT.fullmatch(serial):
            self.problem(
                ref,
                "serial_number",
                "the spreadsheet turned it into an exponent: format the column as text and "
                "type the number again",
            )
            serial = None
        location = (
            self.text(ref, "location", cells["location"], TEXT_MAX_LENGTH)
            if cells["location"]
            else DEFAULT_LOCATION
        )
        initial = (
            self.meter_value(ref, "initial_value", cells["initial_value"], positive=False)
            if cells["initial_value"]
            else None
        )
        limit = (
            self.meter_value(ref, "max_monthly_delta", cells["max_monthly_delta"], positive=True)
            if cells["max_monthly_delta"]
            else None
        )
        defaulted = not cells["max_monthly_delta"]
        if len(self.problems) > before or not add or resource is None or unit is None:
            return
        if location is None:  # cannot happen without a problem; keeps the type checker sure
            return
        if limit is None:
            limit = default_limit(resource, unit, building=apartment is None)
        key = (apartment, resource, location.casefold())
        if key in self._meter_keys:
            self.problem(
                ref,
                "location",
                f"two {resource.value} meters at one place need different locations "
                f"(see row {self._meter_keys[key]})",
            )
            return
        self._meter_keys[key] = ref
        if defaulted and apartment is None:
            self._scaled.append(len(self.layout.meters))
        self.layout.meters.append(
            LayoutMeter(
                apartment=apartment,
                resource=resource,
                unit=unit,
                serial_number=serial,
                location=location,
                initial_value=initial,
                max_monthly_delta=limit,
            )
        )


def check_layout(rows: list[RowInput]) -> tuple[BuildingLayout, list[Problem]]:
    """The layout of the rows and every problem found; the layout counts only without problems.

    An apartment row with every meter column empty declares an apartment without meters; a row
    with an empty apartment is a building meter."""
    checker = _Checker()
    for row in rows:
        checker.row(row)
    if not checker.problems and not checker.layout.apartments:
        checker.problems.append(Problem(0, "apartment", "the layout has no apartments"))
    checker.scale_building_limits()
    return checker.layout, checker.problems
