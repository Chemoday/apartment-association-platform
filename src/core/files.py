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
import errno
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
from urllib.parse import quote

import structlog
from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ColumnElement,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    cast,
    delete,
    func,
    literal,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column
from starlette.requests import ClientDisconnect

from src.core.config import Settings
from src.core.database import Base, DbSession, session_outbox, varchar_enum
from src.core.domain_events import SessionFactory
from src.core.event_bus import EventBus
from src.core.exceptions import AUTH_ERRORS, DomainError, error_responses
from src.core.file_events import StorageUsageHigh
from src.core.images import EncodedPhoto, reencode_photo
from src.core.security import require_building_roles
from src.modules.property.schemas import BuildingRole, CurrentUserDTO

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
    DOCUMENT = "document"


class QuotaClass(StrEnum):
    PHOTOS = "photos"
    DOCUMENTS = "documents"


PURPOSE_CLASS = {
    FilePurpose.ISSUE_PHOTO: QuotaClass.PHOTOS,
    FilePurpose.DOCUMENT: QuotaClass.DOCUMENTS,
}


class FileVariant(StrEnum):
    DISPLAY = "display"
    THUMB = "thumb"
    ORIGINAL = "original"


class PhotoVariant(StrEnum):
    """The variants a photo has (a subset of FileVariant)."""

    DISPLAY = "display"
    THUMB = "thumb"


# Keyed by the variant's value, so FileVariant and PhotoVariant members both work.
_VARIANT_FILES: dict[str, str] = {
    FileVariant.DISPLAY.value: "display.webp",
    FileVariant.THUMB.value: "thumb.webp",
    FileVariant.ORIGINAL.value: "original.pdf",
}
# The variant whose hash is stored and checked by the janitor.
_MAIN_VARIANT = {
    FilePurpose.ISSUE_PHOTO: FileVariant.DISPLAY,
    FilePurpose.DOCUMENT: FileVariant.ORIGINAL,
}
PHOTO_CONTENT_TYPE = "image/webp"
PDF_CONTENT_TYPE = "application/pdf"
PDF_SIGNATURE = b"%PDF-"
WRITE_BUFFER = 1024 * 1024
# The reserve for official votes (E11 section 6): 5% of the quota, at least 100 MB, at most 20%.
VOTES_RESERVE_SHARE = 0.05
VOTES_RESERVE_MIN = 100 * 1024 * 1024
VOTES_RESERVE_MAX_SHARE = 0.2


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


# Usage thresholds the board is told about once (task F4), and how far below a threshold the
# usage must fall before it can be told again.
ALERT_THRESHOLDS = (70, 90)  # percent of the room for files (quota minus the votes reserve)
ALERT_RESET_POINTS = 10


class FileAlert(Base):
    __tablename__ = "core_file_alerts"
    __table_args__ = (
        CheckConstraint("threshold IN (70, 90)", name="ck_core_file_alerts_threshold"),
    )

    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("property_buildings.id", ondelete="CASCADE"),
        primary_key=True,
    )
    threshold: Mapped[int] = mapped_column(Integer, primary_key=True)
    reached_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


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


def _is_key_conflict(error: IntegrityError) -> bool:
    """The insert met the Idempotency-Key index, not another constraint (a foreign key). The
    driver's own error names the constraint; its text is the fallback."""
    name = "uq_core_files_idempotency"
    driver_error = getattr(error.orig, "__cause__", None)
    if getattr(driver_error, "constraint_name", None) == name:
        return True
    return name in str(error.orig)


def _known_purpose(value: object) -> FilePurpose | None:
    try:
        return FilePurpose(value)
    except ValueError:
        return None


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


def _not_that_type() -> DomainError:
    return DomainError(
        status_code=415,
        error_code="UNSUPPORTED_MEDIA_TYPE",
        message="The file is not of the type it claims to be.",
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
        raise DomainError(
            status_code=415,
            error_code="UNSUPPORTED_MEDIA_TYPE",
            message=f"Send the file as {expected}.",
        )


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


def _disposition(filename: str | None) -> str:
    """inline for images; for a document an attachment with an ASCII fallback name and the full
    UTF-8 name (RFC 6266 / RFC 5987)."""
    if filename is None:
        return "inline"
    ascii_name = "".join(
        ch if ch.isascii() and (ch.isalnum() or ch in " ._-") else "_" for ch in filename
    )
    ascii_name = " ".join(ascii_name.split())
    if not any(ch.isalnum() for ch in ascii_name.rsplit(".", 1)[0]):
        ascii_name = "document." + filename.rsplit(".", 1)[-1] if "." in filename else "document"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename, safe='')}"


@dataclass(frozen=True)
class ReceivedFile:
    """A body written to tmp/ while it was counted and hashed (delete it if it is not stored)."""

    path: Path
    size: int
    sha256: str


async def receive_to_disk(
    request: Request, disk: "LocalDisk", length: int, cap: int, signature: bytes
) -> ReceivedFile:
    """Stream a body to a temporary file: at most the declared length and the cap, fsynced, and
    starting with `signature` (else 415, and nothing stays on disk)."""
    path = disk.new_temporary()
    digest = hashlib.sha256()
    size = 0
    head = b""
    buffer = bytearray()
    try:
        handle = await asyncio.to_thread(open, path, "wb")
    except OSError as exc:  # a full disk or too many open files: nothing was written
        if exc.errno == errno.ENOSPC:
            raise _low_disk() from exc
        raise
    try:
        try:
            async for chunk in request.stream():
                if not chunk:
                    continue
                if len(head) < len(signature):
                    head += chunk[: len(signature) - len(head)]
                    if not signature.startswith(head):
                        raise _not_that_type()
                size += len(chunk)
                if size > length or size > cap:
                    raise _too_large(min(length, cap))
                digest.update(chunk)
                buffer.extend(chunk)
                if len(buffer) >= WRITE_BUFFER:  # one hand-off to a thread per MB, not per chunk
                    await asyncio.to_thread(handle.write, bytes(buffer))
                    buffer.clear()
        except ClientDisconnect as exc:
            raise _interrupted() from exc
        if head != signature:
            raise _not_that_type()
        if buffer:
            await asyncio.to_thread(handle.write, bytes(buffer))
        await asyncio.to_thread(_flush_and_sync, handle)
        await asyncio.to_thread(handle.close)
    except BaseException as exc:
        with contextlib.suppress(OSError):
            await asyncio.to_thread(handle.close)
        _remove(path)  # always: a half-written file never stays behind
        if isinstance(exc, OSError) and exc.errno == errno.ENOSPC:
            raise _low_disk() from exc
        raise
    return ReceivedFile(path=path, size=size, sha256=digest.hexdigest())


def _flush_and_sync(handle) -> None:  # type: ignore[no-untyped-def]
    handle.flush()
    os.fsync(handle.fileno())


_IMMUTABLE = "private, max-age=31536000, immutable"


def _file_headers(attachment_name: str | None) -> dict[str, str]:
    return {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        # A document's name and audience can change: never keep a copy (a shared device).
        "Cache-Control": _IMMUTABLE if attachment_name is None else "private, no-store",
        "Content-Disposition": _disposition(attachment_name),
    }


def streamed_file_response(path: Path, content_type: str, attachment_name: str) -> FileResponse:
    """A large stored file (a document) streamed from disk in chunks, never read whole."""
    return FileResponse(path, media_type=content_type, headers=_file_headers(attachment_name))


def file_response(data: bytes, content_type: str) -> Response:
    """A small stored image shown inline: never sniffed, never scripted, cached for good (a file
    never changes). Documents use `streamed_file_response`."""
    return Response(content=data, media_type=content_type, headers=_file_headers(None))


def attachment_name(title: str, extension: str) -> str:
    """A file name from a title: no path separators or control characters, at most 120 chars."""
    cleaned = "".join(ch for ch in title if ch.isprintable() and ch not in '/\\:*?"<>|')
    cleaned = " ".join(cleaned.split())[:120].strip(" .") or "document"
    return f"{cleaned}.{extension}"


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

    def adopt(self, file_id: uuid.UUID, temporary: Path, name: str) -> None:
        """Move a fully received temporary file into place as the blob's only variant."""
        target = self._dir(file_id)
        try:
            target.mkdir(parents=True, exist_ok=True)
            os.replace(temporary, target / name)
            _fsync_dir(target)
            _fsync_dir(target.parent)
        except BaseException:
            _remove(temporary)
            _remove(target)
            raise

    def new_temporary(self) -> Path:
        return self.tmp / f"upload-{uuid.uuid4().hex}"

    def read(self, file_id: uuid.UUID, name: str) -> bytes | None:
        try:
            return (self._dir(file_id) / name).read_bytes()
        except FileNotFoundError:
            return None

    def sha256(self, file_id: uuid.UUID, name: str) -> str | None:
        """The hash of a variant, read in chunks (a document can be 20 MB)."""
        digest = hashlib.sha256()
        try:
            with open(self._dir(file_id) / name, "rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
        except FileNotFoundError:
            return None
        return digest.hexdigest()

    def path_of(self, file_id: uuid.UUID, name: str) -> Path | None:
        path = self._dir(file_id) / name
        return path if path.is_file() else None

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


def votes_reserve(quota_bytes: int) -> int:
    reserve = max(int(quota_bytes * VOTES_RESERVE_SHARE), VOTES_RESERVE_MIN)
    return min(reserve, int(quota_bytes * VOTES_RESERVE_MAX_SHARE))


def room_for_files(quota_bytes: int) -> int:
    """What photos and documents together may fill: the quota minus the votes reserve. The
    storage alerts are percentages of it, so they come before uploads are refused."""
    return quota_bytes - votes_reserve(quota_bytes)


def class_limit(quota_bytes: int, quota_class: QuotaClass) -> int:
    """How much of the quota a class may fill (all classes together count against it)."""
    if quota_class == QuotaClass.PHOTOS:
        return int(quota_bytes * PHOTO_SHARE_OF_QUOTA)
    return quota_bytes - votes_reserve(quota_bytes)


class FileStore:
    def __init__(
        self,
        session: AsyncSession,
        settings: Settings,
        disk: LocalDisk,
        gate: UploadGate,
        reservations: Reservations,
        bus: EventBus | None = None,
    ) -> None:
        self.session = session
        # Events (StorageUsageHigh) go to the request's outbox; None only where nothing listens.
        self.bus = bus
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

    async def read(self, file: FileDTO, variant: FileVariant | PhotoVariant) -> bytes | None:
        """The bytes of a variant; None (and an error in the log) when the blob is missing."""
        data = await asyncio.to_thread(self.disk.read, file.id, _VARIANT_FILES[variant])
        if data is None:
            logger.error("file_blob_missing", file_id=str(file.id), purpose=file.purpose.value)
        return data

    async def blob_path(self, file: FileDTO, variant: FileVariant) -> Path | None:
        """Where a variant lies on disk, for streaming; None (and an error) when it is missing."""
        path = await asyncio.to_thread(self.disk.path_of, file.id, _VARIANT_FILES[variant])
        if path is None:
            logger.error("file_blob_missing", file_id=str(file.id), purpose=file.purpose.value)
        return path

    @staticmethod
    def file_is_live(file_id: ColumnElement[uuid.UUID]) -> ColumnElement[bool]:
        """A condition for a module's query: its file (by id) exists and is not deleted, so a
        record whose file expired (demo mode) or was deleted is hidden. Uses the primary key."""
        return (
            select(StoredFile.id)
            .where(StoredFile.id == file_id, StoredFile.deleted_at.is_(None))
            .exists()
        )

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
        if PURPOSE_CLASS[purpose] != QuotaClass.PHOTOS:
            return  # the daily limit is for the residents' stream; staff files have the quota
        now = _now()
        photo_purposes = [p for p, c in PURPOSE_CLASS.items() if c == QuotaClass.PHOTOS]
        rows = (
            await self.session.execute(
                select(StoredFile.created_at, StoredFile.size_bytes).where(
                    StoredFile.created_by_user_id == user_id,
                    StoredFile.created_at > now - DAY,
                    StoredFile.purpose.in_(photo_purposes),
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
        used_after = await self._used(building_id) + size
        if used_after > class_limit(self.limits.quota_bytes, PURPOSE_CLASS[purpose]):
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
            sha256=hashlib.sha256(variants[_VARIANT_FILES[_MAIN_VARIANT[purpose]]]).hexdigest(),
            created_by_user_id=created_by,
            idempotency_key=idempotency_key,
            created_at=now,
            delete_after=delete_after,
        )
        try:
            async with self.session.begin_nested():
                self.session.add(row)
                await self.session.flush()
        except IntegrityError as exc:
            await asyncio.to_thread(self.disk.remove, file_id)
            if idempotency_key is not None and _is_key_conflict(exc):  # a parallel request won
                repeat = await self.find_repeat(created_by, idempotency_key, purpose, owner_ref)
                if repeat is not None and not repeat.deleted:
                    return repeat, False
                raise key_reused() from None
            raise
        logger.info("file_stored", file_id=str(file_id), purpose=purpose.value, size_bytes=size)
        await self._check_alerts(building_id, now, used_after)
        return _dto(row, created_by), True

    async def store_received(
        self,
        *,
        building_id: uuid.UUID,
        purpose: FilePurpose,
        owner_ref: uuid.UUID,
        created_by: uuid.UUID,
        received: ReceivedFile,
        content_type: str,
        idempotency_key: str | None,
    ) -> FileDTO:
        """Store a streamed file (a document) in the caller's transaction: the final quota check
        under the building's lock, the blob moved into place, then the row. The caller removes
        `received.path` if this raises before the move."""
        await self.session.execute(
            select(
                func.pg_advisory_xact_lock(func.hashtextextended(f"core:files:{building_id}", 0))
            )
        )
        used_after = await self._used(building_id) + received.size
        if used_after > class_limit(self.limits.quota_bytes, PURPOSE_CLASS[purpose]):
            raise _quota_exceeded()
        now = _now()
        file_id = uuid.uuid4()
        await asyncio.to_thread(
            self.disk.adopt, file_id, received.path, _VARIANT_FILES[_MAIN_VARIANT[purpose]]
        )
        row = StoredFile(
            id=file_id,
            building_id=building_id,
            purpose=purpose,
            owner_ref=owner_ref,
            content_type=content_type,
            size_bytes=received.size,
            sha256=received.sha256,
            created_by_user_id=created_by,
            idempotency_key=idempotency_key,
            created_at=now,
            delete_after=(
                now + self.limits.demo_retention if self.limits.demo_retention is not None else None
            ),
        )
        try:
            async with self.session.begin_nested():
                self.session.add(row)
                await self.session.flush()
        except IntegrityError as exc:
            await asyncio.to_thread(self.disk.remove, file_id)
            if idempotency_key is None or not _is_key_conflict(exc):
                raise
            raise key_reused() from None  # the same key won a race; the module looks it up
        logger.info(
            "file_stored", file_id=str(file_id), purpose=purpose.value, size_bytes=received.size
        )
        await self._check_alerts(building_id, now, used_after)
        return _dto(row, created_by)

    async def _check_alerts(self, building_id: uuid.UUID, now: datetime, used: int) -> None:
        """A threshold of the room for files reached for the first time (since the usage last
        fell well below it): insert its row and store the event, in the caller's transaction."""
        if self.bus is None:
            return
        room_percent = used * 100 // room_for_files(self.limits.quota_bytes)
        used_percent = used * 100 // self.limits.quota_bytes
        for threshold in ALERT_THRESHOLDS:
            if room_percent < threshold:
                continue
            inserted = await self.session.scalar(
                pg_insert(FileAlert)
                .values(building_id=building_id, threshold=threshold, reached_at=now)
                .on_conflict_do_nothing(index_elements=["building_id", "threshold"])
                .returning(FileAlert.threshold)
            )
            if inserted is not None:
                logger.warning(
                    "file_storage_threshold", threshold=threshold, used_percent=used_percent
                )
                session_outbox(self.session, self.bus).add(
                    StorageUsageHigh(
                        building_id=building_id, threshold=threshold, used_percent=used_percent
                    )
                )

    async def usage(self, building_id: uuid.UUID) -> "FileUsage":
        rows = (
            await self.session.execute(
                select(
                    # As text: a purpose of a newer release (after a rollback) must not fail
                    # the enum's strict result processing.
                    cast(StoredFile.purpose, String),
                    func.sum(StoredFile.size_bytes),
                    func.sum(StoredFile.size_bytes).filter(StoredFile.deleted_at.is_not(None)),
                )
                .where(StoredFile.building_id == building_id)
                .group_by(cast(StoredFile.purpose, String))
            )
        ).all()
        by_class: dict[QuotaClass, int] = dict.fromkeys(QuotaClass, 0)
        used = pending = 0
        for purpose, size, deleted in rows:
            used += int(size or 0)  # every row, like the quota check
            pending += int(deleted or 0)
            purpose_known = _known_purpose(purpose)
            if purpose_known is not None:  # an unknown purpose is in the total only
                by_class[PURPOSE_CLASS[purpose_known]] += int(size or 0)
        quota = self.limits.quota_bytes
        return FileUsage(
            quota_bytes=quota,
            used_bytes=used,
            used_percent=used * 100 // quota,
            pending_deletion_bytes=pending,
            categories=[
                CategoryUsage(
                    category=quota_class.value,
                    used_bytes=by_class[quota_class],
                    limit_bytes=class_limit(quota, quota_class),
                )
                for quota_class in QuotaClass
            ],
        )

    async def find_by_key(
        self, user_id: uuid.UUID, key: str, purpose: FilePurpose
    ) -> FileDTO | None:
        """The file a user stored with this Idempotency-Key for a purpose whose owner the module
        creates with the upload (a document); another purpose is 409 IDEMPOTENCY_KEY_REUSED."""
        row = await self.session.scalar(
            select(StoredFile)
            .where(StoredFile.created_by_user_id == user_id, StoredFile.idempotency_key == key)
            .execution_options(populate_existing=True)
        )
        if row is None:
            return None
        if row.purpose != purpose:
            raise key_reused()
        return _dto(row, user_id)

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
        session,
        state.settings,
        state.file_disk,
        state.upload_gate,
        state.file_reservations,
        state.event_bus,
    )


# --- Usage (task F4; docs/API.md section 12) ------------------------------------------------------


class CategoryUsage(BaseModel):
    category: str
    used_bytes: int
    limit_bytes: int


class FileUsage(BaseModel):
    quota_bytes: int
    used_bytes: int
    used_percent: int
    pending_deletion_bytes: int
    categories: list[CategoryUsage]


usage_router = APIRouter(
    prefix="/api/v1/files",
    tags=["files"],
    responses=error_responses(
        {401: AUTH_ERRORS, 403: ["FORBIDDEN"], 500: ["INTERNAL_SERVER_ERROR"]}
    ),
)


@usage_router.get("/usage", response_model=FileUsage)
async def get_usage(
    request: Request,
    session: DbSession,
    user: CurrentUserDTO = Depends(
        require_building_roles(BuildingRole.CHAIRMAN, BuildingRole.BOARD)
    ),
) -> FileUsage:
    """How much of the association's quota its files use (the chairman and the board)."""
    return await get_file_store_factory(request)(session).usage(user.building_id)


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
    session_factory: SessionFactory,
    disk: LocalDisk,
    now: datetime | None = None,
    quota_bytes: int | None = None,
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
        if quota_bytes is not None:  # usage fell well below a threshold: it may be told again
            used = (
                select(func.coalesce(func.sum(StoredFile.size_bytes), 0))
                .where(StoredFile.building_id == FileAlert.building_id)
                .scalar_subquery()
            )
            await session.execute(
                delete(FileAlert)
                # BIGINT throughout: any real quota times a percent overflows a 32-bit integer.
                .where(
                    cast(used, BigInteger) * 100
                    < (cast(FileAlert.threshold, BigInteger) - ALERT_RESET_POINTS)
                    * literal(room_for_files(quota_bytes), BigInteger)
                )
                .execution_options(synchronize_session=False)
            )
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
            await session.execute(
                select(
                    StoredFile.id,
                    StoredFile.sha256,
                    StoredFile.deleted_at,
                    cast(StoredFile.purpose, String),  # as text: see FileStore.usage
                )
            )
        ).all()
    known = {file_id for file_id, _, _, _ in rows}
    on_disk = await asyncio.to_thread(lambda: dict(disk.blob_ages()))
    for file_id, age in on_disk.items():
        if file_id not in known and age > ORPHAN_MIN_AGE.total_seconds():
            await asyncio.to_thread(disk.remove, file_id)
            report.orphans_removed += 1
    live = [
        (file_id, digest, purpose)
        for file_id, digest, deleted_at, purpose in rows
        if deleted_at is None
    ]
    for file_id, _, _ in live:
        if file_id not in on_disk:
            report.missing += 1
            logger.error("file_blob_missing", file_id=str(file_id))
    sample = random.sample(live, min(CORRUPTION_SAMPLE, len(live)))
    for file_id, digest, purpose in sample:
        purpose_known = _known_purpose(purpose)
        if purpose_known is None:
            continue
        actual = await asyncio.to_thread(
            disk.sha256, file_id, _VARIANT_FILES[_MAIN_VARIANT[purpose_known]]
        )
        if actual is not None and actual != digest:
            report.corrupt += 1
            logger.error("file_blob_corrupt", file_id=str(file_id))
    await asyncio.to_thread(disk.mark_reconciled)
    report.reconciled = True


async def run_janitor_loop(
    session_factory_provider: Callable[[], SessionFactory],
    disk_provider: Callable[[], LocalDisk],
    quota_provider: Callable[[], int] | None = None,
) -> None:
    """Run until cancelled: one tick, then wait an hour."""
    while True:
        try:
            await janitor_tick(
                session_factory_provider(),
                disk_provider(),
                quota_bytes=quota_provider() if quota_provider is not None else None,
            )
        except Exception:  # CancelledError is not an Exception, so cancelling still stops it
            logger.exception("files_janitor_failed")
        await _sleep(JANITOR_INTERVAL.total_seconds())
