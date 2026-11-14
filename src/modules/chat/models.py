"""Private SQLAlchemy models of the chat module. NEVER import them from another module.

docs/SCHEMA.md section 14. Rows live at most 2 hours (chat/purge.py).
"""

import uuid
from datetime import UTC, datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Identity, Index, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.core.database import Base
from src.modules.chat.policies import MAX_LENGTH


def _utc_now() -> datetime:
    return datetime.now(UTC)


class ChatMessage(Base):
    __tablename__ = "chat_messages"
    __table_args__ = (
        CheckConstraint("btrim(body) <> ''", name="ck_chat_messages_body_not_blank"),
        Index("ix_chat_messages_building_id", "building_id", "id"),
        Index("ix_chat_messages_author_created", "author_user_id", "created_at"),
        Index("ix_chat_messages_created", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_buildings.id", ondelete="CASCADE"), nullable=False
    )
    author_user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id", ondelete="CASCADE"), nullable=False
    )
    author_apartment_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_apartments.id", ondelete="CASCADE"), nullable=True
    )
    body: Mapped[str] = mapped_column(String(MAX_LENGTH), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utc_now
    )

    def __repr__(self) -> str:  # never the body: a repr can end up in a log
        return f"ChatMessage(id={self.id!r}, building_id={self.building_id!r})"
