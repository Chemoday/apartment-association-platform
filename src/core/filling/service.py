"""Laying a new building out: the checks of the installation and the one transaction.

Writes only through the services of `property` and `meters` (docs/ARCHITECTURE.md section 15);
the setup wizard (epic E13 R7) will call the same functions.
"""

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.filling.layout import BuildingLayout
from src.core.instance import is_real_installation
from src.modules.meters.schemas import NewMeter
from src.modules.meters.service import MetersService
from src.modules.property.schemas import NewApartment
from src.modules.property.service import PropertyService

FILLING_LOCK_KEY = 7_202_612_001


class FillingRefused(Exception):
    """The installation cannot be filled now; `message` follows `error: `."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


@dataclass(frozen=True)
class FillingTarget:
    building_id: uuid.UUID
    country_code: str


async def filling_target(session: AsyncSession) -> FillingTarget:
    """The building to fill, under the filling lock (two runs at once fill it once).

    Refuses unless the installation is a real one, has its building, and that building has no
    apartment and no meter yet."""
    await session.execute(select(func.pg_advisory_xact_lock(FILLING_LOCK_KEY)))
    if not await is_real_installation(session):
        raise FillingRefused(
            "the installation is not marked as a real one (start the backend once without "
            "demo mode and without the seed)"
        )
    properties = PropertyService(session)
    building_ids = await properties.building_ids()
    if not building_ids:
        raise FillingRefused("the installation has no building yet: run create-building first")
    building_id = building_ids[0]
    meters = MetersService(session, properties)
    if await properties.has_apartments(building_id) or await meters.has_meters(building_id):
        raise FillingRefused(
            "the building already has apartments or meters: a new building is filled once"
        )
    return FillingTarget(building_id, await properties.building_country(building_id))


async def lay_out(session: AsyncSession, target: FillingTarget, layout: BuildingLayout) -> None:
    """Every object and meter of the layout; the caller's transaction commits or not."""
    properties = PropertyService(session)
    ids = await properties.create_apartments(
        target.building_id,
        [
            NewApartment(
                kind=a.kind,
                number=a.number,
                entrance=a.entrance,
                floor=a.floor,
                area_m2=a.area_m2,
            )
            for a in layout.apartments
        ],
    )
    await MetersService(session, properties).create_meters(
        target.building_id,
        [
            NewMeter(
                apartment_id=ids[m.apartment] if m.apartment is not None else None,
                resource_type=m.resource,
                unit=m.unit,
                serial_number=m.serial_number,
                location_label=m.location,
                initial_value=m.initial_value,
                max_monthly_delta=m.max_monthly_delta,
            )
            for m in layout.meters
        ],
    )
