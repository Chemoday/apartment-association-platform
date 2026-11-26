"""Pure rules of the building chat."""

import uuid
from datetime import UTC, datetime, timedelta

from src.modules.chat.policies import HISTORY, rate_limit, takes_part, window_start
from src.modules.property.schemas import (
    ApartmentMembershipDTO,
    BuildingRole,
    CurrentUserDTO,
    DisplayMode,
    ObjectKind,
)

NOW = datetime(2026, 11, 15, 12, 0, tzinfo=UTC)


def caller(role: BuildingRole, apartments: int = 0) -> CurrentUserDTO:
    return CurrentUserDTO(
        id=uuid.uuid4(),
        building_id=uuid.uuid4(),
        building_role=role,
        privacy_display_mode=DisplayMode.APARTMENT_ONLY,
        memberships=tuple(
            ApartmentMembershipDTO.model_construct(
                apartment_id=uuid.uuid4(), apartment_kind=ObjectKind.APARTMENT, entrance=1
            )
            for _ in range(apartments)
        ),
    )


def test_residents_and_the_board_take_part_but_not_staff_without_an_apartment() -> None:
    assert takes_part(caller(BuildingRole.USER, apartments=1))
    assert takes_part(caller(BuildingRole.CHAIRMAN))
    assert takes_part(caller(BuildingRole.BOARD))
    assert takes_part(caller(BuildingRole.ACCOUNTANT, apartments=1))
    assert not takes_part(caller(BuildingRole.ACCOUNTANT))
    assert not takes_part(caller(BuildingRole.USER))


def test_the_window_is_two_hours_and_starts_no_earlier_than_turning_on() -> None:
    assert window_start(NOW, None) == NOW - HISTORY
    assert window_start(NOW, NOW - timedelta(hours=5)) == NOW - HISTORY
    assert window_start(NOW, NOW - timedelta(minutes=5)) == NOW - timedelta(minutes=5)


def test_ten_messages_a_minute() -> None:
    times = [NOW - timedelta(seconds=50 - i) for i in range(10)]  # 50 s .. 41 s ago
    assert rate_limit(times[:9], NOW) is None
    assert rate_limit(times, NOW) == ("MINUTE_LIMIT", 10), "the oldest leaves the minute in 10 s"


def test_sixty_messages_an_hour() -> None:
    times = [NOW - timedelta(minutes=59, seconds=30) + timedelta(seconds=55 * i) for i in range(60)]
    assert all(t < NOW - timedelta(minutes=1) for t in times)
    assert rate_limit(times[:59], NOW) is None
    assert rate_limit(times, NOW) == ("HOUR_LIMIT", 30)
    old = [NOW - timedelta(hours=1, seconds=1)] * 100
    assert rate_limit(old, NOW) is None, "messages older than an hour do not count"


def test_the_wait_is_at_least_a_second() -> None:
    times = [NOW - timedelta(seconds=59, microseconds=999_000)] * 10
    assert rate_limit(times, NOW) == ("MINUTE_LIMIT", 1)


def test_with_both_limits_broken_the_longer_wait_is_told() -> None:
    times = [NOW - timedelta(minutes=50)] * 50 + [NOW - timedelta(seconds=5)] * 10
    assert rate_limit(times, NOW) == ("HOUR_LIMIT", 600), "not the 55 s of the minute limit"
