"""Objects of several kinds (epic E14, sections 2.2, 2.4 and 5): labels, references by kind and
number, and the one order of objects (pure, and the SQL order kept equal to it)."""

from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.property.schemas import (
    NewApartment,
    ObjectKind,
    ObjectRef,
    object_label,
    object_sort_key,
    parse_object_ref,
)
from src.modules.property.service import PropertyService
from tests.factories import create_apartment, create_building


@pytest.mark.parametrize(
    ("kind", "number", "label"),
    [
        (ObjectKind.APARTMENT, "14", "Apt. 14"),
        (ObjectKind.APARTMENT, "A1", "Apt. A1"),
        (ObjectKind.PARKING, "1", "P1"),
        (ObjectKind.PARKING, "P-2", "P-2"),
        (ObjectKind.PARKING, "P-012", "P-012"),
        (ObjectKind.PARKING, "p7", "p7"),
        (ObjectKind.GARAGE, "12", "G12"),
        (ObjectKind.GARAGE, "G12", "G12"),
        (ObjectKind.GARAGE, "g12", "g12"),
        (ObjectKind.GARAGE, "1G", "G1G"),
        (ObjectKind.GARAGE, "P1", "GP1"),
    ],
)
def test_the_label_of_an_object_names_its_kind(kind: ObjectKind, number: str, label: str) -> None:
    assert object_label(kind, number) == label


@pytest.mark.parametrize(
    ("kind", "number", "ref"),
    [
        (None, "14", ObjectRef(ObjectKind.APARTMENT, "14")),
        ("", " 14 ", ObjectRef(ObjectKind.APARTMENT, "14")),
        ("PARKING", "1", ObjectRef(ObjectKind.PARKING, "1")),
        (" garage ", "G12", ObjectRef(ObjectKind.GARAGE, "G12")),
    ],
)
def test_a_reference_without_a_kind_is_an_apartment(
    kind: str | None, number: str, ref: ObjectRef
) -> None:
    assert parse_object_ref(kind, number) == ref


def test_an_unknown_kind_is_refused() -> None:
    with pytest.raises(ValueError):
        parse_object_ref("CELLAR", "1")


def test_objects_are_ordered_by_kind_entrance_and_natural_number() -> None:
    objects = [
        (ObjectKind.GARAGE, None, "1"),
        (ObjectKind.PARKING, None, "10"),
        (ObjectKind.APARTMENT, 2, "14a"),
        (ObjectKind.APARTMENT, 2, "14A"),
        (ObjectKind.APARTMENT, None, "1"),
        (ObjectKind.APARTMENT, 2, "14"),
        (ObjectKind.PARKING, -1, "2"),
        (ObjectKind.APARTMENT, 1, "10"),
        (ObjectKind.APARTMENT, 1, "2"),
        (ObjectKind.APARTMENT, 2, "3"),
    ]

    assert sorted(objects, key=lambda o: object_sort_key(*o)) == [
        (ObjectKind.APARTMENT, 1, "2"),
        (ObjectKind.APARTMENT, 1, "10"),
        (ObjectKind.APARTMENT, 2, "3"),
        (ObjectKind.APARTMENT, 2, "14"),
        (ObjectKind.APARTMENT, 2, "14A"),
        (ObjectKind.APARTMENT, 2, "14a"),
        (ObjectKind.APARTMENT, None, "1"),
        (ObjectKind.PARKING, -1, "2"),
        (ObjectKind.PARKING, None, "10"),
        (ObjectKind.GARAGE, None, "1"),
    ]


# --- The SQL order and the database --------------------------------------------------------------


async def test_the_sql_order_of_objects_equals_the_sort_key(db_session: AsyncSession) -> None:
    building = await create_building(db_session)
    # Created out of order; "14A" and "14a" differ only in case (code point order: upper first).
    for number, entrance in [
        ("14b", 2),
        ("10", 1),
        ("14a", 2),
        ("2", 1),
        ("14B", 2),
        ("14", 2),
        ("14A", 2),
        ("3", 2),
        ("1", 3),
    ]:
        await create_apartment(db_session, building, number, entrance=entrance)

    listed = await PropertyService(db_session).list_apartments(building.id)

    assert [a.number for a in listed] == [
        a.number
        for a in sorted(
            listed, key=lambda a: object_sort_key(ObjectKind.APARTMENT, a.entrance, a.number)
        )
    ]
    assert [a.number for a in listed] == ["2", "10", "3", "14", "14A", "14B", "14a", "14b", "1"]


async def test_objects_are_created_and_found_by_kind_and_number(db_session: AsyncSession) -> None:
    building = await create_building(db_session)
    properties = PropertyService(db_session)

    ids = await properties.create_apartments(
        building.id,
        [NewApartment(number="1", entrance=1, floor=1, area_m2=Decimal("40.10"))],
    )
    found = await properties.apartment_by_ref(building.id, ObjectKind.APARTMENT, "1")

    assert list(ids) == [ObjectRef(ObjectKind.APARTMENT, "1")]
    assert found is not None and found.apartment_id == ids[ObjectRef(ObjectKind.APARTMENT, "1")]
    # Every object is an apartment until objects get their kind.
    assert await properties.apartment_by_ref(building.id, ObjectKind.PARKING, "1") is None
    assert await properties.apartment_by_ref(building.id, ObjectKind.APARTMENT, "2") is None
