"""Domain events of module auth, stored durably in the transaction that raises them.

Payloads carry ids only: never an e-mail, a name or a token.
"""

import uuid
from dataclasses import dataclass

from src.core.event_bus import DomainEvent
from src.modules.property.schemas import ObjectKind


@dataclass(frozen=True, kw_only=True)
class UserAccountClosed(DomainEvent):
    """An account was closed (its personal data removed); notifications drops what it kept for
    the person: bindings, preferences, link codes and the feed."""

    user_id: uuid.UUID
    building_id: uuid.UUID


@dataclass(frozen=True, kw_only=True)
class JoinRequestSubmitted(DomainEvent):
    """Someone used a join code on paper (E13 R4c); notifications tells the chairmen
    (JOIN_REQUEST_SUBMITTED). Ids and the object's number and kind only, never what the person typed."""

    building_id: uuid.UUID
    request_id: uuid.UUID
    apartment_id: uuid.UUID
    apartment_number: str
    # Absent in events stored before epic E14: an apartment.
    apartment_kind: ObjectKind = ObjectKind.APARTMENT
