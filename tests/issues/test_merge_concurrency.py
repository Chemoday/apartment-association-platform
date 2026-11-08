"""Real concurrency: two board members merge two issues into each other at the same moment."""

import asyncio

from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import DomainError
from src.modules.issues.schemas import BoardStatus, StatusChange
from tests.issues.test_concurrency import REPORT, committed, service_for  # noqa: F401

BLOCKED = 0.5


async def test_opposite_merges_cannot_make_a_cycle(committed) -> None:  # noqa: F811
    engine, world = committed
    async with AsyncSession(engine) as setup:
        service, owner = await service_for(setup, world.owner_14.id)
        board_service, board = await service_for(setup, world.board_15.id)
        first = await service.report(owner, REPORT)
        second = await board_service.report(board, REPORT)
        await setup.commit()

    async with AsyncSession(engine) as one, AsyncSession(engine) as two:
        chair_service, chairman = await service_for(one, world.chairman.id)
        member_service, member = await service_for(two, world.board_15.id)
        await chair_service.change_status(
            chairman, first.id, StatusChange(status=BoardStatus.DUPLICATE, duplicate_of=second.id)
        )
        waiting = asyncio.create_task(
            member_service.change_status(
                member,
                second.id,
                StatusChange(status=BoardStatus.DUPLICATE, duplicate_of=first.id),
            )
        )
        await asyncio.sleep(BLOCKED)
        assert not waiting.done(), "the second merge waits for the locks of both issues"
        await one.commit()
        try:
            await waiting
        except DomainError as refused:
            assert refused.error_code == "INVALID_DUPLICATE"
        else:  # pragma: no cover - the cycle this test guards against
            raise AssertionError("both issues became duplicates of each other")
        await two.rollback()
