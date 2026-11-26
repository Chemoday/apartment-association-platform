"""The target every module shares (epic E14, section 3.1): its shape, its consistency check and
the one rule of who is reached (pure, no database)."""

import uuid

import pytest

from src.modules.property.schemas import (
    ObjectKind,
    TargetDTO,
    TargetScope,
    apartment_in_target,
    target_consistency_problem,
)

APARTMENT = uuid.uuid4()


def test_a_target_is_built_from_request_fields_or_a_stored_row() -> None:
    other = uuid.uuid4()

    assert TargetDTO.of(TargetScope.ALL_BUILDING, None, None) == TargetDTO(
        scope=TargetScope.ALL_BUILDING
    )
    stored = TargetDTO.of(TargetScope.APARTMENT_LIST, None, [str(APARTMENT), other])
    assert stored.apartment_ids == {APARTMENT, other}
    assert TargetDTO.of("ENTRANCE", 2, ()).scope is TargetScope.ENTRANCE


@pytest.mark.parametrize(
    ("scope", "entrance", "apartments"),
    [
        (TargetScope.ALL_BUILDING, None, None),
        (TargetScope.ALL_BUILDING, None, []),
        (TargetScope.ENTRANCE, 2, None),
        (TargetScope.APARTMENT_LIST, None, [APARTMENT]),
    ],
)
def test_consistent_targets_pass(scope, entrance, apartments) -> None:
    assert target_consistency_problem(TargetDTO.of(scope, entrance, apartments)) is None


@pytest.mark.parametrize(
    ("scope", "entrance", "apartments", "message"),
    [
        (
            TargetScope.ALL_BUILDING,
            2,
            None,
            "ALL_BUILDING takes neither target_entrance nor target_apartment_ids.",
        ),
        (
            TargetScope.ALL_BUILDING,
            None,
            [APARTMENT],
            "ALL_BUILDING takes neither target_entrance nor target_apartment_ids.",
        ),
        (TargetScope.ENTRANCE, None, None, "ENTRANCE needs target_entrance."),
        (TargetScope.ENTRANCE, 2, [APARTMENT], "ENTRANCE does not take target_apartment_ids."),
        (
            TargetScope.APARTMENT_LIST,
            None,
            [],
            "APARTMENT_LIST needs at least one apartment in target_apartment_ids.",
        ),
        (
            TargetScope.APARTMENT_LIST,
            2,
            [APARTMENT],
            "APARTMENT_LIST does not take target_entrance.",
        ),
    ],
)
def test_inconsistent_targets_are_explained(scope, entrance, apartments, message) -> None:
    assert target_consistency_problem(TargetDTO.of(scope, entrance, apartments)) == message


def test_the_shared_targeting_rule() -> None:
    def matches(scope: TargetScope, entrance: int | None, ids: set[uuid.UUID]) -> bool:
        return apartment_in_target(
            TargetDTO.of(scope, entrance, ids),
            apartment_id=APARTMENT,
            kind=ObjectKind.APARTMENT,
            entrance=2,
        )

    assert matches(TargetScope.ALL_BUILDING, None, set())
    assert matches(TargetScope.ENTRANCE, 2, set())
    assert not matches(TargetScope.ENTRANCE, 1, set())
    assert not matches(TargetScope.ENTRANCE, None, set())
    assert matches(TargetScope.APARTMENT_LIST, None, {APARTMENT})
    assert not matches(TargetScope.APARTMENT_LIST, None, {uuid.uuid4()})


def test_the_targeting_clause_takes_objects_without_an_entrance() -> None:
    from datetime import UTC, datetime

    from sqlalchemy import column
    from sqlalchemy.dialects import postgresql

    from src.modules.property.schemas import (
        ApartmentMembershipDTO,
        BuildingRole,
        CurrentUserDTO,
        DisplayMode,
        RelationType,
    )
    from src.modules.property.service import PropertyService

    def membership(entrance: int | None) -> ApartmentMembershipDTO:
        return ApartmentMembershipDTO(
            membership_id=uuid.uuid4(),
            apartment_id=uuid.uuid4(),
            apartment_number="1",
            apartment_kind=ObjectKind.APARTMENT if entrance else ObjectKind.PARKING,
            entrance=entrance,
            floor=None,
            relation_type=RelationType.OWNER,
            can_submit_readings=True,
            can_view_bills=True,
            can_vote=True,
            privacy_display_mode=DisplayMode.APARTMENT_ONLY,
            since=datetime.now(UTC),
        )

    user = CurrentUserDTO(
        id=uuid.uuid4(),
        building_id=uuid.uuid4(),
        building_role=BuildingRole.USER,
        privacy_display_mode=DisplayMode.APARTMENT_ONLY,
        memberships=(membership(None), membership(2)),
    )
    clause = PropertyService.targeting_clause(
        user,
        scope=column("target_scope"),
        entrance=column("target_entrance"),
        apartment_ids=column("target_apartment_ids", postgresql.JSONB),
        member_only=True,
    )

    compiled = clause.compile(dialect=postgresql.dialect())
    assert "target_entrance IN" in str(compiled)
    assert [2] in compiled.params.values()  # the entrance of the parking space is left out
