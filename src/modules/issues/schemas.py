"""Public enums and DTOs of the issue tracker (docs/API.md section 10, epic E9)."""

import uuid
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, model_validator

from src.core.validation import optional_safe_text, safe_text
from src.modules.property.schemas import AuthorBadgeDTO

TITLE_MAX_LENGTH = 120
PLACE_MAX_LENGTH = 200
DESCRIPTION_MAX_LENGTH = 2000
ISSUES_PAGE_MAX = 100

TitleText = safe_text(TITLE_MAX_LENGTH)
PlaceText = safe_text(PLACE_MAX_LENGTH)
DescriptionText = optional_safe_text(DESCRIPTION_MAX_LENGTH)


class IssueCategory(StrEnum):
    LIGHTING = "LIGHTING"
    DOORS_AND_LOCKS = "DOORS_AND_LOCKS"
    LIFT = "LIFT"
    HEATING = "HEATING"
    WATER_AND_SEWAGE = "WATER_AND_SEWAGE"
    ELECTRICITY = "ELECTRICITY"
    CLEANING = "CLEANING"
    WASTE = "WASTE"
    YARD = "YARD"
    ROOF_AND_FACADE = "ROOF_AND_FACADE"
    OTHER = "OTHER"


class IssueStatus(StrEnum):
    REPORTED = "REPORTED"
    IN_PROGRESS = "IN_PROGRESS"
    WAITING_FOR_CONTRACTOR = "WAITING_FOR_CONTRACTOR"
    RESOLVED = "RESOLVED"
    DUPLICATE = "DUPLICATE"
    DECLINED = "DECLINED"
    WITHDRAWN = "WITHDRAWN"


class BoardStatus(StrEnum):
    """The statuses the board sets (REPORTED and WITHDRAWN belong to the reporter)."""

    IN_PROGRESS = "IN_PROGRESS"
    WAITING_FOR_CONTRACTOR = "WAITING_FOR_CONTRACTOR"
    RESOLVED = "RESOLVED"
    DUPLICATE = "DUPLICATE"
    DECLINED = "DECLINED"


class IssueAction(StrEnum):
    """What an entry of the action log records."""

    STATUS = "STATUS"
    URGENT_CLEARED = "URGENT_CLEARED"


class StatusFilter(StrEnum):
    """`status` of GET /issues: a group or one status."""

    OPEN = "OPEN"
    ENDED = "ENDED"
    REPORTED = "REPORTED"
    IN_PROGRESS = "IN_PROGRESS"
    WAITING_FOR_CONTRACTOR = "WAITING_FOR_CONTRACTOR"
    RESOLVED = "RESOLVED"
    DUPLICATE = "DUPLICATE"
    DECLINED = "DECLINED"
    WITHDRAWN = "WITHDRAWN"


# --- Requests ------------------------------------------------------------------------------------


class IssueReport(BaseModel):
    """Body of POST /issues."""

    model_config = ConfigDict(extra="forbid")

    category: IssueCategory
    entrance: StrictInt | None = Field(default=None, ge=1, le=1000)
    place: PlaceText
    title: TitleText
    description: DescriptionText = None
    urgent: StrictBool = False
    apartment_id: uuid.UUID | None = None


class IssueEdit(BaseModel):
    """Body of PATCH /issues/{id}: only the fields given change (`entrance` may become null)."""

    model_config = ConfigDict(extra="forbid")

    category: IssueCategory | None = None
    entrance: StrictInt | None = Field(default=None, ge=1, le=1000)
    place: PlaceText | None = None
    title: TitleText | None = None
    description: DescriptionText = None


class StatusChange(BaseModel):
    """Body of POST /issues/{id}/status (the board)."""

    model_config = ConfigDict(extra="forbid")

    status: BoardStatus
    duplicate_of: uuid.UUID | None = None

    @model_validator(mode="after")
    def _original_only_for_duplicates(self) -> "StatusChange":
        if (self.status == BoardStatus.DUPLICATE) != (self.duplicate_of is not None):
            raise ValueError("duplicate_of is given exactly when the status is DUPLICATE")
        return self


# --- Responses -----------------------------------------------------------------------------------


class IssueForm(BaseModel):
    urgent_enabled: bool
    apartment_ids: list[uuid.UUID]
    entrances: list[int]


class TimelineEntry(BaseModel):
    """`action` and `changed_by` are the board's action log; others get STATUS and null."""

    status: IssueStatus
    at: datetime
    action: IssueAction = IssueAction.STATUS
    changed_by: AuthorBadgeDTO | None = None


class ReporterView(BaseModel):
    """For the chairman and the board only: the privacy badge, never a raw name."""

    badge: AuthorBadgeDTO
    apartment_id: uuid.UUID | None


class IssueSummary(BaseModel):
    id: uuid.UUID
    category: IssueCategory
    entrance: int | None
    place: str
    title: str
    status: IssueStatus
    urgent: bool
    duplicate_of: uuid.UUID | None
    followers: int
    i_reported: bool
    i_follow: bool
    can_edit: bool
    can_follow: bool
    created_at: datetime
    updated_at: datetime
    ended_at: datetime | None
    reporter: ReporterView | None


class IssueView(IssueSummary):
    description: str
    timeline: list[TimelineEntry]
