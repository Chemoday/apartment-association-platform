"""Public enums and DTOs of the maintenance calendar (docs/API.md section 11, epic E10)."""

import re
import uuid
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Annotated

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
)

from src.core.validation import optional_safe_text, safe_text
from src.modules.communication.schemas import PostCategory, TargetApartmentIds
from src.modules.communication.schemas import TitleText as NoticeTitleText
from src.modules.property.schemas import AuthorBadgeDTO, TargetScope

TITLE_MAX_LENGTH = 120
INSTRUCTIONS_MAX_LENGTH = 4000
NOTE_MAX_LENGTH = 1000
TASKS_PAGE_MAX = 100

TitleText = safe_text(TITLE_MAX_LENGTH)
InstructionsText = optional_safe_text(INSTRUCTIONS_MAX_LENGTH)
NoteText = optional_safe_text(NOTE_MAX_LENGTH)
# Shorter than a post body (10000): the calendar appends the planned date to the notice.
NOTICE_BODY_MAX_LENGTH = 9500
NoticeBodyText = safe_text(NOTICE_BODY_MAX_LENGTH)
RequiredNoteText = safe_text(NOTE_MAX_LENGTH)

_COST = re.compile(r"[0-9]{1,10}(\.[0-9]{1,2})?")


def _cost(value: str | None) -> Decimal | None:
    """An exact amount in euros: a decimal string with up to 2 decimals, never a float."""
    if value is None:
        return None
    if not _COST.fullmatch(value):
        raise ValueError("a cost is a decimal string such as 145 or 145.50")
    return Decimal(value).quantize(Decimal("0.01"))


CostInput = Annotated[StrictStr | None, AfterValidator(_cost)]


class PeriodUnit(StrEnum):
    DAY = "DAY"
    MONTH = "MONTH"
    YEAR = "YEAR"


class TaskStatus(StrEnum):
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    ARCHIVED = "ARCHIVED"


class OccurrenceStatus(StrEnum):
    OPEN = "OPEN"
    DONE = "DONE"
    SKIPPED = "SKIPPED"
    CANCELLED = "CANCELLED"


class OccurrenceState(StrEnum):
    """The shown state of the open occurrence (computed, never stored)."""

    UPCOMING = "UPCOMING"
    DUE = "DUE"
    OVERDUE = "OVERDUE"
    PAUSED = "PAUSED"


class LogKind(StrEnum):
    DONE = "DONE"
    SKIPPED = "SKIPPED"


# --- Requests ------------------------------------------------------------------------------------


class NoticeDraft(BaseModel):
    """The official notice for residents a task publishes with each occurrence (task M2)."""

    model_config = ConfigDict(extra="forbid")

    title: NoticeTitleText
    body: NoticeBodyText
    category: PostCategory = PostCategory.MAINTENANCE
    target_scope: TargetScope = TargetScope.ALL_BUILDING
    target_entrance: StrictInt | None = Field(default=None, ge=1, le=1000)
    target_apartment_ids: TargetApartmentIds = None
    comments_enabled: StrictBool = False


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: TitleText
    instructions: InstructionsText = None
    period_unit: PeriodUnit
    period_count: StrictInt = Field(ge=1, le=3650)
    lead_days: StrictInt = Field(default=0, ge=0, le=90)
    first_due_date: date
    notice: NoticeDraft | None = None


class TaskEdit(BaseModel):
    """PATCH: only the fields given change; `notice: null` removes the notice."""

    model_config = ConfigDict(extra="forbid")

    title: TitleText | None = None
    instructions: InstructionsText = None
    period_unit: PeriodUnit | None = None
    period_count: StrictInt | None = Field(default=None, ge=1, le=3650)
    lead_days: StrictInt | None = Field(default=None, ge=0, le=90)
    notice: NoticeDraft | None = None
    next_due_date: date | None = None
    # The open occurrence the caller saw: moving the date of another one is refused (409).
    occurrence_id: uuid.UUID | None = None


class TaskResume(BaseModel):
    model_config = ConfigDict(extra="forbid")

    next_due_date: date | None = None
    occurrence_id: uuid.UUID | None = None


class DoneRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    occurrence_id: uuid.UUID
    done_on: date
    note: NoteText = None
    cost: CostInput = None


class SkipRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    occurrence_id: uuid.UUID
    note: RequiredNoteText


class LogEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    note: NoteText = None
    cost: CostInput = None


# --- Responses -----------------------------------------------------------------------------------


class NoticeView(BaseModel):
    title: str
    body: str
    category: PostCategory
    target_scope: TargetScope
    target_entrance: int | None
    target_apartment_ids: list[uuid.UUID] | None
    comments_enabled: bool


class CurrentOccurrence(BaseModel):
    occurrence_id: uuid.UUID
    due_date: date
    publish_on: date
    state: OccurrenceState
    # Publishing (task M2).
    published_at: datetime | None
    board_post_id: uuid.UUID | None
    notice_post_id: uuid.UUID | None
    notice_failed: bool
    reminder_count: int


class TaskView(BaseModel):
    id: uuid.UUID
    title: str
    instructions: str
    period_unit: PeriodUnit
    period_count: int
    lead_days: int
    anchor_date: date
    status: TaskStatus
    notice: NoticeView | None
    current: CurrentOccurrence | None
    last_closed_on: date | None
    created_at: datetime
    updated_at: datetime
    archived_at: datetime | None


class LogEntryView(BaseModel):
    """`cost` as a decimal string with 2 decimals; who recorded it by name (the board)."""

    id: uuid.UUID
    task_id: uuid.UUID
    task_title: str
    kind: LogKind
    planned_date: date
    closed_on: date
    note: str
    cost: str | None
    recorded_by: AuthorBadgeDTO
    recorded_at: datetime
    updated_at: datetime
    updated_by: AuthorBadgeDTO | None


class ClosedOccurrence(BaseModel):
    """Response of done / skip: the new log entry and the task with its next occurrence."""

    entry: LogEntryView
    task: TaskView
