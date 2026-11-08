"""Real concurrency on committed data: "+1" racing the board's work on the same issue."""

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import DomainError
from src.modules.issues.models import IssueFollower
from src.modules.issues.schemas import BoardStatus, StatusChange
from tests.issues.test_concurrency import REPORT, committed, service_for  # noqa: F401

BLOCKED = 0.5


async def test_a_plus_one_waiting_for_a_resolve_gets_issue_ended(committed) -> None:  # noqa: F811
    engine, world = committed
    async with AsyncSession(engine) as setup:
        service, owner = await service_for(setup, world.owner_14.id)
        issue = await service.report(owner, REPORT)
        await setup.commit()

    async with AsyncSession(engine) as one, AsyncSession(engine) as two:
        board_service, chairman = await service_for(one, world.chairman.id)
        tenant_service, tenant = await service_for(two, world.tenant_2.id)
        await board_service.change_status(
            chairman, issue.id, StatusChange(status=BoardStatus.RESOLVED)
        )
        waiting = asyncio.create_task(tenant_service.follow(tenant, issue.id))
        await asyncio.sleep(BLOCKED)
        assert not waiting.done(), "the +1 waits for the status change"
        await one.commit()
        with pytest.raises(DomainError) as refused:
            await waiting
        await two.rollback()

    assert refused.value.error_code == "ISSUE_ENDED"
    async with AsyncSession(engine) as check:
        followers = set(
            await check.scalars(
                select(IssueFollower.user_id).where(IssueFollower.issue_id == issue.id)
            )
        )
    assert followers == {world.owner_14.id}


async def test_a_merge_waiting_for_a_plus_one_moves_that_follower_too(committed) -> None:  # noqa: F811
    engine, world = committed
    async with AsyncSession(engine) as setup:
        service, owner = await service_for(setup, world.owner_14.id)
        board_service, board = await service_for(setup, world.board_15.id)
        duplicate = await service.report(owner, REPORT)
        original = await board_service.report(board, REPORT)
        await setup.commit()

    async with AsyncSession(engine) as one, AsyncSession(engine) as two:
        tenant_service, tenant = await service_for(one, world.tenant_2.id)
        chair_service, chairman = await service_for(two, world.chairman.id)
        await tenant_service.follow(tenant, duplicate.id)
        waiting = asyncio.create_task(
            chair_service.change_status(
                chairman,
                duplicate.id,
                StatusChange(status=BoardStatus.DUPLICATE, duplicate_of=original.id),
            )
        )
        await asyncio.sleep(BLOCKED)
        assert not waiting.done(), "the merge waits for the +1 that holds the issue"
        await one.commit()
        await waiting
        await two.commit()

    async with AsyncSession(engine) as check:
        followers = set(
            await check.scalars(
                select(IssueFollower.user_id).where(IssueFollower.issue_id == original.id)
            )
        )
    assert followers == {world.board_15.id, world.owner_14.id, world.tenant_2.id}
