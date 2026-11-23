"""Reusable validators for free-text input (reasons, post titles and bodies, comments).

PostgreSQL rejects NUL bytes in text columns, so an unchecked "\\u0000" in any field becomes a
500 — on exactly the endpoints the user-impact alerts watch. Free text must use these types.
"""

import re
import unicodedata
from typing import Annotated

import phonenumbers
from pydantic import AfterValidator, BeforeValidator, Field

# C0 control characters except tab, line feed and carriage return, plus DEL.
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def clean_text(value: str) -> str:
    if _CONTROL_CHARACTERS.search(value):
        raise ValueError("text must not contain control characters")
    return value.strip()


def clean_required_text(value: str) -> str:
    """Like clean_text, but blank input is rejected."""
    cleaned = clean_text(value)
    if not cleaned:
        raise ValueError("text must not be blank")
    return cleaned


SafeText = Annotated[str, AfterValidator(clean_text)]


# Length limits come AFTER the cleaning validator, so they apply to the trimmed text:
# "  " + 255 characters is a valid 255-character title.


def safe_text(max_length: int) -> object:
    """Type for a required free-text field (titles, bodies, comments): cleaned, never blank,
    at most max_length characters after trimming."""
    return Annotated[str, AfterValidator(clean_required_text), Field(max_length=max_length)]


def _blank_to_none(value: str | None) -> str | None:
    return value or None


def optional_safe_text(max_length: int) -> object:
    """Type for an optional free-text field: cleaned, length-checked after trimming,
    blank -> None."""
    return Annotated[
        Annotated[str, AfterValidator(clean_text), Field(max_length=max_length)] | None,
        AfterValidator(_blank_to_none),
    ]


def canonical_email(value: str) -> str:
    """The form e-mail addresses are stored and matched in: trimmed, NFKC, lower case
    (docs/SCHEMA.md 1), so the unique index of core_users.email ignores case."""
    return unicodedata.normalize("NFKC", value).strip().lower()


# Phone numbers (docs/API.md section 0, "Phone numbers"): typed with "+" and the country code,
# digits, spaces, "-" and parentheses; stored and returned in E.164 form. The server never
# guesses a country, so a number without "+" is refused.
PHONE_MAX_LENGTH = 32
PHONE_PATTERN = r"^\+[0-9\-() ]+$"


def canonical_phone(value: str) -> str:
    """The E.164 form of a phone number typed with its country code ("+372 5765 4321" ->
    "+37257654321"); ValueError for a number that cannot exist."""
    try:
        number = phonenumbers.parse(value, None)
    except phonenumbers.NumberParseException:
        raise ValueError("not a phone number with a country code") from None
    if not phonenumbers.is_valid_number(number):
        raise ValueError("not a valid phone number")
    return phonenumbers.format_number(number, phonenumbers.PhoneNumberFormat.E164)


_PLAIN = {"Zs": " ", "Pd": "-"}


def plain_phone_text(value: str) -> str:
    """A phone as pasted from a contact list, in plain characters: NFKC (full-width digits and
    "+"), every Unicode space as a space, every dash as "-", and no invisible format characters
    (direction marks). Text longer than 4 times the limit is refused before the work."""
    if len(value) > 4 * PHONE_MAX_LENGTH:
        raise ValueError("a phone number is too long")
    return "".join(
        _PLAIN.get(unicodedata.category(c), c)
        for c in unicodedata.normalize("NFKC", value)
        if unicodedata.category(c) != "Cf"
    ).strip()


_PhoneText = Annotated[
    str,
    AfterValidator(clean_text),
    AfterValidator(plain_phone_text),
    # A pattern after a validator is checked but left out of the JSON schema: put it there.
    Field(
        max_length=PHONE_MAX_LENGTH,
        pattern=PHONE_PATTERN,
        json_schema_extra={"pattern": PHONE_PATTERN},
    ),
]

# A required phone number, stored in E.164 form.
PhoneNumber = Annotated[_PhoneText, AfterValidator(canonical_phone)]


def _blank_to_no_phone(value: object) -> object:
    return None if isinstance(value, str) and not value.strip() else value


def _optional_phone(value: str | None) -> str | None:
    return None if value is None else canonical_phone(value)


# An optional phone number: null or a blank text is no phone.
OptionalPhoneNumber = Annotated[
    _PhoneText | None, BeforeValidator(_blank_to_no_phone), AfterValidator(_optional_phone)
]
