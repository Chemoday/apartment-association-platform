"""Requests and responses of the documents module (docs/API.md section 13)."""

import unicodedata
import uuid
from datetime import date, datetime
from enum import StrEnum
from typing import Annotated

from pydantic import AfterValidator, BaseModel, BeforeValidator, Field, model_validator

from src.core.validation import clean_required_text
from src.modules.property.schemas import AuthorBadgeDTO

DOCUMENTS_PAGE_MAX = 100
TITLE_MAX = 200


class DocumentCategory(StrEnum):
    ARTICLES = "ARTICLES"
    GENERAL_MEETING_MINUTES = "GENERAL_MEETING_MINUTES"
    BOARD_MINUTES = "BOARD_MINUTES"
    CONTRACT = "CONTRACT"
    INVOICE = "INVOICE"
    FINANCIAL_REPORT = "FINANCIAL_REPORT"
    INSURANCE = "INSURANCE"
    HOUSE_RULES = "HOUSE_RULES"
    OTHER = "OTHER"


class DocumentAudience(StrEnum):
    EVERYONE = "EVERYONE"
    BOARD_AND_ACCOUNTANT = "BOARD_AND_ACCOUNTANT"
    BOARD = "BOARD"


def single_line(value: str) -> str:
    """A title is one line of visible text: it becomes a file name, so tabs and line breaks are
    refused too, and a title of only invisible characters would be an empty line in the list."""
    if any(ch in value for ch in "\t\r\n"):
        raise ValueError("title must be a single line")
    if not any(unicodedata.category(ch)[0] not in "CZ" for ch in value):
        raise ValueError("title must contain visible text")
    return value


DATE_MIN = date(1900, 1, 1)
DATE_MAX_YEARS_AHEAD = 5


def _blank_to_none(value: object) -> object:
    return None if value == "" else value  # a date field left empty in a form


def check_document_date(value: date | None) -> date | None:
    """The date of a document: from 1900 to five years from now (a contract may run ahead)."""
    if value is None:
        return None
    today = date.today()
    try:
        latest = today.replace(year=today.year + DATE_MAX_YEARS_AHEAD)
    except ValueError:  # 29 February: that year has none
        latest = today.replace(year=today.year + DATE_MAX_YEARS_AHEAD, day=28)
    if not DATE_MIN <= value <= latest:
        raise ValueError(f"document_date must be between {DATE_MIN} and {latest}")
    return value


DocumentDate = Annotated[
    date | None, BeforeValidator(_blank_to_none), AfterValidator(check_document_date)
]


Title = Annotated[
    str,
    AfterValidator(clean_required_text),
    AfterValidator(single_line),
    Field(max_length=TITLE_MAX),
]


class DocumentEdit(BaseModel):
    """Only the fields that are sent change; `document_date: null` clears the date."""

    title: Title | None = None  # type: ignore[valid-type]
    category: DocumentCategory | None = None
    audience: DocumentAudience | None = None
    document_date: DocumentDate = None

    @model_validator(mode="after")
    def _no_null_for_required_fields(self) -> "DocumentEdit":
        for field in ("title", "category", "audience"):
            if field in self.model_fields_set and getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class DocumentView(BaseModel):
    id: uuid.UUID
    title: str
    category: DocumentCategory
    audience: DocumentAudience
    document_date: date | None
    size_bytes: int
    created_at: datetime
    updated_at: datetime
    mine: bool
    can_edit: bool
    can_delete: bool
    uploaded_by: AuthorBadgeDTO | None  # staff only, a privacy badge without an apartment


class UploadOptions(BaseModel):
    """What the upload form may offer the caller (no form when `can_upload` is false)."""

    can_upload: bool
    audiences: list[DocumentAudience]
    categories: list[DocumentCategory]
    max_bytes: int
