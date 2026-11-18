"""Operator commands of module property (docs/API.md section 1, "The building of a new
installation").

    uv run python -m src.modules.property create-building --name "KÜ Näide 5"
        --address "Näide tn 5, Tallinn" [--registry-code 80123456] [--country EE]
        [--reading-deadline-day 4]

It creates the building of a new installation without the demo seed, so that
`python -m src.modules.auth create-chairman` can invite its first chairman. Every field is checked
before anything is written; it refuses when the installation already has a building.
"""

import argparse
import asyncio
import sys
from collections.abc import Callable
from typing import TextIO

from pydantic import ValidationError

from src.core.database import transaction
from src.core.domain_events import SessionFactory
from src.core.exceptions import DomainError
from src.modules.property.schemas import NewBuilding
from src.modules.property.service import PropertyService

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
    args = parser.parse_args(argv)

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
