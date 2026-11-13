"""Durable domain events of the file storage (epic E11, task F4; docs/ARCHITECTURE.md 10)."""

import uuid
from dataclasses import dataclass

from src.core.event_bus import DomainEvent


@dataclass(frozen=True, kw_only=True)
class StorageUsageHigh(DomainEvent):
    """A stored file brought the association's files to a threshold (70 or 90 percent) of its
    room for files (the quota minus the votes reserve); `used_percent` is of the whole quota.
    Notifications tell the chairman and the board (STORAGE_ALMOST_FULL)."""

    building_id: uuid.UUID
    threshold: int
    used_percent: int
