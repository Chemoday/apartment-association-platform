"""Durable domain events of the file storage (epic E11, task F4; docs/ARCHITECTURE.md 10)."""

import uuid
from dataclasses import dataclass

from src.core.event_bus import DomainEvent


@dataclass(frozen=True, kw_only=True)
class StorageUsageHigh(DomainEvent):
    """A stored file brought the association's files to a threshold of its quota (80 or 95
    percent); notifications tell the chairman and the board (STORAGE_ALMOST_FULL)."""

    building_id: uuid.UUID
    threshold: int
    used_percent: int
