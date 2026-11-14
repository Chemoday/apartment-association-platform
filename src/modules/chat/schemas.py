"""DTOs of the building chat (docs/API.md section 14)."""

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from src.core.validation import safe_text
from src.modules.chat.policies import MAX_LENGTH
from src.modules.property.schemas import AuthorBadgeDTO

PAGE_DEFAULT = 100
PAGE_MAX = 200
CURSOR_MAX = 2**63 - 1  # the largest BIGINT; a larger `after` is a 422, not a 500

MessageText = safe_text(MAX_LENGTH)


class ChatMessageView(BaseModel):
    id: int
    body: str
    author_badge: AuthorBadgeDTO
    created_at: datetime
    expires_at: datetime
    is_own: bool


class ChatPage(BaseModel):
    messages: list[ChatMessageView]
    cursor: int | None = Field(description="Pass as `after` next time.")
    has_more: bool
    turned_on_at: datetime | None = Field(
        description="When the chat was last turned on; a change means it was off meanwhile: "
        "clear the messages on screen."
    )


class ChatState(BaseModel):
    enabled: bool
    turned_on_at: datetime | None
    can_take_part: bool
    recent_count: int
    recent_minutes: int
    last_message_at: datetime | None
    history_hours: int
    max_length: int


class ChatMessageCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    body: MessageText
    author_apartment_id: uuid.UUID | None = None
