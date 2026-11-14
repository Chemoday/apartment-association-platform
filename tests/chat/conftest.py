"""The building of the issue tracker tests also serves the chat: residents (one with two
apartments), the chairman, a board member who lives in the building, an accountant without an
apartment and a resident of another building."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests.issues.conftest import IssueWorld, build_issue_world


@pytest.fixture
async def world(db_session: AsyncSession) -> IssueWorld:
    return await build_issue_world(db_session)
