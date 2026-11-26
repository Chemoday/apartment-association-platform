"""The building chat (docs/API.md section 14; docs/ARCHITECTURE.md section 12).

Who takes part comes from the caller (memberships, building role), badges from PropertyService,
the switch from the core building settings. No events, no notifications, and the text of a
message never goes into a log line or an error.
"""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.building_settings import BuildingSettings
from src.core.database import DbSession
from src.core.exceptions import DomainError
from src.modules.chat.models import ChatMessage
from src.modules.chat.policies import (
    BUILDING_ROOM,
    HISTORY,
    MAX_LENGTH,
    RECENT,
    in_room,
    rate_limit,
    takes_part,
    window_start,
)
from src.modules.chat.schemas import (
    PAGE_DEFAULT,
    ChatMessageCreate,
    ChatMessageView,
    ChatPage,
    ChatState,
)
from src.modules.chat.settings import CHAT_ENABLED
from src.modules.property.schemas import CurrentUserDTO, first_object_in
from src.modules.property.service import PropertyService, get_property_service


def _now() -> datetime:
    return datetime.now(UTC)


def _forbidden() -> DomainError:
    return DomainError(
        status_code=403,
        error_code="FORBIDDEN",
        message="Only residents and the board take part in the building chat.",
    )


def _disabled() -> DomainError:
    return DomainError(
        status_code=409, error_code="CHAT_DISABLED", message="The building chat is turned off."
    )


def _invalid_author_apartment() -> DomainError:
    return DomainError(
        status_code=422,
        error_code="INVALID_AUTHOR_APARTMENT",
        message="You can write only from an apartment you belong to.",
    )


def _rate_limited(reason: str, wait: int) -> DomainError:
    return DomainError(
        status_code=429,
        error_code="RATE_LIMITED",
        message="Too many messages; wait a moment before the next one.",
        extra={"retry_after_seconds": wait, "reason": reason},
        headers={"Retry-After": str(wait)},
    )


class ChatService:
    def __init__(
        self,
        session: AsyncSession,
        property_service: PropertyService,
        settings: BuildingSettings | None = None,
    ):
        self.session = session
        self.property_service = property_service
        self.settings = settings or BuildingSettings(session)

    async def state(self, user: CurrentUserDTO) -> ChatState:
        enabled, since = await self.settings.get_with_time(user.building_id, CHAT_ENABLED)
        part = takes_part(user)
        count, last = 0, None
        if enabled and part:
            now = _now()
            start = window_start(now, since)
            count = await self.session.scalar(
                select(func.count()).where(
                    ChatMessage.building_id == user.building_id,
                    ChatMessage.created_at >= max(start, now - RECENT),
                )
            )
            last = await self.session.scalar(
                select(func.max(ChatMessage.created_at)).where(
                    ChatMessage.building_id == user.building_id,
                    ChatMessage.created_at >= start,
                )
            )
        return ChatState(
            enabled=enabled,
            turned_on_at=since if enabled else None,
            can_take_part=part,
            recent_count=count or 0,
            recent_minutes=int(RECENT.total_seconds() // 60),
            last_message_at=last,
            history_hours=int(HISTORY.total_seconds() // 3600),
            max_length=MAX_LENGTH,
        )

    async def messages(
        self, user: CurrentUserDTO, after: int | None, limit: int = PAGE_DEFAULT
    ) -> ChatPage:
        start, since = await self._open_window(user)
        visible = (ChatMessage.building_id == user.building_id, ChatMessage.created_at >= start)
        if after is None:
            newest = list(
                await self.session.scalars(
                    select(ChatMessage).where(*visible).order_by(ChatMessage.id.desc()).limit(limit)
                )
            )
            rows, has_more = newest[::-1], False
        else:
            rows = list(
                await self.session.scalars(
                    select(ChatMessage)
                    .where(*visible, ChatMessage.id > after)
                    .order_by(ChatMessage.id)
                    .limit(limit + 1)
                )
            )
            has_more = len(rows) > limit
            rows = rows[:limit]
        views = await self._views(user, rows)
        cursor = rows[-1].id if rows else after
        return ChatPage(messages=views, cursor=cursor, has_more=has_more, turned_on_at=since)

    async def post(self, user: CurrentUserDTO, request: ChatMessageCreate) -> ChatMessageView:
        await self._open_window(user)  # 403 and 409 come before a wrong apartment
        apartment_id = self._author_apartment(user, request.author_apartment_id)
        # One writer per building at a time: ids are then committed in the order they are taken,
        # so a client polling with `after` never skips a message, and the limits are exact.
        await self.session.execute(
            select(func.pg_advisory_xact_lock(func.hashtextextended(f"chat:{user.building_id}", 0)))
        )
        now = _now()
        own = await self.session.scalars(
            select(ChatMessage.created_at).where(
                ChatMessage.author_user_id == user.id,
                ChatMessage.building_id == user.building_id,
                ChatMessage.created_at > now - timedelta(hours=1),  # the longest limit
            )
        )
        if limited := rate_limit(list(own), now):
            raise _rate_limited(*limited)
        message = ChatMessage(
            building_id=user.building_id,
            author_user_id=user.id,
            author_apartment_id=apartment_id,
            body=request.body,
            created_at=now,
        )
        self.session.add(message)
        await self.session.flush()
        (view,) = await self._views(user, [message])
        return view

    async def _open_window(self, user: CurrentUserDTO) -> tuple[datetime, datetime | None]:
        """The start of the visible window and when the chat was turned on; refuses a caller
        who does not take part, and any use while the chat is off."""
        if not takes_part(user):
            raise _forbidden()
        enabled, since = await self.settings.get_with_time(user.building_id, CHAT_ENABLED)
        if not enabled:
            raise _disabled()
        return window_start(_now(), since), since

    @staticmethod
    def _author_apartment(user: CurrentUserDTO, requested: uuid.UUID | None) -> uuid.UUID | None:
        """An explicit choice must be one of the caller's objects inside the room's target;
        without one, the first of them (an owner of Apt. 14 and P1 writes as Apt. 14), or none
        for a chairman or board member without one there."""
        if requested is not None:
            if not in_room(user, BUILDING_ROOM, requested):
                raise _invalid_author_apartment()
            return requested
        return first_object_in(user, BUILDING_ROOM)

    async def _views(self, user: CurrentUserDTO, rows: list[ChatMessage]) -> list[ChatMessageView]:
        badges = await self.property_service.get_masked_author_badges(
            (row.author_user_id, row.author_apartment_id) for row in rows
        )
        return [
            ChatMessageView(
                id=row.id,
                body=row.body,
                author_badge=badges[(row.author_user_id, row.author_apartment_id)],
                created_at=row.created_at,
                expires_at=row.created_at + HISTORY,
                is_own=row.author_user_id == user.id,
            )
            for row in rows
        ]


def get_chat_service(
    session: DbSession, property_service: PropertyService = Depends(get_property_service)
) -> ChatService:
    return ChatService(session, property_service)
