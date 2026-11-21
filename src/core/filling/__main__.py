"""Operator commands that fill a new building (docs/API.md section 1, epic E13 R3).

    uv run python -m src.core.filling building-template --out <file.csv>
        (--from-register [<building code>] | --apartments <N>)
        [--entrances <ranges>] [--meters <types>] [--no-building-meters]
    uv run python -m src.core.filling import-building --file <file.csv> [--dry-run]

Output and logs carry row numbers, counts, apartment numbers, areas and header names (printable
only, shortened), never cell values of persons: the template holds no personal data.
"""

import argparse
import asyncio
import sys
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO, TextIO

from src.core.config import Settings, get_settings
from src.core.database import transaction
from src.core.domain_events import SessionFactory
from src.core.filling.compare import register_warnings
from src.core.filling.draft import (
    DEFAULT_METERS,
    DraftApartmentRow,
    DraftError,
    LeftOut,
    from_count,
    from_register,
    parse_entrances,
    parse_meters,
    template_rows,
)
from src.core.filling.layout import check_layout
from src.core.filling.service import FillingRefused, filling_target, lay_out
from src.core.filling.template import (
    MAX_FILE_BYTES,
    MAX_SHOWN,
    TemplateError,
    read_template_report,
    shown,
    write_template,
)
from src.core.telemetry import configure_logging
from src.modules.property.registry import BuildingRegistryService
from src.plugins.registry import (
    RegistryBuildingNotFound,
    RegistryUnavailable,
    build_plugin_registry,
)

NO_REGISTER_BLOCK = object()  # the building has no block and no code was given


def _read_capped(path: Path) -> bytes:
    """At most one byte more than a template may have, so a huge file is never loaded."""
    with path.open("rb") as file:
        return file.read(MAX_FILE_BYTES + 1)


def configure_cli_logging(settings: Settings) -> None:
    """Logs of the commands go to standard error, never standard output: with `--out -` the
    standard output is the template itself, and a log line in it would break the file."""
    configure_logging(level=settings.LOG_LEVEL, json_logs=settings.LOG_JSON, stream=sys.stderr)


def _write_new(path: Path, text: str) -> None:
    """Write a file that must not exist yet (an existing one raises FileExistsError)."""
    with path.open("x", encoding="utf-8", newline="") as file:
        file.write(text)


class _Exit(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


async def _register_draft(
    session, settings: Settings, building_id, country_code: str, code: str | None
) -> tuple[list[DraftApartmentRow], list[LeftOut]]:
    registry = BuildingRegistryService(session, build_plugin_registry(settings))
    provider = registry.provider_for(country_code)
    if provider is None:
        raise _Exit(4, f"no register provider of {country_code} is enabled")
    block = await registry.stored_block(building_id)
    if code is not None:
        code = code.strip()
        stored_code = getattr(getattr(block, "source", None), "building_code", None)
        if block is not None and stored_code != code:
            # The operator names another building than the one stored (a wrong pick of the
            # lookup): fetch that one and keep it as the proposal instead of drafting the old.
            block = None
    if block is None:
        if code is None:
            raise _Exit(
                2,
                "--from-register needs the register's building code: the building has no "
                "passport block yet (find it with find-building)",
            )
        if not provider.valid_code(code):
            raise _Exit(2, "--from-register the building code has the wrong form")
        try:
            block = await registry.fetch_for_operator(building_id, provider, code)
        except RegistryBuildingNotFound:
            raise _Exit(2, "--from-register the register does not know this building") from None
        except RegistryUnavailable:
            raise _Exit(3, "the register does not answer usably; try again later") from None
    return from_register(provider.apartment_draft(block))


async def building_template(
    session_factory: SessionFactory,
    settings: Settings,
    *,
    out_path: Path | None,
    from_register_code: str | None | object,
    apartments: int | None,
    entrances: str | None,
    meters: str,
    building_meters: bool,
    out: TextIO,
    template_out: TextIO | None = None,
) -> int:
    """Returns the exit code (docs/API.md section 1, `building-template`). `out_path` None
    writes the template to `template_out` (`--out -`); the messages always go to `out`."""
    try:
        meter_spec = parse_meters(meters)
    except DraftError as error:
        print(f"error: --meters {error}", file=out)
        return 2
    try:
        async with session_factory() as session, transaction(session):
            target = await filling_target(session)
            if out_path is not None and await asyncio.to_thread(out_path.exists):
                raise _Exit(1, f"{out_path} exists already; give another --out")
            if apartments is not None:
                try:
                    draft, left_out = from_count(apartments), []
                except DraftError as error:
                    raise _Exit(2, f"--apartments {error}") from None
            else:
                code = None if from_register_code is NO_REGISTER_BLOCK else from_register_code
                draft, left_out = await _register_draft(
                    session, settings, target.building_id, target.country_code, code
                )
                if not draft:
                    raise _Exit(
                        1,
                        "the register lists no apartments for this building: use --apartments <N>",
                    )
            try:
                entrance_of = parse_entrances(entrances, len(draft)) if entrances else None
            except DraftError as error:
                raise _Exit(2, f"--entrances {error}") from None
            rows = template_rows(draft, entrance_of, meter_spec, building_meters)
            try:
                if out_path is None:
                    (template_out or sys.stdout).write(write_template(rows))
                else:
                    await asyncio.to_thread(_write_new, out_path, write_template(rows))
            except FileExistsError:
                raise _Exit(1, f"{out_path} exists already; give another --out") from None
            except OSError as error:
                raise _Exit(
                    2,
                    f"--out cannot be written ({error.strerror or 'error'}); inside the backend "
                    "container use --out - and redirect it on the host",
                ) from None
    except FillingRefused as refused:
        print(f"error: {refused.message}", file=out)
        return 1
    except _Exit as stop:
        print(f"error: {stop.message}", file=out)
        return stop.code
    apartment_rows = sum(1 for row in rows if row.cells.get("apartment"))
    print(
        f"template {out_path or '-'} written: {len(draft)} apartments, {len(rows)} meters "
        f"({apartment_rows} apartment, {len(rows) - apartment_rows} building)",
        file=out,
    )
    for part in left_out:
        # Register text, never personal data, but shown on a terminal: printable only.
        number = "".join(c if c.isprintable() else "?" for c in part.number or "")
        print(f"left out: part {number or 'without a number'} ({part.reason})", file=out)
    return 0


async def import_building(
    session_factory: SessionFactory,
    *,
    file_path: Path | None,
    dry_run: bool,
    out: TextIO,
    stdin: BinaryIO | None = None,
    settings: Settings | None = None,
) -> int:
    """Returns the exit code (docs/API.md section 1, `import-building`). `file_path` None
    reads the template from `stdin` (`--file -`)."""
    try:
        if file_path is None:
            data = await asyncio.to_thread((stdin or sys.stdin.buffer).read, MAX_FILE_BYTES + 1)
        else:
            data = await asyncio.to_thread(_read_capped, file_path)
    except OSError:
        print("error: --file cannot be read", file=out)
        return 2
    try:
        read = read_template_report(data)
    except TemplateError as error:
        print(f"error: {error}", file=out)
        return 2
    layout, problems = check_layout(read.rows)
    if problems:
        for problem in problems:
            print(
                f"error: {problem.message}" if problem.ref == 0 else str(problem),
                file=out,
            )
        print(f"error: {len(problems)} problems, nothing written", file=out)
        return 2
    warnings = (
        [
            "warning: column(s) ignored: "
            + ", ".join(shown(name) for name in read.ignored_columns[:MAX_SHOWN])
            + (
                f" and {len(read.ignored_columns) - MAX_SHOWN} more"
                if len(read.ignored_columns) > MAX_SHOWN
                else ""
            )
        ]
        if read.ignored_columns
        else []
    )
    try:
        async with session_factory() as session, transaction(session):
            target = await filling_target(session)
            warnings += await _register_check(session, settings or get_settings(), target, layout)
            if not dry_run:
                await lay_out(session, target, layout)
    except FillingRefused as refused:
        print(f"error: {refused.message}", file=out)
        return 1
    for warning in warnings:
        print(warning, file=out)
    counts = (
        f"{len(layout.apartments)} apartments, {layout.apartment_meters} apartment meters, "
        f"{layout.building_meters} building meters, {layout.rounded_areas} areas rounded"
    )
    print(f"{'checked' if dry_run else 'imported'}: {counts}", file=out)
    return 0


async def _register_check(session, settings: Settings, target, layout) -> list[str]:
    """Warnings where the file differs from the building's register block, if there is one and
    its provider is enabled; never a call to the register."""
    registry = BuildingRegistryService(session, build_plugin_registry(settings))
    provider = registry.provider_for(target.country_code)
    if provider is None:
        return []
    block = await registry.stored_block(target.building_id)
    if block is None:
        return []
    apartments, _ = from_register(provider.apartment_draft(block))
    return register_warnings(layout, apartments)


def main(
    argv: list[str] | None = None,
    session_factory: Callable[[], SessionFactory] | None = None,
) -> int:
    parser = argparse.ArgumentParser(prog="python -m src.core.filling")
    commands = parser.add_subparsers(dest="command", required=True)
    template = commands.add_parser("building-template", help="write the building template")
    template.add_argument("--out", required=True, help="a new file, or - for standard output")
    source = template.add_mutually_exclusive_group(required=True)
    source.add_argument("--from-register", nargs="?", const=NO_REGISTER_BLOCK, default=None)
    source.add_argument("--apartments", type=int)
    template.add_argument("--entrances")
    template.add_argument("--meters", default=DEFAULT_METERS)
    template.add_argument("--no-building-meters", action="store_true")
    importer = commands.add_parser("import-building", help="lay the building out from a file")
    importer.add_argument("--file", required=True, help="the filled template, or - for stdin")
    importer.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    settings = get_settings()
    configure_cli_logging(settings)

    if session_factory is None:
        from src.core.database import async_session_factory

        factory: SessionFactory = async_session_factory
    else:
        factory = session_factory()
    if args.command == "building-template":
        return asyncio.run(
            building_template(
                factory,
                settings,
                out_path=None if args.out == "-" else Path(args.out),
                from_register_code=args.from_register,
                apartments=args.apartments,
                entrances=args.entrances,
                meters=args.meters,
                building_meters=not args.no_building_meters,
                # With --out - the template is the standard output, so the messages move aside.
                out=sys.stderr if args.out == "-" else sys.stdout,
                template_out=sys.stdout,
            )
        )
    return asyncio.run(
        import_building(
            factory,
            file_path=None if args.file == "-" else Path(args.file),
            dry_run=args.dry_run,
            out=sys.stdout,
            settings=settings,
        )
    )


if __name__ == "__main__":
    sys.exit(main())
