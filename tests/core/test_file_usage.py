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

    await _photo(files, building, user, 7 * MB)  # 70%: nothing yet
    assert _alerts(db_session, bus) == []
    await _photo(files, building, user, 1 * MB)  # 80%
    await files._check_alerts(building.id, datetime.now(UTC))  # still 80%: told already

    [alert] = _alerts(db_session, bus)
    assert (alert.building_id, alert.threshold, alert.used_percent) == (building.id, 80, 80)
    rows = list(await db_session.scalars(select(FileAlert.threshold)))
    assert rows == [80]


async def test_the_janitor_lets_a_threshold_be_told_again_after_the_usage_fell(
    db_session: AsyncSession, disk: LocalDisk
) -> None:
    building = await create_building(db_session)
    db_session.add(FileAlert(building_id=building.id, threshold=80, reached_at=datetime.now(UTC)))
    await db_session.flush()

    # Nothing is stored: 0% is well below 80 - 10.
    await janitor_tick(factory_of(db_session), disk, quota_bytes=QUOTA_MB * MB)

    assert list(await db_session.scalars(select(FileAlert))) == []


async def test_the_janitor_keeps_the_alert_while_the_usage_stays_near_the_threshold(
    db_session: AsyncSession, disk: LocalDisk
) -> None:
    building = await create_building(db_session)
    user = await create_user(db_session, building, "Ivan Petrov")
    files = store_with_bus(db_session, disk, InMemoryEventBus())
    await _photo(files, building, user, 8 * MB)  # 80%, alert row inserted

    await janitor_tick(factory_of(db_session), disk, quota_bytes=QUOTA_MB * MB)

    assert list(await db_session.scalars(select(FileAlert.threshold))) == [80]


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
    db_session.add(FileAlert(building_id=building.id, threshold=95, reached_at=datetime.now(UTC)))
    await db_session.flush()

    report = await janitor_tick(factory_of(db_session), disk, quota_bytes=quota_mb * MB)

    assert report is not None
    assert list(await db_session.scalars(select(FileAlert))) == []  # 1 MB is far below 85%
