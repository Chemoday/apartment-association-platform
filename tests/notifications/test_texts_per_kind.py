"""Texts that name an object have a sentence per kind (epic E14, section 2.4): a notification or
an e-mail says "garage 12" in the recipient's language, never "apartment G12". Russian and
Estonian put the object in a case and agree the verb with it, so each sentence has variants."""

import uuid
from datetime import UTC, datetime

import pytest

from src.core.events_registry import get_event_registry
from src.modules.auth.events import JoinRequestSubmitted
from src.modules.auth.mail import auth_catalog, invitation_target
from src.modules.notifications.messages import compose, default_catalog
from src.modules.notifications.schemas import NotificationEventType
from src.modules.property.schemas import ObjectKind, ObjectRef

SITE = "https://kyu.example.test"
TZ = "Europe/Tallinn"
E = NotificationEventType
OTHER_KINDS = (ObjectKind.PARKING.value, ObjectKind.GARAGE.value)
# How each language names the kind in these texts (any case of the word).
NAMES = {
    "en": {"APARTMENT": "partment", "PARKING": "parking space", "GARAGE": "garage"},
    "ru": {
        "APARTMENT": "\u043a\u0432\u0430\u0440\u0442\u0438\u0440",
        "PARKING": "\u043f\u0430\u0440\u043a\u043e\u0432\u043e\u0447\u043d",
        "GARAGE": "\u0433\u0430\u0440\u0430\u0436",
    },
    "et": {"APARTMENT": "korter", "PARKING": "parkimiskoh", "GARAGE": "garaaž"},
}


@pytest.mark.parametrize("catalog", [default_catalog(), auth_catalog()], ids=["notif", "auth"])
def test_every_sentence_with_a_variant_has_one_for_each_kind_in_every_language(catalog) -> None:
    bases = {key.rsplit(".", 1)[0] for key in catalog.texts if key.endswith(OTHER_KINDS)}

    assert bases, "the catalogue has sentences per kind"
    for base in bases:
        assert base in catalog.texts, base
        for kind in OTHER_KINDS:
            cells = catalog.texts[f"{base}.{kind}"]
            assert all(cells[locale] for locale in ("en", "ru", "et")), (base, kind)


@pytest.mark.parametrize("locale", ["en", "ru", "et"])
@pytest.mark.parametrize("kind", ["APARTMENT", "PARKING", "GARAGE"])
@pytest.mark.parametrize(
    ("event_type", "params"),
    [
        (E.APARTMENT_MESSAGE, {"apartment_number": "12", "from_board": True}),
        (E.APARTMENT_MESSAGE, {"apartment_number": "12", "from_board": False}),
        (E.APARTMENT_MESSAGE_TO_BOARD, {"apartment_number": "12", "from_board": False}),
        (E.JOIN_REQUEST_SUBMITTED, {"apartment_number": "12"}),
    ],
)
def test_a_text_names_the_object_by_its_kind(event_type, params, kind: str, locale: str) -> None:
    message = compose(
        event_type, locale, {**params, "apartment_kind": kind}, site_url=SITE, timezone=TZ
    )

    words = f"{message.subject} {message.text}".lower()
    assert NAMES[locale][kind] in words, (event_type, kind, locale)
    for other, name in NAMES[locale].items():
        if other != kind:
            assert name not in words, (event_type, kind, locale, other)


@pytest.mark.parametrize("locale", ["en", "ru", "et"])
def test_params_stored_before_the_kinds_mean_an_apartment(locale: str) -> None:
    params = {"apartment_number": "14", "from_board": False}

    old = compose(E.APARTMENT_MESSAGE_TO_BOARD, locale, params, site_url=SITE, timezone=TZ)
    new = compose(
        E.APARTMENT_MESSAGE_TO_BOARD,
        locale,
        {**params, "apartment_kind": "APARTMENT"},
        site_url=SITE,
        timezone=TZ,
    )

    assert old == new
    assert "14" in old.subject


def test_a_join_request_event_stored_before_the_kinds_is_an_apartment() -> None:
    registry = get_event_registry()
    stored = {
        "building_id": "00000000-0000-0000-0000-000000000001",
        "request_id": "00000000-0000-0000-0000-000000000002",
        "apartment_id": "00000000-0000-0000-0000-000000000003",
        "apartment_number": "14",
    }

    event = registry.decode(
        "JoinRequestSubmitted", stored, event_id=uuid.uuid4(), occurred_at=datetime.now(UTC)
    )

    assert isinstance(event, JoinRequestSubmitted)
    assert event.apartment_kind is ObjectKind.APARTMENT


@pytest.mark.parametrize(
    ("locale", "kind", "expected"),
    [
        ("en", ObjectKind.APARTMENT, "as the owner of apartment 14"),
        ("en", ObjectKind.GARAGE, "as the owner of garage 14"),
        (
            "ru",
            ObjectKind.PARKING,
            # "as the owner of parking space 14" (escaped: Cyrillic lives in the catalogues)
            "\u043a\u0430\u043a "
            "\u0432\u043b\u0430\u0434\u0435\u043b\u044c\u0446\u0430 "
            "\u043f\u0430\u0440\u043a\u043e\u0432\u043e\u0447\u043d\u043e\u0433\u043e "
            "\u043c\u0435\u0441\u0442\u0430 "
            "14",
        ),
        ("et", ObjectKind.GARAGE, "garaaži 14 omanikuks"),
    ],
)
def test_the_invitation_mail_names_the_object_by_its_kind(
    locale: str, kind: ObjectKind, expected: str
) -> None:
    assert invitation_target(locale, "OWNER", ObjectRef(kind, "14"), None) == expected


@pytest.mark.parametrize("locale", ["en", "ru", "et"])
@pytest.mark.parametrize(
    ("params", "english"),
    [
        ({"target_scope": "ALL_OBJECTS"}, "everything: apartments, parking spaces and garages"),
        ({"target_scope": "KINDS", "target_kinds": ["GARAGE"]}, "garages"),
        (
            {"target_scope": "KINDS", "target_kinds": ["PARKING", "GARAGE"]},
            "parking spaces and garages",
        ),
        (
            {"target_scope": "KINDS", "target_kinds": ["APARTMENT", "PARKING", "GARAGE"]},
            "apartments, parking spaces and garages",
        ),
    ],
)
def test_an_emergency_names_a_target_by_kind(params: dict, english: str, locale: str) -> None:
    message = compose(
        E.EMERGENCY_PUBLISHED,
        locale,
        {"category": "GENERAL", "target_entrance": None, **params},
        site_url=SITE,
        timezone=TZ,
        title="Gate",
        body="Stuck.",
    )

    if locale == "en":
        assert message.text.endswith(f"Affected: {english}")
    for kind in params.get("target_kinds", []):
        assert NAMES[locale][kind] in message.text.lower(), (kind, locale)


def test_an_emergency_stored_before_the_kinds_still_decodes() -> None:
    from src.modules.communication.events import EmergencyAlertPublished

    stored = {
        "post_id": str(uuid.uuid4()),
        "building_id": str(uuid.uuid4()),
        "category": "WATER_SHUTOFF",
        "target_scope": "ENTRANCE",
        "target_entrance": 2,
        "target_apartment_ids": [],
        "published_by_user_id": str(uuid.uuid4()),
    }

    event = get_event_registry().decode(
        "EmergencyAlertPublished", stored, event_id=uuid.uuid4(), occurred_at=datetime.now(UTC)
    )

    assert isinstance(event, EmergencyAlertPublished) and event.target_kinds == ()


@pytest.mark.parametrize("params", [{}, {"target_kinds": []}])
def test_kinds_missing_from_params_never_break_an_emergency(params: dict) -> None:
    message = compose(
        E.EMERGENCY_PUBLISHED,
        "en",
        {"category": "GENERAL", "target_scope": "KINDS", "target_entrance": None, **params},
        site_url=SITE,
        timezone=TZ,
        title="Gate",
        body="Stuck.",
    )

    assert message.text.endswith("Affected: objects of some kinds")
