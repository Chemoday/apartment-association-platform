"""Objects of several kinds (epic E14, sections 2.2, 2.4 and 5): labels, references by kind and
number, and the one order of objects (pure, no database)."""

import pytest

from src.modules.property.schemas import (
    ObjectKind,
    ObjectRef,
    object_label,
    object_sort_key,
    parse_object_ref,
)


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
