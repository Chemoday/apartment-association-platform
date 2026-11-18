"""Operator commands of module property (docs/API.md section 1, "The building of a new
installation").

    uv run python -m src.modules.property create-building --name "KÜ Näide 5"
        --address "Näide tn 5, Tallinn" [--registry-code 80123456] [--country EE]
        [--reading-deadline-day 4]

It creates the building of a new installation without the demo seed, so that
`python -m src.modules.auth create-chairman` can invite its first chairman. Every field is checked
before anything is written; it refuses when the installation already has a building.

    uv run python -m src.modules.property find-building --address "Näide tn 5, Tallinn"
        [--country EE]

It asks the register provider of the country for matching buildings and prints one line of JSON
(docs/API.md section 1, "Looking a building up in the register"), for the installer. No database.
"""

import argparse
import asyncio
import json
import sys
from collections.abc import Callable
from typing import TextIO

from pydantic import ValidationError

from src.core.config import Settings, get_settings
from src.core.database import transaction
from src.core.domain_events import SessionFactory
from src.core.exceptions import DomainError
from src.modules.property.schemas import NewBuilding, RegistryLookup
from src.modules.property.service import PropertyService
from src.plugins.registry import RegistryUnavailable, build_plugin_registry

# The command's option for each field, so that an error names what the operator typed.
_OPTION = {
    "name": "--name",
    "address": "--address",
    "country_code": "--country",
    "registry_code": "--registry-code",
    "reading_deadline_day": "--reading-deadline-day",
}


_REFUSALS = {
    "NOT_A_REAL_INSTALLATION": (
        "the installation is not marked as a real one (start the backend once without demo mode "
        "and without the seed)"
    ),
    "BUILDING_EXISTS": "the installation already has a building",
}


def _first_error(error: ValidationError) -> str:
    detail = error.errors()[0]
    field = str(detail["loc"][0]) if detail["loc"] else ""
    message = str(detail["msg"]).removeprefix("Value error, ")
    if not field and message.startswith("registry_code: "):
        field, message = "registry_code", message.removeprefix("registry_code: ")
    return f"error: {_OPTION.get(field, field)} {message}"


async def create_building(
    session_factory: SessionFactory,
    *,
    name: str,
    address: str,
    country: str,
    registry_code: str | None,
    reading_deadline_day: int | str,
    out: TextIO,
) -> int:
    """Returns the exit code."""
    try:
        building = NewBuilding(
            name=name,
            address=address,
            country_code=country,
            registry_code=registry_code,
            reading_deadline_day=reading_deadline_day,
        )
    except ValidationError as error:
        print(_first_error(error), file=out)
        return 2
    try:
        async with session_factory() as session, transaction(session):
            building_id = await PropertyService(session).create_first_building(building)
    except DomainError as refused:
        print(f"error: {_REFUSALS[refused.error_code]}", file=out)
        return 1
    print(f"building {building_id} created", file=out)
    return 0


async def find_building(settings: Settings, *, address: str, country: str, out: TextIO) -> int:
    """Returns the exit code: 0 found (maybe nothing), 2 invalid, 3 unavailable, 4 no provider."""
    try:
        lookup = RegistryLookup(address=address, country_code=country)
    except ValidationError as error:
        print(_first_error(error), file=out)
        return 2
    provider = build_plugin_registry(settings).building_registry(lookup.country_code)
    if provider is None:
        print(json.dumps({"status": "no_provider"}), file=out)
        return 4
    try:
        candidates = await provider.search(lookup.address)
    except RegistryUnavailable:
        print(json.dumps({"status": "unavailable"}), file=out)
        return 3
    found = [{"code": c.code, "address": c.address} for c in candidates[:10]]
    print(json.dumps({"status": "found", "candidates": found}, ensure_ascii=False), file=out)
    return 0


def main(
    argv: list[str] | None = None,
    session_factory: Callable[[], SessionFactory] | None = None,
) -> int:
    parser = argparse.ArgumentParser(prog="python -m src.modules.property")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-building", help="the building of a new installation")
    create.add_argument("--name", required=True)
    create.add_argument("--address", required=True)
    create.add_argument("--country", default="EE")
    create.add_argument("--registry-code")
    # Read as text: NewBuilding checks it, so its error looks like those of the other fields.
    create.add_argument("--reading-deadline-day", default="4")
    find = commands.add_parser("find-building", help="look a building up in the register")
    find.add_argument("--address", required=True)
    find.add_argument("--country", default="EE")
    args = parser.parse_args(argv)

    if args.command == "find-building":
        return asyncio.run(
            find_building(
                get_settings(), address=args.address, country=args.country, out=sys.stdout
            )
        )

    if session_factory is None:
        from src.core.database import async_session_factory

        factory: SessionFactory = async_session_factory
    else:
        factory = session_factory()
    return asyncio.run(
        create_building(
            factory,
            name=args.name,
            address=args.address,
            country=args.country,
            registry_code=args.registry_code,
            reading_deadline_day=args.reading_deadline_day,
            out=sys.stdout,
        )
    )


if __name__ == "__main__":
    sys.exit(main())
