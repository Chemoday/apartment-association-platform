"""QA pass over epic E13 R4a and R4c in demo mode (docs/API.md section 7): the invitation queue
sends only what AUTH_MAIL_IN_DEMO and AUTH_DEMO_MAIL_DOMAINS allow and tries the rest again like a
failed send; every endpoint of "Join codes on paper" answers 404 NOT_FOUND like an unknown route,
before the sign-in or the body is checked.
"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import Settings, get_settings
from src.main import create_app
from src.modules.auth.models import AuthInvitation
from src.modules.auth.queue import drain_queue
from src.modules.auth.schemas import AuthMethod
from src.modules.auth.service import AuthService
from src.modules.property.schemas import BuildingRole
from tests.factories import create_apartment, create_building, create_user
from tests.smtp_server import SmtpServer

API = "/api/v1/auth"
ALLOWED = "allowed.example"


@pytest.fixture
def demo_settings(smtp_server: SmtpServer) -> Settings:
    return Settings(
        **{
            **get_settings().model_dump(),
            "DEMO_MODE_ENABLED": True,
            "AUTH_MAIL_IN_DEMO": True,
            "AUTH_DEMO_MAIL_DOMAINS": ALLOWED,
            "ENABLED_PLUGINS": "common.csv_export,common.email_smtp",
            "SMTP_HOST": smtp_server.host,
            "SMTP_PORT": smtp_server.port,
            "SMTP_TLS": "none",
            "SMTP_FROM": "KU <noreply@kyu.example.test>",
            "PUBLIC_BASE_URL": "https://kyu.example.test",
            "NOTIFICATIONS_DISPATCHER_ENABLED": False,
        }
    )


@pytest.fixture
def app(demo_settings: Settings) -> FastAPI:
    app = create_app(demo_settings)
    app.dependency_overrides[get_settings] = lambda: demo_settings
    return app


@pytest.fixture
async def chairman(db_session: AsyncSession, demo_settings: Settings):
    building = await create_building(db_session)
    await create_apartment(db_session, building, "2")
    user = await create_user(db_session, building, "Chair", role=BuildingRole.CHAIRMAN)
    issued = await AuthService(db_session, demo_settings).start_session(
        user.id, AuthMethod.MAGIC_LINK, None
    )
    return user, {"Authorization": f"Bearer {issued.response.access_token}"}


async def test_demo_mode_with_mail_sends_only_to_the_allowed_domain_and_retries_the_rest(
    api_client: AsyncClient,
    db_app: FastAPI,
    db_session: AsyncSession,
    demo_settings: Settings,
    smtp_server: SmtpServer,
    chairman,
) -> None:
    _, bearer = chairman
    allowed = f"owner.{uuid.uuid4().hex[:6]}@{ALLOWED}"
    other = f"owner.{uuid.uuid4().hex[:6]}@example.com"
    for email in (allowed, other):
        created = await api_client.post(
            f"{API}/invitations",
            json={"kind": "OWNER", "email": email, "apartment_number": "2"},
            headers=bearer,
        )
        assert (created.status_code, created.json()["delivery"]) == (201, "QUEUED")
    before = datetime.now(UTC)
    await drain_queue(
        db_app.state.auth_session_factory, db_app.state.plugin_registry, demo_settings
    )
    assert [m["To"] for m in smtp_server.messages] == [allowed]
    db_session.expunge_all()
    rows = {
        row.email: row
        for row in await db_session.scalars(
            select(AuthInvitation).where(AuthInvitation.email.in_([allowed, other]))
        )
    }
    assert rows[allowed].send_due_at is None
    held = rows[other]
    assert held.send_attempts == 1  # like a failed send: the retry schedule applies
    assert abs(held.send_due_at - (before + timedelta(minutes=1))) < timedelta(seconds=30)
    listed = (await api_client.get(f"{API}/invitations", headers=bearer)).json()
    assert {i["email"]: i["delivery"] for i in listed} == {allowed: "SENT", other: "QUEUED"}


JOIN_ROUTES = [
    ("post", "/join-codes", {"apartment_ids": "not-a-list"}),
    ("get", "/join-codes", None),
    ("delete", "/join-codes/not-a-uuid", None),
    ("get", "/join/privacy-notice?locale=et", None),
    ("post", "/join/lookup", {"join_code": ""}),
    ("post", "/join", {"join_code": "K7QF-M3TX-9R"}),
    ("get", "/join-requests", None),
    ("post", f"/join-requests/{uuid.uuid4()}/confirm", None),
    ("post", "/join-requests/not-a-uuid/reject", None),
    ("get", "/join-decisions?limit=0", None),
]


@pytest.mark.parametrize("route", JOIN_ROUTES, ids=lambda r: f"{r[0]} {r[1]}")
async def test_every_join_route_is_not_found_in_demo_mode_whoever_asks_with_any_body(
    api_client: AsyncClient, chairman, route: tuple
) -> None:
    user, bearer = chairman
    method, path, body = route
    for headers in ({}, bearer, {"X-Demo-User-Id": str(user.id)}):
        kwargs: dict = {"headers": headers}
        if body is not None:
            kwargs["json"] = body
        response = await api_client.request(method.upper(), f"{API}{path}", **kwargs)
        assert (response.status_code, response.json()["error_code"]) == (404, "NOT_FOUND"), (
            headers.keys()
        )


@pytest.mark.parametrize("path", ["/join", "/join/lookup", "/join-codes"])
async def test_a_body_that_is_not_json_is_refused_by_the_framework_in_demo_mode(
    api_client: AsyncClient, path: str
) -> None:
    """The documented exception (docs/API.md 7): FastAPI decodes the body before the join
    dependency answers 404, so a body that is not JSON at all gets 422; a JSON body gets 404."""
    unknown = await api_client.post(
        f"{API}/no-such-route", content=b"{not json", headers={"content-type": "application/json"}
    )
    response = await api_client.post(
        f"{API}{path}", content=b"{not json", headers={"content-type": "application/json"}
    )
    assert unknown.status_code == 404
    assert response.status_code == 422, response.text
