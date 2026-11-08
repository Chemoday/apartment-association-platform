"""A building for the maintenance calendar tests.

Apt 14 (entrance 2) owned by Ivan Petrov; Apt 2 (entrance 1) rented by Mari Tamm. Staff: the
chairman, a board member (Apt 15, entrance 2) and an accountant. A second building with its own
chairman, who must never see this building's calendar.
"""

from dataclasses import dataclass
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.modules.property.models import Apartment, Building, User
from src.modules.property.schemas import BuildingRole
from tests.factories import (
    create_apartment,
    create_building,
    create_demo_building,
    create_membership,
    create_user,
)


@dataclass
class MaintWorld:
    building: Building
    apt_14: Apartment
    apt_2: Apartment
    owner_14: User
    tenant_2: User
    board_15: User
    chairman: User
    accountant: User
    other_chairman: User
    other_apartment: Apartment


def local_today() -> date:
    return datetime.now(ZoneInfo(get_settings().INSTANCE_TIMEZONE)).date()


@pytest.fixture
async def world(db_session: AsyncSession) -> MaintWorld:
    return await build_maint_world(db_session)


async def build_maint_world(db_session: AsyncSession) -> MaintWorld:
    demo = await create_demo_building(db_session)
    apt_15 = await create_apartment(db_session, demo.building, "15", entrance=2, floor=5)
    board_15 = await create_user(db_session, demo.building, "Peeter Saar", role=BuildingRole.BOARD)
    await create_membership(db_session, board_15, apt_15)
    accountant = await create_user(
        db_session, demo.building, "Anna Kask", role=BuildingRole.ACCOUNTANT
    )
    other = await create_building(db_session, name="KÜ Tamme 3")
    other_apartment = await create_apartment(db_session, other, "1")
    other_chairman = await create_user(db_session, other, "Kalle Kask", role=BuildingRole.CHAIRMAN)
    return MaintWorld(
        building=demo.building,
        apt_14=demo.apt_14,
        apt_2=demo.apt_2,
        owner_14=demo.owner_14,
        tenant_2=demo.tenant_2,
        board_15=board_15,
        chairman=demo.chairman,
        accountant=accountant,
        other_chairman=other_chairman,
        other_apartment=other_apartment,
    )
