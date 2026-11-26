"""The building template names objects by kind and number (epic E14, task K4): the optional kind
column, the rules of a parking space and a garage, colliding labels, and the register check of
apartments only."""

from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.filling.compare import register_warnings
from src.core.filling.draft import DraftApartmentRow
from src.core.filling.layout import RowInput, check_layout
from src.core.filling.service import FillingTarget, lay_out
from src.modules.meters.models import MeterDevice
from src.modules.property.models import Apartment
from src.modules.property.schemas import ObjectKind, ObjectRef
from tests.factories import create_building

D = Decimal


def rows(*cells: dict[str, str]) -> list[RowInput]:
    return [RowInput(ref=index + 2, cells=row) for index, row in enumerate(cells)]


def problems_of(*cells: dict[str, str]) -> list[str]:
    return [f"{p.column}: {p.message}" for p in check_layout(rows(*cells))[1]]


APT_1 = {"apartment": "1", "entrance": "1", "area_m2": "48"}


def test_one_number_under_two_kinds_is_two_objects_with_their_own_meters() -> None:
    layout, problems = check_layout(
        rows(
            {**APT_1, "resource": "COLD_WATER"},
            {"apartment": "1", "kind": "parking", "resource": "ELECTRICITY"},
            {"apartment": "P-2", "kind": "PARKING", "floor": "-1"},
            {"apartment": "12", "kind": "Garage", "area_m2": "18,5", "resource": "ELECTRICITY"},
            {"apartment": "12", "kind": "GARAGE", "area_m2": "18,5", "resource": "HEAT"},
            {"resource": "COLD_WATER"},
        )
    )

    assert problems == []
    assert [(a.kind, a.number, a.entrance, a.floor, a.area_m2) for a in layout.apartments] == [
        (ObjectKind.APARTMENT, "1", 1, 1, D("48.00")),
        # Another kind has no entrance, and its empty floor stays empty (never 1).
        (ObjectKind.PARKING, "1", None, None, None),
        (ObjectKind.PARKING, "P-2", None, -1, None),
        (ObjectKind.GARAGE, "12", None, None, D("18.50")),
    ]
    assert [(m.apartment, m.resource.value) for m in layout.meters] == [
        (ObjectRef(ObjectKind.APARTMENT, "1"), "COLD_WATER"),
        (ObjectRef(ObjectKind.PARKING, "1"), "ELECTRICITY"),
        (ObjectRef(ObjectKind.GARAGE, "12"), "ELECTRICITY"),
        (ObjectRef(ObjectKind.GARAGE, "12"), "HEAT"),
        (None, "COLD_WATER"),
    ]
    assert layout.objects_of(ObjectKind.PARKING) == 2


def test_a_parking_space_or_a_garage_takes_no_entrance_and_a_building_meter_no_kind() -> None:
    assert problems_of(
        APT_1,
        {"apartment": "3", "kind": "GARAGE", "entrance": "1"},
        {"kind": "PARKING", "resource": "COLD_WATER"},
        {"apartment": "4", "kind": "CELLAR"},
        {"apartment": "5", "kind": "PARKING", "area_m2": "0"},
    ) == [
        "entrance: a parking space or a garage has no entrance",
        "kind: must be empty for a building meter",
        "kind: one of APARTMENT, PARKING, GARAGE",
        "area_m2: must be greater than 0",
    ]


def test_an_apartment_still_needs_its_entrance_and_area() -> None:
    assert problems_of({"apartment": "1", "kind": "APARTMENT"}) == [
        "entrance: required",
        "area_m2: required",
    ]


def test_colliding_labels_of_one_kind_are_refused() -> None:
    assert problems_of(
        APT_1,
        {"apartment": "1", "kind": "PARKING"},
        {"apartment": "P1", "kind": "PARKING"},  # both are P1
        {"apartment": "G7", "kind": "GARAGE"},
        {"apartment": "g7", "kind": "GARAGE"},  # one number written differently
        {"apartment": "P1", "kind": "GARAGE"},  # GP1: no clash with the parking space P1
        {"apartment": "2", "kind": "PARKING"},
        {"apartment": "P 02", "kind": "PARKING"},  # spaces and leading zeros: P2 again
    ) == [
        "apartment: the same label P1 as row 3",
        "apartment: the same number as row 5, written differently",
        "apartment: the same label P 02 as row 8",
    ]


def test_the_register_check_compares_apartments_only() -> None:
    layout, _ = check_layout(
        rows(APT_1, {"apartment": "2", "kind": "GARAGE"}, {"apartment": "2", "kind": "PARKING"})
    )

    warnings = register_warnings(layout, [DraftApartmentRow("1", D("48"), 1)])

    assert warnings == []


async def test_the_objects_are_laid_out_with_their_kind(db_session: AsyncSession) -> None:
    building = await create_building(db_session)
    layout, problems = check_layout(
        rows(
            {**APT_1, "resource": "COLD_WATER"},
            {"apartment": "1", "kind": "GARAGE", "resource": "ELECTRICITY", "unit": "kWh"},
        )
    )
    assert problems == []

    await lay_out(db_session, FillingTarget(building.id, "EE"), layout)

    objects = {
        apartment.id: (apartment.kind, apartment.number, apartment.entrance)
        for apartment in await db_session.scalars(
            select(Apartment).where(Apartment.building_id == building.id)
        )
    }
    meters = [
        (objects[meter.apartment_id], meter.resource_type.value)
        for meter in await db_session.scalars(
            select(MeterDevice).where(MeterDevice.building_id == building.id)
        )
    ]
    assert sorted(objects.values()) == [
        (ObjectKind.APARTMENT, "1", 1),
        (ObjectKind.GARAGE, "1", None),
    ]
    assert sorted(meters) == [
        ((ObjectKind.APARTMENT, "1", 1), "COLD_WATER"),
        ((ObjectKind.GARAGE, "1", None), "ELECTRICITY"),
    ]
