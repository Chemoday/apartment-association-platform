"""Invitations, registration and accepting (task E7/A4, docs/API.md section 7, "Invitations").

An invitation is the only way into the system and the only way to another apartment or a staff
role. No account exists until it is accepted: a new person registers through the link; a person
with an account signs in and accepts. Nothing here tells an inviter whether an e-mail has an
account: every invitation answers the same and sends the same e-mail.

Invitation e-mails go through the queue (epic E13 R4a, src/modules/auth/queue.py): an invitation
is stored with its e-mail due, and the link is made only when the queue sends it (claim_due), so
the plain token lives only in memory. The e-mails of resend_for_sign_in and of the first chairman
are returned as AuthMail values and sent right after the commit. Nothing personal is logged.
"""

import secrets
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import Settings
from src.core.exceptions import DomainError
from src.modules.auth.bulk import BulkListTooLong, ParsedRow, parse_bulk_list
from src.modules.auth.errors import (
    apartment_not_found,
    bulk_list_too_long,
    conflict,
    forbidden,
    invalid_link,
    invitation_not_found,
    locale_not_offered,
    rate_limited,
)
from src.modules.auth.mail import AuthMail, invitation_target
from src.modules.auth.models import AuthAttempt, AuthInvitation, AuthToken
from src.modules.auth.policies import (
    INVITATION_MAX_FAILED_SENDS,
    INVITATION_RETENTION,
    INVITATION_RETRY_LAST,
    INVITATION_SEND_LEASE,
    INVITATION_TTL,
    INVITATION_UNAVAILABLE_RETRY,
    INVITATIONS_PER_INVITER_PER_HOUR,
    REGISTRATION_TTL,
    invitation_retry_delay,
    invitation_status,
    keyed_hash,
    mask_email,
    sign_in_link,
    staff_invitation_applies,
    user_subject,
)
from src.modules.auth.schemas import (
    AttemptKind,
    AuthMethod,
    BulkInvitationReport,
    BulkInvitationRow,
    BulkRowOutcome,
    InvitationCreate,
    InvitationDelivery,
    InvitationKind,
    InvitationPreview,
    InvitationStatus,
    InvitationView,
    IssuedSession,
    OwnerInvitationCreate,
    RegistrationRequest,
    SignInResponse,
    SignInStatus,
    StaffInvitationCreate,
    StaffRole,
    TenantInvitationCreate,
    TokenPurpose,
)
from src.modules.auth.service import AuthService
from src.modules.property.schemas import (
    BuildingRole,
    CurrentUserDTO,
    DisplayMode,
    Locale,
    ObjectKind,
    ObjectRef,
    RelationType,
)
from src.modules.property.service import PropertyService

HOUR = timedelta(hours=1)
DAY = timedelta(hours=24)
TOKEN_BYTES = 32
# The building limit of bulk invitations (E13 R4a): this many per apartment in any 24 hours.
BULK_INVITATIONS_PER_APARTMENT_PER_DAY = 2
# What the INVITATION_MAIL attempts of the queue's pacing count: the whole installation.
QUEUE_SUBJECT = "queue:invitation-mails"
_RELATION = {InvitationKind.OWNER: RelationType.OWNER, InvitationKind.TENANT: RelationType.TENANT}


def _now() -> datetime:
    return datetime.now(UTC)


def delivery_of(send_due_at: datetime | None, send_failures: int) -> InvitationDelivery:
    """QUEUED while due, FAILED when the queue gave up, else SENT."""
    if send_due_at is not None:
        return InvitationDelivery.QUEUED
    if send_failures >= INVITATION_MAX_FAILED_SENDS:
        return InvitationDelivery.FAILED
    return InvitationDelivery.SENT


@dataclass(frozen=True)
class QueuedMail:
    """A claimed e-mail of the invitation queue; `mail` holds the plain link, memory only."""

    invitation_id: uuid.UUID
    attempt: int
    failures: int  # refusals in a row before this attempt
    lease: datetime
    expires_at: datetime
    mail: AuthMail


@dataclass(frozen=True)
class _Applies:
    """Answers "does this invitation still apply?" with one query per apartment or building."""

    properties: PropertyService

    async def __call__(self, invitation: AuthInvitation, cache: dict[object, bool]) -> bool:
        if invitation.invited_by_user_id is None:
            return True  # sent by the system (the first chairman): no chairman needed
        if invitation.kind == InvitationKind.TENANT:
            assert invitation.apartment_id is not None
            key: object = ("owner", invitation.apartment_id)
            if key not in cache:
                cache[key] = await self.properties.has_active_owner(invitation.apartment_id)
            return cache[key]
        if invitation.apartment_id is not None:
            apartment_key = ("apartment", invitation.apartment_id)
            if apartment_key not in cache:
                ref = await self.properties.apartment_ref(invitation.apartment_id)
                cache[apartment_key] = ref is not None
            if not cache[apartment_key]:
                return False
        key = ("chairman", invitation.building_id)
        if key not in cache:
            cache[key] = await self.properties.active_chairman_count(invitation.building_id) > 0
        return cache[key]


class InvitationService:
    def __init__(self, session: AsyncSession, settings: Settings) -> None:
        self.session = session
        self.settings = settings
        self.properties = PropertyService(session)
        self._applies = _Applies(self.properties)

    def _hash(self, value: str) -> str:
        return keyed_hash(self.settings.AUTH_HASH_SECRET.get_secret_value(), value)

    # --- Creating, resending, deleting ----------------------------------------------------------

    def offered_locales(self) -> frozenset[str]:
        """The languages a first invitation may be written in: the default and en."""
        return frozenset({self.settings.DEFAULT_LOCALE, Locale.EN.value})

    async def create(self, caller: CurrentUserDTO, body: InvitationCreate) -> InvitationView:
        """Invite someone (201); the e-mail is queued. The answer is the same whether the
        e-mail has an account."""
        now = _now()
        apartment_id: uuid.UUID | None = None
        if isinstance(body, OwnerInvitationCreate | StaffInvitationCreate):
            if caller.building_role != BuildingRole.CHAIRMAN:
                raise forbidden()
        if isinstance(body, OwnerInvitationCreate):
            apartment = await self.properties.apartment_by_ref(
                caller.building_id, body.apartment_kind, body.apartment_number
            )
            if apartment is None:
                raise apartment_not_found()
            apartment_id = apartment.apartment_id
        elif isinstance(body, TenantInvitationCreate):
            apartment = await self.properties.apartment_ref(body.apartment_id)
            if apartment is None or apartment.building_id != caller.building_id:
                raise apartment_not_found()
            if not await self.properties.is_owner_of(caller.id, apartment.apartment_id):
                raise forbidden()
            apartment_id = apartment.apartment_id
        if body.locale is not None and body.locale.value not in self.offered_locales():
            raise locale_not_offered()  # after the checks of who may invite
        building_role = body.building_role if isinstance(body, StaffInvitationCreate) else None
        return await self._invite(
            caller,
            kind=body.kind,
            email=body.email,
            apartment_id=apartment_id,
            building_role=building_role,
            locale=body.locale,
            now=now,
        )

    async def invite_tenant(
        self, caller: CurrentUserDTO, apartment_id: uuid.UUID, email: str
    ) -> InvitationView:
        """A TENANT invitation whose caller is already known to own the apartment (replace)."""
        return await self._invite(
            caller,
            kind=InvitationKind.TENANT,
            email=email,
            apartment_id=apartment_id,
            building_role=None,
            locale=None,
            now=_now(),
        )

    async def _invite(
        self,
        caller: CurrentUserDTO,
        *,
        kind: InvitationKind,
        email: str,
        apartment_id: uuid.UUID | None,
        building_role: StaffRole | None,
        locale: Locale | None,
        now: datetime,
    ) -> InvitationView:
        await self.properties.lock_people(caller.building_id)  # the one lock order, see there
        await self._check_limit(caller.id, now)
        invitation = await self._open(
            caller,
            kind=kind,
            email=email,
            apartment_id=apartment_id,
            building_role=building_role,
            locale=locale,
            now=now,
        )
        self._record_send(caller.id, now)
        await self.session.flush()
        return (await self._views([invitation], caller.id, now))[0]

    async def _open(
        self,
        caller: CurrentUserDTO,
        *,
        kind: InvitationKind,
        email: str,
        apartment_id: uuid.UUID | None,
        building_role: StaffRole | None,
        locale: Locale | None,
        now: datetime,
    ) -> AuthInvitation:
        """A new invitation with its e-mail queued, under the people lock the caller holds; an
        expired or no longer valid one of the same target is replaced."""
        if apartment_id is not None:
            await self.properties.lock_apartment(apartment_id)
        # One request per target at a time (a double click, two chairmen), so the second one
        # finds the first instead of failing on the unique index.
        target = f"{kind}|{email}|{apartment_id}|{building_role}"
        await self.session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"auth:invite:{self._hash(target)}"},
        )
        # The unique index is installation-wide (one building per installation today, BACKLOG
        # B-1); the lookup stays in the caller's building.
        existing = await self.session.scalar(
            select(AuthInvitation)
            .where(
                AuthInvitation.building_id == caller.building_id,
                AuthInvitation.kind == kind,
                AuthInvitation.email == email,
                AuthInvitation.apartment_id.is_(None)
                if apartment_id is None
                else AuthInvitation.apartment_id == apartment_id,
                AuthInvitation.building_role.is_(None)
                if building_role is None
                else AuthInvitation.building_role == building_role,
                AuthInvitation.accepted_at.is_(None),
            )
            .with_for_update()
        )
        if existing is not None:
            if await self._status(existing, now, {}) == InvitationStatus.PENDING:
                raise conflict(
                    "INVITATION_ALREADY_PENDING",
                    "This person is already invited; resend the invitation instead.",
                )
            await self.session.delete(existing)  # expired or no longer valid: replaced
            await self.session.flush()
        if kind == InvitationKind.TENANT:
            assert apartment_id is not None
            await self._check_tenant_limit(apartment_id, now)
        invitation = AuthInvitation(
            building_id=caller.building_id,
            kind=kind,
            email=email,
            apartment_id=apartment_id,
            building_role=building_role,
            invited_by_user_id=caller.id,
            created_at=now,
            last_sent_at=now,
            expires_at=now + INVITATION_TTL,
            locale=locale,
            send_due_at=now,
            send_attempts=0,
        )
        self.session.add(invitation)
        await self.session.flush()
        return invitation

    async def resend(self, caller: CurrentUserDTO, invitation_id: uuid.UUID) -> InvitationView:
        """Queue a pending or expired invitation again: a new link when it goes out, and the 7
        days start again."""
        now = _now()
        await self.properties.lock_people(caller.building_id)
        invitation = await self._visible_for_update(caller, invitation_id)
        if invitation.accepted_at is not None:
            raise self._accepted()
        if not await self._applies(invitation, {}):
            raise conflict(
                "INVITATION_NO_LONGER_VALID",
                "This invitation no longer applies; delete it instead.",
            )
        await self._check_limit(caller.id, now)
        if invitation.kind == InvitationKind.TENANT and invitation.expires_at <= now:
            assert invitation.apartment_id is not None
            # An expired invitation does not count toward the limit; a resent one does again.
            await self.properties.lock_apartment(invitation.apartment_id)
            await self._check_tenant_limit(invitation.apartment_id, now)
        await self._drop_links(invitation.id)  # the old link stops working at once
        self._queue(invitation, now)
        self._record_send(caller.id, now)
        await self.session.flush()
        return (await self._views([invitation], caller.id, now))[0]

    @staticmethod
    def _queue(invitation: AuthInvitation, now: datetime) -> None:
        """Put the invitation's e-mail into the queue, due now; it is pending for 7 days from
        now, and again from the moment the e-mail goes out."""
        invitation.expires_at = now + INVITATION_TTL
        invitation.send_due_at = now
        invitation.send_attempts = 0
        invitation.send_failures = 0

    async def delete(self, caller: CurrentUserDTO, invitation_id: uuid.UUID) -> None:
        await self.properties.lock_people(caller.building_id)
        invitation = await self._visible_for_update(caller, invitation_id)
        if invitation.accepted_at is not None:
            raise self._accepted()
        await self.session.delete(invitation)  # its links cascade
        await self.session.flush()

    # --- Bulk invitations and "resend expired" (E13 R4a) -----------------------------------------

    async def bulk(
        self, caller: CurrentUserDTO, list_text: str, *, send: bool
    ) -> BulkInvitationReport:
        """The preview (send=False, changes nothing) or the send of a bulk list of owners. The
        send checks every row again and creates all READY rows in this transaction, or nothing
        (429) when the building limit does not allow them all."""
        if caller.building_role != BuildingRole.CHAIRMAN:
            raise forbidden()
        now = _now()
        if send:
            await self.properties.lock_people(caller.building_id)  # rows and limit stay put
        objects = await self.properties.list_apartments(caller.building_id)
        # The list names apartments only until it takes a kind (epic E14, K4); the limit counts
        # objects of every kind.
        apartments = {a.number: a.id for a in objects if a.kind == ObjectKind.APARTMENT}
        limit = BULK_INVITATIONS_PER_APARTMENT_PER_DAY * len(objects)
        try:
            parsed = parse_bulk_list(
                list_text, max_rows=limit, offered_locales=self.offered_locales()
            )
        except BulkListTooLong:
            raise bulk_list_too_long() from None
        outcomes = await self._bulk_outcomes(caller, parsed, apartments, now)
        used = await self._bulk_used(caller.building_id, now)
        ready = [row for row, outcome in zip(parsed, outcomes, strict=True) if outcome is None]
        remaining = max(limit - len(used), 0)
        if send:
            self._check_bulk_limit(used, len(ready), limit, now)
            for row in ready:
                assert row.email is not None and row.apartment_number is not None
                await self._open(
                    caller,
                    kind=InvitationKind.OWNER,
                    email=row.email,
                    apartment_id=apartments[row.apartment_number],
                    building_role=None,
                    locale=Locale(row.locale) if row.locale else None,
                    now=now,
                )
            self._record_bulk(caller.building_id, len(ready), now)
            await self.session.flush()
            remaining -= len(ready)
        done = BulkRowOutcome.INVITED if send else BulkRowOutcome.READY
        rows = [
            BulkInvitationRow(
                line=row.line,
                apartment_number=row.apartment_number,
                apartment_kind=ObjectKind.APARTMENT,
                email=row.email,
                locale=row.locale,
                outcome=outcome or done,
            )
            for row, outcome in zip(parsed, outcomes, strict=True)
        ]
        counts: dict[BulkRowOutcome, int] = {}
        for row_view in rows:
            counts[row_view.outcome] = counts.get(row_view.outcome, 0) + 1
        return BulkInvitationReport(rows=rows, counts=counts, limit_remaining=remaining)

    async def _bulk_outcomes(
        self,
        caller: CurrentUserDTO,
        parsed: list[ParsedRow],
        apartments: dict[str, uuid.UUID],
        now: datetime,
    ) -> list[BulkRowOutcome | None]:
        """The outcome of each row that is not READY, in the order of the contract."""
        emails = {row.email for row in parsed if row.outcome is None and row.email}
        open_rows = (
            list(
                await self.session.scalars(
                    select(AuthInvitation).where(
                        AuthInvitation.building_id == caller.building_id,
                        AuthInvitation.kind == InvitationKind.OWNER,
                        AuthInvitation.email.in_(emails),
                        AuthInvitation.accepted_at.is_(None),
                    )
                )
            )
            if emails
            else []
        )
        cache: dict[object, bool] = {}
        pending = {
            (invitation.email, invitation.apartment_id)
            for invitation in open_rows
            if await self._status(invitation, now, cache) == InvitationStatus.PENDING
        }
        seen: set[tuple[str, uuid.UUID]] = set()
        outcomes: list[BulkRowOutcome | None] = []
        for row in parsed:
            if row.outcome is not None:
                outcomes.append(row.outcome)
                continue
            assert row.email is not None and row.apartment_number is not None
            apartment_id = apartments.get(row.apartment_number)
            if apartment_id is None:
                outcomes.append(BulkRowOutcome.APARTMENT_NOT_FOUND)
            elif (row.email, apartment_id) in seen:
                outcomes.append(BulkRowOutcome.DUPLICATE_IN_LIST)
            elif (row.email, apartment_id) in pending:
                seen.add((row.email, apartment_id))
                outcomes.append(BulkRowOutcome.ALREADY_PENDING)
            else:
                seen.add((row.email, apartment_id))
                outcomes.append(None)
        return outcomes

    async def resend_expired(self, caller: CurrentUserDTO) -> tuple[int, int]:
        """Queue the expired OWNER and STAFF invitations of the building that still apply, oldest
        first, as many as the building limit still allows; returns (queued, left). 429 when it
        allows none."""
        if caller.building_role != BuildingRole.CHAIRMAN:
            raise forbidden()
        now = _now()
        await self.properties.lock_people(caller.building_id)
        rows = list(
            await self.session.scalars(
                select(AuthInvitation)
                .where(
                    AuthInvitation.building_id == caller.building_id,
                    AuthInvitation.kind.in_([InvitationKind.OWNER, InvitationKind.STAFF]),
                    AuthInvitation.accepted_at.is_(None),
                    AuthInvitation.expires_at <= now,
                )
                .order_by(AuthInvitation.created_at, AuthInvitation.id)
                .with_for_update()
            )
        )
        cache: dict[object, bool] = {}
        expired = [row for row in rows if await self._applies(row, cache)]
        apartments = len(await self.properties.list_apartments(caller.building_id))
        limit = BULK_INVITATIONS_PER_APARTMENT_PER_DAY * apartments
        used = await self._bulk_used(caller.building_id, now)
        remaining = max(limit - len(used), 0)
        if expired and remaining == 0:
            self._check_bulk_limit(used, 1, limit, now)  # 429 until the oldest one ages out
        chosen = expired[:remaining]
        for invitation in chosen:
            await self._drop_links(invitation.id)
            self._queue(invitation, now)
        self._record_bulk(caller.building_id, len(chosen), now)
        await self.session.flush()
        return len(chosen), len(expired) - len(chosen)

    async def invite_from_join(
        self,
        caller: CurrentUserDTO,
        email: str,
        apartment_id: uuid.UUID,
        locale: Locale | None,
    ) -> InvitationView:
        """A confirmed join request (E13 R4c): an OWNER invitation by the confirming chairman,
        queued, counted against the building limit (429 leaves the request waiting). A pending
        OWNER invitation of that e-mail and apartment is resent instead: it keeps its inviter and
        takes the request's language."""
        now = _now()
        await self.properties.lock_people(caller.building_id)  # the caller's lock is re-entrant
        apartments = len(await self.properties.list_apartments(caller.building_id))
        limit = BULK_INVITATIONS_PER_APARTMENT_PER_DAY * apartments
        self._check_bulk_limit(await self._bulk_used(caller.building_id, now), 1, limit, now)
        existing = await self.session.scalar(
            select(AuthInvitation)
            .where(
                AuthInvitation.building_id == caller.building_id,
                AuthInvitation.kind == InvitationKind.OWNER,
                AuthInvitation.email == email,
                AuthInvitation.apartment_id == apartment_id,
                AuthInvitation.accepted_at.is_(None),
            )
            .with_for_update()
        )
        if (
            existing is not None
            and await self._status(existing, now, {}) == InvitationStatus.PENDING
        ):
            invitation = existing
            await self._drop_links(invitation.id)
            self._queue(invitation, now)
            invitation.locale = locale
        else:
            invitation = await self._open(
                caller,
                kind=InvitationKind.OWNER,
                email=email,
                apartment_id=apartment_id,
                building_role=None,
                locale=locale,
                now=now,
            )
        self._record_bulk(caller.building_id, 1, now)
        await self.session.flush()
        return (await self._views([invitation], caller.id, now))[0]

    def _bulk_subject(self, building_id: uuid.UUID) -> str:
        return self._hash(f"building:{building_id}")

    async def _bulk_used(self, building_id: uuid.UUID, now: datetime) -> list[datetime]:
        """When each invitation counted against the building limit in the last 24 hours."""
        return list(
            await self.session.scalars(
                select(AuthAttempt.attempted_at)
                .where(
                    AuthAttempt.kind == AttemptKind.BULK_INVITATION,
                    AuthAttempt.subject_hash == self._bulk_subject(building_id),
                    AuthAttempt.attempted_at > now - DAY,
                )
                .order_by(AuthAttempt.attempted_at)
            )
        )

    @staticmethod
    def _check_bulk_limit(used: list[datetime], wanted: int, limit: int, now: datetime) -> None:
        """429 when `wanted` more do not fit; Retry-After is when enough old ones have aged out."""
        over = len(used) + wanted - limit
        if wanted == 0 or over <= 0:
            return
        if over > len(used):  # more than the whole limit: never fits (the bulk row cap prevents it)
            raise rate_limited(int(DAY.total_seconds()))
        raise rate_limited(max(int((used[over - 1] + DAY - now).total_seconds()), 1))

    def _record_bulk(self, building_id: uuid.UUID, count: int, now: datetime) -> None:
        subject = self._bulk_subject(building_id)
        self.session.add_all(
            AuthAttempt(
                kind=AttemptKind.BULK_INVITATION,
                subject_hash=subject,
                succeeded=True,
                attempted_at=now,
            )
            for _ in range(count)
        )

    # --- The invitation queue (E13 R4a; docs/ARCHITECTURE.md 4.9) ------------------------------

    async def claim_due(self, now: datetime, limit: int) -> tuple[list[QueuedMail], int]:
        """Step 1 of a queue tick: claim up to `limit` due e-mails under a lease and make their
        links; also how many due rows were looked at (a row that no longer applies is pushed back,
        not claimed). The caller commits, then sends with no transaction open."""
        rows = list(
            await self.session.scalars(
                select(AuthInvitation)
                .where(
                    AuthInvitation.send_due_at <= now,
                    AuthInvitation.accepted_at.is_(None),
                    AuthInvitation.expires_at > now,
                )
                .order_by(AuthInvitation.send_due_at, AuthInvitation.created_at)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        claimed = []
        cache: dict[object, bool] = {}
        for invitation in rows:
            if not await self._applies(invitation, cache):
                # It may apply again (a new chairman); never sent while it does not.
                invitation.send_due_at = now + INVITATION_RETRY_LAST
                continue
            invitation.send_attempts += 1
            invitation.send_due_at = now + INVITATION_SEND_LEASE
            expires_at = now + INVITATION_TTL
            token = await self._new_link(invitation, now, expires_at)
            place = await self._apartment_of(invitation)
            claimed.append(
                QueuedMail(
                    invitation_id=invitation.id,
                    attempt=invitation.send_attempts,
                    failures=invitation.send_failures,
                    lease=invitation.send_due_at,
                    expires_at=expires_at,
                    mail=await self._mail(invitation, place, token),
                )
            )
        await self.session.flush()
        return claimed, len(rows)

    async def record_send(self, queued: QueuedMail, *, outcome: str, now: datetime) -> bool:
        """Step 3: record one result ('sent', 'failed': the mail server refused or could not be
        reached, or 'unavailable': no working e-mail at all), fenced on the attempt and the lease,
        so a stale worker or a resend in between never gets overwritten. False when the row moved
        on. After INVITATION_MAX_FAILED_SENDS refusals in a row the queue gives up (FAILED)."""
        ok = outcome == "sent"
        values: dict[str, object]
        if ok:
            values = {
                "send_due_at": None,
                "send_failures": 0,
                "last_sent_at": now,
                "expires_at": queued.expires_at,
            }
        elif outcome == "unavailable":
            values = {"send_due_at": now + INVITATION_UNAVAILABLE_RETRY}
        else:
            failures = queued.failures + 1
            values = {
                "send_failures": failures,
                "send_due_at": None
                if failures >= INVITATION_MAX_FAILED_SENDS
                else now + invitation_retry_delay(failures),
            }
        if ok:  # the pacing counts e-mails that went out, whatever happens to the row
            self.session.add(
                AuthAttempt(
                    kind=AttemptKind.INVITATION_MAIL,
                    subject_hash=self._hash(QUEUE_SUBJECT),
                    succeeded=True,
                    attempted_at=now,
                )
            )
        result = await self.session.execute(
            update(AuthInvitation)
            .where(
                AuthInvitation.id == queued.invitation_id,
                AuthInvitation.send_attempts == queued.attempt,
                AuthInvitation.send_due_at == queued.lease,
                AuthInvitation.accepted_at.is_(None),
            )
            .values(**values)
            .execution_options(synchronize_session=False)
        )
        await self.session.flush()
        return bool(result.rowcount)

    # --- Listing ---------------------------------------------------------------------------------

    async def list_for(self, caller: CurrentUserDTO) -> list[InvitationView]:
        """The chairman sees the building's invitations; an owner the TENANT invitations of the
        apartments they own; anyone else none. Newest first."""
        query = select(AuthInvitation).where(AuthInvitation.building_id == caller.building_id)
        if caller.building_role != BuildingRole.CHAIRMAN:
            owned = self._owned_apartments(caller)
            if not owned:
                return []
            query = query.where(
                AuthInvitation.kind == InvitationKind.TENANT,
                AuthInvitation.apartment_id.in_(owned),
            )
        rows = list(
            await self.session.scalars(
                query.order_by(AuthInvitation.created_at.desc(), AuthInvitation.id)
            )
        )
        return await self._views(rows, caller.id, _now())

    async def open_for_apartment(
        self, caller: CurrentUserDTO, apartment_id: uuid.UUID
    ) -> list[InvitationView]:
        """Not yet accepted invitations of one apartment that the caller may see (residents)."""
        query = select(AuthInvitation).where(
            AuthInvitation.apartment_id == apartment_id,
            AuthInvitation.building_id == caller.building_id,
            AuthInvitation.accepted_at.is_(None),
        )
        if caller.building_role != BuildingRole.CHAIRMAN:
            query = query.where(AuthInvitation.kind == InvitationKind.TENANT)
        rows = list(
            await self.session.scalars(
                query.order_by(AuthInvitation.created_at.desc(), AuthInvitation.id)
            )
        )
        return await self._views(rows, caller.id, _now())

    # --- The invitation link -------------------------------------------------------------------

    async def open_link(self, token_row: AuthToken, now: datetime) -> SignInResponse | None:
        """Redeeming an invitation link: a registration form for a new person, or "sign in to
        accept" for an existing account. None when the link cannot be used."""
        invitation = await self._usable_invitation(token_row, now)
        if invitation is None:
            return None
        preview = await self._preview(invitation)
        account = await self.properties.find_active_user_by_email(invitation.email)
        if account is not None:
            if account.building_id != invitation.building_id:
                return None
            # Nothing is applied and the link is not used up: the person signs in and accepts.
            return SignInResponse(status=SignInStatus.SIGN_IN_TO_ACCEPT, invitation=preview)
        await self.session.execute(
            delete(AuthToken)
            .where(
                AuthToken.invitation_id == invitation.id,
                AuthToken.purpose == TokenPurpose.REGISTRATION,
            )
            .execution_options(synchronize_session=False)
        )
        registration = secrets.token_urlsafe(TOKEN_BYTES)
        self.session.add(
            AuthToken(
                purpose=TokenPurpose.REGISTRATION,
                token_hash=self._hash(registration),
                invitation_id=invitation.id,
                created_at=now,
                expires_at=now + REGISTRATION_TTL,
            )
        )
        await self.session.flush()
        return SignInResponse(
            status=SignInStatus.REGISTRATION_REQUIRED,
            registration_token=registration,
            expires_in=int(REGISTRATION_TTL.total_seconds()),
            invitation=preview,
        )

    async def register(self, body: RegistrationRequest, user_agent: str | None) -> IssuedSession:
        """Create the invited person's account with its membership or role, and sign them in."""
        now = _now()
        token_hash = self._hash(body.registration_token)
        # The people lock before any row lock (the one order of PropertyService.lock_people):
        # find the building without a lock, then lock in order.
        building_id = await self.session.scalar(
            select(AuthInvitation.building_id)
            .join(AuthToken, AuthToken.invitation_id == AuthInvitation.id)
            .where(
                AuthToken.token_hash == token_hash, AuthToken.purpose == TokenPurpose.REGISTRATION
            )
        )
        if building_id is None:
            raise invalid_link()
        await self.properties.lock_people(building_id)
        await self.lock_invitation_of(token_hash)  # the invitation before its token rows
        token_row = await self.session.scalar(
            select(AuthToken)
            .where(
                AuthToken.token_hash == token_hash, AuthToken.purpose == TokenPurpose.REGISTRATION
            )
            .with_for_update()
        )
        if token_row is None or token_row.used_at is not None or token_row.expires_at <= now:
            raise invalid_link()
        invitation = await self._invitation_for_update(token_row.invitation_id)
        if (
            invitation is None
            or invitation.accepted_at is not None
            or invitation.expires_at <= now  # an expired one no longer holds a tenant's place
            or not await self._applies(invitation, {})
        ):
            raise invalid_link()
        # One registration per e-mail at a time, so two tabs cannot both create the account.
        await self.session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"auth:register:{self._hash('email:' + invitation.email)}"},
        )
        if await self.properties.find_active_user_by_email(invitation.email) is not None:
            raise conflict(
                "EMAIL_ALREADY_REGISTERED",
                "An account with this e-mail exists; sign in and accept the invitation.",
            )
        role = (
            BuildingRole(invitation.building_role)
            if invitation.kind == InvitationKind.STAFF and invitation.building_role
            else BuildingRole.USER
        )
        user_id = await self.properties.create_user(
            invitation.building_id,
            email=invitation.email,
            full_name=body.full_name,
            phone=body.phone,
            locale=body.locale,
            building_role=role,
        )
        membership_id = None
        if invitation.kind in _RELATION:
            assert invitation.apartment_id is not None
            membership_id = await self.properties.open_membership(
                user_id,
                invitation.apartment_id,
                _RELATION[invitation.kind],
                body.privacy_display_mode,
            )
        self._mark_accepted(invitation, user_id, membership_id, applied=True, now=now)
        await self._drop_links(invitation.id)
        return await AuthService(self.session, self.settings).start_session(
            user_id, AuthMethod.REGISTRATION, user_agent
        )

    async def accept(self, caller: CurrentUserDTO, token: str) -> bool:
        """An existing account accepts after signing in; True when anything changed. It never
        lowers anything: an existing membership stays, a staff role is not replaced."""
        now = _now()
        # Before any invitation row: closing an account takes this lock, then deletes rows.
        await self.properties.lock_people(caller.building_id)
        await self.lock_invitation_of(self._hash(token))
        token_row = await self.session.scalar(
            select(AuthToken)
            .where(
                AuthToken.token_hash == self._hash(token),
                AuthToken.purpose == TokenPurpose.INVITATION,
            )
            .with_for_update()
        )
        if token_row is None:
            raise invalid_link()
        invitation = await self._usable_invitation(token_row, now)
        if invitation is None or invitation.building_id != caller.building_id:
            raise invalid_link()
        account = await self.properties.find_active_user_by_email(invitation.email)
        if account is None or account.user_id != caller.id:
            raise invalid_link()  # another person's invitation: no hint why
        membership_id = None
        if invitation.kind in _RELATION:
            assert invitation.apartment_id is not None
            membership_id = await self.properties.open_membership(
                caller.id,
                invitation.apartment_id,
                _RELATION[invitation.kind],
                DisplayMode.APARTMENT_ONLY,
            )
            applied = membership_id is not None
            if not applied and invitation.kind == InvitationKind.OWNER:
                # Raising is not lowering: a tenant (or family member) who bought the flat.
                current = await self.properties.active_membership(
                    caller.id, invitation.apartment_id
                )
                if current is not None and await self.properties.raise_to_owner(
                    current.membership_id
                ):
                    applied, membership_id = True, current.membership_id
        else:
            assert invitation.building_role is not None
            applied = staff_invitation_applies(account.building_role, invitation.building_role)
            if applied:
                await self.properties.set_building_role(
                    caller.id, BuildingRole(invitation.building_role)
                )
        self._mark_accepted(invitation, caller.id, membership_id, applied=applied, now=now)
        await self._drop_links(invitation.id)
        await self.session.flush()
        return applied

    async def resend_for_sign_in(self, email: str, now: datetime) -> list[AuthMail]:
        """`POST /auth/magic-link` for an e-mail without an account: each of its pending
        invitations gets a new link with the same expiry (the old links stop working). One whose
        e-mail is still queued is left to the queue, so the person never gets two links."""
        rows = list(
            await self.session.scalars(
                select(AuthInvitation)
                .where(
                    AuthInvitation.email == email,
                    AuthInvitation.accepted_at.is_(None),
                    AuthInvitation.expires_at > now,
                    AuthInvitation.send_due_at.is_(None),
                )
                .order_by(AuthInvitation.created_at)
                .with_for_update()
            )
        )
        mails = []
        cache: dict[object, bool] = {}
        for invitation in rows:
            if not await self._applies(invitation, cache):
                continue
            token = await self._new_link(invitation, now)
            place = await self._apartment_of(invitation)
            mails.append(await self._mail(invitation, place, token))
        return mails

    # --- For the system (the first chairman) -----------------------------------------------------

    async def invite_first_chairman(
        self, building_id: uuid.UUID, email: str
    ) -> tuple[uuid.UUID, AuthMail]:
        """A STAFF invitation with CHAIRMAN on behalf of the system; replaces an open one."""
        now = _now()
        await self.session.execute(
            delete(AuthInvitation)
            .where(
                AuthInvitation.kind == InvitationKind.STAFF,
                AuthInvitation.email == email,
                AuthInvitation.building_role == StaffRole.CHAIRMAN,
                AuthInvitation.accepted_at.is_(None),
            )
            .execution_options(synchronize_session=False)
        )
        invitation = AuthInvitation(
            building_id=building_id,
            kind=InvitationKind.STAFF,
            email=email,
            building_role=StaffRole.CHAIRMAN,
            invited_by_user_id=None,
            created_at=now,
            last_sent_at=now,
            expires_at=now + INVITATION_TTL,
        )
        self.session.add(invitation)
        await self.session.flush()
        token = await self._new_link(invitation, now)
        return invitation.id, await self._mail(invitation, None, token)

    # --- E-mails a caller typed (residents, people) ---------------------------------------------

    async def invited_emails_by_membership(
        self, caller_id: uuid.UUID, membership_ids: Iterable[uuid.UUID]
    ) -> dict[uuid.UUID, str]:
        """For each membership an invitation of the caller created or reopened: its e-mail."""
        ids = list(membership_ids)
        if not ids:
            return {}
        rows = await self.session.execute(
            select(AuthInvitation.membership_id, AuthInvitation.email)
            .where(
                AuthInvitation.membership_id.in_(ids),
                AuthInvitation.invited_by_user_id == caller_id,
            )
            .order_by(AuthInvitation.accepted_at)  # the newest wins below
        )
        return {membership_id: email for membership_id, email in rows.all() if membership_id}

    async def invited_emails_by_staff(
        self, caller_id: uuid.UUID, roles: dict[uuid.UUID, BuildingRole]
    ) -> dict[uuid.UUID, str]:
        """For each person: the e-mail of the newest applied STAFF invitation the caller typed for
        the person's current role."""
        if not roles:
            return {}
        rows = await self.session.execute(
            select(
                AuthInvitation.accepted_user_id,
                AuthInvitation.building_role,
                AuthInvitation.email,
            )
            .where(
                AuthInvitation.kind == InvitationKind.STAFF,
                AuthInvitation.applied.is_(True),
                AuthInvitation.accepted_user_id.in_(list(roles)),
                AuthInvitation.invited_by_user_id == caller_id,
            )
            .order_by(AuthInvitation.accepted_at)
        )
        found: dict[uuid.UUID, str] = {}
        for user_id, role, email in rows.all():
            if user_id is not None and roles.get(user_id) == role:
                found[user_id] = email
        return found

    async def drop_for_closed_account(self, user_id: uuid.UUID, building_id: uuid.UUID) -> None:
        """Before an account is closed: delete the invitations to its e-mail (open ones, and the
        accepted ones, which still hold the address). The caller holds the people lock."""
        emails = set(
            await self.session.scalars(
                select(AuthInvitation.email).where(
                    AuthInvitation.building_id == building_id,
                    AuthInvitation.accepted_at.is_(None),
                )
            )
        )
        owners = await self.properties.active_users_by_emails(emails)
        own = [email for email, owner in owners.items() if owner == user_id]
        conditions = [AuthInvitation.accepted_user_id == user_id]
        if own:
            conditions.append(
                and_(AuthInvitation.email.in_(own), AuthInvitation.accepted_at.is_(None))
            )
        for condition in conditions:
            await self.session.execute(
                delete(AuthInvitation).where(condition).execution_options(synchronize_session=False)
            )

    # --- Internals ------------------------------------------------------------------------------

    @staticmethod
    def _accepted() -> DomainError:
        return conflict(
            "INVITATION_ACCEPTED",
            "The invitation was accepted; to take access away, end the membership.",
        )

    @staticmethod
    def _owned_apartments(caller: CurrentUserDTO) -> list[uuid.UUID]:
        return [m.apartment_id for m in caller.memberships if m.relation_type == RelationType.OWNER]

    async def _visible_for_update(
        self, caller: CurrentUserDTO, invitation_id: uuid.UUID
    ) -> AuthInvitation:
        """The chairman reaches every invitation of the building; an owner the TENANT ones of
        their apartments; otherwise it does not exist (404)."""
        invitation = await self._invitation_for_update(invitation_id)
        if invitation is None or invitation.building_id != caller.building_id:
            raise invitation_not_found()
        if caller.building_role == BuildingRole.CHAIRMAN:
            return invitation
        if (
            invitation.kind == InvitationKind.TENANT
            and invitation.apartment_id in self._owned_apartments(caller)
        ):
            return invitation
        raise invitation_not_found()

    async def lock_invitation_of(self, token_hash: str) -> None:
        """Lock the invitation of a link before the link's own row: the order is the people lock,
        an apartment, the invitation, then its tokens (registering in one tab while the link opens
        in another must not deadlock). A token without an invitation locks nothing."""
        invitation_id = await self.session.scalar(
            select(AuthToken.invitation_id).where(AuthToken.token_hash == token_hash)
        )
        await self._invitation_for_update(invitation_id)

    async def _invitation_for_update(
        self, invitation_id: uuid.UUID | None
    ) -> AuthInvitation | None:
        # A path that later changes people must hold PropertyService.lock_people already, or
        # it can deadlock with one that took the people lock first.
        if invitation_id is None:
            return None
        return await self.session.scalar(
            select(AuthInvitation).where(AuthInvitation.id == invitation_id).with_for_update()
        )

    async def _usable_invitation(
        self, token_row: AuthToken, now: datetime
    ) -> AuthInvitation | None:
        if token_row.used_at is not None or token_row.expires_at <= now:
            return None
        invitation = await self._invitation_for_update(token_row.invitation_id)
        if (
            invitation is None
            or invitation.accepted_at is not None
            or invitation.expires_at <= now
            or not await self._applies(invitation, {})
        ):
            return None
        return invitation

    async def _check_limit(self, inviter_id: uuid.UUID, now: datetime) -> None:
        """At most 10 invitations and resends per inviter per hour (429, not silent)."""
        subject = self._hash(user_subject(inviter_id))
        recent = list(
            await self.session.scalars(
                select(AuthAttempt.attempted_at)
                .where(
                    AuthAttempt.kind == AttemptKind.INVITATION,
                    AuthAttempt.subject_hash == subject,
                    AuthAttempt.attempted_at > now - HOUR,
                )
                .order_by(AuthAttempt.attempted_at)
            )
        )
        if len(recent) >= INVITATIONS_PER_INVITER_PER_HOUR:
            raise rate_limited(max(int((recent[0] + HOUR - now).total_seconds()), 1))

    def _record_send(self, inviter_id: uuid.UUID, now: datetime) -> None:
        self.session.add(
            AuthAttempt(
                kind=AttemptKind.INVITATION,
                subject_hash=self._hash(user_subject(inviter_id)),
                succeeded=True,
                attempted_at=now,
            )
        )

    async def _check_tenant_limit(self, apartment_id: uuid.UUID, now: datetime) -> None:
        """Active tenants plus pending tenant invitations, under the apartment's lock."""
        pending = await self.session.scalar(
            select(func.count(AuthInvitation.id)).where(
                AuthInvitation.kind == InvitationKind.TENANT,
                AuthInvitation.apartment_id == apartment_id,
                AuthInvitation.accepted_at.is_(None),
                AuthInvitation.expires_at > now,
            )
        )
        tenants = await self.properties.active_tenant_count(apartment_id)
        if tenants + int(pending or 0) >= self.settings.MAX_TENANTS_PER_APARTMENT:
            raise conflict(
                "TENANT_LIMIT_REACHED",
                "The apartment has the most tenants allowed, pending invitations included.",
            )

    async def _new_link(
        self, invitation: AuthInvitation, now: datetime, expires_at: datetime | None = None
    ) -> str:
        """A new invitation link that lives as long as the invitation (or until `expires_at`, the
        expiry the queue sets once the e-mail went out); every older link of the invitation (and a
        registration form in progress) stops working."""
        await self._drop_links(invitation.id)
        token = secrets.token_urlsafe(TOKEN_BYTES)
        self.session.add(
            AuthToken(
                purpose=TokenPurpose.INVITATION,
                token_hash=self._hash(token),
                invitation_id=invitation.id,
                created_at=now,
                expires_at=expires_at or invitation.expires_at,
            )
        )
        await self.session.flush()
        return token

    async def _drop_links(self, invitation_id: uuid.UUID) -> None:
        await self.session.execute(
            delete(AuthToken)
            .where(AuthToken.invitation_id == invitation_id)
            .execution_options(synchronize_session=False)
        )

    @staticmethod
    def _mark_accepted(
        invitation: AuthInvitation,
        user_id: uuid.UUID,
        membership_id: uuid.UUID | None,
        *,
        applied: bool,
        now: datetime,
    ) -> None:
        invitation.accepted_at = now
        invitation.accepted_user_id = user_id
        invitation.membership_id = membership_id
        invitation.applied = applied
        invitation.send_due_at = None  # nothing more to send

    async def _status(
        self, invitation: AuthInvitation, now: datetime, cache: dict[object, bool]
    ) -> InvitationStatus:
        return invitation_status(
            accepted=invitation.accepted_at is not None,
            applies=invitation.accepted_at is not None or await self._applies(invitation, cache),
            expires_at=invitation.expires_at,
            now=now,
        )

    async def _apartment_of(self, invitation: AuthInvitation) -> ObjectRef | None:
        if invitation.apartment_id is None:
            return None
        ref = await self.properties.apartment_ref(invitation.apartment_id)
        return ObjectRef(ref.kind, ref.number) if ref else None

    async def _preview(self, invitation: AuthInvitation) -> InvitationPreview:
        place = await self._apartment_of(invitation)
        return InvitationPreview(
            kind=invitation.kind,
            apartment_number=place.number if place else None,
            apartment_kind=place.kind if place else None,
            building_role=invitation.building_role,
            country_code=await self.properties.building_country(invitation.building_id),
        )

    async def _views(
        self, rows: list[AuthInvitation], caller_id: uuid.UUID, now: datetime
    ) -> list[InvitationView]:
        cache: dict[object, bool] = {}
        places: dict[uuid.UUID, ObjectRef | None] = {}
        views = []
        for invitation in rows:
            if invitation.apartment_id is not None and invitation.apartment_id not in places:
                places[invitation.apartment_id] = await self._apartment_of(invitation)
            place = places.get(invitation.apartment_id) if invitation.apartment_id else None
            mine = invitation.invited_by_user_id == caller_id
            views.append(
                InvitationView(
                    invitation_id=invitation.id,
                    kind=invitation.kind,
                    email=invitation.email if mine else mask_email(invitation.email),
                    apartment_id=invitation.apartment_id,
                    apartment_number=place.number if place else None,
                    apartment_kind=place.kind if place else None,
                    building_role=invitation.building_role,
                    status=await self._status(invitation, now, cache),
                    mine=mine,
                    locale=invitation.locale,
                    delivery=delivery_of(invitation.send_due_at, invitation.send_failures),
                    created_at=invitation.created_at,
                    expires_at=invitation.expires_at,
                )
            )
        return views

    async def _mail(
        self, invitation: AuthInvitation, place: ObjectRef | None, token: str
    ) -> AuthMail:
        """The invitation e-mail, in the language of the account if the e-mail has one (only the
        mailbox owner sees which), else the invitation's language, else the instance default."""
        account = await self.properties.find_active_user_by_email(invitation.email)
        locale = (
            (account.locale if account else None)
            or invitation.locale
            or self.settings.DEFAULT_LOCALE
        )
        return AuthMail(
            email=invitation.email,
            locale=locale,
            kind="invitation",
            link=sign_in_link(self.settings.PUBLIC_BASE_URL, token),
            values={
                "target": invitation_target(
                    locale, invitation.kind, place, invitation.building_role
                )
            },
        )


async def delete_old_invitations(session: AsyncSession, now: datetime) -> int:
    """For the clean-up loop (docs/SCHEMA.md 7, retention). Kept while they explain something:
    - an open invitation: until 30 days after it expired;
    - an accepted one that created or reopened a membership: until 30 days after that ended;
    - an applied STAFF invitation: while its person is active and holds that role;
    - any other accepted one: 30 days after acceptance.
    """
    cutoff = now - INVITATION_RETENTION
    properties = PropertyService(session)
    doomed: list[uuid.UUID] = list(
        await session.scalars(
            select(AuthInvitation.id).where(
                AuthInvitation.accepted_at.is_(None), AuthInvitation.expires_at < cutoff
            )
        )
    )
    accepted = (
        await session.execute(
            select(
                AuthInvitation.id,
                AuthInvitation.kind,
                AuthInvitation.applied,
                AuthInvitation.membership_id,
                AuthInvitation.accepted_user_id,
                AuthInvitation.building_role,
                AuthInvitation.accepted_at,
            ).where(AuthInvitation.accepted_at.is_not(None))
        )
    ).all()
    ended = await properties.membership_end_times(
        row.membership_id for row in accepted if row.membership_id is not None
    )
    staff = [
        row
        for row in accepted
        if row.membership_id is None and row.kind == InvitationKind.STAFF and row.applied
    ]
    staff_ids = {row.id for row in staff}
    roles = await properties.building_roles(
        row.accepted_user_id for row in staff if row.accepted_user_id is not None
    )
    for row in accepted:
        if row.membership_id is not None:
            end = ended.get(row.membership_id)
            if end is not None and end < cutoff:
                doomed.append(row.id)
        elif row.id in staff_ids:
            if row.accepted_user_id is None or roles.get(row.accepted_user_id) != row.building_role:
                doomed.append(row.id)
        elif row.accepted_at is not None and row.accepted_at < cutoff:
            doomed.append(row.id)
    if not doomed:
        return 0
    result = await session.execute(
        delete(AuthInvitation)
        .where(AuthInvitation.id.in_(doomed))
        .execution_options(synchronize_session=False)
    )
    return result.rowcount or 0
