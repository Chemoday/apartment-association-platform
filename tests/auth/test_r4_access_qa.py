# The fixtures of tests/auth/test_invitations.py are imported by name; using them as parameters
# is what pytest expects, so F811 does not apply to this file.
# ruff: noqa: F811
"""QA pass over epic E13 R4a-R4c: who may call each new endpoint (docs/API.md section 7). Bulk
invitations, "resend expired", the connection overview, the paper mark, join codes and join
requests are the chairman's (signed in with a Bearer token); the decision list is also the
board's. Everyone else gets 403 FORBIDDEN, the demo header and no sign-in 401, and nothing changes.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import Settings
from src.modules.auth.models import AuthInvitation, AuthJoinCode
from src.modules.property.models import Apartment
from src.modules.property.schemas import BuildingRole, RelationType
from tests.auth.test_invitations import (  # noqa: F401 (fixtures used by name)
    API,
    World,
    app,
    as_,
    client,
    mail_settings,
    sign_in,
    unique,
    world,
)
from tests.factories import create_membership, create_user

# (method, path, body); {apt} is apartment 2 of `world`, {id} an unknown id.
ENDPOINTS = [
    ("post", "/invitations/bulk/preview", {"text": "2;someone@example.com\n"}),
    ("post", "/invitations/bulk", {"text": "2;someone@example.com\n"}),
    ("post", "/invitations/resend-expired", None),
    ("get", "/connections", None),
    ("put", "/connections/{apt}/paper", {"on_paper": True}),
    ("post", "/join-codes", {"apartment_ids": None}),
    ("get", "/join-codes", None),
    ("delete", "/join-codes/{id}", None),
    ("get", "/join-requests", None),
    ("post", "/join-requests/{id}/confirm", None),
    ("post", "/join-requests/{id}/reject", None),
    ("get", "/join-decisions", None),
]
BOARD_MAY = {("get", "/join-decisions")}


@pytest.fixture
async def callers(world: World, db_session: AsyncSession, mail_settings: Settings) -> dict:
    """Headers of everyone who is not the chairman: an owner, a tenant, the accountant, a board
    member, the chairman's demo header, and nobody."""
    tenant = await create_user(db_session, world.building, "Tom Tenant", email=unique("tenant"))
    await create_membership(db_session, tenant, world.apt_2, relation=RelationType.TENANT)
    board = await create_user(
        db_session, world.building, "Bea Board", role=BuildingRole.BOARD, email=unique("board")
    )
    return {
        "owner": as_(world, world.owner_14),
        "tenant": await sign_in(db_session, mail_settings, tenant),
        "accountant": as_(world, world.accountant),
        "board": await sign_in(db_session, mail_settings, board),
        "demo header": {"X-Demo-User-Id": str(world.chairman.id)},
        "nobody": {},
    }


async def call(client: AsyncClient, world: World, endpoint: tuple, headers: dict[str, str]):
    method, path, body = endpoint
    url = API + path.format(apt=world.apt_2.id, id=uuid.uuid4())
    kwargs: dict = {"headers": headers}
    if body is not None:
        kwargs["json"] = body
    return await client.request(method.upper(), url, **kwargs)


@pytest.mark.parametrize("endpoint", ENDPOINTS, ids=lambda e: f"{e[0]} {e[1]}")
async def test_only_the_chairman_reaches_the_new_endpoints(
    client: AsyncClient, world: World, callers: dict, db_session: AsyncSession, endpoint: tuple
) -> None:
    for who, headers in callers.items():
        response = await call(client, world, endpoint, headers)
        if who in ("demo header", "nobody"):
            expected = (401, "NOT_AUTHENTICATED")
        elif who == "board" and endpoint[:2] in BOARD_MAY:
            assert response.status_code == 200, response.text
            continue
        else:
            expected = (403, "FORBIDDEN")
        assert (response.status_code, response.json()["error_code"]) == expected, who
    db_session.expunge_all()
    assert await db_session.scalar(select(func.count(AuthInvitation.id))) == 0
    assert await db_session.scalar(select(func.count(AuthJoinCode.id))) == 0
    assert (await db_session.get(Apartment, world.apt_2.id)).on_paper is False


async def test_the_chairman_reaches_every_new_endpoint(client: AsyncClient, world: World) -> None:
    expected = {
        "/invitations/bulk/preview": 200,
        "/invitations/bulk": 200,
        "/invitations/resend-expired": 200,
        "/connections": 200,
        "/connections/{apt}/paper": 200,
        "/join-codes": None,  # 201 for POST, 200 for GET
        "/join-codes/{id}": 404,
        "/join-requests": 200,
        "/join-requests/{id}/confirm": 404,
        "/join-requests/{id}/reject": 404,
        "/join-decisions": 200,
    }
    for endpoint in ENDPOINTS:
        method, path, _ = endpoint
        response = await call(client, world, endpoint, as_(world, world.chairman))
        want = expected[path] or (201 if method == "post" else 200)
        assert response.status_code == want, (method, path, response.text)
