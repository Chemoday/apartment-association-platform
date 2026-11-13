"""Shared file storage (epic E11, task F1): docs/ARCHITECTURE.md section 10, docs/SCHEMA.md
section 12, docs/API.md section 12.

- `FileStore` is the port modules use: it stores, lists, serves and deletes the files of one
  `purpose` and `owner_ref`. A module checks its own rules first; to the store, a file of another
  purpose, owner or building does not exist.
- `LocalDisk` keeps the bytes under FILES_DIR (`blobs/<2>/<id>/<variant>`, `tmp/`). A blob is
  written before its row, so a crash leaves at most a blob without a row.
- Uploads are raw request bodies: `declared_length` and `read_body` refuse a body before it is read
  and stop at the cap. `UploadGate` bounds how many bodies are received and how many photos are
  re-encoded at once; `Reservations` hold a route's cap against the quota while its body arrives.
- `janitor_tick` marks expired files, erases deleted ones after 14 days, cleans `tmp/` and, weekly,
  compares the disk with the table.

`created_by_user_id` never leaves this module; logs carry ids and sizes only.
"""

import asyncio
import contextlib
import hashlib
import os
import random
import shutil
import time
import uuid
from collections import defaultdict
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from pathlib import Path

import structlog
from fastapi import Request, Response
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ColumnElement,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    delete,
    func,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column
from starlette.requests import ClientDisconnect

from src.core.config import Settings
from src.core.database import Base, varchar_enum
from src.core.domain_events import SessionFactory
from src.core.exceptions import DomainError
from src.core.images import EncodedPhoto, reencode_photo, unsupported_media_type

logger = structlog.get_logger(__name__)

NON_PRODUCTION_ENVIRONMENTS = frozenset({"local", "dev", "test"})
MB = 1024 * 1024
PURGE_DELAY = timedelta(days=14)
TMP_MAX_AGE = timedelta(hours=1)
ORPHAN_MIN_AGE = timedelta(days=1)
RECONCILE_EVERY = timedelta(days=7)
CORRUPTION_SAMPLE = 20
PURGE_BATCH = 500
DAY = timedelta(days=1)
# Photos may not use the last 20% of the quota: it stays for documents and official votes.
PHOTO_SHARE_OF_QUOTA = 0.8
# Bodies received at once, photos being re-encoded at once, and photos waiting for that.
MAX_BODIES_IN_FLIGHT = 8
MAX_CONCURRENT_PHOTOS = 1
MAX_QUEUED_PHOTOS = 4
BUSY_RETRY_SECONDS = 5
JANITOR_INTERVAL = timedelta(hours=1)
JANITOR_LOCK_KEY = "core:files:janitor"
_RECONCILE_MARKER = ".reconciled"
_sleep = asyncio.sleep  # tests replace it, never the global asyncio.sleep


def _now() -> datetime:
    return datetime.now(UTC)


class FilePurpose(StrEnum):
    ISSUE_PHOTO = "issue_photo"


class QuotaClass(StrEnum):
    PHOTOS = "photos"


PURPOSE_CLASS = {FilePurpose.ISSUE_PHOTO: QuotaClass.PHOTOS}


class PhotoVariant(StrEnum):
    DISPLAY = "display"
    THUMB = "thumb"


_VARIANT_FILES = {PhotoVariant.DISPLAY: "display.webp", PhotoVariant.THUMB: "thumb.webp"}
_MAIN_VARIANT = PhotoVariant.DISPLAY
PHOTO_CONTENT_TYPE = "image/webp"


# --- Table ---------------------------------------------------------------------------------------


class StoredFile(Base):
    __tablename__ = "core_files"
    __table_args__ = (
        CheckConstraint("(deleted_at IS NULL) = (purge_after IS NULL)", name="ck_core_files_purge"),
        CheckConstraint("size_bytes > 0", name="ck_core_files_size_positive"),
        CheckConstraint("width > 0 AND height > 0", name="ck_core_files_dimensions_positive"),
        Index("ix_core_files_owner", "purpose", "owner_ref"),
        Index("ix_core_files_building", "building_id"),
        Index("ix_core_files_creator_time", "created_by_user_id", "created_at"),
        Index(
            "uq_core_files_idempotency",
            "created_by_user_id",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key IS NOT NULL"),
        ),
        Index(
            "ix_core_files_expiring",
            "delete_after",
            postgresql_where=text("deleted_at IS NULL AND delete_after IS NOT NULL"),
        ),
        Index(
            "ix_core_files_purge",
            "purge_after",
            postgresql_where=text("purge_after IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_buildings.id", ondelete="CASCADE"), nullable=False
    )
    purpose: Mapped[FilePurpose] = mapped_column(
        varchar_enum(FilePurpose, "ck_core_files_purpose"), nullable=False
    )
    owner_ref: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    content_type: Mapped[str] = mapped_column(String(64), nullable=False)
    width: Mapped[int | None] = mapped_column(Integer, nullable=True)
    height: Mapped[int | None] = mapped_column(Integer, nullable=True)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id", ondelete="SET NULL"), nullable=True
    )
    idempotency_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    delete_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    purge_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


@dataclass(frozen=True)
class FileDTO:
    id: uuid.UUID
    purpose: FilePurpose
    owner_ref: uuid.UUID
    content_type: str
    width: int | None
    height: int | None
    size_bytes: int
    created_at: datetime
    uploaded_by_caller: bool  # whether the user the module asked for uploaded it
    deleted: bool = False  # only find_repeat returns deleted files


def _dto(row: StoredFile, caller_id: uuid.UUID | None) -> FileDTO:
    return FileDTO(
        id=row.id,
        purpose=row.purpose,
        owner_ref=row.owner_ref,
        content_type=row.content_type,
        width=row.width,
        height=row.height,
        size_bytes=row.size_bytes,
        created_at=row.created_at,
        uploaded_by_caller=caller_id is not None and row.created_by_user_id == caller_id,
        deleted=row.deleted_at is not None,
    )


# --- Errors --------------------------------------------------------------------------------------


def busy() -> DomainError:
    return DomainError(
        status_code=429,
        error_code="RATE_LIMITED",
        message="The server is busy with other uploads; try this file again shortly.",
        extra={"retry_after_seconds": BUSY_RETRY_SECONDS},
        headers={"Retry-After": str(BUSY_RETRY_SECONDS)},
    )


def _daily_limit(wait: int) -> DomainError:
    return DomainError(
        status_code=429,
        error_code="RATE_LIMITED",
        message="You have stored the files allowed for a day; try again later.",
        extra={"retry_after_seconds": wait},
        headers={"Retry-After": str(wait)},
    )


def _uploads_disabled() -> DomainError:
    return DomainError(
        status_code=403,
        error_code="UPLOADS_DISABLED",
        message="Uploads are switched off in this demo.",
    )


def _quota_exceeded() -> DomainError:
    return DomainError(
        status_code=507,
        error_code="STORAGE_QUOTA_EXCEEDED",
        message="The association has used up its storage for files.",
    )


def _low_disk() -> DomainError:
    return DomainError(
        status_code=507,
        error_code="STORAGE_LOW_DISK",
        message="The server is nearly out of disk space; uploads are paused.",
    )


def key_reused() -> DomainError:
    return DomainError(
        status_code=409,
        error_code="IDEMPOTENCY_KEY_REUSED",
        message="This Idempotency-Key was used for another file; send a new key for every file.",
    )


def _interrupted() -> DomainError:
    return DomainError(
        status_code=400,
        error_code="UPLOAD_INTERRUPTED",
        message="The upload was interrupted; send the file again.",
    )


def _too_large(cap: int) -> DomainError:
    return DomainError(
        status_code=413,
        error_code="FILE_TOO_LARGE",
        message=f"The file is larger than {cap} bytes.",
        extra={"max_bytes": cap},
    )


# --- Reading an upload --------------------------------------------------------------------------


def declared_length(request: Request, cap: int) -> int:
    """The body's Content-Length, refused before reading: missing (411) or above the cap (413)."""
    raw = request.headers.get("content-length")
    if raw is None or not raw.isdigit():
        raise DomainError(
            status_code=411,
            error_code="LENGTH_REQUIRED",
            message="Send the file with a Content-Length header.",
        )
    length = int(raw)
    if length > cap:
        raise _too_large(cap)
    return length


def require_content_type(request: Request, expected: str) -> None:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != expected:
        raise unsupported_media_type()


async def read_body(request: Request, length: int, cap: int) -> bytes:
    """Read at most the declared length; a longer body is cut off with 413."""
    body = bytearray()
    try:
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > length or len(body) > cap:
                raise _too_large(min(length, cap))
    except ClientDisconnect as exc:  # common on a mobile network; not a server error
        raise _interrupted() from exc
    return bytes(body)


def file_response(data: bytes, content_type: str) -> Response:
    """A stored file: never sniffed, never scripted, cached for good (a file never changes)."""
    return Response(
        content=data,
        media_type=content_type,
        headers={
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Cache-Control": "private, max-age=31536000, immutable",
            "Content-Disposition": "inline",
        },
    )


# --- Disk ----------------------------------------------------------------------------------------


class LocalDisk:
    """Blobs under one root directory. All methods are blocking: call them via asyncio.to_thread."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.blobs = root / "blobs"
        self.tmp = root / "tmp"

    def ensure_layout(self) -> None:
        self.blobs.mkdir(parents=True, exist_ok=True)
        self.tmp.mkdir(parents=True, exist_ok=True)

    def prepare(self) -> None:
        """At startup of the server: create the layout, empty tmp/ (left-overs of a crash) and
        prove the root is writable. Not at import: a one-off command in the running container
        must never empty tmp/ under an upload in progress."""
        self.ensure_layout()
        for leftover in self.tmp.iterdir():
            _remove(leftover)
        probe = self.tmp / f"probe-{uuid.uuid4().hex}"
        try:
            probe.write_bytes(b"")
            probe.unlink()
        except OSError as exc:
            raise RuntimeError(f"FILES_DIR {self.root} is not writable") from exc

    def _dir(self, file_id: uuid.UUID) -> Path:
        name = str(file_id)
        return self.blobs / name[:2] / name

    def write(self, file_id: uuid.UUID, variants: dict[str, bytes]) -> None:
        """Write every variant durably: temporary file, fsync, rename, fsync of the directory."""
        target = self._dir(file_id)
        temporary = self.tmp / f"{file_id}-{uuid.uuid4().hex}"
        try:
            target.mkdir(parents=True, exist_ok=True)
            for name, data in variants.items():
                with open(temporary, "wb") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, target / name)
            _fsync_dir(target)
            _fsync_dir(target.parent)
        except BaseException:
            _remove(temporary)
            _remove(target)  # a full disk leaves no half-written blob behind
            raise

    def read(self, file_id: uuid.UUID, name: str) -> bytes | None:
        try:
            return (self._dir(file_id) / name).read_bytes()
        except FileNotFoundError:
            return None

    def exists(self, file_id: uuid.UUID) -> bool:
        return self._dir(file_id).is_dir()

    def remove(self, file_id: uuid.UUID) -> None:
        _remove(self._dir(file_id))

    def free_bytes(self) -> int:
        return shutil.disk_usage(self.root).free

    def blob_ages(self) -> Iterator[tuple[uuid.UUID, float]]:
        """Every blob directory with its age in seconds; names that are not ids are skipped."""
        now = time.time()
        for prefix in self.blobs.iterdir():
            if not prefix.is_dir():
                continue
            for entry in prefix.iterdir():
                try:
                    file_id = uuid.UUID(entry.name)
                    yield file_id, now - entry.stat().st_mtime
                except (ValueError, FileNotFoundError):
                    continue

    def clean_tmp(self, older_than: timedelta) -> int:
        cutoff = time.time() - older_than.total_seconds()
        removed = 0
        for entry in self.tmp.iterdir():
            with contextlib.suppress(FileNotFoundError):
                if entry.stat().st_mtime < cutoff:
                    _remove(entry)
                    removed += 1
        return removed

    def reconcile_due(self, every: timedelta) -> bool:
        marker = self.root / _RECONCILE_MARKER
        try:
            return time.time() - marker.stat().st_mtime >= every.total_seconds()
        except FileNotFoundError:
            return True

    def mark_reconciled(self) -> None:
        (self.root / _RECONCILE_MARKER).touch()


def _remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path, ignore_errors=True)
    else:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def _fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


# --- Concurrency and reservations ---------------------------------------------------------------


class UploadGate:
    """Bounds the bodies being received and the photos being re-encoded (one app instance)."""

    def __init__(self) -> None:
        self._bodies = 0
        self._photo_slots = asyncio.Semaphore(MAX_CONCURRENT_PHOTOS)
        self._photos_waiting = 0

    @contextlib.contextmanager
    def receiving(self) -> Iterator[None]:
        if self._bodies >= MAX_BODIES_IN_FLIGHT:
            raise busy()
        self._bodies += 1
        try:
            yield
        finally:
            self._bodies -= 1

    async def reencode(self, data: bytes) -> EncodedPhoto:
        if self._photos_waiting >= MAX_CONCURRENT_PHOTOS + MAX_QUEUED_PHOTOS:
            raise busy()
        self._photos_waiting += 1
        try:
            async with self._photo_slots:
                return await asyncio.to_thread(reencode_photo, data)
        finally:
            self._photos_waiting -= 1


class Reservations:
    """Bytes held against a building's quota while bodies arrive (the backend is one process; the
    final check under the building's lock holds with several processes too)."""

    def __init__(self) -> None:
        self._held: defaultdict[uuid.UUID, int] = defaultdict(int)

    def held(self, building_id: uuid.UUID) -> int:
        return self._held[building_id]

    @contextlib.contextmanager
    def hold(self, building_id: uuid.UUID, size: int) -> Iterator[None]:
        self._held[building_id] += size
        try:
            yield
        finally:
            self._held[building_id] -= size
            if self._held[building_id] <= 0:
                del self._held[building_id]


# --- The port ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class FileLimits:
    quota_bytes: int
    user_bytes_per_day: int
    min_free_bytes: int
    demo_retention: timedelta | None  # set only while demo mode stores files


def file_limits(settings: Settings) -> FileLimits:
    demo = settings.DEMO_MODE_ENABLED
    quota_mb = settings.FILES_QUOTA_MB
    if demo:
        quota_mb = min(quota_mb, settings.FILES_DEMO_QUOTA_MB)
    return FileLimits(
        quota_bytes=quota_mb * MB,
        user_bytes_per_day=settings.FILES_USER_MB_PER_DAY * MB,
        min_free_bytes=settings.FILES_MIN_FREE_MB * MB,
        demo_retention=timedelta(hours=settings.FILES_DEMO_RETENTION_HOURS) if demo else None,
    )


def class_limit(quota_bytes: int, quota_class: QuotaClass) -> int:
    if quota_class == QuotaClass.PHOTOS:
        return int(quota_bytes * PHOTO_SHARE_OF_QUOTA)
    return quota_bytes  # pragma: no cover - documents and votes come with F3 and E3 part B


class FileStore:
    def __init__(
        self,
        session: AsyncSession,
        settings: Settings,
        disk: LocalDisk,
        gate: UploadGate,
        reservations: Reservations,
    ) -> None:
        self.session = session
        self.settings = settings
        self.disk = disk
        self.gate = gate
        self.reservations = reservations
        self.limits = file_limits(settings)

    @property
    def uploads_enabled(self) -> bool:
        """False in demo mode without FILES_IN_DEMO: no upload can succeed there."""
        return not (self.settings.DEMO_MODE_ENABLED and not self.settings.FILES_IN_DEMO)

    # --- Reading -------------------------------------------------------------------------------

    @staticmethod
    def _visible(purpose: FilePurpose, owner_ref: uuid.UUID) -> tuple[ColumnElement[bool], ...]:
        return (
            StoredFile.purpose == purpose,
            StoredFile.owner_ref == owner_ref,
            StoredFile.deleted_at.is_(None),
        )

    async def list_files(
        self, purpose: FilePurpose, owner_ref: uuid.UUID, caller_id: uuid.UUID | None = None
    ) -> list[FileDTO]:
        rows = await self.session.scalars(
            select(StoredFile)
            .where(*self._visible(purpose, owner_ref))
            .order_by(StoredFile.created_at, StoredFile.id)
            .execution_options(populate_existing=True)
        )
        return [_dto(row, caller_id) for row in rows]

    async def list_many(
        self,
        purpose: FilePurpose,
        owner_refs: list[uuid.UUID],
        caller_id: uuid.UUID | None = None,
    ) -> dict[uuid.UUID, list[FileDTO]]:
        found: dict[uuid.UUID, list[FileDTO]] = {ref: [] for ref in owner_refs}
        if not owner_refs:
            return found
        rows = await self.session.scalars(
            select(StoredFile)
            .where(
                StoredFile.purpose == purpose,
                StoredFile.owner_ref.in_(owner_refs),
                StoredFile.deleted_at.is_(None),
            )
            .order_by(StoredFile.created_at, StoredFile.id)
            .execution_options(populate_existing=True)
        )
        for row in rows:
            found[row.owner_ref].append(_dto(row, caller_id))
        return found

    async def count(self, purpose: FilePurpose, owner_ref: uuid.UUID) -> int:
        return int(
            await self.session.scalar(
                select(func.count())
                .select_from(StoredFile)
                .where(*self._visible(purpose, owner_ref))
            )
            or 0
        )

    async def get(
        self,
        file_id: uuid.UUID,
        purpose: FilePurpose,
        owner_ref: uuid.UUID,
        caller_id: uuid.UUID | None = None,
    ) -> FileDTO | None:
        row = await self.session.scalar(
            select(StoredFile)
            .where(StoredFile.id == file_id, *self._visible(purpose, owner_ref))
            .execution_options(populate_existing=True)
        )
        return _dto(row, caller_id) if row is not None else None

    async def read(self, file: FileDTO, variant: PhotoVariant) -> bytes | None:
        """The bytes of a variant; None (and an error in the log) when the blob is missing."""
        data = await asyncio.to_thread(self.disk.read, file.id, _VARIANT_FILES[variant])
        if data is None:
            logger.error("file_blob_missing", file_id=str(file.id), purpose=file.purpose.value)
        return data

    async def find_repeat(
        self, user_id: uuid.UUID, key: str, purpose: FilePurpose, owner_ref: uuid.UUID
    ) -> FileDTO | None:
        """The file a user already stored with this Idempotency-Key for the same purpose and
        owner (a repeat; `deleted` tells the module it is gone meanwhile), None when the key is
        new. A key used for another owner or purpose is 409 IDEMPOTENCY_KEY_REUSED: a client sends
        a new key for every file. Keys of purged files may be used again."""
        row = await self.session.scalar(
            select(StoredFile)
            .where(StoredFile.created_by_user_id == user_id, StoredFile.idempotency_key == key)
            # Deletes are bulk updates: never trust a row object held from earlier.
            .execution_options(populate_existing=True)
        )
        if row is None:
            return None
        if row.purpose != purpose or row.owner_ref != owner_ref:
            raise key_reused()
        return _dto(row, user_id)

    # --- Admission (before the body is read) ----------------------------------------------------

    async def admit(
        self, building_id: uuid.UUID, user_id: uuid.UUID, purpose: FilePurpose, cap: int
    ) -> None:
        """Demo mode, the disk, the quota (with the bodies in flight) and the user's daily
        limit, all before a byte of the body is read."""
        if not self.uploads_enabled:
            raise _uploads_disabled()
        if await asyncio.to_thread(self.disk.free_bytes) < self.limits.min_free_bytes:
            logger.warning("file_upload_low_disk", purpose=purpose.value)
            raise _low_disk()
        used = await self._used(building_id)
        limit = class_limit(self.limits.quota_bytes, PURPOSE_CLASS[purpose])
        if used + self.reservations.held(building_id) + cap > limit:
            raise _quota_exceeded()
        now = _now()
        rows = (
            await self.session.execute(
                select(StoredFile.created_at, StoredFile.size_bytes).where(
                    StoredFile.created_by_user_id == user_id,
                    StoredFile.created_at > now - DAY,
                )
            )
        ).all()
        stored = sum(size for _, size in rows)
        if stored + cap > self.limits.user_bytes_per_day and rows:
            oldest = min(at for at, _ in rows)
            raise _daily_limit(max(1, int((oldest + DAY - now).total_seconds()) + 1))

    async def _used(self, building_id: uuid.UUID) -> int:
        return int(
            await self.session.scalar(
                select(func.coalesce(func.sum(StoredFile.size_bytes), 0)).where(
                    StoredFile.building_id == building_id
                )
            )
            or 0
        )

    # --- Writing ---------------------------------------------------------------------------------

    async def store_photo(
        self,
        *,
        building_id: uuid.UUID,
        purpose: FilePurpose,
        owner_ref: uuid.UUID,
        created_by: uuid.UUID,
        photo: EncodedPhoto,
        idempotency_key: str | None,
        delete_after: datetime | None = None,
    ) -> tuple[FileDTO, bool]:
        """Store a re-encoded photo in the caller's transaction. Returns the file and whether it
        is new (False: the same Idempotency-Key won a race and its file is returned)."""
        await self.session.execute(
            select(
                func.pg_advisory_xact_lock(func.hashtextextended(f"core:files:{building_id}", 0))
            )
        )
        size = len(photo.display) + len(photo.thumb)
        if await self._used(building_id) + size > class_limit(
            self.limits.quota_bytes, PURPOSE_CLASS[purpose]
        ):
            raise _quota_exceeded()
        now = _now()
        if self.limits.demo_retention is not None:
            delete_after = min(filter(None, [delete_after, now + self.limits.demo_retention]))
        file_id = uuid.uuid4()
        variants = {
            _VARIANT_FILES[PhotoVariant.DISPLAY]: photo.display,
            _VARIANT_FILES[PhotoVariant.THUMB]: photo.thumb,
        }
        await asyncio.to_thread(self.disk.write, file_id, variants)  # the blob before the row
        row = StoredFile(
            id=file_id,
            building_id=building_id,
            purpose=purpose,
            owner_ref=owner_ref,
            content_type=PHOTO_CONTENT_TYPE,
            width=photo.width,
            height=photo.height,
            size_bytes=size,
            sha256=hashlib.sha256(variants[_VARIANT_FILES[_MAIN_VARIANT]]).hexdigest(),
            created_by_user_id=created_by,
            idempotency_key=idempotency_key,
            created_at=now,
            delete_after=delete_after,
        )
        try:
            async with self.session.begin_nested():
                self.session.add(row)
                await self.session.flush()
        except IntegrityError:
            await asyncio.to_thread(self.disk.remove, file_id)
            if idempotency_key is not None:  # a parallel request with the same key won
                repeat = await self.find_repeat(created_by, idempotency_key, purpose, owner_ref)
                if repeat is not None and not repeat.deleted:
                    return repeat, False
                raise key_reused() from None
            raise
        logger.info("file_stored", file_id=str(file_id), purpose=purpose.value, size_bytes=size)
        return _dto(row, created_by), True

    async def delete(self, file_id: uuid.UUID, purpose: FilePurpose, owner_ref: uuid.UUID) -> bool:
        """Hide a file now; the janitor erases it after PURGE_DELAY."""
        now = _now()
        result = await self.session.execute(
            update(StoredFile)
            .where(StoredFile.id == file_id, *self._visible(purpose, owner_ref))
            .values(deleted_at=now, purge_after=now + PURGE_DELAY)
            .execution_options(synchronize_session=False)
        )
        return bool(result.rowcount)

    async def delete_all(self, purpose: FilePurpose, owner_ref: uuid.UUID) -> int:
        """Hide every file of an owner now; the janitor erases them after PURGE_DELAY."""
        now = _now()
        result = await self.session.execute(
            update(StoredFile)
            .where(*self._visible(purpose, owner_ref))
            .values(deleted_at=now, purge_after=now + PURGE_DELAY)
            .execution_options(synchronize_session=False)
        )
        return int(result.rowcount or 0)

    async def set_delete_after(
        self, purpose: FilePurpose, owner_ref: uuid.UUID, when: datetime | None
    ) -> None:
        """The retention of an owner's files (None: kept). In demo mode a file never outlives
        its demo retention."""
        value: object = when
        if self.limits.demo_retention is not None:
            cap = StoredFile.created_at + self.limits.demo_retention
            value = cap if when is None else func.least(when, cap)
        await self.session.execute(
            update(StoredFile)
            .where(*self._visible(purpose, owner_ref))
            .values(delete_after=value)
            .execution_options(synchronize_session=False)
        )


def get_file_store_factory(request: Request) -> Callable[[AsyncSession], FileStore]:
    state = request.app.state
    return lambda session: FileStore(
        session, state.settings, state.file_disk, state.upload_gate, state.file_reservations
    )


# --- Settings and startup ----------------------------------------------------------------------


def validate_files_settings(settings: Settings) -> None:
    if settings.FILES_IN_DEMO and settings.ENVIRONMENT not in NON_PRODUCTION_ENVIRONMENTS:
        raise RuntimeError("FILES_IN_DEMO is only allowed for ENVIRONMENT local, dev or test")


# --- The janitor -------------------------------------------------------------------------------


@dataclass
class JanitorReport:
    expired: int = 0
    purged: int = 0
    tmp_removed: int = 0
    orphans_removed: int = 0
    missing: int = 0
    corrupt: int = 0
    reconciled: bool = False


async def janitor_tick(
    session_factory: SessionFactory, disk: LocalDisk, now: datetime | None = None
) -> JanitorReport | None:
    """One round of clean-up; None when another process held the lock."""
    now = now or _now()
    report = JanitorReport()
    async with session_factory() as session:
        locked = await session.scalar(
            text("SELECT pg_try_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": JANITOR_LOCK_KEY},
        )
        if not locked:
            return None
        expired = await session.execute(
            update(StoredFile)
            .where(StoredFile.deleted_at.is_(None), StoredFile.delete_after <= now)
            .values(deleted_at=now, purge_after=now + PURGE_DELAY)
            .execution_options(synchronize_session=False)
        )
        report.expired = expired.rowcount or 0
        to_purge = list(
            await session.scalars(
                select(StoredFile.id)
                .where(StoredFile.purge_after <= now)
                .order_by(StoredFile.purge_after)
                .limit(PURGE_BATCH)
            )
        )
        await session.commit()
    # The disk work outside the transaction: the blob first, then its row.
    for file_id in to_purge:
        await asyncio.to_thread(disk.remove, file_id)
    if to_purge:
        async with session_factory() as session:
            result = await session.execute(
                delete(StoredFile)
                .where(StoredFile.id.in_(to_purge), StoredFile.purge_after <= now)
                .execution_options(synchronize_session=False)
            )
            await session.commit()
        report.purged = result.rowcount or 0
    report.tmp_removed = await asyncio.to_thread(disk.clean_tmp, TMP_MAX_AGE)
    if await asyncio.to_thread(disk.reconcile_due, RECONCILE_EVERY):
        await _reconcile(session_factory, disk, report)
    if any((report.expired, report.purged, report.orphans_removed, report.missing, report.corrupt)):
        logger.info(
            "files_janitor",
            expired=report.expired,
            purged=report.purged,
            tmp_removed=report.tmp_removed,
            orphans_removed=report.orphans_removed,
            missing=report.missing,
            corrupt=report.corrupt,
        )
    return report


async def _reconcile(
    session_factory: SessionFactory, disk: LocalDisk, report: JanitorReport
) -> None:
    """Blobs without a row (older than a day) go; rows without a blob and a sample of corrupt
    blobs are logged as errors."""
    async with session_factory() as session:
        rows = (
            await session.execute(select(StoredFile.id, StoredFile.sha256, StoredFile.deleted_at))
        ).all()
    known = {file_id for file_id, _, _ in rows}
    on_disk = await asyncio.to_thread(lambda: dict(disk.blob_ages()))
    for file_id, age in on_disk.items():
        if file_id not in known and age > ORPHAN_MIN_AGE.total_seconds():
            await asyncio.to_thread(disk.remove, file_id)
            report.orphans_removed += 1
    live = [(file_id, digest) for file_id, digest, deleted_at in rows if deleted_at is None]
    for file_id, _ in live:
        if file_id not in on_disk:
            report.missing += 1
            logger.error("file_blob_missing", file_id=str(file_id))
    sample = random.sample(live, min(CORRUPTION_SAMPLE, len(live)))
    for file_id, digest in sample:
        data = await asyncio.to_thread(disk.read, file_id, _VARIANT_FILES[_MAIN_VARIANT])
        if data is not None and hashlib.sha256(data).hexdigest() != digest:
            report.corrupt += 1
            logger.error("file_blob_corrupt", file_id=str(file_id))
    await asyncio.to_thread(disk.mark_reconciled)
    report.reconciled = True


async def run_janitor_loop(
    session_factory_provider: Callable[[], SessionFactory],
    disk_provider: Callable[[], LocalDisk],
) -> None:
    """Run until cancelled: one tick, then wait an hour."""
    while True:
        try:
            await janitor_tick(session_factory_provider(), disk_provider())
        except Exception:  # CancelledError is not an Exception, so cancelling still stops it
            logger.exception("files_janitor_failed")
        await _sleep(JANITOR_INTERVAL.total_seconds())
