"""The draft of a building template: apartments from the register or a count, entrances by
ranges of positions, a default set of meters (docs/API.md section 1, `building-template`)."""

import re
from dataclasses import dataclass
from decimal import Decimal

from src.core.filling.layout import NUMBER_MAX_LENGTH, UNITS, round_area
from src.core.filling.template import TemplateRow
from src.modules.meters.schemas import ResourceType
from src.plugins.registry import ApartmentDraft

DEFAULT_METERS = "COLD_WATER,HOT_WATER"
MAX_APARTMENTS = 1000
MAX_METERS_PER_TYPE = 4

_RANGE = re.compile(r"([0-9]{1,4})(?:-([0-9]{1,4}))?")
_METER = re.compile(r"([A-Za-z_]+)(?::([0-9]{1,2}))?")


class DraftError(ValueError):
    """A wrong option of building-template; the message follows `error: <option>`."""


@dataclass(frozen=True)
class DraftApartmentRow:
    number: str
    area_m2: Decimal | None
    floor: int | None


@dataclass(frozen=True)
class LeftOut:
    number: str | None
    reason: str


def parse_meters(text: str) -> list[tuple[ResourceType, int]]:
    """`TYPE[:count]`, comma-separated, each type once, a count from 1 to 4."""
    spec: list[tuple[ResourceType, int]] = []
    for item in (part.strip() for part in text.split(",")):
        match = _METER.fullmatch(item)
        if match is None:
            raise DraftError(f"'{item}' is not TYPE or TYPE:count")
        try:
            resource = ResourceType(match.group(1).upper())
        except ValueError:
            raise DraftError(
                f"'{match.group(1)}' is not one of " + ", ".join(t.value for t in ResourceType)
            ) from None
        count = int(match.group(2) or 1)
        if not 1 <= count <= MAX_METERS_PER_TYPE:
            raise DraftError(f"the count of {resource.value} must be from 1 to 4")
        if any(existing == resource for existing, _ in spec):
            raise DraftError(f"{resource.value} is given twice")
        spec.append((resource, count))
    return spec


def parse_entrances(text: str, apartments: int) -> list[int]:
    """The entrance of each position: ranges `a-b` or single positions, numbered 1, 2, ... in
    the order given; together they must cover positions 1..apartments exactly once."""
    entrance_of: dict[int, int] = {}
    for entrance, item in enumerate((part.strip() for part in text.split(",")), start=1):
        match = _RANGE.fullmatch(item)
        if match is None:
            raise DraftError(f"'{item}' is not a position or a range a-b")
        first = int(match.group(1))
        last = int(match.group(2) or first)
        if first < 1 or last < first:
            raise DraftError(f"'{item}' is not a range of positions from 1")
        if last > apartments:
            raise DraftError(f"'{item}' goes past the last apartment ({apartments})")
        for position in range(first, last + 1):
            if position in entrance_of:
                raise DraftError(f"position {position} is in two ranges")
            entrance_of[position] = entrance
    missing = [p for p in range(1, apartments + 1) if p not in entrance_of]
    if missing:
        raise DraftError(f"position {missing[0]} is in no range")
    return [entrance_of[p] for p in range(1, apartments + 1)]


def from_register(draft: ApartmentDraft) -> tuple[list[DraftApartmentRow], list[LeftOut]]:
    """The provider's draft, with numbers the app cannot hold and repeated numbers left out."""
    apartments: list[DraftApartmentRow] = []
    left_out = [LeftOut(part.number, part.reason) for part in draft.left_out]
    seen: set[str] = set()
    for apartment in draft.apartments:
        number = apartment.number.strip()
        if len(number) > NUMBER_MAX_LENGTH:
            left_out.append(LeftOut(number, "NUMBER_TOO_LONG"))
        elif number in seen:
            left_out.append(LeftOut(number, "NUMBER_REPEATED"))
        else:
            seen.add(number)
            apartments.append(
                DraftApartmentRow(number=number, area_m2=apartment.area_m2, floor=apartment.floor)
            )
    return apartments, left_out


def from_count(count: int) -> list[DraftApartmentRow]:
    if not 1 <= count <= MAX_APARTMENTS:
        raise DraftError(f"must be from 1 to {MAX_APARTMENTS}")
    return [DraftApartmentRow(number=str(n), area_m2=None, floor=None) for n in range(1, count + 1)]


def _area(value: Decimal | None) -> str:
    return "" if value is None else str(round_area(value)).replace(".", ",")


def template_rows(
    apartments: list[DraftApartmentRow],
    entrances: list[int],
    meters: list[tuple[ResourceType, int]],
    building_meters: bool,
) -> list[TemplateRow]:
    """One row per meter: each apartment's meters in the order of `meters`, then one building
    meter per type; `unit` holds the type's default, the other meter columns stay empty."""
    rows: list[TemplateRow] = []
    for apartment, entrance in zip(apartments, entrances, strict=True):
        place = {
            "apartment": apartment.number,
            "entrance": str(entrance),
            "floor": "" if apartment.floor is None else str(apartment.floor),
            "area_m2": _area(apartment.area_m2),
        }
        for resource, count in meters:
            for _ in range(count):
                rows.append(
                    TemplateRow(
                        {**place, "resource": resource.value, "unit": UNITS[resource][0].value}
                    )
                )
    if building_meters:
        for resource, _ in meters:
            rows.append(TemplateRow({"resource": resource.value, "unit": UNITS[resource][0].value}))
    return rows
