"""A smoke test of every read endpoint in a building with apartments, parking spaces and garages
(epic E14, section 6.2): called as each person of the mixed building, nothing answers with a
5xx. An object without an entrance, a floor or an area must break no view."""

import re
import uuid

from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.core.security import create_access_token
from src.modules.property.models import User
from tests.factories import create_mixed_building, create_period

_PARAMETER = re.compile(r"\{([a-z_]+)\}")
# Query parameters some reads require; the rest have defaults.
_QUERY = {"period_code": "2026-10"}


def _bearer(user: User) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user.id, get_settings())}"}


def _read_paths(app: FastAPI, values: dict[str, list[str]]) -> list[str]:
    """Every GET path of the API, with each path parameter filled by each known value (an
    object id under every kind) or a random id."""
    paths: list[str] = []
    for path, operations in app.openapi()["paths"].items():
        if "get" not in operations or not path.startswith("/api/"):
            continue
        filled = [path]
        for name in _PARAMETER.findall(path):
            options = values.get(name, [str(uuid.uuid4())])
            filled = [path.replace(f"{{{name}}}", option) for path in filled for option in options]
        paths.extend(filled)
    return paths


async def test_every_read_endpoint_answers_every_person_of_a_mixed_building(
    api_client: AsyncClient, db_app: FastAPI, db_session: AsyncSession
) -> None:
    mixed = await create_mixed_building(db_session)
    await create_period(db_session, mixed.building)
    objects = [mixed.apt_1, mixed.apt_14, mixed.p_1, mixed.p_2, mixed.g_12, mixed.g_1, mixed.g_7]
    for author, body in ((mixed.a, "From P1 or Apt 14"), (mixed.b, "From G12")):
        published = await api_client.post(
            "/api/v1/communication/posts",
            json={"post_type": "FORUM_TOPIC", "title": "Hello", "body": body},
            headers=_bearer(author),
        )
        assert published.status_code == 201, published.text
    paths = _read_paths(
        db_app,
        {
            "apartment_id": [str(o.id) for o in objects],
            "period_code": ["2026-10"],
            "user_id": [str(mixed.b.id)],
        },
    )
    assert len(paths) > 40, "the routes were found"

    failures, answered = [], 0
    for name, person in mixed.people.items():
        for path in paths:
            response = await api_client.get(path, params=_QUERY, headers=_bearer(person))
            answered += response.status_code == 200
            if response.status_code >= 500:
                failures.append((name, path, response.status_code))

    assert failures == []
    # Not only refusals: most reads answer most people.
    assert answered > len(mixed.people) * 15, answered
