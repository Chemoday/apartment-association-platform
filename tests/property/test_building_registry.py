"""The building passport from a register through the API (epic E12 X1), with a fake provider."""

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import DEMO_USER_HEADER
from src.modules.property import registry as registry_module
from src.modules.property.models import Building, BuildingRegistryRecord, RegistryCallDay, User
from src.plugins.countries.ee.facts import EEBuilding, EEBuildingFacts, EESource, EEUnit, UnitKind
from src.plugins.registry import (
    RegistryBuildingNotFound,
    RegistryCandidate,
    RegistryUnavailable,
)
from tests.issues.conftest import IssueWorld, build_issue_world

API = "/api/v1/property/building"
REGISTRY = f"{API}/registry"


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


class FakeRegister:
    country_code = "EE"
    schema = "ee/1"

    def __init__(self) -> None:
        self.queries: list[str] = []
        self.failing = False
        self.fetches = 0

    def valid_code(self, code: str) -> bool:
        return code.isdigit() and 6 <= len(code) <= 12

    async def search(self, query: str) -> list[RegistryCandidate]:
        self.queries.append(query)
        if self.failing:
            raise RegistryUnavailable()
        return [
            RegistryCandidate(code="100000001", address="Näidise tn 1", kind_label="EHITISHOONE")
        ]

    def certificate_valid_until(self, block: EEBuildingFacts):
        return None

    async def fetch(self, code: str) -> EEBuildingFacts:
        if self.failing:
            raise RegistryUnavailable()
        if code != "100000001":
            raise RegistryBuildingNotFound()
        self.fetches += 1
        return EEBuildingFacts(
            source=EESource(building_code=code, fetched_at=datetime(2026, 11, 15, 9, tzinfo=UTC)),
            building=EEBuilding(first_use_year=1971, floors_max=4 + self.fetches),
            units=[EEUnit(number="14", kind=UnitKind.APARTMENT, area_m2="54.3")],
        )


@pytest.fixture
async def world(db_session: AsyncSession) -> IssueWorld:
    return await build_issue_world(db_session)


@pytest.fixture
def fake(db_app: FastAPI) -> Iterator[FakeRegister]:
    register = FakeRegister()
    providers = db_app.state.plugin_registry._building_registries
    providers["EE"] = register
    yield register
    providers.pop("EE", None)


async def test_without_a_provider_the_building_has_no_facts(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    building = await api_client.get(API, headers=as_user(world.owner_14))
    assert building.status_code == 200
    assert building.json()["registry_facts"] is None
    for method, path, body in (
        ("GET", REGISTRY, None),
        ("POST", f"{REGISTRY}/search", {}),
        ("POST", f"{REGISTRY}/proposal", {"code": "100000001"}),
        ("POST", f"{REGISTRY}/accept", None),
    ):
        response = await api_client.request(
            method, path, json=body, headers=as_user(world.chairman)
        )
        assert response.status_code == 404, path
        assert response.json()["error_code"] == "REGISTRY_NOT_ENABLED"


async def test_the_chairman_finds_fetches_and_accepts(
    api_client: AsyncClient, world: IssueWorld, fake: FakeRegister
) -> None:
    found = await api_client.post(f"{REGISTRY}/search", json={}, headers=as_user(world.chairman))
    assert found.status_code == 200
    assert found.json() == {
        "candidates": [
            {"code": "100000001", "address": "Näidise tn 1", "kind_label": "EHITISHOONE"}
        ]
    }
    assert fake.queries == [world.building.address], "the building's own address by default"
    await api_client.post(
        f"{REGISTRY}/search", json={"query": "  Näidise   1 "}, headers=as_user(world.chairman)
    )
    assert fake.queries[-1] == "Näidise 1", "spaces collapsed"

    proposed = await api_client.post(
        f"{REGISTRY}/proposal", json={"code": "100000001"}, headers=as_user(world.chairman)
    )
    assert proposed.status_code == 200, proposed.text
    state = proposed.json()
    assert state["accepted"] is None and state["accepted_at"] is None
    assert state["proposal"]["schema"] == "ee/1"
    assert state["proposal"]["units"][0]["area_m2"] == "54.3"
    assert state["proposal_fetched_at"] is not None

    hidden = await api_client.get(API, headers=as_user(world.owner_14))
    assert hidden.json()["registry_facts"] is None, "residents see nothing before acceptance"

    accepted = await api_client.post(f"{REGISTRY}/accept", headers=as_user(world.chairman))
    assert accepted.status_code == 200
    assert accepted.json()["proposal"] is None
    assert accepted.json()["accepted"]["source"]["register"] == "EHR"

    facts = (await api_client.get(API, headers=as_user(world.owner_14))).json()["registry_facts"]
    assert facts["country_code"] == "EE"
    assert facts["building"]["first_use_year"] == 1971
    assert facts["units"] == [
        {
            "number": "14",
            "kind": "APARTMENT",
            "area_m2": "54.3",
            "heated_area_m2": None,
            "rooms": None,
            "toilets": None,
            "entrance_floor": None,
        }
    ]

    board = await api_client.get(REGISTRY, headers=as_user(world.board_15))
    assert board.status_code == 200 and board.json()["accepted"] is not None

    removed = await api_client.delete(REGISTRY, headers=as_user(world.chairman))
    assert removed.status_code == 204
    assert (await api_client.get(API, headers=as_user(world.owner_14))).json()[
        "registry_facts"
    ] is None


async def test_only_the_chairman_changes_and_only_the_board_looks(
    api_client: AsyncClient, world: IssueWorld, fake: FakeRegister
) -> None:
    for user in (world.board_15, world.owner_14, world.accountant):
        for method, path, body in (
            ("POST", f"{REGISTRY}/search", {}),
            ("POST", f"{REGISTRY}/proposal", {"code": "100000001"}),
            ("POST", f"{REGISTRY}/accept", None),
            ("DELETE", REGISTRY, None),
        ):
            response = await api_client.request(method, path, json=body, headers=as_user(user))
            assert response.status_code == 403, (user.full_name, path)
    for user in (world.owner_14, world.accountant):
        assert (await api_client.get(REGISTRY, headers=as_user(user))).status_code == 403
    assert fake.queries == []


async def test_accept_needs_a_proposal(
    api_client: AsyncClient, world: IssueWorld, fake: FakeRegister
) -> None:
    response = await api_client.post(f"{REGISTRY}/accept", headers=as_user(world.chairman))
    assert response.status_code == 409
    assert response.json()["error_code"] == "NO_REGISTRY_PROPOSAL"


async def test_register_failures_change_nothing(
    api_client: AsyncClient, world: IssueWorld, fake: FakeRegister
) -> None:
    unknown = await api_client.post(
        f"{REGISTRY}/proposal", json={"code": "999999999"}, headers=as_user(world.chairman)
    )
    assert unknown.status_code == 404
    assert unknown.json()["error_code"] == "REGISTRY_BUILDING_NOT_FOUND"

    for bad in ({"code": "abc"}, {"code": ""}, {"code": "1" * 40}, {"code": "1", "x": 1}):
        response = await api_client.post(
            f"{REGISTRY}/proposal", json=bad, headers=as_user(world.chairman)
        )
        assert response.status_code == 422, bad
    for query in ("ab", "x" * 201, "     ", " a  ", "a\x00bc", 12):
        response = await api_client.post(
            f"{REGISTRY}/search", json={"query": query}, headers=as_user(world.chairman)
        )
        assert response.status_code == 422, query

    fake.failing = True
    for method, path, body in (
        ("POST", f"{REGISTRY}/search", {}),
        ("POST", f"{REGISTRY}/proposal", {"code": "100000001"}),
    ):
        response = await api_client.request(
            method, path, json=body, headers=as_user(world.chairman)
        )
        assert response.status_code == 503
        assert response.json()["error_code"] == "REGISTRY_UNAVAILABLE"
    state = (await api_client.get(REGISTRY, headers=as_user(world.chairman))).json()
    assert state["proposal"] is None and state["accepted"] is None


async def test_a_block_that_no_longer_fits_is_shown_as_none(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld, fake: FakeRegister
) -> None:
    db_session.add(
        BuildingRegistryRecord(
            building_id=world.building.id,
            accepted={"country_code": "EE", "schema": "ee/0", "anything": 1},
            accepted_at=datetime.now(UTC),
            updated_at=datetime.now(UTC),
        )
    )
    await db_session.flush()
    assert (await api_client.get(API, headers=as_user(world.owner_14))).json()[
        "registry_facts"
    ] is None
    state = (await api_client.get(REGISTRY, headers=as_user(world.chairman))).json()
    assert state["accepted"] is None and state["accepted_at"] is None


async def test_a_building_of_another_country_has_no_provider(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld, fake: FakeRegister
) -> None:
    await db_session.execute(
        update(Building).where(Building.id == world.building.id).values(country_code="LV")
    )
    await db_session.flush()
    response = await api_client.post(f"{REGISTRY}/search", json={}, headers=as_user(world.chairman))
    assert response.status_code == 404
    assert response.json()["error_code"] == "REGISTRY_NOT_ENABLED"
    assert fake.queries == []


async def propose_and_accept(api_client: AsyncClient, chairman: User) -> None:
    proposed = await api_client.post(
        f"{REGISTRY}/proposal", json={"code": "100000001"}, headers=as_user(chairman)
    )
    assert proposed.status_code == 200
    assert (
        await api_client.post(f"{REGISTRY}/accept", headers=as_user(chairman))
    ).status_code == 200


async def test_a_removed_provider_hides_the_passport_and_the_chairman_can_remove_it(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld, fake: FakeRegister
) -> None:
    await propose_and_accept(api_client, world.chairman)
    await db_session.execute(
        update(Building).where(Building.id == world.building.id).values(country_code="LV")
    )
    await db_session.flush()

    building = await api_client.get(API, headers=as_user(world.owner_14))
    assert building.json()["registry_facts"] is None, "no provider: no stale passport"
    removed = await api_client.delete(REGISTRY, headers=as_user(world.chairman))
    assert removed.status_code == 204
    assert await db_session.get(BuildingRegistryRecord, world.building.id) is None


async def test_a_proposal_that_no_longer_fits_is_not_accepted(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld, fake: FakeRegister
) -> None:
    await propose_and_accept(api_client, world.chairman)
    await db_session.execute(
        update(BuildingRegistryRecord)
        .where(BuildingRegistryRecord.building_id == world.building.id)
        .values(proposal={"country_code": "EE", "schema": "ee/0"})
    )
    await db_session.flush()
    response = await api_client.post(f"{REGISTRY}/accept", headers=as_user(world.chairman))
    assert response.status_code == 409
    assert response.json()["error_code"] == "NO_REGISTRY_PROPOSAL"
    state = (await api_client.get(REGISTRY, headers=as_user(world.chairman))).json()
    assert state["accepted"] is not None, "the accepted block is kept"


async def test_a_second_fetch_replaces_the_proposal(
    api_client: AsyncClient, world: IssueWorld, fake: FakeRegister
) -> None:
    floors = []
    for _ in range(2):
        response = await api_client.post(
            f"{REGISTRY}/proposal", json={"code": "100000001"}, headers=as_user(world.chairman)
        )
        assert response.status_code == 200
        floors.append(response.json()["proposal"]["building"]["floors_max"])
    assert floors == [5, 6]
    state = (await api_client.get(REGISTRY, headers=as_user(world.chairman))).json()
    assert state["proposal"]["building"]["floors_max"] == 6, "the newer proposal replaced the old"


async def test_the_search_text_never_reaches_a_trace_or_a_log(
    api_client: AsyncClient, world: IssueWorld, fake: FakeRegister, span_exporter, log_capture
) -> None:
    secret = "Saladuse tn 77"
    response = await api_client.post(
        f"{REGISTRY}/search", json={"query": secret}, headers=as_user(world.chairman)
    )
    assert response.status_code == 200
    for span in span_exporter.get_finished_spans():
        assert all(secret not in str(value) for value in (span.attributes or {}).values())
    assert secret not in log_capture.raw


@pytest.fixture
def quota(db_app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> Callable[[int], None]:
    def set_limit(limit: int) -> None:
        monkeypatch.setattr(db_app.state.plugin_registry.settings, "REGISTRY_CALLS_PER_DAY", limit)

    return set_limit


async def test_the_daily_quota_counts_search_and_proposal_together(
    api_client: AsyncClient, world: IssueWorld, fake: FakeRegister, quota
) -> None:
    quota(3)
    chairman = as_user(world.chairman)
    assert (
        await api_client.post(f"{REGISTRY}/search", json={}, headers=chairman)
    ).status_code == 200
    fake.failing = True  # a call that fails still reached the register
    assert (
        await api_client.post(f"{REGISTRY}/search", json={}, headers=chairman)
    ).status_code == 503
    fake.failing = False
    proposed = await api_client.post(
        f"{REGISTRY}/proposal", json={"code": "100000001"}, headers=chairman
    )
    assert proposed.status_code == 200

    used = await api_client.post(f"{REGISTRY}/search", json={}, headers=chairman)
    assert used.status_code == 429
    body = used.json()
    assert body["error_code"] == "RATE_LIMITED" and body["reason"] == "DAILY_LIMIT"
    assert 1 <= body["retry_after_seconds"] <= 86_400
    assert used.headers["Retry-After"] == str(body["retry_after_seconds"])
    assert len(fake.queries) == 2, "no call once the quota is used"
    again = await api_client.post(
        f"{REGISTRY}/proposal", json={"code": "100000001"}, headers=chairman
    )
    assert again.status_code == 429
    # Accepting and reading never call the register.
    assert (await api_client.post(f"{REGISTRY}/accept", headers=chairman)).status_code == 200
    assert (await api_client.get(REGISTRY, headers=chairman)).status_code == 200


async def test_the_quota_starts_again_the_next_day(
    api_client: AsyncClient,
    db_session: AsyncSession,
    world: IssueWorld,
    fake: FakeRegister,
    quota,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    quota(1)
    chairman = as_user(world.chairman)
    assert (
        await api_client.post(f"{REGISTRY}/search", json={}, headers=chairman)
    ).status_code == 200
    assert (
        await api_client.post(f"{REGISTRY}/search", json={}, headers=chairman)
    ).status_code == 429

    today = datetime.now(UTC)
    db_session.add(RegistryCallDay(day=(today - timedelta(days=9)).date(), calls=4))
    await db_session.flush()
    monkeypatch.setattr(registry_module, "_now", lambda: today + timedelta(days=1))
    assert (
        await api_client.post(f"{REGISTRY}/search", json={}, headers=chairman)
    ).status_code == 200
    days = set(await db_session.scalars(select(RegistryCallDay.day)))
    assert (today - timedelta(days=9)).date() not in days, "old days are removed"


async def test_refused_requests_never_use_the_quota(
    api_client: AsyncClient, db_session: AsyncSession, world: IssueWorld, fake: FakeRegister, quota
) -> None:
    quota(1)
    chairman = as_user(world.chairman)
    bad = await api_client.post(f"{REGISTRY}/proposal", json={"code": "abc"}, headers=chairman)
    assert bad.status_code == 422
    await db_session.execute(
        update(Building).where(Building.id == world.building.id).values(country_code="LV")
    )
    await db_session.flush()
    assert (
        await api_client.post(f"{REGISTRY}/search", json={}, headers=chairman)
    ).status_code == 404
    await db_session.execute(
        update(Building).where(Building.id == world.building.id).values(country_code="EE")
    )
    await db_session.flush()
    assert (
        await api_client.post(f"{REGISTRY}/search", json={}, headers=chairman)
    ).status_code == 200
