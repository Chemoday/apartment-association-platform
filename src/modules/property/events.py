"""Durable domain events of module property (docs/ARCHITECTURE.md 13, epic E12 X2b)."""

import uuid
from dataclasses import dataclass
from datetime import date

from src.core.event_bus import DomainEvent


@dataclass(frozen=True, kw_only=True)
class EnergyCertificateExpiring(DomainEvent):
    """The energy certificate of the accepted building passport reached a threshold: 180 or 30
    days before `valid_until`, or the day itself (0, also when found later). Notifications tell
    the chairman and the board (ENERGY_CERTIFICATE_EXPIRING)."""

    building_id: uuid.UUID
    valid_until: date
    days_left: int
    threshold: int
