"""Free-text types reject control characters (a NUL byte would be a 500 from PostgreSQL)."""

import pytest
from pydantic import BaseModel, ValidationError

from src.core.validation import OptionalPhoneNumber, PhoneNumber, optional_safe_text, safe_text


class Form(BaseModel):
    title: safe_text(10)  # type: ignore[valid-type]
    note: optional_safe_text(10) = None  # type: ignore[valid-type]


def test_required_text_is_trimmed() -> None:
    assert Form(title="  Hello \n").title == "Hello"


@pytest.mark.parametrize("title", ["", "   ", "\t\n", "a\u0000b", "bell\x07", "x" * 11])
def test_required_text_rejects_blank_control_characters_and_overlong(title: str) -> None:
    with pytest.raises(ValidationError):
        Form(title=title)


def test_required_text_keeps_tabs_and_line_breaks_inside() -> None:
    assert Form(title="a\tb\r\nc").title == "a\tb\r\nc"


def test_optional_text_turns_blank_into_none() -> None:
    assert Form(title="t", note="   ").note is None
    with pytest.raises(ValidationError):
        Form(title="t", note="\u0000")


def test_length_limits_apply_after_trimming() -> None:
    assert Form(title="  " + "x" * 10 + "\n").title == "x" * 10
    assert Form(title="t", note=" " + "y" * 10 + " ").note == "y" * 10
    with pytest.raises(ValidationError):
        Form(title="t", note="y" * 11)


# --- Phone numbers (docs/API.md section 0) ----------------------------------------------------


class Contact(BaseModel):
    phone: PhoneNumber
    other: OptionalPhoneNumber = None


@pytest.mark.parametrize(
    ("typed", "stored"),
    [
        ("+372 5765 4321", "+37257654321"),
        ("  +372 (5765) 43-21 ", "+37257654321"),
        ("+37257654321", "+37257654321"),
        ("+372 600 0000", "+3726000000"),  # a landline
        ("+44 20 7946 0958", "+442079460958"),
        ("+1 (202) 555-0143", "+12025550143"),
        # Pasted from a contact list: Unicode spaces, direction marks, full-width characters.
        ("+372\u00a05765\u00a04321", "+37257654321"),
        ("\u202a+372 5765 4321\u202c", "+37257654321"),
        ("+372\u200b5765 4321", "+37257654321"),
        ("+372\u20115765\u20134321", "+37257654321"),  # a non-breaking hyphen and an en dash
        ("\uff0b\uff13\uff17\uff12 \uff15\uff17\uff16\uff15 4321", "+37257654321"),
    ],
)
def test_a_phone_with_its_country_code_is_stored_in_e164_form(typed: str, stored: str) -> None:
    assert Contact(phone=typed).phone == stored


@pytest.mark.parametrize(
    "typed",
    [
        "5765 4321",  # no country code: never guessed
        "00372 5765 4321",
        "+",
        "+372 1",
        "+372 1234",
        "+999 5555 1234",
        "+372 5765 4321 ext 7",
        "+372.5765.4321",
        "+372 5765 4321\u0000",
        "+372\n5765 4321",
        "+" + "5" * 32,
        "+372 5765 4321" + "\u200b" * 120,  # too long before the invisible marks are dropped
        "",
        "   ",
    ],
)
def test_a_phone_without_a_country_code_or_that_cannot_exist_is_refused(typed: str) -> None:
    with pytest.raises(ValidationError):
        Contact(phone=typed)


@pytest.mark.parametrize("typed", [None, "", "  "])
def test_an_optional_phone_turns_blank_into_none(typed: str | None) -> None:
    assert Contact(phone="+37257654321", other=typed).other is None


def test_an_optional_phone_is_checked_like_a_required_one() -> None:
    assert Contact(phone="+37257654321", other="+372 5555 1234").other == "+37255551234"
    with pytest.raises(ValidationError):
        Contact(phone="+37257654321", other="5555 1234")
