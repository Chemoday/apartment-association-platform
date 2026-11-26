"""The import's check against the register (owner, 2026-11-21): warnings, never refusals.

docs/API.md section 1, `import-building`. A spreadsheet can lose an apartment (its rows deleted)
or change an area (45,36 read as 4536); the register's draft of the same building shows both.
Numbers and areas of a building are no personal data.
"""

from decimal import Decimal

from src.core.filling.draft import DraftApartmentRow
from src.core.filling.layout import BuildingLayout, round_area, same_number
from src.modules.property.schemas import ObjectKind

MAX_NUMBERS = 10
MAX_AREA_LINES = 20
AREA_TOLERANCE_M2 = Decimal("1")
AREA_TOLERANCE_SHARE = Decimal("0.02")


def _numbers(numbers: list[str]) -> str:
    shown = ", ".join(numbers[:MAX_NUMBERS])
    more = len(numbers) - MAX_NUMBERS
    return shown + (f" and {more} more" if more > 0 else "")


def register_warnings(layout: BuildingLayout, register: list[DraftApartmentRow]) -> list[str]:
    """Apartments the file or the register lacks, and areas that differ by more than 1 m2 and
    2 % (both, so rounding and small measuring differences never warn)."""
    # The register lists apartments; parking spaces and garages are compared later (epic E12 X3).
    in_file = {
        same_number(a.number): a for a in layout.apartments if a.kind == ObjectKind.APARTMENT
    }
    in_register = {same_number(a.number): a for a in register}
    warnings: list[str] = []
    lacking = [a.number for key, a in in_register.items() if key not in in_file]
    if lacking:
        warnings.append(
            "warning: the register lists apartments the file does not have: " + _numbers(lacking)
        )
    extra = [a.number for key, a in in_file.items() if key not in in_register]
    if extra:
        warnings.append(
            "warning: the file has apartments the register does not list: " + _numbers(extra)
        )
    areas = 0
    for key, apartment in in_file.items():
        listed = in_register.get(key)
        if listed is None or listed.area_m2 is None:
            continue
        register_area = round_area(listed.area_m2)
        difference = abs(apartment.area_m2 - register_area)
        if difference > AREA_TOLERANCE_M2 and difference > register_area * AREA_TOLERANCE_SHARE:
            areas += 1
            if areas <= MAX_AREA_LINES:
                warnings.append(
                    f"warning: apartment {apartment.number}: area {apartment.area_m2} m2, "
                    f"the register says {register_area} m2"
                )
    if areas > MAX_AREA_LINES:
        warnings.append(f"warning: and {areas - MAX_AREA_LINES} more areas differ")
    return warnings
