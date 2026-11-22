"""Join codes on paper and join requests (epic E13 R4c; docs/API.md 7, "Join codes on paper";
docs/ARCHITECTURE.md 4.10).

The chairman issues one-time codes for printed sheets; a person looks one up on the public join
page and leaves a request with their full name, phone and e-mail; the chairman confirms it (an
ordinary OWNER invitation through the queue, InvitationService) or rejects it. The request's data
live only until the decision; a decision record without personal data stays. Codes are kept as
keyed hashes only. Nothing personal and no code ever reaches a log line or a span.
"""

import uuid
from datetime import UTC, datetime, timedelta
from importlib import resources

import structlog
from sqlalchemy import delete, func, or_, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.building_settings import BuildingSettings
from src.core.config import Settings
from src.core.event_bus import EventOutbox
from src.core.exceptions import DomainError
from src.modules.auth.connections import ConnectionService
from src.modules.auth.errors import apartment_not_found, forbidden, not_found, rate_limited
from src.modules.auth.events import JoinRequestSubmitted
from src.modules.auth.invitations import InvitationService
from src.modules.auth.models import AuthAttempt, AuthJoinCode, AuthJoinDecision, AuthJoinRequest
from src.modules.auth.policies import (
    JOIN_CODE_RETENTION,
    JOIN_REQUEST_RETENTION,
    JOINS_PER_IP_PER_HOUR,
    format_join_code,
    ip_subject,
    join_code_subject,
    keyed_hash,
    new_join_code,
    normalise_join_code,
)
from src.modules.auth.schemas import (
    AttemptKind,
    ConnectionStatus,
    InvitationView,
    IssuedJoinCode,
    JoinCodesIssued,
    JoinCodeView,
    JoinDecisionView,
    JoinOutcome,
    JoinRequestView,
    JoinSubmit,
    JoinTarget,
    PrivacyNotice,
)
from src.modules.auth.settings import PRIVACY_NOTICE_URL
from src.modules.property.schemas import BuildingRole, CurrentUserDTO, Locale
from src.modules.property.service import PropertyService

logger = structlog.get_logger(__name__)
HOUR = timedelta(hours=1)
JOIN_PATH = "/join"
# Looked up for a text that cannot be a code (lower case: never a normalised code).
NEVER_A_CODE = "not-a-code"
NOTICE_LOCALES = frozenset({Locale.ET, Locale.EN})
# The apartments a default issue picks: no active owner and nothing going on (docs/API.md 7).
_NOTHING_PENDING = frozenset(
    {
        ConnectionStatus.NOT_INVITED,
        ConnectionStatus.EXPIRED,
        ConnectionStatus.PAPER,
        ConnectionStatus.TENANT_ONLY,
    }
)
_DECISION_READERS = frozenset({BuildingRole.CHAIRMAN, BuildingRole.BOARD})


def _now() -> datetime:
    return datetime.now(UTC)


def invalid_join_code() -> DomainError:
    """One answer for a wrong, used, expired or cancelled code."""
    return DomainError(
        status_code=400, error_code="INVALID_JOIN_CODE", message="This code cannot be used."
    )


def demo_not_found() -> DomainError:
    """Join codes do not exist in demo mode: like an unknown route."""
    return DomainError(status_code=404, error_code="NOT_FOUND", message="Not found.")


def notice_template(locale: Locale) -> str:
    """The platform's template privacy notice (Markdown) in et or en."""
    name = f"{locale.value if locale in NOTICE_LOCALES else Locale.EN.value}.md"
    return (resources.files("src.modules.auth") / "privacy_notice" / name).read_text("utf-8")


class JoinService:
    def __init__(
        self, session: AsyncSession, settings: Settings, outbox: EventOutbox | None = None
    ) -> None:
        if settings.DEMO_MODE_ENABLED:
            raise demo_not_found()
        self.session = session
        self.settings = settings
        self.outbox = outbox
        self.properties = PropertyService(session)

    def _hash(self, value: str) -> str:
        return keyed_hash(self.settings.AUTH_HASH_SECRET.get_secret_value(), value)

    @staticmethod
    def _chairman(caller: CurrentUserDTO) -> None:
        if caller.building_role != BuildingRole.CHAIRMAN:
            raise forbidden()

    async def _numbers(self, building_id: uuid.UUID) -> dict[uuid.UUID, str]:
        return {a.id: a.number for a in await self.properties.list_apartments(building_id)}

    # --- The chairman: codes ------------------------------------------------------------------

    async def issue(
        self, caller: CurrentUserDTO, apartment_ids: list[uuid.UUID] | None
    ) -> JoinCodesIssued:
        self._chairman(caller)
        now = _now()
        await self.properties.lock_people(caller.building_id)
        numbers = await self._numbers(caller.building_id)
        if apartment_ids is None:
            items = await ConnectionService(self.session).items(caller.building_id)
            chosen = [item.apartment_id for item in items if item.status in _NOTHING_PENDING]
        else:
            if len(set(apartment_ids)) != len(apartment_ids) or len(apartment_ids) > len(numbers):
                raise DomainError(
                    status_code=422,
                    error_code="VALIDATION_ERROR",
                    message="The request is invalid.",
                    extra={
                        "errors": [
                            {
                                "loc": ["body", "apartment_ids"],
                                "message": "repeated ids, or more ids than apartments",
                                "type": "value_error",
                            }
                        ]
                    },
                )
            if any(apartment_id not in numbers for apartment_id in apartment_ids):
                raise apartment_not_found()
            chosen = apartment_ids
        expires_at = now + timedelta(days=self.settings.AUTH_JOIN_CODE_DAYS)
        issued = []
        for apartment_id in chosen:
            code = new_join_code()
            row = AuthJoinCode(
                building_id=caller.building_id,
                apartment_id=apartment_id,
                code_hash=self._hash(join_code_subject(code)),
                created_by_user_id=caller.id,
                created_at=now,
                expires_at=expires_at,
            )
            self.session.add(row)
            await self.session.flush()
            issued.append(
                IssuedJoinCode(
                    code_id=row.id,
                    apartment_id=apartment_id,
                    apartment_number=numbers[apartment_id],
                    join_code=format_join_code(code),
                    expires_at=expires_at,
                )
            )
        logger.info("auth_join_codes_issued", count=len(issued))
        return JoinCodesIssued(
            association_name=await self.properties.building_name(caller.building_id) or "",
            join_url=self.settings.PUBLIC_BASE_URL.rstrip("/") + JOIN_PATH,
            codes=issued,
        )

    async def codes(self, caller: CurrentUserDTO) -> list[JoinCodeView]:
        self._chairman(caller)
        numbers = await self._numbers(caller.building_id)
        rows = await self.session.scalars(
            select(AuthJoinCode)
            .where(AuthJoinCode.building_id == caller.building_id, *self._usable(_now()))
            .order_by(AuthJoinCode.created_at.desc(), AuthJoinCode.id)
        )
        return [
            JoinCodeView(
                code_id=row.id,
                apartment_id=row.apartment_id,
                apartment_number=numbers.get(row.apartment_id, ""),
                created_at=row.created_at,
                expires_at=row.expires_at,
            )
            for row in rows
        ]

    async def cancel(self, caller: CurrentUserDTO, code_id: uuid.UUID) -> None:
        self._chairman(caller)
        now = _now()
        result = await self.session.execute(
            update(AuthJoinCode)
            .where(
                AuthJoinCode.id == code_id,
                AuthJoinCode.building_id == caller.building_id,
                *self._usable(now),
            )
            .values(cancelled_at=now)
            .execution_options(synchronize_session=False)
        )
        if not result.rowcount:
            raise not_found("JOIN_CODE_NOT_FOUND", "No such unused join code.")

    @staticmethod
    def _usable(now: datetime) -> tuple:
        return (
            AuthJoinCode.used_at.is_(None),
            AuthJoinCode.cancelled_at.is_(None),
            AuthJoinCode.expires_at > now,
        )

    # --- The public join page -----------------------------------------------------------------

    async def _building(self) -> uuid.UUID:
        """The installation's building (one per installation today, BACKLOG B-1)."""
        ids = await self.properties.building_ids()
        if not ids:
            raise demo_not_found()
        return ids[0]

    async def privacy_notice(self, locale: str | None) -> PrivacyNotice:
        building_id = await self._building()
        custom = await BuildingSettings(self.session).get(building_id, PRIVACY_NOTICE_URL)
        shown = Locale(locale) if locale in {item.value for item in NOTICE_LOCALES} else Locale.EN
        if custom:
            return PrivacyNotice(custom_url=custom, locale=shown, text=None)
        name = await self.properties.building_name(building_id) or ""
        text = notice_template(shown).replace("{association_name}", name)
        text = text.replace("{site_url}", self.settings.PUBLIC_BASE_URL.rstrip("/"))
        return PrivacyNotice(custom_url=None, locale=shown, text=text)

    async def _limit(self, address: str, now: datetime) -> None:
        """At most 20 lookups and submits per IP address per hour; every one counts. One request
        per address at a time, so a burst cannot pass the count together."""
        subject = self._hash(ip_subject(address))
        await self.session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": f"auth:join:{subject}"},
        )
        recent = list(
            await self.session.scalars(
                select(AuthAttempt.attempted_at)
                .where(
                    AuthAttempt.kind == AttemptKind.JOIN,
                    AuthAttempt.subject_hash == subject,
                    AuthAttempt.attempted_at > now - HOUR,
                )
                .order_by(AuthAttempt.attempted_at)
            )
        )
        if len(recent) >= JOINS_PER_IP_PER_HOUR:
            raise rate_limited(max(int((recent[0] + HOUR - now).total_seconds()), 1))
        self.session.add(
            AuthAttempt(
                kind=AttemptKind.JOIN, subject_hash=subject, succeeded=True, attempted_at=now
            )
        )
        await self.session.flush()

    def _code_hash(self, typed: str) -> str:
        """The hash to look up; a text that cannot be a code is looked up as a code that never
        exists, so every failure does the same work."""
        code = normalise_join_code(typed) or NEVER_A_CODE
        return self._hash(join_code_subject(code))

    async def lookup(self, typed: str, address: str) -> JoinTarget:
        now = _now()
        await self._limit(address, now)
        code_hash = self._code_hash(typed)
        row = await self.session.scalar(
            select(AuthJoinCode).where(AuthJoinCode.code_hash == code_hash, *self._usable(now))
        )
        if row is None:
            await self.session.commit()  # the failed attempt counts
            raise invalid_join_code()
        numbers = await self._numbers(row.building_id)
        return JoinTarget(
            association_name=await self.properties.building_name(row.building_id) or "",
            apartment_number=numbers.get(row.apartment_id, ""),
        )

    async def submit(self, body: JoinSubmit, address: str) -> None:
        """Use the code up and store the request in one transaction; the answer never depends on
        whether the e-mail has an account, and nothing is sent to it."""
        now = _now()
        await self._limit(address, now)
        code_hash = self._code_hash(body.join_code)
        used = (
            await self.session.execute(
                update(AuthJoinCode)
                .where(AuthJoinCode.code_hash == code_hash, *self._usable(now))
                .values(used_at=now)
                .returning(AuthJoinCode.id, AuthJoinCode.building_id, AuthJoinCode.apartment_id)
                .execution_options(synchronize_session=False)
            )
        ).first()
        if used is None:
            await self.session.commit()  # the failed attempt counts
            raise invalid_join_code()
        code_id, building_id, apartment_id = used
        request = AuthJoinRequest(
            building_id=building_id,
            apartment_id=apartment_id,
            code_id=code_id,
            full_name=body.full_name,
            phone=body.phone,
            email=body.email,
            locale=body.locale,
            created_at=now,
        )
        self.session.add(request)
        await self.session.flush()
        numbers = await self._numbers(building_id)
        if self.outbox is not None:
            self.outbox.add(
                JoinRequestSubmitted(
                    building_id=building_id,
                    request_id=request.id,
                    apartment_id=apartment_id,
                    apartment_number=numbers.get(apartment_id, ""),
                )
            )
        logger.info(
            "auth_join_request_submitted",
            request_id=str(request.id),
            apartment_id=str(apartment_id),
        )
        waiting = await self.session.scalar(
            select(func.count(AuthJoinRequest.id)).where(AuthJoinRequest.building_id == building_id)
        )
        if int(waiting or 0) > len(numbers):
            logger.warning(
                "auth_join_requests_many", building_id=str(building_id), waiting=int(waiting or 0)
            )

    # --- The chairman: requests and decisions -------------------------------------------------

    async def requests(self, caller: CurrentUserDTO) -> list[JoinRequestView]:
        self._chairman(caller)
        numbers = await self._numbers(caller.building_id)
        rows = await self.session.scalars(
            select(AuthJoinRequest)
            .where(AuthJoinRequest.building_id == caller.building_id)
            .order_by(AuthJoinRequest.created_at, AuthJoinRequest.id)
        )
        return [
            JoinRequestView(
                request_id=row.id,
                apartment_id=row.apartment_id,
                apartment_number=numbers.get(row.apartment_id, ""),
                full_name=row.full_name,
                phone=row.phone,
                email=row.email,
                locale=row.locale,
                created_at=row.created_at,
            )
            for row in rows
        ]

    async def _request_for_update(
        self, caller: CurrentUserDTO, request_id: uuid.UUID
    ) -> AuthJoinRequest:
        self._chairman(caller)
        await self.properties.lock_people(caller.building_id)
        row = await self.session.scalar(
            select(AuthJoinRequest)
            .where(
                AuthJoinRequest.id == request_id,
                AuthJoinRequest.building_id == caller.building_id,
            )
            .with_for_update()
        )
        if row is None:
            raise not_found("JOIN_REQUEST_NOT_FOUND", "No such waiting join request.")
        return row

    def _decide(
        self, row: AuthJoinRequest, outcome: JoinOutcome, user_id: uuid.UUID | None
    ) -> None:
        self.session.add(
            AuthJoinDecision(
                building_id=row.building_id,
                apartment_id=row.apartment_id,
                outcome=outcome,
                decided_by_user_id=user_id,
                decided_at=_now(),
            )
        )

    async def confirm(self, caller: CurrentUserDTO, request_id: uuid.UUID) -> InvitationView:
        row = await self._request_for_update(caller, request_id)
        invitations = InvitationService(self.session, self.settings)
        locale = (
            row.locale if row.locale and row.locale.value in invitations.offered_locales() else None
        )
        view = await invitations.invite_from_join(caller, row.email, row.apartment_id, locale)
        self._decide(row, JoinOutcome.CONFIRMED, caller.id)
        await self.session.delete(row)
        await self.session.flush()
        logger.info("auth_join_request_decided", request_id=str(request_id), outcome="CONFIRMED")
        return view

    async def reject(self, caller: CurrentUserDTO, request_id: uuid.UUID) -> None:
        row = await self._request_for_update(caller, request_id)
        self._decide(row, JoinOutcome.REJECTED, caller.id)
        await self.session.delete(row)
        await self.session.flush()
        logger.info("auth_join_request_decided", request_id=str(request_id), outcome="REJECTED")

    async def decisions(
        self, caller: CurrentUserDTO, limit: int, offset: int
    ) -> list[JoinDecisionView]:
        if caller.building_role not in _DECISION_READERS:
            raise forbidden()
        numbers = await self._numbers(caller.building_id)
        rows = await self.session.scalars(
            select(AuthJoinDecision)
            .where(AuthJoinDecision.building_id == caller.building_id)
            .order_by(AuthJoinDecision.decided_at.desc(), AuthJoinDecision.id)
            .limit(limit)
            .offset(offset)
        )
        return [
            JoinDecisionView(
                apartment_id=row.apartment_id,
                apartment_number=numbers.get(row.apartment_id) if row.apartment_id else None,
                outcome=row.outcome,
                decided_by_user_id=row.decided_by_user_id,
                decided_at=row.decided_at,
            )
            for row in rows
        ]


async def delete_old_join_rows(session: AsyncSession, now: datetime) -> dict[str, int]:
    """For the clean-up loop (docs/SCHEMA.md 7, retention): an undecided request older than 30
    days goes with an EXPIRED decision; a code used, cancelled or expired more than 30 days ago
    goes. Works in any mode (demo mode has no codes)."""
    request_cutoff = now - JOIN_REQUEST_RETENTION
    expired = list(
        await session.scalars(
            select(AuthJoinRequest)
            .where(AuthJoinRequest.created_at < request_cutoff)
            # A locked request is being decided right now; it never waits for that (lock order).
            .with_for_update(skip_locked=True)
        )
    )
    for row in expired:
        session.add(
            AuthJoinDecision(
                building_id=row.building_id,
                apartment_id=row.apartment_id,
                outcome=JoinOutcome.EXPIRED,
                decided_by_user_id=None,
                decided_at=now,
            )
        )
        await session.delete(row)
    code_cutoff = now - JOIN_CODE_RETENTION
    codes = await session.execute(
        delete(AuthJoinCode)
        .where(
            or_(
                AuthJoinCode.used_at < code_cutoff,
                AuthJoinCode.cancelled_at < code_cutoff,
                AuthJoinCode.expires_at < code_cutoff,
            )
        )
        .execution_options(synchronize_session=False)
    )
    await session.flush()
    # Not "join_codes": that key holds the scrubber marker, so the count would be redacted.
    return {"join_requests": len(expired), "codes_on_paper": codes.rowcount or 0}
