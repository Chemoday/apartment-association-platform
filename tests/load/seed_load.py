"""Fill an EMPTY demo installation with one larger building for load tests (tests/load/README.md).

    python -m tests.load.seed_load --apartments 60 --out users.json

Runs next to the target's database (DATABASE_URL), usually as a one-off container of the target's
image with `tests/` mounted. It refuses a database that is not marked as a demo installation or
that already holds a building, so it can never touch the data of a real association.

Writes the ids the load generator needs (users per role, apartments) to --out. The users have no
e-mail and act through the demo header X-Demo-User-Id, so no login is involved.
"""

import argparse
import asyncio
import json
import os
import random
import sys
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from src.core.instance import read_marker
from src.modules.meters.policies import period_code_of, previous_period_code
from src.modules.meters.schemas import PeriodStatus, ResourceType
from src.modules.property.models import Building
from src.modules.property.schemas import BuildingRole, RelationType
from tests import factories

HISTORY_MONTHS = 12


class Refused(RuntimeError):
    """The target is not an empty demo installation."""


async def check_target(session: AsyncSession) -> None:
    marker = await read_marker(session)
    if marker is None or not marker.demo:
        raise Refused("the database is not marked as a demo installation; refusing to write")
    if await session.scalar(select(func.count()).select_from(Building)):
        raise Refused("the database already holds a building; load tests need an empty demo")


def month_codes(now: datetime, timezone: str) -> tuple[list[str], str]:
    """The past HISTORY_MONTHS period codes (oldest first) and the current one."""
    current = period_code_of(now.astimezone(ZoneInfo(timezone)).date())
    past, code = [], current
    for _ in range(HISTORY_MONTHS):
        code = previous_period_code(code)
        past.append(code)
    return list(reversed(past)), current


async def seed(session: AsyncSession, apartments: int, rng: random.Random, timezone: str) -> dict:
    await check_target(session)
    building = await factories.create_building(session, name="KÜ Koormustest 1")
    staff = {
        role: await factories.create_user(
            session, building, f"Load {role.value.title()}", role=role
        )
        for role in (BuildingRole.CHAIRMAN, BuildingRole.ACCOUNTANT)
    }
    board = [
        await factories.create_user(session, building, f"Load Board {i}", role=BuildingRole.BOARD)
        for i in range(1, 3)
    ]

    past_codes, current_code = month_codes(datetime.now(UTC), timezone)
    periods = [
        await factories.create_period(session, building, code, PeriodStatus.LOCKED)
        for code in past_codes
    ]
    current = await factories.create_period(
        session, building, current_code, PeriodStatus.OPEN_FOR_RESIDENTS
    )

    residents = []
    for number in range(1, apartments + 1):
        entrance = (number - 1) // 30 + 1
        apartment = await factories.create_apartment(
            session, building, str(number), entrance=entrance, floor=(number - 1) % 10 + 1
        )
        owner = await factories.create_user(session, building, f"Load Owner {number}")
        await factories.create_membership(session, owner, apartment)
        users = [owner]
        if number % 2 == 0:  # about 1.5 users per apartment
            tenant = await factories.create_user(session, building, f"Load Tenant {number}")
            await factories.create_membership(session, tenant, apartment, RelationType.TENANT)
            users.append(tenant)
        for resource in (ResourceType.COLD_WATER, ResourceType.HOT_WATER):
            start = Decimal(rng.randint(50, 900))
            meter = await factories.create_meter(
                session, building, apartment, resource, initial_value=start
            )
            value = start
            for period in periods:
                delta = Decimal(rng.randint(1500, 9000)) / 1000
                await factories.create_reading(session, meter, period, value + delta, value)
                value += delta
        residents.extend(
            {"user_id": str(user.id), "apartment_id": str(apartment.id)} for user in users
        )
    for resource in (ResourceType.COLD_WATER, ResourceType.HOT_WATER):
        await factories.create_meter(session, building, None, resource)
    await session.commit()
    return {
        "building_id": str(building.id),
        "apartments": apartments,
        "current_period": current.period_code,
        "chairman": str(staff[BuildingRole.CHAIRMAN].id),
        "accountant": str(staff[BuildingRole.ACCOUNTANT].id),
        "board": [str(user.id) for user in board],
        "residents": residents,
    }


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apartments", type=int, default=60, choices=range(1, 501), metavar="N")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=1, help="random seed, for repeatable data")
    args = parser.parse_args(argv)

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("seed_load: DATABASE_URL is not set", file=sys.stderr)
        return 2
    timezone = os.environ.get("INSTANCE_TIMEZONE", "Europe/Tallinn")
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            data = await seed(session, args.apartments, random.Random(args.seed), timezone)
    except Refused as exc:
        print(f"seed_load: {exc}", file=sys.stderr)
        return 1
    finally:
        await engine.dispose()
    args.out.write_text(json.dumps(data, indent=1))
    print(
        f"seed_load: {args.apartments} apartments, {len(data['residents'])} residents, "
        f"period {data['current_period']} open -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
