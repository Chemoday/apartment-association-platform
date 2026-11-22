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
from src.modules.auth.models import AuthInvitation, AuthJoinCode, AuthJoinRequest
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


@dataclass
class _Activity:
    """What the OWNER invitations, join codes and join requests of one apartment say about it."""

    pending_queued: bool | None = None  # of the pending invitation: queued or sent; None: none
    code_issued: bool = False  # an unused, unexpired join code (R4c)
    join_request: bool = False  # a join request waits (R4c)
    last_activity_at: datetime | None = None  # the latest invitation e-mail or code issue
    # The newest invitation or (not cancelled) code by creation, and whether it ran out unused.
    newest_at: datetime | None = None
    newest_expired_unused: bool = False

    def saw(self, at: datetime) -> None:
        if self.last_activity_at is None or at > self.last_activity_at:
            self.last_activity_at = at

    def created(self, at: datetime, expired_unused: bool) -> None:
        if self.newest_at is None or at > self.newest_at:
            self.newest_at, self.newest_expired_unused = at, expired_unused


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

    async def items(self, building_id: uuid.UUID) -> list[ConnectionItem]:
        """Every apartment's item, with no caller check (the default pick of join codes)."""
        return await self._items(building_id, None)

    async def _items(
        self, building_id: uuid.UUID, apartment_id: uuid.UUID | None
    ) -> list[ConnectionItem]:
        now = _now()
        rows = await self.properties.connection_rows(building_id, apartment_id)
        activity = await self._activity(building_id, apartment_id, now)
        return [self._item(row, activity.get(row.apartment_id, _Activity())) for row in rows]

    @staticmethod
    def _item(row: ConnectionRowDTO, invitations: _Activity) -> ConnectionItem:
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
                join_request=invitations.join_request,
                code_issued=invitations.code_issued,
            ),
            owners=row.owners,
            tenants=row.tenants,
            on_paper=row.on_paper,
            last_invited_at=invitations.last_activity_at,
            invitation_delivery=None
            if queued is None
            else InvitationDelivery.QUEUED
            if queued
            else InvitationDelivery.SENT,
        )

    async def _activity(
        self, building_id: uuid.UUID, apartment_id: uuid.UUID | None, now: datetime
    ) -> dict[uuid.UUID, _Activity]:
        """The OWNER invitations, join codes and join requests of the building (or of one
        apartment) by apartment. An OWNER invitation applies while the building has an active
        chairman, which the caller is."""
        found: dict[uuid.UUID, _Activity] = {}

        def of(apartment: uuid.UUID) -> _Activity:
            return found.setdefault(apartment, _Activity())

        invitations = select(
            AuthInvitation.apartment_id,
            AuthInvitation.created_at,
            AuthInvitation.last_sent_at,
            AuthInvitation.expires_at,
            AuthInvitation.accepted_at,
            AuthInvitation.send_due_at,
        ).where(
            AuthInvitation.building_id == building_id,
            AuthInvitation.kind == InvitationKind.OWNER,
        )
        codes = select(
            AuthJoinCode.apartment_id,
            AuthJoinCode.created_at,
            AuthJoinCode.expires_at,
            AuthJoinCode.used_at,
            AuthJoinCode.cancelled_at,
        ).where(AuthJoinCode.building_id == building_id)
        requests = select(AuthJoinRequest.apartment_id).where(
            AuthJoinRequest.building_id == building_id
        )
        if apartment_id is not None:
            invitations = invitations.where(AuthInvitation.apartment_id == apartment_id)
            codes = codes.where(AuthJoinCode.apartment_id == apartment_id)
            requests = requests.where(AuthJoinRequest.apartment_id == apartment_id)
        # Newest first, so the first pending invitation met is the newest pending one.
        invitations = invitations.order_by(AuthInvitation.created_at.desc(), AuthInvitation.id)
        for apartment, created, sent, expires, accepted, due in await self.session.execute(
            invitations
        ):
            item = of(apartment)
            unused = accepted is None
            if item.pending_queued is None and unused and expires > now:
                item.pending_queued = due is not None
            item.saw(sent)
            item.created(created, unused and expires <= now)
        for apartment, created, expires, used, cancelled in await self.session.execute(codes):
            item = of(apartment)
            item.saw(created)
            if cancelled is not None:
                continue  # a cancelled code is neither issued nor expired
            if used is None and expires > now:
                item.code_issued = True
            item.created(created, used is None and expires <= now)
        for (apartment,) in await self.session.execute(requests):
            of(apartment).join_request = True
        return found
