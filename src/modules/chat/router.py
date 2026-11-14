"""Thin HTTP layer of the building chat (docs/API.md section 14)."""

from typing import Annotated

from fastapi import APIRouter, Depends, Query

from src.core.exceptions import AUTH_ERRORS, error_responses
from src.core.security import get_current_user
from src.modules.chat.schemas import (
    CURSOR_MAX,
    PAGE_DEFAULT,
    PAGE_MAX,
    ChatMessageCreate,
    ChatMessageView,
    ChatPage,
    ChatState,
)
from src.modules.chat.service import ChatService, get_chat_service
from src.modules.property.schemas import CurrentUserDTO

router = APIRouter(
    prefix="/api/v1/chat",
    tags=["chat"],
    responses=error_responses({401: AUTH_ERRORS, 500: ["INTERNAL_SERVER_ERROR"]}),
)

Service = Annotated[ChatService, Depends(get_chat_service)]
Caller = Annotated[CurrentUserDTO, Depends(get_current_user)]

_PARTICIPANTS = {403: ["FORBIDDEN"], 409: ["CHAT_DISABLED"]}


@router.get("", response_model=ChatState)
async def chat_state(user: Caller, service: Service) -> ChatState:
    """Whether the chat is on, whether the caller takes part, and its recent activity."""
    return await service.state(user)


@router.get(
    "/messages",
    response_model=ChatPage,
    responses=error_responses({**_PARTICIPANTS, 422: ["VALIDATION_ERROR"]}),
)
async def list_messages(
    user: Caller,
    service: Service,
    after: Annotated[int | None, Query(ge=0, le=CURSOR_MAX)] = None,
    limit: Annotated[int, Query(ge=1, le=PAGE_MAX)] = PAGE_DEFAULT,
) -> ChatPage:
    """Messages of the last 2 hours, oldest first; with `after`, only the newer ones."""
    return await service.messages(user, after, limit)


@router.post(
    "/messages",
    response_model=ChatMessageView,
    status_code=201,
    responses=error_responses(
        {
            **_PARTICIPANTS,
            422: ["VALIDATION_ERROR", "INVALID_AUTHOR_APARTMENT"],
            429: ["RATE_LIMITED"],
        }
    ),
)
async def post_message(body: ChatMessageCreate, user: Caller, service: Service) -> ChatMessageView:
    """Write a message to the building chat (at most 10 a minute and 60 an hour)."""
    return await service.post(user, body)
