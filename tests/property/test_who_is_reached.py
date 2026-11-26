"""Who is reached, by kind of object (epic E14, sections 3.1-3.4 and 6.2): the table of the
design over every target, for the feed, the emergency banner, `can_read_post`, the notification
recipients, polls and their electorate. The rule is per object: a person is reached through each
of their objects that the target holds, and only through those."""

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import DEMO_USER_HEADER
from src.modules.communication.service import CommunicationService
from src.modules.property.models import User
from src.modules.property.schemas import TargetDTO
from src.modules.property.service import PropertyService
from tests.factories import MixedBuilding, create_mixed_building

POSTS = "/api/v1/communication/posts"
POLLS = "/api/v1/governance/polls"

# target -> who of A, B, C, D, E, X is reached (docs/epics/E14_OBJECT_KINDS.md section 6.2).
TABLE = [
    ({"target_scope": "ALL_BUILDING"}, "A D E X"),
    ({"target_scope": "ALL_OBJECTS"}, "A B C D E X"),
    ({"target_scope": "ENTRANCE", "target_entrance": 1}, "D E X"),
    ({"target_scope": "ENTRANCE", "target_entrance": 2}, "A"),
    ({"target_scope": "APARTMENT_LIST", "objects": ["p_1"]}, "A"),
    ({"target_scope": "APARTMENT_LIST", "objects": ["p_2"]}, "C X"),
    ({"target_scope": "KINDS", "target_kinds": ["APARTMENT"]}, "A D E X"),
    ({"target_scope": "KINDS", "target_kinds": ["PARKING"]}, "A C X"),
    ({"target_scope": "KINDS", "target_kinds": ["GARAGE"]}, "B"),
    ({"target_scope": "KINDS", "target_kinds": ["GARAGE", "PARKING"]}, "A B C X"),
]
PEOPLE = "A B C D E X".split()


def as_user(user: User) -> dict[str, str]:
    return {DEMO_USER_HEADER: str(user.id)}


@pytest.fixture
async def mixed(db_session: AsyncSession) -> MixedBuilding:
    return await create_mixed_building(db_session)


def body(mixed: MixedBuilding, target: dict) -> dict:
    fields = {k: v for k, v in target.items() if k != "objects"}
    if "objects" in target:
        fields["target_apartment_ids"] = [
            str(getattr(mixed, name).id) for name in target["objects"]
        ]
    return fields


def label(target: dict) -> str:
    return " ".join(str(v) for v in target.values())


@pytest.mark.parametrize(("target", "reached"), TABLE, ids=[label(t) for t, _ in TABLE])
async def test_who_sees_an_emergency_and_is_notified_of_it(
    api_client: AsyncClient,
    db_session: AsyncSession,
    mixed: MixedBuilding,
    target: dict,
    reached: str,
) -> None:
    published = await api_client.post(
        POSTS,
        json={
            "post_type": "EMERGENCY",
            "category": "WATER_SHUTOFF",
            "title": "Water off",
            "body": "Until 18:00.",
            **body(mixed, target),
        },
        headers=as_user(mixed.chairman),
    )
    assert published.status_code == 201, published.text
    post_id = published.json()["id"]
    properties = PropertyService(db_session)
    communication = CommunicationService(db_session, properties)
    stored = published.json()
    rule = TargetDTO.of(
        stored["target_scope"],
        stored["target_entrance"],
        stored["target_apartment_ids"],
        stored["target_kinds"],
    )
    recipients = {r.user_id for r in await properties.resolve_recipients(mixed.building.id, rule)}

    seen = set()
    for name in PEOPLE:
        user = mixed.people[name]
        current = await properties.get_current_user(user.id)
        assert current is not None
        feed = await api_client.get(POSTS, headers=as_user(user))
        banner = await api_client.get(
            "/api/v1/communication/emergencies/active", headers=as_user(user)
        )
        in_feed = post_id in {post["id"] for post in feed.json()}
        on_banner = post_id in {alert["id"] for alert in banner.json()}
        readable = await communication.can_read_post(current, post_id)
        assert in_feed == on_banner == readable == (user.id in recipients), name
        if in_feed:
            seen.add(name)

    assert seen == set(reached.split())
    # The accountant sees by the role what reaches at least the apartments, never a recipient.
    accountant = await properties.get_current_user(mixed.accountant.id)
    assert accountant is not None
    assert await communication.can_read_post(accountant, post_id) == (
        target["target_scope"] in ("ALL_BUILDING", "ALL_OBJECTS")
        or "APARTMENT" in target.get("target_kinds", [])
    )
    assert mixed.accountant.id not in recipients


@pytest.mark.parametrize(("target", "reached"), TABLE, ids=[label(t) for t, _ in TABLE])
async def test_who_is_offered_a_poll_and_for_which_objects(
    api_client: AsyncClient, mixed: MixedBuilding, target: dict, reached: str
) -> None:
    from tests.governance.test_api import deadline, draft

    created = await api_client.post(
        POLLS,
        json=draft(closes_at=deadline(), **body(mixed, target)),
        headers=as_user(mixed.chairman),
    )
    assert created.status_code == 201, created.text
    opened = await api_client.post(
        f"{POLLS}/{created.json()['id']}/open", headers=as_user(mixed.chairman)
    )
    assert opened.status_code == 200, opened.text
    objects_of = {
        "A": {mixed.apt_14.id, mixed.p_1.id},
        "B": {mixed.g_12.id},
        "C": {mixed.p_2.id},
        "D": {mixed.apt_1.id},
        "E": {mixed.apt_1.id},
        "X": {mixed.apt_1.id, mixed.p_2.id},
    }
    in_target = {
        "ALL_BUILDING": {mixed.apt_1.id, mixed.apt_14.id},
        "ENTRANCE": {mixed.apt_1.id} if target.get("target_entrance") == 1 else {mixed.apt_14.id},
        "APARTMENT_LIST": {getattr(mixed, n).id for n in target.get("objects", [])},
        "KINDS": {
            o.id
            for o in (mixed.apt_1, mixed.apt_14, mixed.p_1, mixed.p_2, mixed.g_12, mixed.g_1)
            if o.kind.value in target.get("target_kinds", [])
        },
    }.get(target["target_scope"])

    seen = set()
    for name in PEOPLE:
        response = await api_client.get(
            f"{POLLS}/{created.json()['id']}", headers=as_user(mixed.people[name])
        )
        if response.status_code == 200:
            seen.add(name)
            # The electorate holds only the objects of the target (section 3.3).
            expected = objects_of[name] if in_target is None else objects_of[name] & in_target
            assert {str(o) for o in expected} == set(response.json()["answerable_apartment_ids"])
        else:
            assert response.status_code == 404, response.text

    assert seen == set(reached.split())
    hidden = await api_client.get(
        f"{POLLS}/{created.json()['id']}", headers=as_user(mixed.accountant)
    )
    assert hidden.status_code == 404, "a poll only through a membership"


async def test_a_person_with_several_objects_is_notified_once_per_channel(
    api_client: AsyncClient, mixed: MixedBuilding
) -> None:
    for post in (
        {"post_type": "OFFICIAL_NOTICE", "title": "Yard", "body": "Closed on Saturday."}
        | {"target_scope": "ALL_OBJECTS"},
        {"post_type": "EMERGENCY", "category": "GENERAL", "title": "Gate", "body": "Stuck."}
        | {"target_scope": "KINDS", "target_kinds": ["PARKING", "GARAGE"]},
    ):
        published = await api_client.post(POSTS, json=post, headers=as_user(mixed.chairman))
        assert published.status_code == 201, published.text

    for user in (mixed.a, mixed.board_member):
        feed = await api_client.get("/api/v1/notifications/feed", headers=as_user(user))
        types = sorted(item["event_type"] for item in feed.json())
        assert types == ["EMERGENCY_PUBLISHED", "NOTICE_PUBLISHED"], user.full_name


async def test_a_target_by_a_kind_the_building_lacks_is_refused(
    api_client: AsyncClient, db_session: AsyncSession, mixed: MixedBuilding
) -> None:
    from tests.factories import create_apartment, create_building, create_user

    plain = await create_building(db_session, name="KÜ Korterid 1")
    await create_apartment(db_session, plain, "1")
    chairman = await create_user(
        db_session, plain, "Plain Chair", role=mixed.chairman.building_role
    )

    response = await api_client.post(
        POSTS,
        json={
            "post_type": "OFFICIAL_NOTICE",
            "title": "Garages",
            "body": "None here.",
            "target_scope": "KINDS",
            "target_kinds": ["GARAGE", "APARTMENT", "GARAGE"],
        },
        headers=as_user(chairman),
    )

    assert response.status_code == 422, response.text
    assert response.json()["error_code"] == "INVALID_TARGET"
    assert response.json()["unknown_kinds"] == ["GARAGE"]


# --- Who may publish which target (section 3.2) -------------------------------------------------


@pytest.mark.parametrize(
    ("author", "target", "status"),
    [
        ("A", {}, 201),  # an apartment: the whole building
        ("B", {}, 403),  # a garage only
        ("C", {}, 403),  # a tenant of a parking space only
        ("A", {"target_scope": "ALL_OBJECTS"}, 403),  # everything is for the board
        ("board member", {"target_scope": "ALL_OBJECTS"}, 422),  # forum: whole building (K3)
        # Kinds the author does not hold: 403 before the target is checked at all.
        ("A", {"target_scope": "KINDS", "target_kinds": ["GARAGE"]}, 403),
        ("B", {"target_scope": "KINDS", "target_kinds": ["CELLAR"]}, 422),  # not a kind
        ("B", {"target_scope": "KINDS", "target_kinds": ["GARAGE"]}, 422),  # forum: K3
    ],
)
async def test_who_may_address_a_forum_topic(
    api_client: AsyncClient, mixed: MixedBuilding, author: str, target: dict, status: int
) -> None:
    response = await api_client.post(
        POSTS,
        json={"post_type": "FORUM_TOPIC", "title": "Hello", "body": "Hi", **target},
        headers=as_user(mixed.people[author]),
    )

    assert response.status_code == status, response.text


async def test_no_in_app_row_reaches_a_person_outside_a_whole_building_target(
    api_client: AsyncClient, mixed: MixedBuilding
) -> None:
    from tests.governance.test_api import deadline, draft

    alert = await api_client.post(
        POSTS,
        json={"post_type": "EMERGENCY", "category": "GENERAL", "title": "Fire", "body": "Out!"},
        headers=as_user(mixed.chairman),
    )
    assert alert.status_code == 201, alert.text
    poll = await api_client.post(
        POLLS, json=draft(closes_at=deadline()), headers=as_user(mixed.chairman)
    )
    opened = await api_client.post(
        f"{POLLS}/{poll.json()['id']}/open", headers=as_user(mixed.chairman)
    )
    assert opened.status_code == 200, opened.text

    def types(feed) -> set[str]:
        return {item["event_type"] for item in feed.json()}

    for name in ("B", "C"):
        feed = await api_client.get(
            "/api/v1/notifications/feed", headers=as_user(mixed.people[name])
        )
        assert types(feed) == set(), name
    feed = await api_client.get("/api/v1/notifications/feed", headers=as_user(mixed.x))
    assert types(feed) == {"EMERGENCY_PUBLISHED", "POLL_OPENED"}
