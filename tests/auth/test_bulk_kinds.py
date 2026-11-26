"""Bulk invitations name an object by kind and number (epic E14, task K4): an optional fourth
cell for the kind, a missing kind is an apartment, one number under two kinds is two objects;
and the invitation mail names the kind."""

from datetime import UTC, datetime

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.core.messages import placeholders
from src.core.security import create_access_token
from src.modules.auth.bulk import parse_bulk_list
from src.modules.auth.invitations import InvitationService
from src.modules.auth.mail import auth_catalog, invitation_target
from src.modules.auth.schemas import BulkRowOutcome
from src.modules.notifications.messages import default_catalog
from src.modules.property.schemas import ObjectKind, ObjectRef
from tests.factories import MixedBuilding, create_mixed_building

OFFERED = frozenset({"et", "en"})
API = "/api/v1/auth/invitations/bulk"


@pytest.mark.parametrize(
    ("line", "kind", "outcome"),
    [
        ("1;a@example.org", ObjectKind.APARTMENT, None),
        ("1;a@example.org;;", ObjectKind.APARTMENT, None),
        ("1;a@example.org;;PARKING", ObjectKind.PARKING, None),
        ("1;a@example.org;en; garage ", ObjectKind.GARAGE, None),
        ("1;a@example.org;;apartment", ObjectKind.APARTMENT, None),
        ("1;a@example.org;;CELLAR", None, BulkRowOutcome.INVALID_KIND),
        # A kind in the third cell is a language that is not offered.
        ("1;a@example.org;PARKING", ObjectKind.APARTMENT, BulkRowOutcome.INVALID_LOCALE),
        ("1;a@example.org;en;PARKING;x", None, BulkRowOutcome.INVALID_ROW),
        # Every outcome names the kind of the row, so a garage row is never shown as Apt. 12.
        ("12;not-an-address;;GARAGE", ObjectKind.GARAGE, BulkRowOutcome.INVALID_EMAIL),
        ("12;a@example.org;ru;GARAGE", ObjectKind.GARAGE, BulkRowOutcome.INVALID_LOCALE),
        ("12;;;GARAGE", ObjectKind.GARAGE, BulkRowOutcome.INVALID_ROW),
    ],
)
def test_the_fourth_cell_is_the_kind(
    line: str, kind: ObjectKind | None, outcome: BulkRowOutcome | None
) -> None:
    (row,) = parse_bulk_list(line, max_rows=5, offered_locales=OFFERED)

    assert (row.outcome, row.apartment_kind) == (outcome, kind)


@pytest.fixture
async def mixed(db_session: AsyncSession) -> MixedBuilding:
    return await create_mixed_building(db_session)


async def test_one_number_under_two_kinds_is_two_objects(
    api_client: AsyncClient, mixed: MixedBuilding
) -> None:
    text = "\n".join(
        [
            "1;owner.of.apt.1@example.org",
            "1;owner.of.apt.1@example.org;;PARKING",
            "1;owner.of.apt.1@example.org;;GARAGE",
            "12;owner.of.g12@example.org;;GARAGE",
            "12;nobody@example.org",
            "P-2;owner.of.p2@example.org;;parking",
            "1;wrong@example.org;;CELLAR",
        ]
    )
    token = create_access_token(mixed.chairman.id, get_settings())

    response = await api_client.post(
        f"{API}/preview", json={"text": text}, headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 200, response.text
    report = response.json()
    assert [(r["apartment_number"], r["apartment_kind"], r["outcome"]) for r in report["rows"]] == [
        ("1", "APARTMENT", "READY"),
        ("1", "PARKING", "READY"),
        ("1", "GARAGE", "READY"),
        ("12", "GARAGE", "READY"),
        ("12", "APARTMENT", "APARTMENT_NOT_FOUND"),
        ("P-2", "PARKING", "READY"),
        ("1", None, "INVALID_KIND"),
    ]
    # Twice the objects of every kind: 2 apartments, 2 parking spaces and 3 garages.
    assert report["limit_remaining"] == 14


async def test_the_send_invites_the_owner_of_a_parking_space_and_the_mail_names_it(
    api_client: AsyncClient, db_session: AsyncSession, mixed: MixedBuilding
) -> None:
    token = create_access_token(mixed.chairman.id, get_settings())

    response = await api_client.post(
        API,
        json={"text": "1;space.owner@example.org;en;PARKING\n"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200, response.text
    (row,) = response.json()["rows"]
    assert (row["apartment_kind"], row["outcome"]) == ("PARKING", "INVITED")
    claimed, _ = await InvitationService(db_session, get_settings()).claim_due(
        datetime.now(UTC), 1000
    )
    (mail,) = [q.mail for q in claimed if q.mail.email == "space.owner@example.org"]
    assert mail.values["target"] == "as the owner of parking space 1"


@pytest.mark.parametrize("catalog", [default_catalog(), auth_catalog()], ids=["notif", "auth"])
def test_a_variant_per_kind_takes_the_placeholders_of_its_sentence(catalog) -> None:
    for key, cells in catalog.texts.items():
        base, _, kind = key.rpartition(".")
        if kind in ("PARKING", "GARAGE"):
            assert placeholders(cells["en"]) == placeholders(catalog.texts[base]["en"]), key


@pytest.mark.parametrize("kind", ["PARKING", "GARAGE"])
@pytest.mark.parametrize("relation", ["OWNER", "TENANT"])
@pytest.mark.parametrize("locale", ["en", "ru", "et"])
def test_every_invitation_target_renders_for_every_kind(kind, relation, locale) -> None:
    text = invitation_target(locale, relation, ObjectRef(ObjectKind(kind), "7"), None)

    assert "7" in text and text != invitation_target(
        locale, relation, ObjectRef(ObjectKind.APARTMENT, "7"), None
    )
