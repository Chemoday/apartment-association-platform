"""The reminder of an expiring energy certificate (epic E12 X2b, issue #148)."""

from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.notifications.messages import compose
from src.modules.notifications.models import Delivery
from src.modules.notifications.schemas import Channel, NotificationEventType
from src.modules.property.events import EnergyCertificateExpiring
from src.modules.property.models import BuildingRegistryRecord
from src.modules.property.registry import dump_block
from src.modules.property.registry_watch import due_threshold, needs_reminder
from src.plugins.countries.ee.building_registry import EEBuildingRegistry
from src.plugins.countries.ee.facts import (
    Classified,
    EEBuilding,
    EEBuildingFacts,
    EEEnergyCertificate,
    EESource,
)
from tests.issues.conftest import IssueWorld, build_issue_world

VALID_UNTIL = date(2027, 6, 30)


def block(*certificates: EEEnergyCertificate) -> EEBuildingFacts:
    return EEBuildingFacts(
        source=EESource(building_code="100000001", fetched_at=datetime(2026, 11, 15, tzinfo=UTC)),
        building=EEBuilding(),
        energy_certificates=list(certificates),
    )


def certificate(valid_until: date | None, state: str = "DO_DOKUSEIS_KEHTIV") -> EEEnergyCertificate:
    return EEEnergyCertificate(
        energy_class="D", valid_until=valid_until, state=Classified(code=state, label_et=None)
    )


@pytest.fixture
async def world(db_session: AsyncSession) -> IssueWorld:
    return await build_issue_world(db_session)


@pytest.fixture
def estonian_register(db_app: FastAPI) -> Iterator[None]:
    providers = db_app.state.plugin_registry._building_registries
    providers["EE"] = EEBuildingRegistry()
    yield
    providers.pop("EE", None)


async def accept(db_session: AsyncSession, world: IssueWorld, facts: EEBuildingFacts) -> None:
    db_session.add(
        BuildingRegistryRecord(
            building_id=world.building.id,
            accepted=dump_block(facts),
            accepted_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
    )
    await db_session.flush()


async def tick_on(db_app: FastAPI, day: date):
    return await db_app.state.registry_watch.tick(datetime.combine(day, datetime.min.time(), UTC))


def reminders(events) -> list[tuple[int, int]]:
    return [(e.threshold, e.days_left) for e in events if isinstance(e, EnergyCertificateExpiring)]


# --- Pure rules ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("days_left", "threshold"),
    [(400, None), (181, None), (180, 180), (31, 180), (30, 30), (1, 30), (0, 0), (-50, 0)],
)
def test_the_nearest_threshold_reached(days_left: int, threshold: int | None) -> None:
    assert due_threshold(days_left) == threshold


def test_each_threshold_once_per_certificate() -> None:
    assert needs_reminder(VALID_UNTIL, 180, None, None)
    assert not needs_reminder(VALID_UNTIL, 180, VALID_UNTIL, 180)
    assert needs_reminder(VALID_UNTIL, 30, VALID_UNTIL, 180)
    assert not needs_reminder(VALID_UNTIL, 180, VALID_UNTIL, 30), "never back to a farther one"
    assert needs_reminder(date(2037, 6, 30), 180, VALID_UNTIL, 0), "a new certificate starts again"


def test_the_estonian_provider_takes_the_latest_valid_certificate() -> None:
    provider = EEBuildingRegistry()
    assert provider.certificate_valid_until(block()) is None
    assert provider.certificate_valid_until(block(certificate(None))) is None
    mixed = block(
        certificate(date(2031, 1, 1), state="DO_DOKUSEIS_KEHTETU"),
        certificate(date(2028, 1, 1)),
        certificate(date(2027, 1, 1)),
    )
    assert provider.certificate_valid_until(mixed) == date(2028, 1, 1)
    only_invalid = block(certificate(date(2031, 1, 1), state="DO_DOKUSEIS_KEHTETU"))
    assert provider.certificate_valid_until(only_invalid) is None, "never an annulled one"


# --- The loop ------------------------------------------------------------------------------------


async def test_180_and_30_days_before_and_on_the_day_each_once(
    db_app, db_session: AsyncSession, world: IssueWorld, estonian_register, published_events
) -> None:
    await accept(db_session, world, block(certificate(VALID_UNTIL)))

    await tick_on(db_app, VALID_UNTIL - timedelta(days=181))
    assert reminders(published_events) == []
    await tick_on(db_app, VALID_UNTIL - timedelta(days=180))
    await tick_on(db_app, VALID_UNTIL - timedelta(days=100))
    await tick_on(db_app, VALID_UNTIL - timedelta(days=30))
    await tick_on(db_app, VALID_UNTIL - timedelta(days=29))
    await tick_on(db_app, VALID_UNTIL)
    await tick_on(db_app, VALID_UNTIL + timedelta(days=5))
    assert reminders(published_events) == [(180, 180), (30, 30), (0, 0)]

    record = await db_session.get(BuildingRegistryRecord, world.building.id)
    assert record is not None
    await db_session.refresh(record)
    assert (record.certificate_reminded_for, record.certificate_reminded_threshold) == (
        VALID_UNTIL,
        0,
    )


async def test_a_passport_accepted_late_sends_only_the_nearest(
    db_app, db_session: AsyncSession, world: IssueWorld, estonian_register, published_events
) -> None:
    await accept(db_session, world, block(certificate(VALID_UNTIL)))
    await tick_on(db_app, VALID_UNTIL - timedelta(days=12))
    await tick_on(db_app, VALID_UNTIL - timedelta(days=11))
    assert reminders(published_events) == [(30, 12)]


async def test_nothing_without_a_certificate_or_a_provider(
    db_app, db_session: AsyncSession, world: IssueWorld, published_events
) -> None:
    await accept(db_session, world, block(certificate(VALID_UNTIL)))
    await tick_on(db_app, VALID_UNTIL)  # no provider enabled in the tests
    assert reminders(published_events) == []


async def test_nothing_for_a_passport_without_a_certificate(
    db_app, db_session: AsyncSession, world: IssueWorld, estonian_register, published_events
) -> None:
    await accept(db_session, world, block())
    await tick_on(db_app, VALID_UNTIL)
    assert reminders(published_events) == []


async def test_the_chairman_and_the_board_are_told(
    db_app, db_session: AsyncSession, world: IssueWorld, estonian_register
) -> None:
    await accept(db_session, world, block(certificate(VALID_UNTIL)))
    await tick_on(db_app, VALID_UNTIL - timedelta(days=30))
    rows = list(
        await db_session.scalars(
            select(Delivery).where(
                Delivery.event_type == NotificationEventType.ENERGY_CERTIFICATE_EXPIRING,
                Delivery.channel == Channel.IN_APP,
            )
        )
    )
    assert {row.user_id for row in rows} == {world.chairman.id, world.board_15.id}
    assert all(
        row.params == {"valid_until": "2027-06-30", "days_left": 30, "threshold": 30}
        for row in rows
    )
    assert all(row.subject_id == world.building.id for row in rows)


def test_the_message_names_the_date_and_says_when_it_expired() -> None:
    for locale in ("en", "ru", "et"):
        ahead = compose(
            NotificationEventType.ENERGY_CERTIFICATE_EXPIRING,
            locale,
            {"valid_until": "2027-06-30", "days_left": 30, "threshold": 30},
            site_url="https://example.test",
            timezone="Europe/Tallinn",
        )
        assert "30.06.2027" in ahead.subject and "30.06.2027" in ahead.text
        assert "30" in ahead.text
        expired = compose(
            NotificationEventType.ENERGY_CERTIFICATE_EXPIRING,
            locale,
            {"valid_until": "2027-06-30", "days_left": -3, "threshold": 0},
            site_url="https://example.test",
            timezone="Europe/Tallinn",
        )
        assert expired.text != ahead.text and "30.06.2027" in expired.text


async def test_a_renewed_certificate_starts_the_reminders_again(
    db_app, db_session: AsyncSession, world: IssueWorld, estonian_register, published_events
) -> None:
    await accept(db_session, world, block(certificate(VALID_UNTIL)))
    await tick_on(db_app, VALID_UNTIL - timedelta(days=30))
    renewed = date(2037, 6, 30)
    record = await db_session.get(BuildingRegistryRecord, world.building.id)
    assert record is not None
    record.accepted = dump_block(block(certificate(renewed)))
    await db_session.flush()
    await tick_on(db_app, renewed - timedelta(days=180))
    assert reminders(published_events) == [(30, 30), (180, 180)]


async def test_the_day_is_the_associations_calendar_day(
    db_app, db_session: AsyncSession, world: IssueWorld, estonian_register, published_events
) -> None:
    await accept(db_session, world, block(certificate(VALID_UNTIL)))
    # 22:30 UTC on the day before is already the day itself in Tallinn (UTC+3 in summer).
    await db_app.state.registry_watch.tick(
        datetime.combine(VALID_UNTIL - timedelta(days=1), datetime.min.time(), UTC)
        + timedelta(hours=22, minutes=30)
    )
    assert reminders(published_events) == [(0, 0)]


async def test_one_broken_provider_stops_nothing_else(
    db_app, db_session: AsyncSession, world: IssueWorld, published_events, monkeypatch
) -> None:
    class Broken(EEBuildingRegistry):
        def certificate_valid_until(self, block):
            raise RuntimeError("a provider bug")

    providers = db_app.state.plugin_registry._building_registries
    monkeypatch.setitem(providers, "EE", Broken())
    await accept(db_session, world, block(certificate(VALID_UNTIL)))
    result = await tick_on(db_app, VALID_UNTIL)
    assert result.ran and result.reminded == 0


async def test_a_tick_is_skipped_while_another_process_runs_it(
    db_app, db_engine, world: IssueWorld, estonian_register
) -> None:
    from sqlalchemy import text

    from src.modules.property.registry_watch import WATCH_LOCK_KEY

    async with db_engine.connect() as other:
        await other.begin()
        await other.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"), {"key": WATCH_LOCK_KEY}
        )
        result = await tick_on(db_app, VALID_UNTIL)
        await other.rollback()
    assert result.ran is False


def test_on_the_last_day_it_is_still_valid() -> None:
    for locale in ("en", "ru", "et"):
        today = compose(
            NotificationEventType.ENERGY_CERTIFICATE_EXPIRING,
            locale,
            {"valid_until": "2027-06-30", "days_left": 0, "threshold": 0},
            site_url="https://example.test",
            timezone="Europe/Tallinn",
        )
        expired = compose(
            NotificationEventType.ENERGY_CERTIFICATE_EXPIRING,
            locale,
            {"valid_until": "2027-06-30", "days_left": -1, "threshold": 0},
            site_url="https://example.test",
            timezone="Europe/Tallinn",
        )
        assert today.text != expired.text and "30.06.2027" in today.text
