"""Domain events of the issue tracker, stored durably and published after commit (task I3).

Payloads carry ids and codes only: never titles, descriptions or who follows.
"""

import uuid
from dataclasses import dataclass

from src.core.event_bus import DomainEvent


@dataclass(frozen=True, kw_only=True)
class IssueReported(DomainEvent):
    """A new report; notifications tell the board (ISSUE_REPORTED, or ISSUE_URGENT)."""

    issue_id: uuid.UUID
    building_id: uuid.UUID
    reporter_user_id: uuid.UUID
    urgent: bool


@dataclass(frozen=True, kw_only=True)
class IssueStatusChanged(DomainEvent):
    """The board moved an issue on (not to DUPLICATE); the followers are told."""

    issue_id: uuid.UUID
    building_id: uuid.UUID
    change_id: uuid.UUID
    changed_by_user_id: uuid.UUID
    status: str


@dataclass(frozen=True, kw_only=True)
class IssueMerged(DomainEvent):
    """The board marked an issue a duplicate of `original_id`; its followers are told once."""

    issue_id: uuid.UUID
    original_id: uuid.UUID
    building_id: uuid.UUID
    change_id: uuid.UUID
    changed_by_user_id: uuid.UUID
