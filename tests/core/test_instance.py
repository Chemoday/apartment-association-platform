"""The installation marker (src/core/instance/; docs/DEPLOYMENT.md "Demo mode and the
installation marker"): written on the first start, compared on every later one."""

import asyncio
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
from alembic import command
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core import instance
from src.core.config import Settings
from src.core.database import build_engine
from src.core.files import FilePurpose, StoredFile
from src.core.instance import (
    INSTANCE_FILE,
    InstanceRecord,
    InstanceRefused,
    RefusalReason,
    check_instance,
    describe,
    run_check,
)
from src.core.instance import __main__ as command_line
from src.core.migrations import alembic_config
from src.core.seed import seed_demo_data
from src.modules.property.models import Building
from tests.db_utils import scratch_database
from tests.factories import create_building

ID = "assoc-1"
OTHER = "assoc-2"


def config(instance_id: str = ID, *, demo: bool = False, seed: bool = False, **extra) -> Settings:
    return Settings(INSTANCE_ID=instance_id, DEMO_MODE_ENABLED=demo, SEED_DEMO_DATA=seed, **extra)


def files_marker(root: Path) -> str:
    return (root / INSTANCE_FILE).read_text().strip()


async def refused(session: AsyncSession, settings: Settings, root: Path) -> InstanceRefused:
    with pytest.raises(InstanceRefused) as caught:
        await check_instance(session, settings, root)
    return caught.value


async def add_file(session: AsyncSession) -> None:
    building = await create_building(session)
    session.add(
        StoredFile(
            id=uuid.uuid4(),
            building_id=building.id,
            purpose=FilePurpose.DOCUMENT,
            owner_ref=uuid.uuid4(),
            content_type="application/pdf",
            size_bytes=10,
            sha256="0" * 64,
        )
    )
    await session.flush()


# --- The settings --------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("instance_id", "reason"),
    [
        ("", RefusalReason.INSTANCE_ID_MISSING),
        ("   ", RefusalReason.INSTANCE_ID_MISSING),
        ("ab", RefusalReason.INSTANCE_ID_INVALID),
        ("Assoc-1", RefusalReason.INSTANCE_ID_INVALID),
        ("-assoc", RefusalReason.INSTANCE_ID_INVALID),
        ("assoc_1", RefusalReason.INSTANCE_ID_INVALID),
        ("a" * 65, RefusalReason.INSTANCE_ID_INVALID),
    ],
)
async def test_no_start_without_a_valid_instance_id(
    db_session: AsyncSession, tmp_path: Path, instance_id: str, reason: RefusalReason
) -> None:
    error = await refused(db_session, config(instance_id), tmp_path)

    assert error.reason is reason
    assert await db_session.get(InstanceRecord, 1) is None
    assert not (tmp_path / INSTANCE_FILE).exists()


def test_a_uuid_is_a_valid_instance_id() -> None:
    assert instance.is_valid_instance_id(str(uuid.uuid4()))
    assert instance.is_valid_instance_id("a" * 64)


# --- The first start -----------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("demo", "seed", "expected"),
    [(False, False, False), (True, True, True), (True, False, True), (False, True, True)],
)
async def test_the_first_start_writes_the_marker_in_the_database_and_the_files(
    db_session: AsyncSession, tmp_path: Path, demo: bool, seed: bool, expected: bool
) -> None:
    marker = await check_instance(db_session, config(demo=demo, seed=seed), tmp_path)

    assert marker.claimed_now is True
    assert (marker.instance_id, marker.demo) == (ID, expected)
    record = await db_session.get(InstanceRecord, 1)
    assert record is not None
    assert (record.instance_id, record.demo) == (ID, expected)
    assert record.created_at is not None
    assert files_marker(tmp_path) == ID


async def test_a_database_from_before_the_marker_is_claimed_with_its_files(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    """Dev and prod on their first start after migration 030: data and files, no markers yet."""
    await add_file(db_session)

    marker = await check_instance(db_session, config(demo=True, seed=True), tmp_path)

    assert marker.claimed_now is True
    assert marker.demo is True
    assert files_marker(tmp_path) == ID


async def test_the_first_start_refuses_the_files_of_another_installation(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    instance.write_files_marker(tmp_path, OTHER)

    error = await refused(db_session, config(), tmp_path)

    assert error.reason is RefusalReason.FILES_OF_ANOTHER_INSTANCE
    assert error.found == OTHER
    assert await db_session.get(InstanceRecord, 1) is None


# --- Every later start ---------------------------------------------------------------------------


async def test_a_later_start_of_the_same_installation_passes(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    first = await check_instance(db_session, config(), tmp_path)

    again = await check_instance(db_session, config(), tmp_path)

    assert again.claimed_now is False
    assert (again.instance_id, again.demo, again.created_at) == (ID, False, first.created_at)


async def test_the_database_of_another_installation_is_refused(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await check_instance(db_session, config(OTHER), tmp_path / "other")

    error = await refused(db_session, config(), tmp_path)

    assert error.reason is RefusalReason.DATABASE_OF_ANOTHER_INSTANCE
    assert error.found == OTHER
    assert not (tmp_path / INSTANCE_FILE).exists()


async def test_demo_mode_is_refused_on_the_data_of_a_real_installation(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await check_instance(db_session, config(), tmp_path)

    error = await refused(db_session, config(demo=True), tmp_path)

    assert error.reason is RefusalReason.DEMO_ON_REAL_DATA
    record = await db_session.get(InstanceRecord, 1)
    assert record is not None and record.demo is False


async def test_demo_mode_off_on_demo_data_starts_with_a_warning(
    db_session: AsyncSession, tmp_path: Path, log_capture
) -> None:
    """A local test of the e-mails runs the seeded building without demo mode."""
    await check_instance(db_session, config(demo=True, seed=True), tmp_path)

    marker = await check_instance(db_session, config(), tmp_path)

    assert marker.demo is True
    assert "instance_demo_data_without_demo_mode" in log_capture.raw


@pytest.mark.parametrize("environment", ["prod", "staging"])
async def test_a_real_installation_never_starts_on_demo_data(
    db_session: AsyncSession, tmp_path: Path, environment: str
) -> None:
    """The seeded people are fictitious: outside local, dev and test demo data stay a demo."""
    await check_instance(db_session, config(demo=True, seed=True), tmp_path)

    error = await refused(db_session, config(ENVIRONMENT=environment), tmp_path)

    assert error.reason is RefusalReason.REAL_ON_DEMO_DATA


async def test_a_real_environment_with_the_seed_on_is_refused_on_its_first_start(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    error = await refused(db_session, config(seed=True, ENVIRONMENT="prod"), tmp_path)

    assert error.reason is RefusalReason.REAL_ON_DEMO_DATA
    assert await db_session.get(InstanceRecord, 1) is None
    assert not (tmp_path / INSTANCE_FILE).exists()


async def test_the_files_of_another_installation_are_refused(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await check_instance(db_session, config(), tmp_path)
    instance.write_files_marker(tmp_path, OTHER)

    error = await refused(db_session, config(), tmp_path)

    assert error.reason is RefusalReason.FILES_OF_ANOTHER_INSTANCE
    assert error.found == OTHER


async def test_a_files_directory_without_its_marker_is_refused_when_the_database_has_files(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await check_instance(db_session, config(), tmp_path)
    await add_file(db_session)
    empty = tmp_path / "empty"

    error = await refused(db_session, config(), empty)

    assert error.reason is RefusalReason.FILES_MARKER_MISSING
    assert not (empty / INSTANCE_FILE).exists()


async def test_a_lost_files_marker_is_written_again_when_the_database_has_no_files(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await check_instance(db_session, config(), tmp_path)
    (tmp_path / INSTANCE_FILE).unlink()

    await check_instance(db_session, config(), tmp_path)

    assert files_marker(tmp_path) == ID


async def test_a_refusal_never_carries_what_is_not_an_installation_id(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    (tmp_path / INSTANCE_FILE).write_text("Jaan Tamm, jaan@example.com\n")

    error = await refused(db_session, config(), tmp_path)

    assert error.reason is RefusalReason.FILES_OF_ANOTHER_INSTANCE
    assert error.found is None


@pytest.mark.parametrize("content", [b"\xff\xfe not text", None])
async def test_a_files_marker_that_cannot_be_read_is_refused_with_its_reason(
    db_session: AsyncSession, tmp_path: Path, content: bytes | None
) -> None:
    if content is None:
        (tmp_path / INSTANCE_FILE).mkdir()  # a directory where the file should be
    else:
        (tmp_path / INSTANCE_FILE).write_bytes(content)

    error = await refused(db_session, config(), tmp_path)

    assert error.reason is RefusalReason.FILES_OF_ANOTHER_INSTANCE
    assert error.found is None


def test_the_files_marker_is_written_whole(tmp_path: Path) -> None:
    root = tmp_path / "files"

    instance.write_files_marker(root, ID)

    assert sorted(path.name for path in root.iterdir()) == [INSTANCE_FILE]
    assert files_marker(root) == ID


# --- The seed ------------------------------------------------------------------------------------


async def test_the_seed_never_fills_the_database_of_a_real_installation(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await check_instance(db_session, config(seed=False), tmp_path)

    assert await seed_demo_data(db_session) is False
    assert await db_session.scalar(select(Building.id).limit(1)) is None


async def test_the_seed_fills_the_empty_database_of_a_demo(
    db_session: AsyncSession, tmp_path: Path
) -> None:
    await check_instance(db_session, config(demo=True, seed=True), tmp_path)

    assert await seed_demo_data(db_session) is True


# --- The command of entrypoint.sh ----------------------------------------------------------------


async def test_the_startup_step_commits_the_marker_and_show_prints_it(
    database_url: str, tmp_path: Path
) -> None:
    async with scratch_database(database_url) as url:
        await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
        settings = config(demo=True, DATABASE_URL=url, FILES_DIR=str(tmp_path))

        first, second = await asyncio.gather(run_check(settings), run_check(settings))
        shown = await describe(settings)
        with pytest.raises(InstanceRefused) as other:
            await run_check(config(OTHER, DATABASE_URL=url, FILES_DIR=str(tmp_path / "other")))

        engine = build_engine(url)
        async with AsyncSession(engine) as session:
            record = await session.get(InstanceRecord, 1)
        await engine.dispose()

    assert sorted([first.claimed_now, second.claimed_now]) == [False, True]
    assert other.value.reason is RefusalReason.DATABASE_OF_ANOTHER_INSTANCE
    assert record is not None and record.instance_id == ID
    assert json.loads(json.dumps(shown)) == {
        "instance_id": ID,
        "demo": True,
        "created_at": record.created_at.isoformat(),
        "files_instance_id": ID,
    }


def test_the_startup_step_exits_non_zero_on_a_refusal(
    monkeypatch: pytest.MonkeyPatch, log_capture
) -> None:
    async def refuse(_settings: Settings) -> None:
        raise InstanceRefused(RefusalReason.DEMO_ON_REAL_DATA)

    monkeypatch.setattr(command_line, "run_check", refuse)
    monkeypatch.setattr(command_line, "configure_logging", lambda **_kwargs: None)

    assert command_line.main([]) == 1
    logged = log_capture.raw
    assert "instance_check_refused" in logged
    assert "DEMO_ON_REAL_DATA" in logged
    assert command_line.main(["unknown"]) == 2


@pytest.mark.parametrize(
    "module", ["src.core.instance", "src.modules.property.service", "src.modules.property.__main__"]
)
def test_the_startup_step_and_its_readers_import_alone(module: str) -> None:
    """entrypoint.sh imports src.core.instance first, without the order pytest happens to use."""
    subprocess.run([sys.executable, "-c", f"import {module}"], check=True)


async def test_the_command_of_entrypoint_sh_runs_on_every_start(
    database_url: str, tmp_path: Path
) -> None:
    """As entrypoint.sh runs it: `python -m src.core.instance` in a fresh interpreter, on the first
    start (it writes the marker) and on every later one (it compares and imports src.core.files;
    run as __main__ the model module once defined core_instance twice there)."""
    async with scratch_database(database_url) as url:
        await asyncio.to_thread(command.upgrade, alembic_config(url), "head")
        env = {
            **os.environ,
            "DATABASE_URL": url,
            "INSTANCE_ID": ID,
            "FILES_DIR": str(tmp_path),
            "DEMO_MODE_ENABLED": "true",
            "SEED_DEMO_DATA": "true",
            "LOG_JSON": "true",
        }

        def start(*argv: str) -> subprocess.CompletedProcess[str]:
            return subprocess.run(
                [sys.executable, "-m", "src.core.instance", *argv],
                env=env,
                capture_output=True,
                text=True,
            )

        first = await asyncio.to_thread(start)
        second = await asyncio.to_thread(start)
        (tmp_path / INSTANCE_FILE).unlink()  # a later start that also counts the stored files
        third = await asyncio.to_thread(start)
        shown = await asyncio.to_thread(start, "show")
        env["INSTANCE_ID"] = OTHER
        refused_start = await asyncio.to_thread(start)

    assert first.returncode == 0, first.stdout + first.stderr
    assert '"instance_claimed"' in first.stdout
    assert second.returncode == 0, second.stdout + second.stderr
    assert '"instance_checked"' in second.stdout
    assert third.returncode == 0, third.stdout + third.stderr
    assert files_marker(tmp_path) == ID
    assert json.loads(shown.stdout.splitlines()[-1])["instance_id"] == ID
    assert refused_start.returncode == 1
    assert '"instance_check_refused"' in refused_start.stdout
