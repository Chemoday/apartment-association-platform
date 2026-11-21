"""The connection overview per apartment (epic E13 R4b; docs/API.md 7, "The connection
overview"). The chairman sees which apartments have someone in the app: counts, statuses and
dates only, never a name or an e-mail.

The apartments and their member counts come from PropertyService (property never imports auth);
the invitations are this module's own. The status rule is `connection_status` in policies.py.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.auth.errors import apartment_not_found, forbidden
from src.modules.auth.models import AuthInvitation
from src.modules.auth.policies import connection_status
from src.modules.auth.schemas import (
    ConnectionItem,
    ConnectionOverview,
    ConnectionStatus,
    ConnectionSummary,
    InvitationDelivery,
    InvitationKind,
)
from src.modules.property.schemas import BuildingRole, ConnectionRowDTO, CurrentUserDTO
from src.modules.property.service import PropertyService


def _now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class _OwnerInvitations:
    """What the OWNER invitations of one apartment say about it."""

    pending_queued: bool | None = None  # of the pending one: queued or sent; None without one
    newest_expired_unused: bool = False  # the newest (by creation) ran out unaccepted
    last_sent_at: datetime | None = None  # the latest e-mail of any of them


class ConnectionService:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session
        self.properties = PropertyService(session)

    @staticmethod
    def _chairman(caller: CurrentUserDTO) -> None:
        if caller.building_role != BuildingRole.CHAIRMAN:
            raise forbidden()

    async def overview(
        self,
        caller: CurrentUserDTO,
        status: ConnectionStatus | None,
        limit: int,
        offset: int,
    ) -> ConnectionOverview:
        self._chairman(caller)
        items = await self._items(caller.building_id, None)
        by_status: dict[ConnectionStatus, int] = {}
        for item in items:
            by_status[item.status] = by_status.get(item.status, 0) + 1
        matching = [item for item in items if status is None or item.status == status]
        return ConnectionOverview(
            summary=ConnectionSummary(
                apartments=len(items),
                connected=by_status.get(ConnectionStatus.CONNECTED, 0),
                by_status=by_status,
            ),
            matching=len(matching),
            items=matching[offset : offset + limit],
        )

    async def set_paper(
        self, caller: CurrentUserDTO, apartment_id: uuid.UUID, on_paper: bool
    ) -> ConnectionItem:
        self._chairman(caller)
        if not await self.properties.set_on_paper(caller.building_id, apartment_id, on_paper):
            raise apartment_not_found()
        return (await self._items(caller.building_id, apartment_id))[0]

    async def _items(
        self, building_id: uuid.UUID, apartment_id: uuid.UUID | None
    ) -> list[ConnectionItem]:
        now = _now()
        rows = await self.properties.connection_rows(building_id, apartment_id)
        invitations = await self._owner_invitations(building_id, apartment_id, now)
        return [
            self._item(row, invitations.get(row.apartment_id, _OwnerInvitations())) for row in rows
        ]

    @staticmethod
    def _item(row: ConnectionRowDTO, invitations: _OwnerInvitations) -> ConnectionItem:
        queued = invitations.pending_queued
        return ConnectionItem(
            apartment_id=row.apartment_id,
            apartment_number=row.number,
            entrance=row.entrance,
            status=connection_status(
                owners=row.owners,
                tenants=row.tenants,
                on_paper=row.on_paper,
                invited=queued is not None,
                newest_expired_unused=invitations.newest_expired_unused,
            ),
            owners=row.owners,
            tenants=row.tenants,
            on_paper=row.on_paper,
            last_invited_at=invitations.last_sent_at,
            invitation_delivery=None
            if queued is None
            else InvitationDelivery.QUEUED
            if queued
            else InvitationDelivery.SENT,
        )

    async def _owner_invitations(
        self, building_id: uuid.UUID, apartment_id: uuid.UUID | None, now: datetime
    ) -> dict[uuid.UUID, _OwnerInvitations]:
        """The OWNER invitations of the building (or of one apartment) by apartment. An OWNER
        invitation applies while the building has an active chairman, which the caller is."""
        query = (
            select(
                AuthInvitation.apartment_id,
                AuthInvitation.last_sent_at,
                AuthInvitation.expires_at,
                AuthInvitation.accepted_at,
                AuthInvitation.send_due_at,
            )
            .where(
                AuthInvitation.building_id == building_id,
                AuthInvitation.kind == InvitationKind.OWNER,
            )
            .order_by(AuthInvitation.created_at.desc(), AuthInvitation.id)  # the newest first
        )
        if apartment_id is not None:
            query = query.where(AuthInvitation.apartment_id == apartment_id)
        found: dict[uuid.UUID, _OwnerInvitations] = {}
        for (
            apartment,
            last_sent_at,
            expires_at,
            accepted_at,
            send_due_at,
        ) in await self.session.execute(query):
            unused = accepted_at is None
            current = found.get(apartment)
            if current is None:  # the newest of this apartment
                current = _OwnerInvitations(newest_expired_unused=unused and expires_at <= now)
            pending_queued = current.pending_queued
            if pending_queued is None and unused and expires_at > now:
                pending_queued = send_due_at is not None
            latest = current.last_sent_at
            found[apartment] = _OwnerInvitations(
                pending_queued=pending_queued,
                newest_expired_unused=current.newest_expired_unused,
                last_sent_at=last_sent_at if latest is None else max(latest, last_sent_at),
            )
        return found
