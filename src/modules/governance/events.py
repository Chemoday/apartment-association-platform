"""Domain events of the governance module, stored durably and published after commit.

Payloads carry ids only: no titles, questions or answers.
"""

import uuid
from dataclasses import dataclass

from src.core.event_bus import DomainEvent


@dataclass(frozen=True, kw_only=True)
class PollOpened(DomainEvent):
    """The board opened a poll; notifications tell everyone who may answer (POLL_OPENED)."""

    poll_id: uuid.UUID
    building_id: uuid.UUID
    opened_by_user_id: uuid.UUID
