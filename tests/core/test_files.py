"""The shared file storage (src/core/files.py): admission, storing, serving, deleting, the janitor.

The store runs against the test database and a temporary directory; the routes that use it are
tested in tests/issues/test_photos.py.
"""

import asyncio
import hashlib
import os
import time
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from src.core.config import Settings, get_settings
from src.core.exceptions import DomainError
from src.core.files import (
    MB,
    PURGE_DELAY,
    FilePurpose,
    FileStore,
    LocalDisk,
    PhotoVariant,
    Reservations,
    StoredFile,
    UploadGate,
    declared_length,
    file_response,
    janitor_tick,
    read_body,
    validate_files_settings,
)
from src.core.images import EncodedPhoto
from src.modules.property.models import Building, User
from tests.factories import create_building, create_user

PURPOSE = FilePurpose.ISSUE_PHOTO
PHOTO = EncodedPhoto(display=b"D" * 3000, thumb=b"T" * 500, width=1920, height=1440)


def settings(**overrides: Any) -> Settings:
    base = {"DEMO_MODE_ENABLED": False, "FILES_IN_DEMO": False, "FILES_MIN_FREE_MB": 0}
    return get_settings().model_copy(update={**base, **overrides})


@pytest.fixture
def disk(tmp_path: Path) -> LocalDisk:
    disk = LocalDisk(tmp_path / "files")
    disk.prepare()
    return disk


@pytest.fixture
async def owner(db_session: AsyncSession) -> tuple[Building, User]:
    building = await create_building(db_session)
    user = await create_user(db_session, building, "Ivan Petrov")
    return building, user


def make_store(
    session: AsyncSession, disk: LocalDisk, reservations: Reservations | None = None, **overrides
) -> FileStore:
    return FileStore(
        session, settings(**overrides), disk, UploadGate(), reservations or Reservations()
    )


async def store(store: FileStore, building: Building, user: User, **kwargs: Any):
    params = {
        "building_id": building.id,
        "purpose": PURPOSE,
        "owner_ref": kwargs.pop("owner_ref", uuid.UUID(int=1)),
        "created_by": user.id,
        "photo": kwargs.pop("photo", PHOTO),
        "idempotency_key": kwargs.pop("idempotency_key", None),
        **kwargs,
    }
    return await store.store_photo(**params)


def factory_of(session: AsyncSession) -> Callable[[], Any]:
    @asynccontextmanager
    async def factory() -> AsyncIterator[AsyncSession]:
        yield session

    return factory


# --- Storing, listing, serving, deleting --------------------------------------------------------


async def test_a_photo_is_stored_on_disk_before_its_row_and_served_back(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    files = make_store(db_session, disk)

    stored, new = await store(files, building, user)

    assert new
    assert (stored.width, stored.height, stored.size_bytes) == (1920, 1440, 3500)
    assert stored.content_type == "image/webp"
    assert stored.uploaded_by_caller
    assert await files.read(stored, PhotoVariant.DISPLAY) == PHOTO.display
    assert await files.read(stored, PhotoVariant.THUMB) == PHOTO.thumb
    row = await db_session.get(StoredFile, stored.id)
    assert row is not None and row.sha256 == hashlib.sha256(PHOTO.display).hexdigest()
    assert list(disk.tmp.iterdir()) == []  # no temporary file left behind


async def test_the_store_never_tells_who_uploaded_a_file_except_to_that_user(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    other = await create_user(db_session, building, "Mari Tamm")
    files = make_store(db_session, disk)
    stored, _ = await store(files, building, user)

    [seen_by_other] = await files.list_files(PURPOSE, stored.owner_ref, caller_id=other.id)
    [seen_by_owner] = await files.list_files(PURPOSE, stored.owner_ref, caller_id=user.id)

    assert not seen_by_other.uploaded_by_caller
    assert seen_by_owner.uploaded_by_caller
    assert "created_by" not in repr(seen_by_other)


async def test_a_file_of_another_purpose_or_owner_does_not_exist_for_the_store(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    files = make_store(db_session, disk)
    stored, _ = await store(files, building, user)

    assert await files.get(stored.id, PURPOSE, uuid.UUID(int=2)) is None
    assert await files.get(stored.id, PURPOSE, stored.owner_ref) is not None
    assert await files.delete(stored.id, PURPOSE, uuid.UUID(int=2)) is False


async def test_a_deleted_file_is_hidden_at_once_and_purged_later(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    files = make_store(db_session, disk)
    stored, _ = await store(files, building, user)

    assert await files.delete(stored.id, PURPOSE, stored.owner_ref)

    assert await files.get(stored.id, PURPOSE, stored.owner_ref) is None
    assert await files.count(PURPOSE, stored.owner_ref) == 0
    row = await db_session.get(StoredFile, stored.id, populate_existing=True)
    assert row.deleted_at is not None and row.purge_after == row.deleted_at + PURGE_DELAY
    assert disk.exists(stored.id)  # the window for undoing a mistake


async def test_a_missing_blob_is_logged_and_never_a_server_error(
    db_session: AsyncSession, disk: LocalDisk, owner, log_capture
) -> None:
    building, user = owner
    files = make_store(db_session, disk)
    stored, _ = await store(files, building, user)
    disk.remove(stored.id)

    assert await files.read(stored, PhotoVariant.DISPLAY) is None
    assert any(r["event"] == "file_blob_missing" for r in log_capture.records)


async def test_a_repeated_upload_with_the_same_key_returns_the_first_file(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    files = make_store(db_session, disk)
    first, _ = await store(files, building, user, idempotency_key="k-1")

    assert (await files.find_repeat(user.id, "k-1", PURPOSE, first.owner_ref)).id == first.id
    assert await files.find_repeat(user.id, "k-2", PURPOSE, first.owner_ref) is None
    with pytest.raises(DomainError) as reused:  # the key belongs to another owner's file
        await files.find_repeat(user.id, "k-1", PURPOSE, uuid.UUID(int=9))
    assert (reused.value.status_code, reused.value.error_code) == (409, "IDEMPOTENCY_KEY_REUSED")
    # A race: both requests passed find_repeat; the second insert meets the unique index.
    again, new = await store(files, building, user, idempotency_key="k-1")

    assert (again.id, new) == (first.id, False)
    blobs = [file_id for file_id, _ in disk.blob_ages()]
    assert blobs == [first.id]  # the loser's blob is removed


def test_file_responses_are_never_sniffed_scripted_or_refetched() -> None:
    response = file_response(b"x", "image/webp")

    assert response.media_type == "image/webp"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "default-src 'none'; sandbox"
    assert response.headers["cache-control"] == "private, max-age=31536000, immutable"


# --- Admission ----------------------------------------------------------------------------------


async def _admit(files: FileStore, building: Building, user: User, cap: int = 4_000_000) -> None:
    await files.admit(building.id, user.id, PURPOSE, cap)


async def _refusal(coroutine) -> DomainError:
    with pytest.raises(DomainError) as caught:
        await coroutine
    return caught.value


async def test_demo_mode_refuses_uploads_without_the_flag(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    refused = make_store(db_session, disk, DEMO_MODE_ENABLED=True, FILES_IN_DEMO=False)
    allowed = make_store(db_session, disk, DEMO_MODE_ENABLED=True, FILES_IN_DEMO=True)

    error = await _refusal(_admit(refused, building, user))

    assert (error.status_code, error.error_code) == (403, "UPLOADS_DISABLED")
    await _admit(allowed, building, user)


def test_the_demo_flag_is_refused_in_production() -> None:
    with pytest.raises(RuntimeError, match="FILES_IN_DEMO"):
        validate_files_settings(settings(FILES_IN_DEMO=True, ENVIRONMENT="prod"))
    validate_files_settings(settings(FILES_IN_DEMO=True, ENVIRONMENT="dev"))


async def test_uploads_stop_when_the_disk_is_nearly_full(
    db_session: AsyncSession, disk: LocalDisk, owner, monkeypatch: pytest.MonkeyPatch
) -> None:
    building, user = owner
    files = make_store(db_session, disk, FILES_MIN_FREE_MB=5120)
    monkeypatch.setattr(disk, "free_bytes", lambda: 4000 * MB)

    error = await _refusal(_admit(files, building, user))

    assert (error.status_code, error.error_code) == (507, "STORAGE_LOW_DISK")


async def test_photos_may_not_use_the_last_fifth_of_the_quota(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    files = make_store(db_session, disk, FILES_QUOTA_MB=10, FILES_USER_MB_PER_DAY=100)
    big = EncodedPhoto(display=b"D" * (7 * MB), thumb=b"T", width=1, height=1)
    await store(files, building, user, photo=big)

    # 7 MB used of 10; photos may use 8 MB: a cap of 4 MB no longer fits, 0.5 MB still does.
    error = await _refusal(_admit(files, building, user, cap=4 * MB))
    await _admit(files, building, user, cap=MB // 2)

    assert (error.status_code, error.error_code) == (507, "STORAGE_QUOTA_EXCEEDED")


async def test_bodies_in_flight_count_against_the_quota(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    reservations = Reservations()
    files = make_store(db_session, disk, reservations, FILES_QUOTA_MB=10)

    with reservations.hold(building.id, 6 * MB):
        error = await _refusal(_admit(files, building, user, cap=3 * MB))
    await _admit(files, building, user, cap=3 * MB)

    assert error.error_code == "STORAGE_QUOTA_EXCEEDED"
    assert reservations.held(building.id) == 0


async def test_the_final_check_at_insert_time_holds_the_quota(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    files = make_store(db_session, disk, FILES_QUOTA_MB=10, FILES_USER_MB_PER_DAY=100)
    big = EncodedPhoto(display=b"D" * (7 * MB), thumb=b"T", width=1, height=1)
    await store(files, building, user, photo=big)

    error = await _refusal(
        store(files, building, user, photo=EncodedPhoto(b"D" * (2 * MB), b"", 1, 1))
    )

    assert error.error_code == "STORAGE_QUOTA_EXCEEDED"
    assert len(list(disk.blob_ages())) == 1  # nothing was written


async def test_a_user_stores_at_most_the_daily_limit(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    other = await create_user(db_session, building, "Mari Tamm")
    files = make_store(db_session, disk, FILES_USER_MB_PER_DAY=5)
    await store(files, building, user, photo=EncodedPhoto(b"D" * (3 * MB), b"", 1, 1))

    error = await _refusal(_admit(files, building, user, cap=3 * MB))
    await _admit(files, building, other, cap=3 * MB)

    assert (error.status_code, error.error_code) == (429, "RATE_LIMITED")
    assert 0 < error.extra["retry_after_seconds"] <= 24 * 3600 + 1
    assert error.headers["Retry-After"] == str(error.extra["retry_after_seconds"])


# --- Retention ----------------------------------------------------------------------------------


async def test_the_module_sets_and_clears_the_retention(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    files = make_store(db_session, disk)
    stored, _ = await store(files, building, user)
    when = datetime(2027, 11, 13, tzinfo=UTC)

    await files.set_delete_after(PURPOSE, stored.owner_ref, when)
    row = await db_session.get(StoredFile, stored.id, populate_existing=True)
    assert row.delete_after == when
    await files.set_delete_after(PURPOSE, stored.owner_ref, None)
    row = await db_session.get(StoredFile, stored.id, populate_existing=True)
    assert row.delete_after is None


async def test_a_demo_file_never_outlives_its_demo_retention(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    files = make_store(db_session, disk, DEMO_MODE_ENABLED=True, FILES_IN_DEMO=True)
    stored, _ = await store(files, building, user)
    row = await db_session.get(StoredFile, stored.id)
    demo_end = row.created_at + timedelta(hours=24)
    assert row.delete_after == demo_end

    await files.set_delete_after(PURPOSE, stored.owner_ref, None)
    await files.set_delete_after(PURPOSE, stored.owner_ref, demo_end + timedelta(days=300))
    row = await db_session.get(StoredFile, stored.id, populate_existing=True)

    assert row.delete_after == demo_end


# --- Reading an upload --------------------------------------------------------------------------


def _request(headers: dict[str, str], chunks: list[bytes]) -> Request:
    body = iter(chunks)

    async def receive() -> dict[str, Any]:
        chunk = next(body, None)
        return {"type": "http.request", "body": chunk or b"", "more_body": chunk is not None}

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
    }
    return Request(scope, receive)


def test_a_body_without_length_or_above_the_cap_is_refused_before_reading() -> None:
    with pytest.raises(DomainError) as missing:
        declared_length(_request({}, []), cap=100)
    with pytest.raises(DomainError) as too_large:
        declared_length(_request({"Content-Length": "101"}, []), cap=100)

    assert (missing.value.status_code, missing.value.error_code) == (411, "LENGTH_REQUIRED")
    assert (too_large.value.status_code, too_large.value.error_code) == (413, "FILE_TOO_LARGE")
    assert too_large.value.extra == {"max_bytes": 100}
    assert declared_length(_request({"Content-Length": "100"}, []), cap=100) == 100


async def test_a_body_longer_than_it_said_is_cut_off() -> None:
    request = _request({"Content-Length": "10"}, [b"x" * 8, b"x" * 8])

    with pytest.raises(DomainError) as caught:
        await read_body(request, length=10, cap=100)

    assert caught.value.error_code == "FILE_TOO_LARGE"
    assert await read_body(_request({}, [b"ab", b"cd"]), length=4, cap=100) == b"abcd"


async def test_the_gate_answers_busy_instead_of_queueing_without_end() -> None:
    gate = UploadGate()
    release = asyncio.Event()
    started = 0

    def slow(_: bytes) -> EncodedPhoto:
        nonlocal started
        started += 1
        while not release.is_set():
            time.sleep(0.01)
        return PHOTO

    import src.core.files as files_module

    original = files_module.reencode_photo
    files_module.reencode_photo = slow
    try:
        running = [asyncio.create_task(gate.reencode(b"")) for _ in range(5)]
        await asyncio.sleep(0.1)
        with pytest.raises(DomainError) as caught:
            await gate.reencode(b"")
    finally:
        release.set()  # never leave a spinning worker thread behind
        await asyncio.gather(*running, return_exceptions=True)
        files_module.reencode_photo = original

    assert caught.value.status_code == 429
    assert started == 5  # one at a time, the four waiting ones after it

    with gate.receiving():
        pass


# --- The disk -----------------------------------------------------------------------------------


def test_preparing_empties_tmp_and_refuses_an_unwritable_directory(tmp_path: Path) -> None:
    disk = LocalDisk(tmp_path / "files")
    disk.prepare()
    (disk.tmp / "left-over").write_bytes(b"x")
    disk.prepare()
    assert list(disk.tmp.iterdir()) == []

    locked = tmp_path / "locked"
    locked.mkdir()
    (locked / "blobs").mkdir()
    (locked / "tmp").mkdir()
    os.chmod(locked / "tmp", 0o500)
    try:
        if os.geteuid() != 0:  # root ignores the mode
            with pytest.raises(RuntimeError, match="not writable"):
                LocalDisk(locked).prepare()
    finally:
        os.chmod(locked / "tmp", 0o700)


# --- The janitor --------------------------------------------------------------------------------


async def test_the_janitor_expires_then_purges_blob_before_row(
    db_session: AsyncSession, disk: LocalDisk, owner
) -> None:
    building, user = owner
    files = make_store(db_session, disk)
    expiring, _ = await store(files, building, user, owner_ref=uuid.UUID(int=1))
    kept, _ = await store(files, building, user, owner_ref=uuid.UUID(int=2))
    now = datetime.now(UTC)
    await files.set_delete_after(PURPOSE, expiring.owner_ref, now - timedelta(minutes=1))

    report = await janitor_tick(factory_of(db_session), disk, now=now)
    assert (report.expired, report.purged) == (1, 0)
    assert await files.get(expiring.id, PURPOSE, expiring.owner_ref) is None
    assert disk.exists(expiring.id)

    later = now + PURGE_DELAY + timedelta(minutes=1)
    report = await janitor_tick(factory_of(db_session), disk, now=later)

    assert report.purged == 1
    assert not disk.exists(expiring.id)
    assert await db_session.get(StoredFile, expiring.id, populate_existing=True) is None
    assert disk.exists(kept.id)


async def test_the_janitor_cleans_old_temporary_files(
    db_session: AsyncSession, disk: LocalDisk
) -> None:
    old = disk.tmp / "old"
    fresh = disk.tmp / "fresh"
    old.write_bytes(b"x")
    fresh.write_bytes(b"x")
    two_hours_ago = time.time() - 7200
    os.utime(old, (two_hours_ago, two_hours_ago))

    report = await janitor_tick(factory_of(db_session), disk)

    assert report.tmp_removed == 1
    assert not old.exists() and fresh.exists()


async def test_the_weekly_comparison_removes_orphans_and_reports_missing_or_corrupt_blobs(
    db_session: AsyncSession, disk: LocalDisk, owner, log_capture
) -> None:
    building, user = owner
    files = make_store(db_session, disk)
    missing, _ = await store(files, building, user, owner_ref=uuid.UUID(int=1))
    corrupt, _ = await store(files, building, user, owner_ref=uuid.UUID(int=2))
    disk.remove(missing.id)
    (disk.blobs / str(corrupt.id)[:2] / str(corrupt.id) / "display.webp").write_bytes(b"rot")
    orphan, young_orphan = uuid.uuid4(), uuid.uuid4()
    disk.write(orphan, {"display.webp": b"x"})
    disk.write(young_orphan, {"display.webp": b"x"})
    two_days_ago = time.time() - 2 * 86400
    os.utime(disk.blobs / str(orphan)[:2] / str(orphan), (two_days_ago, two_days_ago))

    report = await janitor_tick(factory_of(db_session), disk)

    assert report.reconciled
    assert (report.orphans_removed, report.missing, report.corrupt) == (1, 1, 1)
    assert not disk.exists(orphan) and disk.exists(young_orphan)
    events = {r["event"] for r in log_capture.records}
    assert {"file_blob_missing", "file_blob_corrupt"} <= events
    # Not again until a week has passed.
    assert not (await janitor_tick(factory_of(db_session), disk)).reconciled


async def test_the_janitor_skips_while_another_process_runs_it(
    db_session: AsyncSession, db_engine, disk: LocalDisk
) -> None:
    async with db_engine.connect() as other:
        await other.begin()
        await other.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended('core:files:janitor', 0))")
        )
        assert await janitor_tick(factory_of(db_session), disk) is None
        await other.rollback()
