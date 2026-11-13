"""The building of the issue tracker tests also serves the documents: residents, the chairman, a
board member, an accountant and a resident of another building."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.issues.conftest import IssueWorld, build_issue_world


@pytest.fixture
async def world(db_session: AsyncSession) -> IssueWorld:
    return await build_issue_world(db_session)
