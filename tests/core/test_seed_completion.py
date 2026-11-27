"""The completion of the demo building (src/core/seed_completion.py; epic E14 task K6, section
6.1 and 6.2): parking spaces and a garage with their people and posts, added on every start, only
what is missing, and never stopping the start-up."""

import logging

import pytest
from fastapi import FastAPI
from httpx import AsyncClient
from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

import src.core.models_registry  # noqa: F401 - every table in the metadata
from src.core import seed, seed_completion
from src.core.database import Base
from src.core.security import DEMO_USER_HEADER
from src.core.seed import (
    DEMO_USERS,
    HISTORY_PERIODS,
    DemoUserKey,
    demo_id,
    demo_object_id,
    seed_demo_data,
)
from src.core.seed_completion import (
    COMMENT_KINDS_ID,
    EMERGENCY_PARKING_ID,
    G12,
    GARAGE_METER_ID,
    NOTICE_EVERYTHING_ID,
    NOTICE_GARAGES_ID,
    P1,
    P2,
    POLL_PARKING_ID,
    TOPIC_KINDS_ID,
    complete_demo_building,
)
from src.modules.communication.models import Comment, Post
from src.modules.governance.models import Poll, PollElector
from src.modules.governance.schemas import PollStatus
from src.modules.meters.models import MeterDevice, MeterReading, ReadingPeriod
from src.modules.property.models import Apartment, ApartmentMembership, User
from tests.factories import create_user
from tests.property.test_mixed_smoke import _read_paths

USERS = {demo.key: demo for demo in DEMO_USERS}
POSTS = "/api/v1/communication/posts"


def as_demo(key: DemoUserKey) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(USERS[key].user_id)}


async def count(session: AsyncSession, model, *where) -> int:
    return await session.scalar(select(func.count()).select_from(model).where(*where))


async def every_count(session: AsyncSession) -> dict[str, int]:
    return {
        table.name: await session.scalar(select(func.count()).select_from(table))
        for table in Base.metadata.sorted_tables
    }


@pytest.fixture
async def seeded(db_session: AsyncSession) -> AsyncSession:
    assert await seed_demo_data(db_session) is True
    return db_session


@pytest.fixture
async def old_demo(db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch) -> AsyncSession:
    """A demo building seeded before the completion existed."""

    async def nothing(session: AsyncSession, now) -> None:
        return None

    with monkeypatch.context() as patch:
        patch.setattr(seed_completion, "complete_demo_building", nothing)
        assert await seed_demo_data(db_session) is True
    assert await db_session.get(Apartment, demo_object_id(G12)) is None
    return db_session


async def titles(api_client: AsyncClient, key: DemoUserKey, post_type: str) -> set[str]:
    response = await api_client.get(POSTS, params={"post_type": post_type}, headers=as_demo(key))
    assert response.status_code == 200, response.text
    return {post["title"] for post in response.json()}


# --- The completed demo building -----------------------------------------------------------------


async def test_the_demo_building_has_its_objects_meters_and_readings(seeded: AsyncSession) -> None:
    assert await count(seeded, Apartment) == 9
    assert set(await seeded.scalars(select(Apartment.entrance))) == {1, 2, None}
    assert await count(seeded, MeterDevice) == 15
    for code in HISTORY_PERIODS:
        in_month = MeterReading.period_id == demo_id(f"period:{code}")
        assert await count(seeded, MeterReading, in_month) == 15, code
    assert await count(seeded, User) == len(DEMO_USERS)
    garage = await seeded.get(MeterDevice, GARAGE_METER_ID)
    assert (garage.unit, str(garage.max_monthly_delta)) == ("kWh", "1000.000")


async def test_the_september_matrix_is_all_submitted_with_the_garage(
    seeded: AsyncSession, api_client: AsyncClient
) -> None:
    response = await api_client.get(
        "/api/v1/meters/periods/2026-09/matrix", headers=as_demo(DemoUserKey.CHAIRMAN)
    )

    assert response.status_code == 200, response.text
    rows = response.json()["apartments"]
    assert "MISSING" not in response.text
    assert ("GARAGE", "12") in {(row["apartment_kind"], row["apartment_number"]) for row in rows}


async def test_the_building_counts_kinds_and_heats_only_the_apartments(
    seeded: AsyncSession, api_client: AsyncClient
) -> None:
    body = (
        await api_client.get("/api/v1/property/building", headers=as_demo(DemoUserKey.OWNER_14))
    ).json()

    apartments = await seeded.scalars(
        select(Apartment.area_m2).where(Apartment.kind == "APARTMENT")
    )
    assert (body["apartment_count"], body["entrance_count"]) == (6, 2)
    assert body["object_counts"] == {"APARTMENT": 6, "PARKING": 2, "GARAGE": 1}
    assert body["heated_area_m2"] == str(sum(apartments))


async def test_the_emergencies_reach_their_objects(
    seeded: AsyncSession, api_client: AsyncClient
) -> None:
    url = "/api/v1/communication/emergencies/active"

    async def categories(key: DemoUserKey) -> list[str]:
        response = await api_client.get(url, headers=as_demo(key))
        return sorted(e["target_scope"] for e in response.json())

    assert await categories(DemoUserKey.OWNER_14) == ["ENTRANCE", "KINDS"]  # Apt. 14 and P1
    assert await categories(DemoUserKey.TENANT_P2) == ["KINDS"]
    assert await categories(DemoUserKey.OWNER_G12) == []


async def test_the_notices_reach_their_kinds(seeded: AsyncSession, api_client: AsyncClient) -> None:
    gate, yard = (
        "The garage gate code changes on Friday",
        "The yard is closed on Saturday for asphalt work",
    )

    owner_g12 = await titles(api_client, DemoUserKey.OWNER_G12, "OFFICIAL_NOTICE")
    owner_14 = await titles(api_client, DemoUserKey.OWNER_14, "OFFICIAL_NOTICE")
    tenant_p2 = await titles(api_client, DemoUserKey.TENANT_P2, "OFFICIAL_NOTICE")

    assert {gate, yard} <= owner_g12
    assert yard in owner_14 and gate not in owner_14
    assert yard in tenant_p2 and gate not in tenant_p2


async def test_the_topic_to_parking_and_garages_and_the_comments_signed_p1_and_g12(
    seeded: AsyncSession, api_client: AsyncClient
) -> None:
    detail = await api_client.get(
        f"{POSTS}/{TOPIC_KINDS_ID}", headers=as_demo(DemoUserKey.OWNER_G12)
    )
    tenant_2 = await titles(api_client, DemoUserKey.TENANT_2, "FORUM_TOPIC")

    assert detail.status_code == 200, detail.text
    body = detail.json()
    assert body["author_badge"]["role_badge"] == "BOARD"
    assert [c["author_badge"]["display_label"] for c in body["comments"]] == ["P1", "T. K. (G12)"]
    assert body["target_kinds"] == ["PARKING", "GARAGE"]
    assert body["last_activity_at"] > body["created_at"]
    assert "Who else wants a charger for electric cars?" not in tenant_2  # an apartment only
    assert "Ivan" not in detail.text and "Tiit" not in detail.text


async def test_a_resident_could_not_publish_the_seeded_topic_but_the_board_can(
    seeded: AsyncSession, api_client: AsyncClient
) -> None:
    # The demo shows only what the API allows (K3: a resident addresses only the kinds held).
    post = {
        "post_type": "FORUM_TOPIC",
        "title": "Chargers",
        "body": "Anyone?",
        "target_scope": "KINDS",
        "target_kinds": ["PARKING", "GARAGE"],
    }
    owner_g12 = await api_client.post(POSTS, json=post, headers=as_demo(DemoUserKey.OWNER_G12))
    board = await api_client.post(POSTS, json=post, headers=as_demo(DemoUserKey.BOARD))

    assert owner_g12.status_code == 403
    assert board.status_code == 201, board.text


async def test_the_parking_poll_is_answered_per_parking_space(
    seeded: AsyncSession, api_client: AsyncClient
) -> None:
    async def polls(key: DemoUserKey) -> dict[str, list[str]]:
        response = await api_client.get("/api/v1/governance/polls", headers=as_demo(key))
        assert response.status_code == 200, response.text
        return {p["title"]: p.get("answerable_apartment_ids") for p in response.json()}

    owner_14 = await polls(DemoUserKey.OWNER_14)
    tenant_p2 = await polls(DemoUserKey.TENANT_P2)
    owner_g12 = await polls(DemoUserKey.OWNER_G12)
    lines = "Repaint the lines of the parking spaces"

    assert {"Spring clean-up in the yard", lines} <= owner_14.keys()
    assert set(tenant_p2) == {lines}
    assert owner_g12 == {}  # the clean-up is a poll of the apartments
    electors = set(
        await seeded.scalars(
            select(PollElector.apartment_id).where(PollElector.poll_id == POLL_PARKING_ID)
        )
    )
    assert electors == {demo_object_id(P1), demo_object_id(P2)}


async def test_the_switcher_lists_the_objects_of_every_user(
    seeded: AsyncSession, api_client: AsyncClient
) -> None:
    users = {u["label"]: u for u in (await api_client.get("/api/v1/demo/users")).json()}

    assert users["Owner Apt 14"]["objects"] == [
        {"kind": "APARTMENT", "number": "14", "relation": "OWNER"},
        {"kind": "PARKING", "number": "1", "relation": "OWNER"},
    ]
    assert users["Owner Garage 12"] | {"user_id": None} == {
        "user_id": None,
        "label": "Owner Garage 12",
        "building_role": "USER",
        "apartment_number": None,
        "relation_type": None,
        "objects": [{"kind": "GARAGE", "number": "12", "relation": "OWNER"}],
    }
    assert users["Tenant Parking P-2"]["objects"] == [
        {"kind": "PARKING", "number": "P-2", "relation": "TENANT"}
    ]
    assert users["Chairman"]["objects"] == []


async def test_the_tenant_of_a_parking_space_has_no_shared_spaces(
    seeded: AsyncSession, api_client: AsyncClient
) -> None:
    me = await api_client.get("/api/v1/property/me", headers=as_demo(DemoUserKey.TENANT_P2))

    assert me.json()["shared_access"] is False
    assert [m["apartment_kind"] for m in me.json()["memberships"]] == ["PARKING"]


async def test_every_read_endpoint_answers_every_demo_user(
    seeded: AsyncSession, api_client: AsyncClient, db_app: FastAPI
) -> None:
    objects = [str(a) for a in await seeded.scalars(select(Apartment.id))]
    paths = _read_paths(
        db_app,
        {
            "apartment_id": objects,
            "period_code": ["2026-09"],
            "post_id": [str(TOPIC_KINDS_ID)],
            "poll_id": [str(POLL_PARKING_ID)],
        },
    )
    failures = []
    for demo in DEMO_USERS:
        for path in paths:
            response = await api_client.get(
                path, params={"period_code": "2026-09"}, headers=as_demo(demo.key)
            )
            if response.status_code >= 500:
                failures.append((demo.key, path, response.status_code))
    assert failures == []


# --- Only what is missing ------------------------------------------------------------------------


async def test_a_second_completion_adds_nothing(seeded: AsyncSession) -> None:
    before = await every_count(seeded)

    assert await seed_demo_data(seeded) is False
    await complete_demo_building(seeded, seed.datetime.now(seed.UTC))

    assert await every_count(seeded) == before


async def test_an_older_demo_building_is_completed_on_start(old_demo: AsyncSession) -> None:
    assert await seed_demo_data(old_demo) is False

    assert await count(old_demo, Apartment) == 9
    assert await count(old_demo, User) == len(DEMO_USERS)
    assert await old_demo.get(Post, TOPIC_KINDS_ID) is not None
    assert await old_demo.get(Comment, COMMENT_KINDS_ID) is not None


async def test_the_completion_copes_with_a_vandalised_demo(
    old_demo: AsyncSession, api_client: AsyncClient
) -> None:
    # The owner of Apt. 14 closed the account, the clean-up poll was closed, a topic deleted,
    # the emergency resolved, and someone registered the e-mail of the new garage owner.
    chairman = as_demo(DemoUserKey.CHAIRMAN)
    bikes = demo_id("post:bike-rack")
    assert (await api_client.delete(f"{POSTS}/{bikes}", headers=chairman)).status_code == 204
    resolved = await api_client.post(
        f"/api/v1/communication/emergencies/{demo_id('post:emergency')}/resolve", headers=chairman
    )
    assert resolved.status_code == 200, resolved.text
    closed = await api_client.post(
        f"/api/v1/governance/polls/{demo_id('poll:clean-up')}/close", headers=chairman
    )
    assert closed.status_code == 200, closed.text
    owner_14 = USERS[DemoUserKey.OWNER_14].user_id
    await old_demo.execute(update(User).where(User.id == owner_14).values(is_active=False))
    demo = await old_demo.get(seed.Building, seed.DEMO_BUILDING_ID)
    await create_user(old_demo, demo, "Somebody Else", email=USERS[DemoUserKey.OWNER_G12].email)

    assert await seed_demo_data(old_demo) is False

    assert await count(old_demo, Apartment) == 9  # the objects need nobody
    assert await old_demo.get(User, USERS[DemoUserKey.OWNER_G12].user_id) is None
    assert await count(old_demo, ApartmentMembership, ApartmentMembership.user_id == owner_14) == 1
    assert await old_demo.get(MeterDevice, GARAGE_METER_ID) is not None
    # Without the owner the chairman typed the garage's readings in, so the matrix is complete.
    sources = set(
        await old_demo.scalars(
            select(MeterReading.source).where(MeterReading.meter_id == GARAGE_METER_ID)
        )
    )
    assert await count(old_demo, MeterReading, MeterReading.meter_id == GARAGE_METER_ID) == 3
    assert sources == {"ADMIN_OVERRIDE"}
    assert await old_demo.get(Post, TOPIC_KINDS_ID) is not None  # the board's
    assert await count(old_demo, Comment, Comment.post_id == TOPIC_KINDS_ID) == 0
    for notice in (NOTICE_GARAGES_ID, NOTICE_EVERYTHING_ID, EMERGENCY_PARKING_ID):
        assert await old_demo.get(Post, notice) is not None
    electors = await old_demo.scalars(
        select(PollElector.apartment_id).where(PollElector.poll_id == POLL_PARKING_ID)
    )
    assert list(electors) == [demo_object_id(P2)]  # only the tenant of P-2 is left
    assert (await old_demo.get(Post, bikes)).deleted_at is not None
    assert (await old_demo.get(Post, demo_id("post:emergency"))).is_active is False
    assert (await old_demo.get(Poll, demo_id("poll:clean-up"))).status == PollStatus.CLOSED


async def test_an_existing_poll_keeps_its_electorate_and_a_deleted_post_stays_deleted(
    seeded: AsyncSession, api_client: AsyncClient
) -> None:
    chairman = as_demo(DemoUserKey.CHAIRMAN)
    assert (
        await api_client.delete(f"{POSTS}/{TOPIC_KINDS_ID}", headers=chairman)
    ).status_code == 204
    resolved = await api_client.post(
        f"/api/v1/communication/emergencies/{EMERGENCY_PARKING_ID}/resolve", headers=chairman
    )
    assert resolved.status_code == 200, resolved.text
    closed = await api_client.post(
        f"/api/v1/governance/polls/{POLL_PARKING_ID}/close", headers=chairman
    )
    assert closed.status_code == 200, closed.text
    # The tenant of P-2 moved out: an open poll would still keep the electorate.
    await seeded.execute(
        delete(PollElector).where(
            PollElector.poll_id == POLL_PARKING_ID,
            PollElector.apartment_id == demo_object_id(P2),
        )
    )

    assert await seed_demo_data(seeded) is False

    assert (await seeded.get(Post, TOPIC_KINDS_ID)).deleted_at is not None
    assert (await seeded.get(Post, EMERGENCY_PARKING_ID)).is_active is False
    assert (await seeded.get(Poll, POLL_PARKING_ID)).status == PollStatus.CLOSED
    assert await count(seeded, PollElector, PollElector.poll_id == POLL_PARKING_ID) == 1


# --- Never stopping the start-up -----------------------------------------------------------------


async def test_a_failing_completion_is_rolled_back_and_the_start_up_goes_on(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def fail_after_the_objects(self) -> None:
        await self.objects()
        raise RuntimeError("tiit.kuusk@demo.invalid")  # an error text may hold personal data

    monkeypatch.setattr(seed_completion._Completion, "run", fail_after_the_objects)
    caplog.set_level(logging.INFO)

    assert await seed_demo_data(db_session) is True

    assert await count(db_session, Apartment) == 6  # the savepoint is rolled back
    assert await count(db_session, ReadingPeriod) == 4  # the rest of the demo stays
    assert "seed_demo_completion_failed" in caplog.text
    assert "RuntimeError" in caplog.text
    assert "tiit.kuusk" not in caplog.text.lower()


async def test_the_completion_never_runs_on_a_real_installation(
    old_demo: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def real(session: AsyncSession) -> bool:
        return True

    monkeypatch.setattr(seed, "is_real_installation", real)

    assert await seed_demo_data(old_demo) is False
    assert await count(old_demo, Apartment) == 6
    assert await old_demo.get(User, USERS[DemoUserKey.OWNER_G12].user_id) is None


async def test_an_ended_membership_stays_ended(seeded: AsyncSession) -> None:
    # The owner of Apt. 14 sold parking space 1; the comment signed P1 and the vote go with it.
    p1 = seed_completion.membership_id(
        DemoUserKey.OWNER_14, seed_completion._object_of(DemoUserKey.OWNER_14, P1)
    )
    await seeded.execute(
        update(ApartmentMembership).where(ApartmentMembership.id == p1).values(ended_at=func.now())
    )
    await seeded.execute(delete(Comment).where(Comment.id == COMMENT_KINDS_ID))

    assert await seed_demo_data(seeded) is False

    assert (await seeded.get(ApartmentMembership, p1)).ended_at is not None
    assert await seeded.get(Comment, COMMENT_KINDS_ID) is None


async def test_an_object_under_the_demo_number_blocks_its_dependent_rows(
    old_demo: AsyncSession,
) -> None:
    # The chairman created "garage 12" by hand before the completion: its id is not the demo's.
    await old_demo.execute(
        insert(Apartment).values(
            building_id=seed.DEMO_BUILDING_ID, kind="GARAGE", number="12", area_m2=None
        )
    )

    assert await seed_demo_data(old_demo) is False

    assert await old_demo.get(Apartment, demo_object_id(G12)) is None
    assert await count(old_demo, Apartment, Apartment.kind == "GARAGE") == 1
    assert await old_demo.get(MeterDevice, GARAGE_METER_ID) is None
    owner = USERS[DemoUserKey.OWNER_G12].user_id
    assert await count(old_demo, ApartmentMembership, ApartmentMembership.user_id == owner) == 0
    assert await count(old_demo, Comment, Comment.post_id == TOPIC_KINDS_ID) == 1  # P1 only


async def test_a_database_error_rolls_back_the_completion_only(
    old_demo: AsyncSession, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # An older demo: the registry code that the same start fills in must still be committed.
    building = await old_demo.get(seed.Building, seed.DEMO_BUILDING_ID)
    building.registry_code = None
    await old_demo.flush()
    broken = seed_completion._OBJECTS + (
        seed_completion._ObjectSpec(seed.ObjectKind.APARTMENT, "99", None, None),
    )
    monkeypatch.setattr(seed_completion, "_OBJECTS", broken)  # an apartment needs an entrance
    caplog.set_level(logging.INFO)

    assert await seed_demo_data(old_demo) is False

    assert await count(old_demo, Apartment) == 6
    assert building.registry_code == "80123456"
    assert await old_demo.scalar(select(func.count()).select_from(seed.Building)) == 1
    assert "seed_demo_completion_failed" in caplog.text
    assert "IntegrityError" in caplog.text and "objects" in caplog.text
