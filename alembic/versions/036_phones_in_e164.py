"""Phone numbers in E.164 form (owner decision 2026-11-23, issue #179).

docs/SCHEMA.md sections 1 and 7: core_users.phone and auth_join_requests.phone hold a number
with its country code in E.164 form ("+37257654321"). A stored phone that is a valid number with
its country code is converted; any other value is dropped: core_users.phone becomes NULL, and a
join request (whose phone is required) is deleted with an EXPIRED decision, as the daily
clean-up of old requests leaves. No association used the platform before this migration, so only
demo data is dropped. One way: a downgrade keeps the E.164 numbers, which the
previous release accepts.

Revision ID: 036
Revises: 035
Create Date: 2026-11-23
"""

import re
import unicodedata
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

import phonenumbers
import sqlalchemy as sa
from alembic import op

revision: str = "036"
down_revision: str | None = "035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_PHONE_TEXT = re.compile(r"^\+[0-9\-() ]+$")
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _e164(value: str) -> str | None:
    # The rule of src.core.validation.plain_phone_text and canonical_phone (copied: migrations
    # never change; tests/auth/test_migration_036.py checks that both rules agree).
    if _CONTROL_CHARACTERS.search(value) or len(value.strip()) > 4 * 32:
        return None
    text = "".join(
        {"Zs": " ", "Pd": "-"}.get(unicodedata.category(c), c)
        for c in unicodedata.normalize("NFKC", value.strip())
        if unicodedata.category(c) != "Cf"
    ).strip()
    if len(text) > 32 or not _PHONE_TEXT.fullmatch(text):
        return None
    try:
        number = phonenumbers.parse(text, None)
    except phonenumbers.NumberParseException:
        return None
    if not phonenumbers.is_valid_number(number):
        return None
    return phonenumbers.format_number(number, phonenumbers.PhoneNumberFormat.E164)


def _rows(table: str) -> list[tuple[object, str]]:
    return (
        op.get_bind()
        .execute(sa.text(f"SELECT id, phone FROM {table} WHERE phone IS NOT NULL"))
        .all()
    )


def _drop_request(row_id: object) -> None:
    connection = op.get_bind()
    connection.execute(
        sa.text(
            "INSERT INTO auth_join_decisions (id, building_id, apartment_id, outcome, decided_at) "
            "SELECT :decision, building_id, apartment_id, 'EXPIRED', :now "
            "FROM auth_join_requests WHERE id = :id"
        ),
        {"decision": uuid.uuid4(), "now": datetime.now(UTC), "id": row_id},
    )
    connection.execute(sa.text("DELETE FROM auth_join_requests WHERE id = :id"), {"id": row_id})


def upgrade() -> None:
    connection = op.get_bind()
    for row_id, phone in _rows("core_users"):
        canonical = _e164(phone)
        if canonical != phone:
            connection.execute(
                sa.text("UPDATE core_users SET phone = :phone WHERE id = :id"),
                {"phone": canonical, "id": row_id},
            )
    for row_id, phone in _rows("auth_join_requests"):
        canonical = _e164(phone)
        if canonical is None:
            _drop_request(row_id)
        elif canonical != phone:
            connection.execute(
                sa.text("UPDATE auth_join_requests SET phone = :phone WHERE id = :id"),
                {"phone": canonical, "id": row_id},
            )


def downgrade() -> None:
    pass
