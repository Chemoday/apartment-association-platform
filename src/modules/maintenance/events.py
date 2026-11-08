"""Domain events of the maintenance calendar, stored durably and published after commit.

Payloads carry ids, dates and counters only: never titles, instructions or notes.
"""

import uuid
from dataclasses import dataclass
from datetime import date

from src.core.event_bus import DomainEvent


@dataclass(frozen=True, kw_only=True)
class MaintenanceTaskDue(DomainEvent):
    """The calendar published an occurrence (reminder_number 0) or reminded of an overdue one
    (1, 2, ...); notifications tell the board (MAINTENANCE_DUE, task M3)."""

    task_id: uuid.UUID
    occurrence_id: uuid.UUID
    building_id: uuid.UUID
    due_date: date
    overdue: bool
    reminder_number: int
