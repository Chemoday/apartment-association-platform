"""Storage usage and quota alerts (epic E11 task F4; docs/API.md section 12)."""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.core.database import session_outbox
from src.core.event_bus import InMemoryEventBus
from src.core.file_events import StorageUsageHigh
from src.core.files import (
    MB,
    FileAlert,
    FilePurpose,
    FileStore,
    LocalDisk,
    Reservations,
    UploadGate,
    janitor_tick,
)
from src.core.images import EncodedPhoto
from tests.core.test_files import factory_of
from tests.factories import create_building, create_user
from tests.issues.conftest import IssueWorld, build_issue_world
from tests.issues.test_api import as_user
from tests.issues.test_photos import PHOTO

QUOTA_MB = 10


@pytest.fixture
async def world(db_session: AsyncSession) -> IssueWorld:
    return await build_issue_world(db_session)


@pytest.fixture
def disk(tmp_path: Path) -> LocalDisk:
    disk = LocalDisk(tmp_path / "files")
    disk.prepare()
    return disk


def store_with_bus(session: AsyncSession, disk: LocalDisk, bus: InMemoryEventBus) -> FileStore:
    settings = get_settings().model_copy(
        update={"DEMO_MODE_ENABLED": False, "FILES_QUOTA_MB": QUOTA_MB, "FILES_MIN_FREE_MB": 0}
    )
    return FileStore(session, settings, disk, UploadGate(), Reservations(), bus)


async def _photo(files: FileStore, building, user, size: int) -> None:
    await files.store_photo(
        building_id=building.id,
        purpose=FilePurpose.ISSUE_PHOTO,
        owner_ref=building.id,
        created_by=user.id,
        photo=EncodedPhoto(display=b"D" * size, thumb=b"", width=1, height=1),
        idempotency_key=None,
    )


def _alerts(session: AsyncSession, bus: InMemoryEventBus) -> list[StorageUsageHigh]:
    return [e for e in session_outbox(session, bus).pending if isinstance(e, StorageUsageHigh)]


async def test_the_board_is_told_once_when_a_threshold_is_reached(
    db_session: AsyncSession, disk: LocalDisk
) -> None:
    building = await create_building(db_session)
    user = await create_user(db_session, building, "Ivan Petrov")
    bus = InMemoryEventBus()
    files = store_with_bus(db_session, disk, bus)

    # A quota of 10 MB keeps 2 MB for official votes: the room for files is 8 MB.
    await _photo(files, building, user, 5 * MB)  # 62% of the room: nothing yet
    assert _alerts(db_session, bus) == []
    await _photo(files, building, user, 1 * MB)  # 75% of the room
    await files._check_alerts(building.id, datetime.now(UTC), 6 * MB)  # told already

    [alert] = _alerts(db_session, bus)
    assert (alert.building_id, alert.threshold, alert.used_percent) == (building.id, 70, 60)
    await _photo(files, building, user, 3 * MB // 2)  # 93% of the room, still below photos' 8 MB
    assert [a.threshold for a in _alerts(db_session, bus)] == [70, 90]
    rows = sorted(await db_session.scalars(select(FileAlert.threshold)))
    assert rows == [70, 90]


async def test_the_janitor_lets_a_threshold_be_told_again_after_the_usage_fell(
    db_session: AsyncSession, disk: LocalDisk
) -> None:
    building = await create_building(db_session)
    db_session.add(FileAlert(building_id=building.id, threshold=70, reached_at=datetime.now(UTC)))
    await db_session.flush()

    # Nothing is stored: 0% is well below 70 - 10.
    await janitor_tick(factory_of(db_session), disk, quota_bytes=QUOTA_MB * MB)

    assert list(await db_session.scalars(select(FileAlert))) == []


async def test_the_janitor_keeps_the_alert_while_the_usage_stays_near_the_threshold(
    db_session: AsyncSession, disk: LocalDisk
) -> None:
    building = await create_building(db_session)
    user = await create_user(db_session, building, "Ivan Petrov")
    files = store_with_bus(db_session, disk, InMemoryEventBus())
    await _photo(files, building, user, 6 * MB)  # 75% of the room, the 70% row is inserted

    await janitor_tick(factory_of(db_session), disk, quota_bytes=QUOTA_MB * MB)

    assert list(await db_session.scalars(select(FileAlert.threshold))) == [70]


async def test_the_chairman_and_the_board_see_the_usage(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    issue = (
        await api_client.post(
            "/api/v1/issues",
            json={"category": "LIGHTING", "entrance": 2, "place": "Landing", "title": "Dark"},
            headers=as_user(world.owner_14),
        )
    ).json()
    await api_client.post(
        f"/api/v1/issues/{issue['id']}/photos",
        content=PHOTO,
        headers={**as_user(world.owner_14), "Content-Type": "image/jpeg"},
    )

    usage = await api_client.get("/api/v1/files/usage", headers=as_user(world.chairman))
    board = await api_client.get("/api/v1/files/usage", headers=as_user(world.board_15))
    accountant = await api_client.get("/api/v1/files/usage", headers=as_user(world.accountant))
    resident = await api_client.get("/api/v1/files/usage", headers=as_user(world.owner_14))

    assert usage.status_code == board.status_code == 200
    body = usage.json()
    photos = next(c for c in body["categories"] if c["category"] == "photos")
    assert photos["used_bytes"] == body["used_bytes"] > 0
    assert photos["limit_bytes"] == int(body["quota_bytes"] * 0.8)
    assert {c["category"] for c in body["categories"]} == {"photos", "documents"}
    assert body["pending_deletion_bytes"] == 0
    assert (accountant.status_code, resident.status_code) == (403, 403)


@pytest.mark.parametrize("quota_mb", [100, 2048, 1_000_000])
async def test_the_janitor_resets_alerts_at_real_quotas_without_overflowing(
    db_session: AsyncSession, disk: LocalDisk, quota_mb: int
) -> None:
    # A 32-bit product of a percent and a quota in bytes overflows from about 21 MB on.
    building = await create_building(db_session)
    user = await create_user(db_session, building, "Ivan Petrov")
    files = store_with_bus(db_session, disk, InMemoryEventBus())
    await _photo(files, building, user, 1 * MB)
    db_session.add(FileAlert(building_id=building.id, threshold=90, reached_at=datetime.now(UTC)))
    await db_session.flush()

    report = await janitor_tick(factory_of(db_session), disk, quota_bytes=quota_mb * MB)

    assert report is not None
    assert list(await db_session.scalars(select(FileAlert))) == []  # 1 MB is far below 80%


async def test_a_purpose_of_a_newer_release_is_counted_but_never_breaks_the_usage(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld
) -> None:
    # After a rollback the database may hold purposes this release does not know.
    from sqlalchemy import text

    await db_session.execute(text("ALTER TABLE core_files DROP CONSTRAINT ck_core_files_purpose"))
    await db_session.execute(
        text(
            "INSERT INTO core_files (id, building_id, purpose, owner_ref, content_type,"
            " size_bytes, sha256) VALUES (gen_random_uuid(), :building, 'vote_ballot',"
            " gen_random_uuid(), 'application/pdf', 5000, repeat('0', 64))"
        ),
        {"building": world.building.id},
    )
    await db_session.commit()

    usage = await api_client.get("/api/v1/files/usage", headers=as_user(world.chairman))

    assert usage.status_code == 200, usage.text
    body = usage.json()
    assert body["used_bytes"] == 5000  # like the quota check, every row counts
    assert all(category["used_bytes"] == 0 for category in body["categories"])


async def test_one_upload_past_both_thresholds_tells_the_board_once(
    db_session: AsyncSession, disk: LocalDisk
) -> None:
    building = await create_building(db_session)
    user = await create_user(db_session, building, "Ivan Petrov")
    bus = InMemoryEventBus()
    files = store_with_bus(db_session, disk, bus)

    await _photo(files, building, user, 15 * MB // 2)  # 93% of the room at once

    [alert] = _alerts(db_session, bus)
    assert alert.threshold == 90
    assert sorted(await db_session.scalars(select(FileAlert.threshold))) == [70, 90]


async def test_photos_near_their_own_limit_alert_before_they_are_refused(
    db_session: AsyncSession, disk: LocalDisk
) -> None:
    from src.core.files import QuotaClass, class_limit, room_for_files, votes_reserve

    # A large quota: the room for files is 95%, photos stop at 80%; 72% of the quota in photos is
    # only 75% of the room but 90% of the room for photos.
    quota_mb = 2048
    building = await create_building(db_session)
    user = await create_user(db_session, building, "Ivan Petrov")
    bus = InMemoryEventBus()
    settings = get_settings().model_copy(
        update={"DEMO_MODE_ENABLED": False, "FILES_QUOTA_MB": quota_mb, "FILES_MIN_FREE_MB": 0}
    )
    files = FileStore(db_session, settings, disk, UploadGate(), Reservations(), bus)
    photos_limit = class_limit(quota_mb * MB, QuotaClass.PHOTOS)
    assert room_for_files(quota_mb * MB) == quota_mb * MB - votes_reserve(quota_mb * MB)
    used = photos_limit * 90 // 100 + 1

    await _photo(files, building, user, used)

    # 75% of the room alone would only be the 70% alert; the room for photos makes it 90%.
    assert used * 100 // room_for_files(quota_mb * MB) < 90
    assert [a.threshold for a in _alerts(db_session, bus)] == [90]


async def test_the_janitor_keeps_an_alert_that_the_photos_reached_while_they_stay_near_it(
    db_session: AsyncSession, disk: LocalDisk
) -> None:
    from src.core.files import QuotaClass, class_limit

    quota_mb = 2048
    building = await create_building(db_session)
    user = await create_user(db_session, building, "Ivan Petrov")
    settings = get_settings().model_copy(
        update={"DEMO_MODE_ENABLED": False, "FILES_QUOTA_MB": quota_mb, "FILES_MIN_FREE_MB": 0}
    )
    files = FileStore(db_session, settings, disk, UploadGate(), Reservations(), InMemoryEventBus())
    # Photos at 85% of their room: the 70% alert stays (85 > 70 - 10), though the whole room is
    # filled far less.
    await _photo(files, building, user, class_limit(quota_mb * MB, QuotaClass.PHOTOS) * 85 // 100)

    await janitor_tick(factory_of(db_session), disk, quota_bytes=quota_mb * MB)

    assert 70 in list(await db_session.scalars(select(FileAlert.threshold)))
