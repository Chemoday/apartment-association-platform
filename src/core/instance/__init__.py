"""The installation marker (epic E13 task R1; docs/ARCHITECTURE.md section 14).

Run by entrypoint.sh after the migrations and before the seed:  python -m src.core.instance
(the command lives in __main__.py, so that this module is never run as __main__).
Every installation has an INSTANCE_ID. Its database (table core_instance) and its files directory
(the file FILES_DIR/INSTANCE) carry it, so the backend never starts on the data of another
installation, nor in demo mode on the data of a real association (docs/BACKLOG.md B-4, S-7).
The rules and the reason codes are in docs/DEPLOYMENT.md "Demo mode and the installation marker".

`python -m src.core.instance show` prints the marker as JSON, for the installer.

Like seed.py this is infrastructure of src/core: it reads only whether core_files has a row.
"""

import asyncio
import os
import re
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from pathlib import Path

import structlog
from sqlalchemy import Boolean, CheckConstraint, DateTime, SmallInteger, String, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from src.core.config import NON_PRODUCTION_ENVIRONMENTS, Settings
from src.core.database import Base, build_engine, transaction

INSTANCE_FILE = "INSTANCE"
INSTANCE_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{2,63}")
INSTANCE_LOCK_KEY = 7_202_611_001

logger = structlog.get_logger(__name__)


class InstanceRecord(Base):
    __tablename__ = "core_instance"
    __table_args__ = (CheckConstraint("id = 1", name="ck_core_instance_single_row"),)

    id: Mapped[int] = mapped_column(SmallInteger, primary_key=True)
    instance_id: Mapped[str] = mapped_column(String(64), nullable=False)
    demo: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class RefusalReason(StrEnum):
    INSTANCE_ID_MISSING = "INSTANCE_ID_MISSING"
    INSTANCE_ID_INVALID = "INSTANCE_ID_INVALID"
    DATABASE_OF_ANOTHER_INSTANCE = "DATABASE_OF_ANOTHER_INSTANCE"
    DEMO_ON_REAL_DATA = "DEMO_ON_REAL_DATA"
    REAL_ON_DEMO_DATA = "REAL_ON_DEMO_DATA"
    FILES_OF_ANOTHER_INSTANCE = "FILES_OF_ANOTHER_INSTANCE"
    FILES_MARKER_MISSING = "FILES_MARKER_MISSING"


class InstanceRefused(RuntimeError):
    """The backend must not start on these data. Carries no value read from them but a valid id."""

    def __init__(self, reason: RefusalReason, found: str | None = None) -> None:
        super().__init__(reason.value)
        self.reason = reason
        self.found = found if found is not None and is_valid_instance_id(found) else None


@dataclass(frozen=True)
class InstanceMarker:
    instance_id: str
    demo: bool
    created_at: datetime
    claimed_now: bool


def is_valid_instance_id(value: str) -> bool:
    return INSTANCE_ID_PATTERN.fullmatch(value) is not None


def read_files_marker(files_root: Path) -> str | None:
    """The id in FILES_DIR/INSTANCE, None when the file is missing, and "" when it cannot be read
    as text (never a valid id, so it is refused like the marker of another installation)."""
    try:
        return (files_root / INSTANCE_FILE).read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return None
    except (OSError, UnicodeDecodeError):
        return ""


def write_files_marker(files_root: Path, instance_id: str) -> None:
    """Atomically: a crash leaves either no file or the whole id, never a part of it."""
    files_root.mkdir(parents=True, exist_ok=True)
    partial = files_root / f".{INSTANCE_FILE}.partial"
    partial.write_text(instance_id + "\n", encoding="utf-8")
    os.replace(partial, files_root / INSTANCE_FILE)


async def read_marker(session: AsyncSession) -> InstanceRecord | None:
    return await session.get(InstanceRecord, 1)


async def check_instance(
    session: AsyncSession, config: Settings, files_root: Path
) -> InstanceMarker:
    """Write the marker on the first start, compare it on every later one.

    Raises InstanceRefused when the backend must not start. The caller commits (use
    `transaction(session)`), so the marker row is written only together with a passed check.
    """
    instance_id = config.INSTANCE_ID.strip()
    if not instance_id:
        raise InstanceRefused(RefusalReason.INSTANCE_ID_MISSING)
    if not is_valid_instance_id(instance_id):
        raise InstanceRefused(RefusalReason.INSTANCE_ID_INVALID)

    # Two containers starting at once must not both write a marker.
    await session.execute(select(func.pg_advisory_xact_lock(INSTANCE_LOCK_KEY)))
    record = await read_marker(session)
    on_file = await asyncio.to_thread(read_files_marker, files_root)
    if on_file is not None and on_file != instance_id:
        raise InstanceRefused(RefusalReason.FILES_OF_ANOTHER_INSTANCE, found=on_file)

    if record is not None:
        if record.instance_id != instance_id:
            raise InstanceRefused(
                RefusalReason.DATABASE_OF_ANOTHER_INSTANCE, found=record.instance_id
            )
        if config.DEMO_MODE_ENABLED and not record.demo:
            raise InstanceRefused(RefusalReason.DEMO_ON_REAL_DATA)
        # Imported here: module property reads the marker, and src.core.files imports it back.
        from src.core.files import StoredFile

        if on_file is None and await session.scalar(select(StoredFile.id).limit(1)) is not None:
            # The files directory of another installation, or an empty one: the files are gone.
            raise InstanceRefused(RefusalReason.FILES_MARKER_MISSING)

    demo = record.demo if record is not None else config.DEMO_MODE_ENABLED or config.SEED_DEMO_DATA
    if demo and not config.DEMO_MODE_ENABLED:
        if config.ENVIRONMENT not in NON_PRODUCTION_ENVIRONMENTS:
            # A real association must not start on the fictitious people of a demo; locally and
            # on dev the seeded building may run without demo mode (a test of the e-mails).
            raise InstanceRefused(RefusalReason.REAL_ON_DEMO_DATA)
        logger.warning("instance_demo_data_without_demo_mode", instance_id=instance_id)

    # Every check passed: only now is anything written.
    claimed_now = record is None
    if record is None:
        record = InstanceRecord(id=1, instance_id=instance_id, demo=demo)
        session.add(record)
        await session.flush()
        await session.refresh(record)
    if on_file is None:
        # Before the commit: a crash in between leaves a file the next start accepts.
        await asyncio.to_thread(write_files_marker, files_root, instance_id)
    return InstanceMarker(
        instance_id=record.instance_id,
        demo=record.demo,
        created_at=record.created_at,
        claimed_now=claimed_now,
    )


async def is_real_installation(session: AsyncSession) -> bool:
    """True when the marker says the database belongs to a real installation (no marker: False)."""
    record = await read_marker(session)
    return record is not None and not record.demo


async def run_check(config: Settings) -> InstanceMarker:
    engine = build_engine(config.DATABASE_URL)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            async with transaction(session):
                return await check_instance(session, config, Path(config.FILES_DIR))
    finally:
        await engine.dispose()


async def describe(config: Settings) -> dict[str, object]:
    engine = build_engine(config.DATABASE_URL)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            record = await read_marker(session)
    finally:
        await engine.dispose()
    on_file = read_files_marker(Path(config.FILES_DIR))
    return {
        "instance_id": record.instance_id if record else None,
        "demo": record.demo if record else None,
        "created_at": record.created_at.isoformat() if record else None,
        "files_instance_id": on_file if on_file is None or is_valid_instance_id(on_file) else "",
    }
