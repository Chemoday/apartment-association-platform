"""Real concurrency on committed data: two reports of one apartment at the same moment, and two
photos of one issue."""

import asyncio
import atexit
import io
import shutil
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from alembic import command
from PIL import Image
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from starlette.requests import Request

from src.core.building_settings import BuildingSettingRecord
from src.core.config import get_settings
from src.core.database import build_engine
from src.core.event_bus import EventOutbox, InMemoryEventBus
from src.core.exceptions import DomainError
from src.core.files import FileStore, LocalDisk, Reservations, StoredFile, UploadGate
from src.core.migrations import alembic_config
from src.modules.issues.models import Issue
from src.modules.issues.schemas import IssueCategory, IssueReport
from src.modules.issues.service import IssuesService
from src.modules.property.service import PropertyService
from tests.db_utils import scratch_database
from tests.issues.conftest import IssueWorld, build_issue_world

BLOCKED = 0.5


@pytest.fixture
async def committed(database_url: str) -> AsyncIterator[tuple[AsyncEngine, IssueWorld]]:
    async with scratch_database(database_url) as url:
        await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
        engine = build_engine(url)
        async with AsyncSession(engine, expire_on_commit=False) as session:
            world = await build_issue_world(session)
            session.add(
                BuildingSettingRecord(
                    building_id=world.building.id,
                    key="issues.reports_per_apartment_per_day",
                    value=1,
                    updated_at=func.now(),
                )
            )
            await session.commit()
        try:
            yield engine, world
        finally:
            await engine.dispose()


# One file store for the tests of this package that work on committed data (photos, retention).
_DISK_ROOT = Path(tempfile.mkdtemp(prefix="aap-test-concurrency-files-"))
atexit.register(shutil.rmtree, _DISK_ROOT, ignore_errors=True)
_DISK = LocalDisk(_DISK_ROOT)
_DISK.prepare()
_FILE_SETTINGS = get_settings().model_copy(update={"FILES_IN_DEMO": True, "FILES_MIN_FREE_MB": 0})
_GATE, _RESERVATIONS = UploadGate(), Reservations()


async def service_for(session: AsyncSession, user_id):
    properties = PropertyService(session)
    files = FileStore(session, _FILE_SETTINGS, _DISK, _GATE, _RESERVATIONS)
    service = IssuesService(session, properties, EventOutbox(InMemoryEventBus()), files)
    return service, await properties.get_current_user(user_id)


REPORT = IssueReport(category=IssueCategory.LIGHTING, entrance=2, place="Landing", title="Dark")


async def test_two_reports_of_one_apartment_cannot_both_take_the_last_slot(committed) -> None:
    engine, world = committed
    async with AsyncSession(engine) as first, AsyncSession(engine) as second:
        owner_service, owner = await service_for(first, world.owner_14.id)
        family_service, family = await service_for(second, world.family_14.id)
        await owner_service.report(owner, REPORT)
        waiting = asyncio.create_task(family_service.report(family, REPORT))
        await asyncio.sleep(BLOCKED)
        assert not waiting.done(), "the second report waits for the apartment's lock"

        await first.commit()
        with pytest.raises(DomainError) as refused:
            await waiting
        await second.rollback()

    assert refused.value.error_code == "RATE_LIMITED"
    async with AsyncSession(engine) as check:
        assert await check.scalar(select(func.count()).select_from(Issue)) == 1


# --- Photos (epic E11 F2): the issue's lock keeps the count at three -----------------------------


def _photo_request(data: bytes) -> Request:
    sent = False

    async def receive() -> dict:
        nonlocal sent
        if sent:
            return {"type": "http.request", "body": b"", "more_body": False}
        sent = True
        return {"type": "http.request", "body": data, "more_body": False}

    headers = [(b"content-type", b"image/jpeg"), (b"content-length", str(len(data)).encode())]
    return Request({"type": "http", "method": "POST", "path": "/", "headers": headers}, receive)


async def test_two_uploads_at_the_same_moment_never_make_a_fourth_photo(committed) -> None:
    engine, world = committed
    buffer = io.BytesIO()
    Image.new("RGB", (64, 48), "blue").save(buffer, format="JPEG")
    photo = buffer.getvalue()
    service_with_files = service_for

    async with AsyncSession(engine, expire_on_commit=False) as setup:
        service, owner = await service_with_files(setup, world.owner_14.id)
        issue = await service.report(owner, REPORT)
        for _ in range(2):
            await service.add_photo(owner, issue.id, _photo_request(photo), None)
            await setup.commit()

    async with AsyncSession(engine) as first, AsyncSession(engine) as second:
        owner_service, owner = await service_with_files(first, world.owner_14.id)
        board_service, board = await service_with_files(second, world.board_15.id)
        await owner_service.add_photo(owner, issue.id, _photo_request(photo), None)
        waiting = asyncio.create_task(
            board_service.add_photo(board, issue.id, _photo_request(photo), None)
        )
        await asyncio.sleep(BLOCKED)
        assert not waiting.done(), "the second upload waits for the issue's lock"

        await first.commit()
        with pytest.raises(DomainError) as refused:
            await waiting
        await second.rollback()

    assert refused.value.error_code == "PHOTO_LIMIT_REACHED"
    async with AsyncSession(engine) as check:
        assert await check.scalar(select(func.count()).select_from(StoredFile)) == 3
