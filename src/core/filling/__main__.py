"""Operator commands that fill a new building (docs/API.md section 1, epic E13 R3).

    uv run python -m src.core.filling building-template --out <file.csv>
        (--from-register [<building code>] | --apartments <N>)
        [--entrances <ranges>] [--meters <types>] [--no-building-meters]
    uv run python -m src.core.filling import-building --file <file.csv> [--dry-run]

Output and logs carry row numbers and counts only, never personal data (the template has none).
"""

import argparse
import asyncio
import sys
from collections.abc import Callable
from pathlib import Path
from typing import TextIO

from src.core.config import Settings, get_settings
from src.core.database import transaction
from src.core.domain_events import SessionFactory
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
from src.core.filling.template import TemplateError, read_template, write_template
from src.modules.property.registry import BuildingRegistryService
from src.plugins.registry import (
    RegistryBuildingNotFound,
    RegistryUnavailable,
    build_plugin_registry,
)

NO_REGISTER_BLOCK = object()  # the building has no block and no code was given


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
    if block is None:
        if code is None:
            raise _Exit(
                2,
                "--from-register needs the register's building code: the building has no "
                "passport block yet (find it with find-building)",
            )
        code = code.strip()
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
    out_path: Path,
    from_register_code: str | None | object,
    apartments: int | None,
    entrances: str | None,
    meters: str,
    building_meters: bool,
    out: TextIO,
) -> int:
    """Returns the exit code (docs/API.md section 1, `building-template`)."""
    try:
        meter_spec = parse_meters(meters)
    except DraftError as error:
        print(f"error: --meters {error}", file=out)
        return 2
    try:
        async with session_factory() as session, transaction(session):
            target = await filling_target(session)
            if await asyncio.to_thread(out_path.exists):
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
                entrance_of = (
                    parse_entrances(entrances, len(draft)) if entrances else [1] * len(draft)
                )
            except DraftError as error:
                raise _Exit(2, f"--entrances {error}") from None
            rows = template_rows(draft, entrance_of, meter_spec, building_meters)
            try:
                await asyncio.to_thread(_write_new, out_path, write_template(rows))
            except FileExistsError:
                raise _Exit(1, f"{out_path} exists already; give another --out") from None
    except FillingRefused as refused:
        print(f"error: {refused.message}", file=out)
        return 1
    except _Exit as stop:
        print(f"error: {stop.message}", file=out)
        return stop.code
    apartment_rows = sum(1 for row in rows if row.cells.get("apartment"))
    print(
        f"template {out_path} written: {len(draft)} apartments, {len(rows)} meters "
        f"({apartment_rows} apartment, {len(rows) - apartment_rows} building)",
        file=out,
    )
    for part in left_out:
        print(f"left out: part {part.number or 'without a number'} ({part.reason})", file=out)
    return 0


async def import_building(
    session_factory: SessionFactory, *, file_path: Path, dry_run: bool, out: TextIO
) -> int:
    """Returns the exit code (docs/API.md section 1, `import-building`)."""
    try:
        data = await asyncio.to_thread(file_path.read_bytes)
    except OSError:
        print("error: --file cannot be read", file=out)
        return 2
    try:
        rows = read_template(data)
    except TemplateError as error:
        print(f"error: {error}", file=out)
        return 2
    layout, problems = check_layout(rows)
    if problems:
        for problem in problems:
            print(
                f"error: {problem.message}" if problem.ref == 0 else str(problem),
                file=out,
            )
        print(f"error: {len(problems)} problems, nothing written", file=out)
        return 2
    try:
        async with session_factory() as session, transaction(session):
            target = await filling_target(session)
            if not dry_run:
                await lay_out(session, target, layout)
    except FillingRefused as refused:
        print(f"error: {refused.message}", file=out)
        return 1
    counts = (
        f"{len(layout.apartments)} apartments, {layout.apartment_meters} apartment meters, "
        f"{layout.building_meters} building meters, {layout.rounded_areas} areas rounded"
    )
    print(f"{'checked' if dry_run else 'imported'}: {counts}", file=out)
    return 0


def main(
    argv: list[str] | None = None,
    session_factory: Callable[[], SessionFactory] | None = None,
) -> int:
    parser = argparse.ArgumentParser(prog="python -m src.core.filling")
    commands = parser.add_subparsers(dest="command", required=True)
    template = commands.add_parser("building-template", help="write the building template")
    template.add_argument("--out", required=True, type=Path)
    source = template.add_mutually_exclusive_group(required=True)
    source.add_argument("--from-register", nargs="?", const=NO_REGISTER_BLOCK, default=None)
    source.add_argument("--apartments", type=int)
    template.add_argument("--entrances")
    template.add_argument("--meters", default=DEFAULT_METERS)
    template.add_argument("--no-building-meters", action="store_true")
    importer = commands.add_parser("import-building", help="lay the building out from a file")
    importer.add_argument("--file", required=True, type=Path)
    importer.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if session_factory is None:
        from src.core.database import async_session_factory

        factory: SessionFactory = async_session_factory
    else:
        factory = session_factory()
    if args.command == "building-template":
        return asyncio.run(
            building_template(
                factory,
                get_settings(),
                out_path=args.out,
                from_register_code=args.from_register,
                apartments=args.apartments,
                entrances=args.entrances,
                meters=args.meters,
                building_meters=not args.no_building_meters,
                out=sys.stdout,
            )
        )
    return asyncio.run(
        import_building(factory, file_path=args.file, dry_run=args.dry_run, out=sys.stdout)
    )


if __name__ == "__main__":
    sys.exit(main())
