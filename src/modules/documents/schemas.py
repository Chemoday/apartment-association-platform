"""Requests and responses of the documents module (docs/API.md section 13)."""

import uuid
from datetime import date, datetime
from enum import StrEnum

from pydantic import BaseModel, model_validator

from src.core.validation import safe_text
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


Title = safe_text(TITLE_MAX)


class DocumentEdit(BaseModel):
    """Only the fields that are sent change; `document_date: null` clears the date."""

    title: Title | None = None  # type: ignore[valid-type]
    category: DocumentCategory | None = None
    audience: DocumentAudience | None = None
    document_date: date | None = None

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
