"""Test data builders. Tests may use models directly; application modules may not."""

import uuid
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.modules.meters.models import MeterDevice, MeterReading, ReadingPeriod
from src.modules.meters.policies import period_due_date
from src.modules.meters.schemas import (
    MeterUnit,
    PeriodStatus,
    PreviousOrigin,
    ReadingSource,
    ResourceType,
)
from src.modules.property.models import Apartment, ApartmentMembership, Building, User
from src.modules.property.schemas import BuildingRole, DisplayMode, ObjectKind, RelationType


async def create_building(session: AsyncSession, name: str = "KÜ Sõpruse 12") -> Building:
    building = Building(name=name, address="Sõpruse pst 12, Tallinn")
    session.add(building)
    await session.flush()
    return building


async def create_object(
    session: AsyncSession,
    building: Building,
    kind: ObjectKind,
    number: str,
    *,
    entrance: int | None = None,
    floor: int | None = None,
    area: Decimal | None = None,
) -> Apartment:
    """An object of any kind (epic E14); a parking space or a garage has no entrance."""
    apartment = Apartment(
        building_id=building.id,
        kind=kind,
        number=number,
        entrance=entrance,
        floor=floor,
        area_m2=area,
    )
    session.add(apartment)
    await session.flush()
    return apartment


async def create_apartment(
    session: AsyncSession, building: Building, number: str, entrance: int = 1, floor: int = 1
) -> Apartment:
    return await create_object(
        session,
        building,
        ObjectKind.APARTMENT,
        number,
        entrance=entrance,
        floor=floor,
        area=Decimal("54.30"),
    )


async def create_user(
    session: AsyncSession,
    building: Building,
    full_name: str,
    role: BuildingRole = BuildingRole.USER,
    email: str | None = None,
    phone: str | None = None,
    is_active: bool = True,
) -> User:
    user = User(
        building_id=building.id,
        full_name=full_name,
        building_role=role,
        email=email,
        phone=phone,
        is_active=is_active,
    )
    session.add(user)
    await session.flush()
    return user


async def create_membership(
    session: AsyncSession,
    user: User,
    apartment: Apartment,
    relation: RelationType = RelationType.OWNER,
    mode: DisplayMode = DisplayMode.APARTMENT_ONLY,
) -> ApartmentMembership:
    membership = ApartmentMembership(
        apartment_id=apartment.id,
        user_id=user.id,
        relation_type=relation,
        can_vote=relation == RelationType.OWNER,
        privacy_display_mode=mode,
    )
    session.add(membership)
    await session.flush()
    return membership


@dataclass
class DemoBuilding:
    building: Building
    apt_14: Apartment
    apt_2: Apartment
    owner_14: User
    owner_14_membership: ApartmentMembership
    tenant_2: User
    tenant_2_membership: ApartmentMembership
    chairman: User


async def create_demo_building(session: AsyncSession) -> DemoBuilding:
    """Apt 14 (entrance 2) owned by Ivan Petrov, Apt 2 (entrance 1) rented, plus a chairman."""
    building = await create_building(session)
    apt_14 = await create_apartment(session, building, "14", entrance=2, floor=4)
    apt_2 = await create_apartment(session, building, "2", entrance=1, floor=1)
    owner_14 = await create_user(
        session,
        building,
        "Ivan Petrov",
        email=f"ivan.petrov.{uuid.uuid4().hex[:8]}@example.com",
        phone="+372 5555 1234",
    )
    tenant_2 = await create_user(session, building, "Mari Tamm", email=None, phone="+372 5111 2222")
    chairman = await create_user(
        session, building, "Oleg Sidorov", role=BuildingRole.CHAIRMAN, phone="+372 5000 0001"
    )
    return DemoBuilding(
        building=building,
        apt_14=apt_14,
        apt_2=apt_2,
        owner_14=owner_14,
        owner_14_membership=await create_membership(session, owner_14, apt_14),
        tenant_2=tenant_2,
        tenant_2_membership=await create_membership(
            session, tenant_2, apt_2, relation=RelationType.TENANT
        ),
        chairman=chairman,
    )


# --- meters --------------------------------------------------------------------------------------


async def create_meter(
    session: AsyncSession,
    building: Building,
    apartment: Apartment | None,
    resource_type: ResourceType = ResourceType.COLD_WATER,
    initial_value: Decimal | None = Decimal("0.000"),
    max_monthly_delta: Decimal = Decimal("25.000"),
    serial_number: str | None = "",
) -> MeterDevice:
    """apartment=None creates a Building Master Meter."""
    meter = MeterDevice(
        building_id=building.id,
        apartment_id=apartment.id if apartment else None,
        resource_type=resource_type,
        serial_number=f"SN-{uuid.uuid4().hex[:10]}" if serial_number == "" else serial_number,
        location_label="Basement Master" if apartment is None else "Bathroom",
        initial_value=initial_value,
        max_monthly_delta=max_monthly_delta,
    )
    session.add(meter)
    await session.flush()
    return meter


async def create_period(
    session: AsyncSession,
    building: Building,
    period_code: str = "2026-10",
    status: PeriodStatus = PeriodStatus.OPEN_FOR_RESIDENTS,
) -> ReadingPeriod:
    period = ReadingPeriod(
        building_id=building.id,
        period_code=period_code,
        status=status,
        due_date=period_due_date(
            period_code, building.reading_deadline_day, get_settings().INSTANCE_TIMEZONE
        ),
    )
    session.add(period)
    await session.flush()
    return period


async def create_reading(
    session: AsyncSession,
    meter: MeterDevice,
    period: ReadingPeriod,
    value: Decimal,
    previous_value: Decimal,
    source: ReadingSource = ReadingSource.RESIDENT,
    submitted_by: User | None = None,
    previous_origin: PreviousOrigin = PreviousOrigin.HISTORY,
) -> MeterReading:
    reading = MeterReading(
        building_id=meter.building_id,
        meter_id=meter.id,
        period_id=period.id,
        value=value,
        previous_value=previous_value,
        previous_origin=previous_origin,
        consumption_delta=value - previous_value,
        source=source,
        submitted_by_user_id=submitted_by.id if submitted_by else None,
    )
    session.add(reading)
    await session.flush()
    return reading


# --- A mixed building (epic E14, section 6.2) -----------------------------------------------------


@dataclass
class MixedBuilding:
    """Apartments, parking spaces and garages, and the people of the design's tables."""

    building: Building
    apt_1: Apartment
    apt_14: Apartment
    p_1: Apartment
    p_2: Apartment  # number "P-2", floor -1, an electricity meter, no area
    g_12: Apartment  # 18.50 m2, an electricity meter
    g_1: Apartment
    g_7: Apartment  # no members
    a: User  # owner of Apt 14 and of P1
    b: User  # owner of G12 only, INITIALS
    c: User  # tenant of P-2 only
    d: User  # owner of Apt 1
    e: User  # tenant of Apt 1
    x: User  # tenant of Apt 1 and of P-2
    r: User  # RESIDENT of Apt 14
    board_member: User  # owner of G1
    chairman: User  # no membership
    accountant: User  # no membership

    @property
    def people(self) -> dict[str, User]:
        return {
            "A": self.a,
            "B": self.b,
            "C": self.c,
            "D": self.d,
            "E": self.e,
            "X": self.x,
            "R": self.r,
            "board member": self.board_member,
            "chairman": self.chairman,
            "accountant": self.accountant,
        }


async def create_mixed_building(session: AsyncSession) -> MixedBuilding:
    building = await create_building(session, name="KÜ Segamaja 7")
    apt_1 = await create_apartment(session, building, "1", entrance=1, floor=1)
    apt_14 = await create_apartment(session, building, "14", entrance=2, floor=4)
    p_1 = await create_object(session, building, ObjectKind.PARKING, "1")
    p_2 = await create_object(session, building, ObjectKind.PARKING, "P-2", floor=-1)
    g_12 = await create_object(session, building, ObjectKind.GARAGE, "12", area=Decimal("18.50"))
    g_1 = await create_object(session, building, ObjectKind.GARAGE, "1")
    g_7 = await create_object(session, building, ObjectKind.GARAGE, "7")

    async def person(name: str, role: BuildingRole = BuildingRole.USER) -> User:
        return await create_user(
            session, building, name, role=role, email=f"{uuid.uuid4().hex[:12]}@example.com"
        )

    a, b, c = await person("Anna Aru"), await person("Toomas Kask"), await person("Carl Cee")
    d, e, x = await person("Dina Dee"), await person("Eero Ee"), await person("Xena Iks")
    r = await person("Rita Arr")
    board_member = await person("Boris Board", BuildingRole.BOARD)
    chairman = await person("Chair Man", BuildingRole.CHAIRMAN)
    accountant = await person("Acc Ountant", BuildingRole.ACCOUNTANT)
    tenant = RelationType.TENANT
    for user, apartment, relation, mode in [
        (a, apt_14, RelationType.OWNER, DisplayMode.APARTMENT_ONLY),
        (a, p_1, RelationType.OWNER, DisplayMode.APARTMENT_ONLY),
        (b, g_12, RelationType.OWNER, DisplayMode.INITIALS),
        (c, p_2, tenant, DisplayMode.APARTMENT_ONLY),
        (d, apt_1, RelationType.OWNER, DisplayMode.APARTMENT_ONLY),
        (e, apt_1, tenant, DisplayMode.APARTMENT_ONLY),
        (x, apt_1, tenant, DisplayMode.APARTMENT_ONLY),
        (x, p_2, tenant, DisplayMode.APARTMENT_ONLY),
        (r, apt_14, RelationType.RESIDENT, DisplayMode.APARTMENT_ONLY),
        (board_member, g_1, RelationType.OWNER, DisplayMode.APARTMENT_ONLY),
    ]:
        await create_membership(session, user, apartment, relation=relation, mode=mode)
    for apartment in (p_2, g_12):
        meter = await create_meter(
            session,
            building,
            apartment,
            ResourceType.ELECTRICITY,
            max_monthly_delta=Decimal("1000.000"),
        )
        meter.unit = MeterUnit.KWH
    await session.flush()
    return MixedBuilding(
        building=building,
        apt_1=apt_1,
        apt_14=apt_14,
        p_1=p_1,
        p_2=p_2,
        g_12=g_12,
        g_1=g_1,
        g_7=g_7,
        a=a,
        b=b,
        c=c,
        d=d,
        e=e,
        x=x,
        r=r,
        board_member=board_member,
        chairman=chairman,
        accountant=accountant,
    )
