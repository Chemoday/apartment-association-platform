"""Public facade of the meters module: readings, the chairman matrix, estimates and export.

Rules live in docs/API.md (sections 2 and 3) and docs/ROADMAP_MVP.md (sections B and C).
Apartments and author badges come from PropertyService; property models are never imported.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import Depends
from opentelemetry import trace
from sqlalchemy import and_, exists, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.core.database import DbSession, get_event_outbox
from src.core.event_bus import EventOutbox
from src.core.exceptions import DomainError
from src.modules.meters.events import (
    MeterReadingSubmitted,
    ReadingPeriodOpened,
    ReadingPeriodStatusChanged,
)
from src.modules.meters.models import MeterDevice, MeterReading, MeterReadingLog, ReadingPeriod
from src.modules.meters.policies import (
    PERIOD_TRANSITIONS,
    PreviousPeriod,
    ReadingCheckStatus,
    SubmissionTarget,
    apartment_submission_status,
    average_per_apartment,
    calculate_rolling_average_delta,
    can_transition_period,
    consumption_per_area,
    meter_submission_status,
    period_code_of,
    period_due_date,
    previous_period_code,
    rolling_average_delta,
    submission_target,
    total_consumption,
    validate_reading_delta,
)
from src.modules.meters.schemas import (
    APARTMENT_HISTORY_PERIODS,
    METER_VALUE_MAX,
    ApartmentConsumptionMonth,
    ApartmentConsumptionResponse,
    ApartmentConsumptionSeries,
    ApartmentMeterHistory,
    ApartmentReading,
    ApartmentReadingsResponse,
    BuildingConsumptionMonth,
    BuildingConsumptionResponse,
    BuildingConsumptionSeries,
    DashboardApartment,
    DashboardMeter,
    DashboardResponse,
    DuePeriodRefDTO,
    EstimatedReading,
    EstimateResponse,
    HistoryEntry,
    MasterMeterRow,
    MatrixApartment,
    MatrixMeter,
    MatrixResponse,
    MeterUnit,
    NewMeter,
    NextSubmission,
    PeriodDTO,
    PeriodListResponse,
    PeriodStatus,
    PeriodStatusUpdateResponse,
    PreviousOrigin,
    ReadingHistoryResponse,
    ReadingResponse,
    ReadingSource,
    ReadingSubmitRequest,
    ReadingSummary,
    ResourceBalance,
    ResourceType,
    canonical_meter_value,
)
from src.modules.property.schemas import ApartmentRefDTO, BuildingRole, CurrentUserDTO
from src.modules.property.service import PropertyService, get_property_service
from src.plugins.registry import ReadingExporter, ReadingExportRow

STAFF_VIEW_ROLES = frozenset({BuildingRole.CHAIRMAN, BuildingRole.BOARD, BuildingRole.ACCOUNTANT})
OVERRIDE_ROLES = frozenset({BuildingRole.CHAIRMAN, BuildingRole.ACCOUNTANT})

# Readings that count as consumption history (docs/ROADMAP_MVP.md, section C).
HISTORY_SOURCES = (ReadingSource.RESIDENT, ReadingSource.ADMIN_OVERRIDE, ReadingSource.IOT_WEBHOOK)
NO_HISTORY_AVERAGE = Decimal("0.000")
ESTIMATE_REASON = "3-month avg estimate"


tracer = trace.get_tracer(__name__)


@dataclass(frozen=True, slots=True)
class _PastReading:
    period_code: str
    value: Decimal
    delta: Decimal
    # Counts as consumption history: HISTORY_SOURCES, not a confirmed anomaly, not a start.
    history: bool
    start: bool  # the reading started the meter (no consumption, epic E13 R3b)


class _MeterHistories:
    """The readings of a few meters, newest period first, from one query (issue #168).

    The dashboard used to ask per meter, in separate queries and some twice, for the previous
    value, the previous delta and the last 3 history deltas. The answers are those of
    `_previous` and `_history_deltas` for the same meter and period.
    """

    def __init__(self, rows: dict[uuid.UUID, list[_PastReading]]) -> None:
        self._rows = rows

    def _before(self, meter_id: uuid.UUID, period: ReadingPeriod | None) -> list[_PastReading]:
        rows = self._rows.get(meter_id, [])
        if period is None:
            return rows
        return [row for row in rows if row.period_code < period.period_code]

    def previous_value(self, meter: MeterDevice, period: ReadingPeriod | None) -> Decimal | None:
        """As MetersService._previous: None for a meter without a start before the period."""
        before = self._before(meter.id, period)
        return before[0].value if before else meter.initial_value

    def previous_delta(self, meter_id: uuid.UUID, period: ReadingPeriod) -> Decimal | None:
        before = self._before(meter_id, period)
        # A start has no consumption: it is no "last month's consumption" either.
        return before[0].delta if before and not before[0].start else None

    def history_deltas(self, meter_id: uuid.UUID, period: ReadingPeriod) -> list[Decimal]:
        deltas = [row.delta for row in self._before(meter_id, period) if row.history][:3]
        return list(reversed(deltas))


def _now() -> datetime:
    """The current time; tests replace it (the month of a reading depends on it)."""
    return datetime.now(UTC)


def _not_found(error_code: str, message: str) -> DomainError:
    return DomainError(status_code=404, error_code=error_code, message=message)


def _summary(reading: MeterReading) -> ReadingSummary:
    return ReadingSummary(
        reading_id=reading.id,
        value=reading.value,
        consumption_delta=reading.consumption_delta,
        source=reading.source,
        is_anomaly_confirmed=reading.is_anomaly_confirmed,
        previous_origin=reading.previous_origin,
    )


def _period_dto(period: ReadingPeriod) -> PeriodDTO:
    return PeriodDTO(period_code=period.period_code, status=period.status, due_date=period.due_date)


class MetersService:
    def __init__(
        self,
        session: AsyncSession,
        property_service: PropertyService,
        outbox: EventOutbox | None = None,
    ):
        self.session = session
        self.property_service = property_service
        # Events go out only after the request's transaction commits (docs/BACKEND_CONVENTIONS.md).
        # None only for system-level readers (e.g. notifications), which never write.
        self.outbox = outbox
        self.timezone = ZoneInfo(get_settings().INSTANCE_TIMEZONE)

    # --- A new building (the filling core, src/core/filling, epic E13 R3) -------------------------

    async def has_meters(self, building_id: uuid.UUID) -> bool:
        """Whether the building has any meter (the filling core fills a new one once)."""
        found = await self.session.scalar(
            select(MeterDevice.id).where(MeterDevice.building_id == building_id).limit(1)
        )
        return found is not None

    async def create_meters(self, building_id: uuid.UUID, meters: list[NewMeter]) -> None:
        """Meters of a new building, checked by the filling core; publishes nothing (the period
        opener already opened the month, and a new meter is simply due a reading in it). The
        caller commits."""
        self.session.add_all(
            MeterDevice(
                building_id=building_id,
                apartment_id=meter.apartment_id,
                resource_type=meter.resource_type,
                unit=meter.unit,
                serial_number=meter.serial_number,
                location_label=meter.location_label,
                initial_value=meter.initial_value,
                max_monthly_delta=meter.max_monthly_delta,
            )
            for meter in meters
        )
        await self.session.flush()

    # --- System-level reads (no caller; used by the notifications module) -----------------------

    async def open_periods_due_within(
        self, until: datetime, *, now: datetime
    ) -> list[DuePeriodRefDTO]:
        """Periods open for residents whose deadline is after `now` and not after `until`."""
        rows = await self.session.scalars(
            select(ReadingPeriod)
            .where(
                ReadingPeriod.status == PeriodStatus.OPEN_FOR_RESIDENTS,
                ReadingPeriod.due_date > now,
                ReadingPeriod.due_date <= until,
            )
            .order_by(ReadingPeriod.due_date, ReadingPeriod.id)
        )
        return [
            DuePeriodRefDTO(
                period_id=period.id,
                building_id=period.building_id,
                period_code=period.period_code,
                due_date=period.due_date,
            )
            for period in rows
        ]

    async def open_current_period(
        self, building_id: uuid.UUID, deadline_day: int, now: datetime
    ) -> uuid.UUID | None:
        """Opens the period of the local month of `now` (the period opener). Returns its id when
        this call inserted it, None when it already existed (another tick or process)."""
        period_code = period_code_of(now.astimezone(self.timezone).date())
        due_date = period_due_date(period_code, deadline_day, self.timezone.key)
        period_id = await self.session.scalar(
            insert(ReadingPeriod)
            .values(
                id=uuid.uuid4(),
                building_id=building_id,
                period_code=period_code,
                status=PeriodStatus.OPEN_FOR_RESIDENTS,
                due_date=due_date,
            )
            .on_conflict_do_nothing(index_elements=["building_id", "period_code"])
            .returning(ReadingPeriod.id)
        )
        if period_id is not None:
            self._writer_outbox().add(
                ReadingPeriodOpened(
                    period_id=period_id,
                    building_id=building_id,
                    period_code=period_code,
                    due_date=due_date,
                )
            )
        return period_id

    async def apartments_missing_readings(self, period_id: uuid.UUID) -> list[uuid.UUID]:
        """Apartments of the period's building with an active meter that has no reading in it."""
        period = await self.session.get(ReadingPeriod, period_id)
        if period is None:
            return []
        has_reading = exists().where(
            MeterReading.meter_id == MeterDevice.id, MeterReading.period_id == period_id
        )
        rows = await self.session.scalars(
            select(MeterDevice.apartment_id)
            .where(
                MeterDevice.building_id == period.building_id,
                MeterDevice.apartment_id.is_not(None),
                MeterDevice.is_active.is_(True),
                ~has_reading,
            )
            .distinct()
            .order_by(MeterDevice.apartment_id)
        )
        return [apartment_id for apartment_id in rows if apartment_id is not None]

    # --- Submitting readings --------------------------------------------------------------------

    async def submit_reading(
        self, user: CurrentUserDTO, request: ReadingSubmitRequest
    ) -> ReadingResponse:
        """POST /readings. Every exit sets meters.outcome on a dedicated span (Task 8)."""
        self._writer_outbox()  # before any change
        with tracer.start_as_current_span(
            "meters.submit_reading", record_exception=False, set_status_on_exception=False
        ) as span:
            span.set_attributes(
                {
                    "meters.meter_id": str(request.meter_id),
                    "meters.period_code": request.period_code,
                    "meters.confirmation_level": request.confirmation_level,
                }
            )
            try:
                response, outcome = await self._submit(user, request, span)
            except DomainError as error:
                span.set_attribute("meters.outcome", error.error_code)  # an expected 4xx
                raise
            except Exception as error:
                span.record_exception(error)
                span.set_status(trace.Status(trace.StatusCode.ERROR, type(error).__name__))
                span.set_attribute("meters.outcome", "ERROR")
                raise
            span.set_attributes(
                {
                    "meters.outcome": outcome,
                    "meters.anomaly_confirmed": response.is_anomaly_confirmed,
                }
            )
            return response

    async def _submit(
        self, user: CurrentUserDTO, request: ReadingSubmitRequest, span
    ) -> tuple[ReadingResponse, str]:
        # 1. Visibility and role, before any lock: nobody can hold locks on meters they cannot see.
        meter = await self.session.scalar(
            select(MeterDevice).where(
                MeterDevice.id == request.meter_id, MeterDevice.building_id == user.building_id
            )
        )
        membership = (
            user.membership_for(meter.apartment_id) if meter and meter.apartment_id else None
        )
        if meter is None or (membership is None and user.building_role not in STAFF_VIEW_ROLES):
            raise _not_found("METER_NOT_FOUND", "Meter not found.")
        if membership is None and user.building_role not in OVERRIDE_ROLES:
            raise DomainError(
                status_code=403,
                error_code="FORBIDDEN",
                message="Board members can view readings but not submit them.",
            )

        # 2. Locks, always period first, then meter (the same order as status changes and
        # estimates, so they can never deadlock). FOR SHARE on the period blocks a concurrent
        # status change until this reading is committed, and vice versa.
        period = await self._period(user.building_id, request.period_code, lock="share")
        meter = await self.session.scalar(
            select(MeterDevice)
            .where(MeterDevice.id == meter.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        existing = await self.session.scalar(
            select(MeterReading).where(
                MeterReading.meter_id == meter.id, MeterReading.period_id == period.id
            )
        )
        is_override_role = user.building_role in OVERRIDE_ROLES
        if not meter.is_active and not (is_override_role and existing is not None):
            # A replaced meter only accepts board corrections of readings it already has.
            raise _not_found("METER_NOT_FOUND", "Meter not found.")

        # 3. Business rules. The month is decided under the locks: a second submission of this
        # meter or a status change of the requested period waits for this one.
        target = (
            (await self._targets(user.building_id, [meter.id], _now()))[meter.id]
            if membership is not None and membership.can_submit_readings
            else None
        )
        if (
            target is not None
            and target.period_code != period.period_code
            and period.status == PeriodStatus.OPEN_FOR_RESIDENTS
            and existing is not None
            and existing.source == ReadingSource.RESIDENT
            and existing.submitted_by_user_id == user.id
            and existing.value == request.value
            and request.reason is None
            # The same start too: adding, changing or dropping the bill's reading is a change.
            and (existing.previous_origin == PreviousOrigin.SUBMITTED)
            == (request.previous_value is not None)
            and request.previous_value in (None, existing.previous_value)
        ):
            # A retry (double click, timeout) of the resident's own reading, e.g. the final one
            # for last month after which the target moved on: nothing to change.
            span.set_attribute("meters.reading_source", ReadingSource.RESIDENT.value)
            return self._reading_response(existing, period), "unchanged"
        source = self._authorize_submission(user, membership, period, target)
        span.set_attribute("meters.reading_source", source.value)
        if (
            source == ReadingSource.RESIDENT
            and existing is not None
            and existing.source == ReadingSource.ADMIN_OVERRIDE
        ):
            raise DomainError(
                status_code=409,
                error_code="READING_SET_BY_BOARD",
                message="The board has corrected this reading; contact the board to change it.",
            )
        if await self._has_later_reading(meter.id, period):
            raise DomainError(
                status_code=409,
                error_code="LATER_READING_EXISTS",
                message="A later period already has a reading for this meter.",
            )

        previous_value, origin = await self._previous(meter, period)
        if previous_value is None:
            # A meter without a start (epic E13 R3b): the reading of the last bill when given,
            # else this reading starts the meter (no consumption, so no anomaly check).
            if request.previous_value is not None:
                previous_value, origin = request.previous_value, PreviousOrigin.SUBMITTED
            else:
                previous_value, origin = request.value, PreviousOrigin.START
        elif request.previous_value is not None:
            raise DomainError(
                status_code=422,
                error_code="PREVIOUS_VALUE_NOT_ALLOWED",
                message="Only the first reading of a meter without a start takes a previous value.",
            )
        average = calculate_rolling_average_delta(
            await self._history_deltas(meter.id, period), NO_HISTORY_AVERAGE
        )
        check = validate_reading_delta(
            previous_value,
            request.value,
            meter.max_monthly_delta,
            average,
            request.confirmation_level,
        )
        if check.status == ReadingCheckStatus.ERR_BELOW_PREV:
            self._raise_for_check(check, previous_value, request.value, average, meter)

        # 4. Nothing would change (a double click): no audit row, no event.
        target = (
            request.value,
            previous_value,
            origin,
            check.consumption_delta,
            source,
            check.is_anomaly_confirmed,
            user.id,
        )
        if (
            existing is not None
            and check.status == ReadingCheckStatus.OK
            and request.reason is None
            and self._state_of(existing) == target
        ):
            return self._reading_response(existing, period), "unchanged"

        if source == ReadingSource.ADMIN_OVERRIDE and existing is not None and not request.reason:
            raise DomainError(
                status_code=422,
                error_code="REASON_REQUIRED",
                message="A board change to an existing reading needs a reason.",
            )
        self._raise_for_check(check, previous_value, request.value, average, meter)

        # 5. Upsert, audit row, event.
        old_value = existing.value if existing is not None else None
        reading = existing or MeterReading(
            building_id=meter.building_id, meter_id=meter.id, period_id=period.id
        )
        reading.value = request.value
        reading.previous_value = previous_value
        reading.previous_origin = origin
        reading.consumption_delta = check.consumption_delta
        reading.source = source
        reading.is_anomaly_confirmed = check.is_anomaly_confirmed
        reading.submitted_by_user_id = user.id
        if existing is None:
            self.session.add(reading)
        await self.session.flush()

        self.session.add(
            MeterReadingLog(
                reading_id=reading.id,
                old_value=old_value,
                new_value=reading.value,
                source=source,
                changed_by_user_id=user.id,
                reason=request.reason or self._default_reason(source, old_value),
            )
        )
        await self.session.flush()
        self._add_submitted_event(reading, meter, period)
        return self._reading_response(reading, period), (
            "created" if existing is None else "updated"
        )

    @staticmethod
    def _state_of(reading: MeterReading) -> tuple:
        return (
            reading.value,
            reading.previous_value,
            reading.previous_origin,
            reading.consumption_delta,
            reading.source,
            reading.is_anomaly_confirmed,
            reading.submitted_by_user_id,
        )

    @staticmethod
    def _authorize_submission(
        user: CurrentUserDTO, membership, period: ReadingPeriod, target: SubmissionTarget | None
    ) -> ReadingSource:
        """Who may write in which period and status (docs/API.md, POST /readings).

        `target` is the meter's next resident period, given when the user may submit for the
        apartment. The chairman and the accountant write as the board outside it."""
        on_target = target is not None and target.period_code == period.period_code
        if on_target and period.status == PeriodStatus.OPEN_FOR_RESIDENTS:
            return ReadingSource.RESIDENT
        if user.building_role in OVERRIDE_ROLES:
            if period.status == PeriodStatus.LOCKED:
                raise DomainError(
                    status_code=409,
                    error_code="PERIOD_LOCKED",
                    message="The period is locked. Reopen it for review to change readings.",
                )
            return ReadingSource.ADMIN_OVERRIDE
        if membership is not None and not membership.can_submit_readings:
            raise DomainError(
                status_code=403,
                error_code="FORBIDDEN",
                message="You are not allowed to submit readings for this apartment.",
            )
        if target is not None and not on_target:
            raise DomainError(
                status_code=409,
                error_code="WRONG_PERIOD",
                message=f"This reading belongs to period {target.period_code}.",
                extra={"target_period_code": target.period_code},
            )
        raise DomainError(
            status_code=409,
            error_code="PERIOD_CLOSED",
            message="The reading period is closed for residents.",
            extra={"period_status": PeriodStatus(period.status).value},
        )

    @staticmethod
    def _raise_for_check(check, previous_value, submitted_value, average, meter) -> None:
        delta = check.consumption_delta
        if check.status == ReadingCheckStatus.ERR_BELOW_PREV:
            raise DomainError(
                status_code=422,
                error_code="READING_BELOW_PREVIOUS",
                message=f"New reading cannot be lower than previous reading ({previous_value}).",
                extra={
                    "previous_value": str(previous_value),
                    "submitted_value": str(submitted_value),
                },
            )
        # Messages are English only; the frontend localizes them by error_code.
        unit = MeterUnit(meter.unit).value
        if check.status == ReadingCheckStatus.WARN_STEP_1:
            raise DomainError(
                status_code=409,
                error_code="ANOMALY_CONFIRMATION_STEP_1",
                message=f"Value is unusually high (consumption {delta} {unit}), are you sure?",
                extra={
                    "required_confirmation_level": check.required_confirmation_level,
                    "consumption_delta": str(delta),
                    "average_delta": str(average),
                    "max_reasonable_delta": str(meter.max_monthly_delta),
                },
            )
        if check.status == ReadingCheckStatus.WARN_STEP_2:
            raise DomainError(
                status_code=409,
                error_code="ANOMALY_CONFIRMATION_STEP_2",
                message="Please double-check the digits; this goes directly to billing!",
                extra={
                    "required_confirmation_level": check.required_confirmation_level,
                    "consumption_delta": str(delta),
                },
            )

    @staticmethod
    def _default_reason(source: ReadingSource, old_value: Decimal | None) -> str:
        if source == ReadingSource.RESIDENT:
            return "Resident submission" if old_value is None else "Resident update"
        return "Board entry" if old_value is None else "Board correction"

    # --- Resident dashboard ---------------------------------------------------------------------

    async def get_dashboard(
        self, user: CurrentUserDTO, period_code: str | None
    ) -> DashboardResponse:
        apartment_ids = [m.apartment_id for m in user.memberships]
        meters = list(
            await self.session.scalars(
                select(MeterDevice)
                .where(
                    MeterDevice.building_id == user.building_id,
                    MeterDevice.apartment_id.in_(apartment_ids),
                    MeterDevice.is_active.is_(True),
                )
                .order_by(MeterDevice.resource_type, MeterDevice.location_label)
            )
        )
        # Where each meter's next reading goes, for the apartments the user may submit for.
        now = _now()
        submitters = {m.apartment_id for m in user.memberships if m.can_submit_readings}
        # A target is always the previous or the current month: both come with one query.
        recent = await self._recent_periods(user.building_id, now)
        targets = await self._targets(
            user.building_id, [m.id for m in meters if m.apartment_id in submitters], now, recent
        )
        target_periods = {
            code: recent[code]
            for code in {t.period_code for t in targets.values()}
            if code in recent
        }

        if period_code is not None:
            period = await self._period(user.building_id, period_code)
        else:
            # The previous month while something is still to be submitted for it, else the
            # current month; else the latest period residents can submit to, else the latest.
            final = next((t for t in targets.values() if t.final), None)
            current = period_code_of(now.astimezone(self.timezone).date())
            period = target_periods.get(final.period_code if final else current)
            if period is None:
                period = await self.session.scalar(
                    select(ReadingPeriod)
                    .where(ReadingPeriod.building_id == user.building_id)
                    .order_by(
                        (ReadingPeriod.status == PeriodStatus.OPEN_FOR_RESIDENTS).desc(),
                        ReadingPeriod.period_code.desc(),
                    )
                    .limit(1)
                )
        # Only the user's meters: the readings of the whole building are not needed here.
        meter_ids = [meter.id for meter in meters]
        readings = await self._readings_by_meter(period, meter_ids) if period else {}
        # The form of each meter works against its own target period, which may differ from the
        # period shown (one meter still due for last month, another already for this one).
        target_readings = {
            code: readings
            if period is not None and code == period.period_code
            else await self._readings_by_meter(target_period, meter_ids)
            for code, target_period in target_periods.items()
        }
        histories = await self._meter_histories(meter_ids)

        apartments = []
        for membership in user.memberships:
            dashboard_meters = []
            for meter in (m for m in meters if m.apartment_id == membership.apartment_id):
                reading = readings.get(meter.id)
                known = histories.previous_value(meter, period)
                dashboard_meters.append(
                    DashboardMeter(
                        meter_id=meter.id,
                        resource_type=meter.resource_type,
                        serial_number=meter.serial_number,
                        location_label=meter.location_label,
                        unit=meter.unit,
                        previous_value=reading.previous_value if reading is not None else known,
                        needs_start=known is None,
                        **self._consumption_hints(meter, period, histories),
                        reading=_summary(reading) if reading is not None else None,
                        next_submission=self._next_submission(
                            meter, targets.get(meter.id), target_periods, target_readings, histories
                        ),
                    )
                )
            apartments.append(
                DashboardApartment(
                    apartment_id=membership.apartment_id,
                    apartment_number=membership.apartment_number,
                    can_submit_readings=membership.can_submit_readings,
                    meters=dashboard_meters,
                )
            )
        return DashboardResponse(
            period=_period_dto(period) if period else None, apartments=apartments
        )

    @staticmethod
    def _next_submission(
        meter: MeterDevice,
        target: SubmissionTarget | None,
        periods: dict[str, ReadingPeriod],
        readings: dict[str, dict[uuid.UUID, MeterReading]],
        histories: _MeterHistories,
    ) -> NextSubmission | None:
        """What the meter's form needs, computed against its target period; None when nothing
        can be submitted (no right, the period does not exist yet or is not open)."""
        period = periods.get(target.period_code) if target is not None else None
        if period is None or period.status != PeriodStatus.OPEN_FOR_RESIDENTS:
            return None
        reading = readings[period.period_code].get(meter.id)
        known = histories.previous_value(meter, period)
        return NextSubmission(
            period_code=period.period_code,
            due_date=period.due_date,
            final=target.final,
            previous_value=reading.previous_value if reading is not None else known,
            needs_start=known is None,
            average_delta=rolling_average_delta(histories.history_deltas(meter.id, period)),
            reading=_summary(reading) if reading is not None else None,
        )

    @staticmethod
    def _consumption_hints(
        meter: MeterDevice, period: ReadingPeriod | None, histories: _MeterHistories
    ) -> dict[str, Decimal | None]:
        if period is None:
            return {"average_delta": None, "previous_delta": None}
        return {
            "average_delta": rolling_average_delta(histories.history_deltas(meter.id, period)),
            "previous_delta": histories.previous_delta(meter.id, period),
        }

    # --- Periods --------------------------------------------------------------------------------

    async def list_periods(self, user: CurrentUserDTO) -> PeriodListResponse:
        periods = await self.session.scalars(
            select(ReadingPeriod)
            .where(ReadingPeriod.building_id == user.building_id)
            .order_by(ReadingPeriod.period_code.desc())
        )
        return PeriodListResponse(periods=[_period_dto(period) for period in periods])

    # --- Apartment history (epic E8) ----------------------------------------------------------

    async def get_apartment_readings(
        self, user: CurrentUserDTO, apartment_id: uuid.UUID
    ) -> ApartmentReadingsResponse:
        """The latest periods of the building and the apartment's readings in them.

        Staff see every apartment of the building, a resident only their own; the history
        belongs to the apartment, so it includes readings from before the resident moved in.
        """
        apartment = await self._visible_apartment(user, apartment_id)
        periods = list(
            await self.session.scalars(
                select(ReadingPeriod)
                .where(ReadingPeriod.building_id == user.building_id)
                .order_by(ReadingPeriod.period_code.desc())
                .limit(APARTMENT_HISTORY_PERIODS)
            )
        )
        codes = {period.id: period.period_code for period in periods}
        rows = (
            await self.session.execute(
                select(MeterReading)
                .join(MeterDevice, MeterDevice.id == MeterReading.meter_id)
                .where(
                    MeterDevice.apartment_id == apartment_id,
                    MeterReading.building_id == user.building_id,
                    MeterReading.period_id.in_(list(codes)),
                )
            )
        ).scalars()
        readings: dict[uuid.UUID, list[MeterReading]] = {}
        for reading in rows:
            readings.setdefault(reading.meter_id, []).append(reading)

        # Active meters, plus replaced ones that still have a reading in these periods.
        meters = await self.session.scalars(
            select(MeterDevice)
            .where(
                MeterDevice.apartment_id == apartment_id,
                MeterDevice.building_id == user.building_id,
                MeterDevice.is_active.is_(True) | MeterDevice.id.in_(list(readings)),
            )
            .order_by(MeterDevice.resource_type, MeterDevice.location_label, MeterDevice.id)
        )
        return ApartmentReadingsResponse(
            apartment_id=apartment_id,
            apartment_number=apartment.number,
            periods=[_period_dto(period) for period in periods],
            meters=[
                ApartmentMeterHistory(
                    meter_id=meter.id,
                    resource_type=meter.resource_type,
                    serial_number=meter.serial_number,
                    location_label=meter.location_label,
                    unit=meter.unit,
                    is_active=meter.is_active,
                    readings=[
                        ApartmentReading(
                            period_code=codes[reading.period_id],
                            reading_id=reading.id,
                            value=reading.value,
                            consumption_delta=reading.consumption_delta,
                            source=reading.source,
                            is_anomaly_confirmed=reading.is_anomaly_confirmed,
                            previous_origin=reading.previous_origin,
                        )
                        for reading in sorted(
                            readings.get(meter.id, []),
                            key=lambda reading: codes[reading.period_id],
                            reverse=True,
                        )
                    ],
                )
                for meter in meters
            ],
        )

    async def _visible_apartment(
        self, user: CurrentUserDTO, apartment_id: uuid.UUID
    ) -> ApartmentRefDTO:
        """Staff see every apartment of the building, a resident only their own; else 404."""
        apartment = await self.property_service.apartment_ref(apartment_id)
        visible = (
            apartment is not None
            and apartment.building_id == user.building_id
            and (user.building_role in STAFF_VIEW_ROLES or user.membership_for(apartment_id))
        )
        if apartment is None or not visible:
            raise _not_found("APARTMENT_NOT_FOUND", "No such apartment.")
        return apartment

    # --- Consumption per month (docs/API.md section 3) ------------------------------------------

    async def _latest_periods(self, building_id: uuid.UUID, months: int) -> list[ReadingPeriod]:
        """The building's latest periods, oldest first (chart order)."""
        latest = await self.session.scalars(
            select(ReadingPeriod)
            .where(ReadingPeriod.building_id == building_id)
            .order_by(ReadingPeriod.period_code.desc())
            .limit(months)
        )
        return list(reversed(list(latest)))

    async def _meter_kinds(
        self, building_id: uuid.UUID, apartment_id: uuid.UUID | None
    ) -> set[tuple[ResourceType, MeterUnit]]:
        """Resource types and units of the active apartment meters (one apartment, or all)."""
        statement = select(MeterDevice.resource_type, MeterDevice.unit).where(
            MeterDevice.building_id == building_id,
            MeterDevice.is_active.is_(True),
            MeterDevice.apartment_id.is_not(None)
            if apartment_id is None
            else MeterDevice.apartment_id == apartment_id,
        )
        return {(row[0], row[1]) for row in await self.session.execute(statement.distinct())}

    async def get_apartment_consumption(
        self, user: CurrentUserDTO, apartment_id: uuid.UUID, months: int
    ) -> ApartmentConsumptionResponse:
        """One apartment's consumption per month and resource type; rights as its readings."""
        apartment = await self._visible_apartment(user, apartment_id)
        periods = await self._latest_periods(user.building_id, months)
        rows = (
            await self.session.execute(
                select(
                    MeterReading.period_id,
                    MeterDevice.resource_type,
                    MeterDevice.unit,
                    MeterReading.consumption_delta,
                    MeterReading.source,
                )
                .join(MeterDevice, MeterDevice.id == MeterReading.meter_id)
                .where(
                    MeterDevice.apartment_id == apartment_id,
                    MeterReading.building_id == user.building_id,
                    MeterReading.period_id.in_([period.id for period in periods]),
                    # A start has no consumption: the month counts as without a reading.
                    MeterReading.previous_origin != PreviousOrigin.START,
                )
            )
        ).all()
        deltas: dict[tuple[ResourceType, MeterUnit, uuid.UUID], list[Decimal]] = {}
        estimated: set[tuple[ResourceType, MeterUnit, uuid.UUID]] = set()
        for period_id, resource_type, unit, delta, source in rows:
            key = (resource_type, unit, period_id)
            deltas.setdefault(key, []).append(delta)
            if source == ReadingSource.AUTO_ESTIMATED:
                estimated.add(key)
        kinds = await self._meter_kinds(user.building_id, apartment_id)
        kinds |= {(resource_type, unit) for resource_type, unit, _ in deltas}
        return ApartmentConsumptionResponse(
            apartment_id=apartment_id,
            apartment_number=apartment.number,
            periods=[_period_dto(period) for period in periods],
            resources=[
                ApartmentConsumptionSeries(
                    resource_type=resource_type,
                    unit=unit,
                    months=[
                        ApartmentConsumptionMonth(
                            period_code=period.period_code,
                            consumption=(total_consumption(deltas[key]) if key in deltas else None),
                            estimated=key in estimated,
                        )
                        for period in periods
                        for key in [(resource_type, unit, period.id)]
                    ],
                )
                for resource_type, unit in sorted(kinds)
            ],
        )

    async def get_building_consumption(
        self, user: CurrentUserDTO, months: int
    ) -> BuildingConsumptionResponse:
        """Totals and averages of the apartment meters per month (staff; masters left out)."""
        periods = await self._latest_periods(user.building_id, months)
        rows = (
            await self.session.execute(
                select(
                    MeterReading.period_id,
                    MeterDevice.apartment_id,
                    MeterDevice.resource_type,
                    MeterDevice.unit,
                    MeterReading.consumption_delta,
                    MeterReading.source,
                )
                .join(MeterDevice, MeterDevice.id == MeterReading.meter_id)
                .where(
                    MeterDevice.apartment_id.is_not(None),
                    MeterReading.building_id == user.building_id,
                    MeterReading.period_id.in_([period.id for period in periods]),
                    # A start has no consumption: that apartment is not counted for the month.
                    MeterReading.previous_origin != PreviousOrigin.START,
                )
            )
        ).all()
        deltas: dict[tuple[ResourceType, MeterUnit, uuid.UUID], list[Decimal]] = {}
        apartments: dict[tuple[ResourceType, MeterUnit, uuid.UUID], set[uuid.UUID]] = {}
        estimates: dict[tuple[ResourceType, MeterUnit, uuid.UUID], int] = {}
        for period_id, apartment_id, resource_type, unit, delta, source in rows:
            key = (resource_type, unit, period_id)
            deltas.setdefault(key, []).append(delta)
            apartments.setdefault(key, set()).add(apartment_id)
            if source == ReadingSource.AUTO_ESTIMATED:
                estimates[key] = estimates.get(key, 0) + 1
        kinds = await self._meter_kinds(user.building_id, None)
        kinds |= {(resource_type, unit) for resource_type, unit, _ in deltas}
        areas = await self.property_service.apartment_areas(user.building_id)

        def month(
            key: tuple[ResourceType, MeterUnit, uuid.UUID], code: str
        ) -> BuildingConsumptionMonth:
            counted = apartments.get(key, set())
            total = total_consumption(deltas.get(key, []))
            area = sum((areas.get(apartment, Decimal(0)) for apartment in counted), Decimal(0))
            return BuildingConsumptionMonth(
                period_code=code,
                total=total if counted else None,
                apartments_counted=len(counted),
                average_per_apartment=average_per_apartment(total, len(counted)),
                average_per_m2=consumption_per_area(total, area) if counted else None,
                estimated_readings=estimates.get(key, 0),
            )

        return BuildingConsumptionResponse(
            periods=[_period_dto(period) for period in periods],
            resources=[
                BuildingConsumptionSeries(
                    resource_type=resource_type,
                    unit=unit,
                    months=[
                        month((resource_type, unit, period.id), period.period_code)
                        for period in periods
                    ],
                )
                for resource_type, unit in sorted(kinds)
            ],
        )

    # --- Chairman matrix ------------------------------------------------------------------------

    async def get_matrix(self, user: CurrentUserDTO, period_code: str) -> MatrixResponse:
        period = await self._period(user.building_id, period_code)
        readings = await self._readings_by_meter(period)
        # Active meters, plus meters replaced during the period that still have a reading in it.
        meters = list(
            await self.session.scalars(
                select(MeterDevice)
                .where(
                    MeterDevice.building_id == user.building_id,
                    MeterDevice.is_active.is_(True) | MeterDevice.id.in_(list(readings)),
                )
                .order_by(MeterDevice.resource_type, MeterDevice.location_label)
            )
        )
        apartments = await self.property_service.list_apartments(user.building_id)
        # One query for every meter's history: the previous value and whether it has a start.
        histories = await self._meter_histories([meter.id for meter in meters])

        def cell(meter: MeterDevice) -> MatrixMeter:
            return self._matrix_cell(
                meter, readings.get(meter.id), histories.previous_value(meter, period)
            )

        rows = []
        for apartment in apartments:
            cells = [cell(meter) for meter in meters if meter.apartment_id == apartment.id]
            if not cells:
                continue
            rows.append(
                MatrixApartment(
                    apartment_id=apartment.id,
                    apartment_number=apartment.number,
                    entrance=apartment.entrance,
                    floor=apartment.floor,
                    status=apartment_submission_status(cell.status for cell in cells),
                    meters=cells,
                )
            )
        master_meters = [
            MasterMeterRow(**cell(meter).model_dump()) for meter in meters if meter.is_master_meter
        ]
        return MatrixResponse(
            period=_period_dto(period),
            balances=self._balances(meters, readings),
            master_meters=master_meters,
            apartments=rows,
        )

    @staticmethod
    def _matrix_cell(
        meter: MeterDevice, reading: MeterReading | None, known: Decimal | None
    ) -> MatrixMeter:
        """`known`: the meter's previous value before the period (None: no start yet)."""
        return MatrixMeter(
            meter_id=meter.id,
            resource_type=meter.resource_type,
            location_label=meter.location_label,
            unit=meter.unit,
            previous_value=reading.previous_value if reading is not None else known,
            needs_start=known is None,
            status=meter_submission_status(
                reading.source if reading else None,
                reading.is_anomaly_confirmed if reading else False,
            ),
            reading=_summary(reading) if reading else None,
        )

    @staticmethod
    def _balances(
        meters: list[MeterDevice], readings: dict[uuid.UUID, MeterReading]
    ) -> list[ResourceBalance]:
        """Master meters minus the sum of apartment meters, per resource type."""
        balances = []
        # Grouped by resource AND unit: kWh and MWh are never summed together.
        groups = sorted({(m.resource_type, m.unit) for m in meters if m.is_master_meter})
        for resource_type, unit in groups:

            def same_kind(meter: MeterDevice, rt=resource_type, u=unit) -> bool:
                return meter.resource_type == rt and meter.unit == u

            masters = [m for m in meters if m.is_master_meter and same_kind(m)]
            apartment_readings = [
                readings[m.id]
                for m in meters
                if not m.is_master_meter and same_kind(m) and m.id in readings
            ]
            apartment_deltas = [reading.consumption_delta for reading in apartment_readings]
            starting = sum(
                1 for r in apartment_readings if r.previous_origin == PreviousOrigin.START
            )
            apartments_sum = canonical_meter_value(sum(apartment_deltas, start=Decimal("0.000")))
            master_total = None
            # A building meter that started this month has no consumption yet: no total either.
            if all(
                m.id in readings and readings[m.id].previous_origin != PreviousOrigin.START
                for m in masters
            ):
                master_total = canonical_meter_value(
                    sum((readings[m.id].consumption_delta for m in masters), start=Decimal("0.000"))
                )
            balances.append(
                ResourceBalance(
                    resource_type=resource_type,
                    unit=unit,
                    master_total=master_total,
                    apartments_sum=apartments_sum,
                    unallocated_loss=(
                        canonical_meter_value(master_total - apartments_sum)
                        if master_total is not None
                        else None
                    ),
                    starting_meters=starting,
                )
            )
        return balances

    # --- Estimates for missing apartments -------------------------------------------------------

    async def estimate_missing(self, user: CurrentUserDTO, period_code: str) -> EstimateResponse:
        self._writer_outbox()  # before any change
        period = await self._period(user.building_id, period_code, lock="update")
        if period.status != PeriodStatus.REVIEW_BY_BOARD:
            raise DomainError(
                status_code=409,
                error_code="PERIOD_NOT_IN_REVIEW",
                message="Missing readings can only be estimated during the board review.",
                extra={"period_status": PeriodStatus(period.status).value},
            )
        meters = list(
            await self.session.scalars(
                select(MeterDevice)
                .where(
                    MeterDevice.building_id == user.building_id,
                    MeterDevice.apartment_id.is_not(None),
                    MeterDevice.is_active.is_(True),
                )
                .order_by(MeterDevice.id)
                .with_for_update()
            )
        )
        with_reading = set(
            await self.session.scalars(
                select(MeterReading.meter_id).where(MeterReading.period_id == period.id)
            )
        )
        # A later reading's consumption already covers this month (its previous_value is the
        # reading before this period): an estimate here would count the month twice.
        with_later_reading = set(
            await self.session.scalars(
                select(MeterReading.meter_id)
                .join(ReadingPeriod, ReadingPeriod.id == MeterReading.period_id)
                .where(
                    MeterReading.building_id == user.building_id,
                    ReadingPeriod.period_code > period.period_code,
                )
            )
        )

        estimated = []
        skipped_without_start: list[uuid.UUID] = []
        for meter in (m for m in meters if m.id not in with_reading | with_later_reading):
            previous_value, origin = await self._previous(meter, period)
            if previous_value is None:
                # Nothing to estimate from: its first reading starts the meter (epic E13 R3b).
                skipped_without_start.append(meter.id)
                continue
            average = calculate_rolling_average_delta(
                await self._history_deltas(meter.id, period), NO_HISTORY_AVERAGE
            )
            if previous_value + average > METER_VALUE_MAX:
                raise DomainError(
                    status_code=422,
                    error_code="ESTIMATE_OUT_OF_RANGE",
                    message="The estimate does not fit NUMERIC(12, 3); enter this reading by hand.",
                    extra={"meter_id": str(meter.id)},
                )
            reading = MeterReading(
                building_id=meter.building_id,
                meter_id=meter.id,
                period_id=period.id,
                value=canonical_meter_value(previous_value + average),
                previous_value=previous_value,
                previous_origin=origin,
                consumption_delta=average,
                source=ReadingSource.AUTO_ESTIMATED,
                is_anomaly_confirmed=False,
                submitted_by_user_id=None,
            )
            self.session.add(reading)
            await self.session.flush()
            self.session.add(
                MeterReadingLog(
                    reading_id=reading.id,
                    old_value=None,
                    new_value=reading.value,
                    source=ReadingSource.AUTO_ESTIMATED,
                    changed_by_user_id=user.id,
                    reason=ESTIMATE_REASON,
                )
            )
            estimated.append((reading, meter))
        await self.session.flush()
        for reading, meter in estimated:
            self._add_submitted_event(reading, meter, period)

        return EstimateResponse(
            period_code=period.period_code,
            estimated_count=len(estimated),
            estimated=[
                EstimatedReading(
                    reading_id=reading.id,
                    meter_id=meter.id,
                    apartment_id=meter.apartment_id,
                    value=reading.value,
                    consumption_delta=reading.consumption_delta,
                )
                for reading, meter in estimated
            ],
            skipped_without_start=skipped_without_start,
        )

    # --- Period status --------------------------------------------------------------------------

    async def change_period_status(
        self, user: CurrentUserDTO, period_code: str, target: PeriodStatus
    ) -> PeriodStatusUpdateResponse:
        period = await self._period(user.building_id, period_code, lock="update")
        current = PeriodStatus(period.status)
        if not can_transition_period(current, target):
            raise DomainError(
                status_code=409,
                error_code="INVALID_PERIOD_TRANSITION",
                message=f"A period cannot go from {current.value} to {target.value}.",
                extra={
                    "current_status": current.value,
                    "requested_status": target.value,
                    "allowed_statuses": sorted(s.value for s in PERIOD_TRANSITIONS[current]),
                },
            )
        outbox = self._writer_outbox()
        period.status = target
        await self.session.flush()
        outbox.add(
            ReadingPeriodStatusChanged(
                period_id=period.id,
                building_id=period.building_id,
                period_code=period.period_code,
                old_status=current,
                new_status=target,
                changed_by_user_id=user.id,
            )
        )
        return PeriodStatusUpdateResponse(
            period_code=period.period_code, previous_status=current, status=target
        )

    # --- Audit history --------------------------------------------------------------------------

    async def get_history(
        self, user: CurrentUserDTO, reading_id: uuid.UUID
    ) -> ReadingHistoryResponse:
        row = (
            await self.session.execute(
                select(MeterReading.meter_id, MeterDevice.apartment_id, ReadingPeriod.period_code)
                .join(MeterDevice, MeterDevice.id == MeterReading.meter_id)
                .join(ReadingPeriod, ReadingPeriod.id == MeterReading.period_id)
                .where(MeterReading.id == reading_id, MeterReading.building_id == user.building_id)
            )
        ).one_or_none()
        visible = row is not None and (
            user.building_role in STAFF_VIEW_ROLES
            or (row.apartment_id is not None and user.membership_for(row.apartment_id))
        )
        if not visible:
            raise _not_found("READING_NOT_FOUND", "Reading not found.")

        logs = list(
            await self.session.scalars(
                select(MeterReadingLog)
                .where(MeterReadingLog.reading_id == reading_id)
                .order_by(MeterReadingLog.changed_at, MeterReadingLog.id)
            )
        )

        # Residents are shown in their apartment's context; board actions and estimates without
        # one, so a chairman never appears as if living in that apartment.
        def author_key(log: MeterReadingLog) -> tuple[uuid.UUID, uuid.UUID | None]:
            context = row.apartment_id if log.source == ReadingSource.RESIDENT else None
            return (log.changed_by_user_id, context)

        badges = await self.property_service.get_masked_author_badges(
            author_key(log) for log in logs if log.changed_by_user_id is not None
        )
        return ReadingHistoryResponse(
            reading_id=reading_id,
            meter_id=row.meter_id,
            period_code=row.period_code,
            entries=[
                HistoryEntry(
                    changed_at=log.changed_at,
                    old_value=log.old_value,
                    new_value=log.new_value,
                    source=log.source,
                    reason=log.reason,
                    changed_by=badges[author_key(log)] if log.changed_by_user_id else None,
                )
                for log in logs
            ],
        )

    # --- Export ---------------------------------------------------------------------------------

    async def export_rows(self, user: CurrentUserDTO, period_code: str) -> list[ReadingExportRow]:
        """All readings of the period, apartments first (natural order), master meters last."""
        period = await self._period(user.building_id, period_code)
        rows = (
            await self.session.execute(
                select(MeterReading, MeterDevice)
                .join(MeterDevice, MeterDevice.id == MeterReading.meter_id)
                .where(MeterReading.period_id == period.id)
            )
        ).all()
        apartments = {
            a.id: a for a in await self.property_service.list_apartments(user.building_id)
        }
        order = {apartment_id: index for index, apartment_id in enumerate(apartments)}

        def sort_key(item):
            reading, meter = item
            position = order.get(meter.apartment_id, len(order))
            return (position, meter.resource_type, meter.location_label, str(meter.id))

        result = []
        for reading, meter in sorted(rows, key=sort_key):
            apartment = apartments.get(meter.apartment_id) if meter.apartment_id else None
            result.append(
                ReadingExportRow(
                    period_code=period.period_code,
                    entrance=apartment.entrance if apartment else None,
                    apartment_number=apartment.number if apartment else None,
                    meter_id=meter.id,
                    resource_type=meter.resource_type.value,
                    serial_number=meter.serial_number,
                    location_label=meter.location_label,
                    unit=meter.unit.value,
                    previous_value=reading.previous_value,
                    value=reading.value,
                    consumption_delta=reading.consumption_delta,
                    source=reading.source.value,
                    is_anomaly_confirmed=reading.is_anomaly_confirmed,
                    recorded_at=reading.recorded_at,
                    previous_origin=reading.previous_origin.value,
                )
            )
        return result

    @staticmethod
    def export_filename(period_code: str, exporter: ReadingExporter) -> str:
        return f"readings-{period_code}.{exporter.file_extension}"

    # --- Internals ------------------------------------------------------------------------------

    async def _period(
        self, building_id: uuid.UUID, period_code: str, lock: str | None = None
    ) -> ReadingPeriod:
        """lock="share": FOR SHARE (submissions; many may run at once).
        lock="update": FOR NO KEY UPDATE (status changes, estimates). Unlike FOR UPDATE it does not
        block the FOR KEY SHARE that foreign-key checks of new readings take on the period row.
        """
        statement = select(ReadingPeriod).where(
            ReadingPeriod.building_id == building_id, ReadingPeriod.period_code == period_code
        )
        if lock == "share":
            statement = statement.with_for_update(read=True)
        elif lock == "update":
            statement = statement.with_for_update(key_share=True)
        if lock is not None:
            statement = statement.execution_options(populate_existing=True)
        period = await self.session.scalar(statement)
        if period is None:
            raise _not_found("PERIOD_NOT_FOUND", f"Reading period {period_code} not found.")
        return period

    async def _recent_periods(
        self, building_id: uuid.UUID, now: datetime
    ) -> dict[str, ReadingPeriod]:
        """The periods of the previous and the current local month that exist, by code."""
        current = period_code_of(now.astimezone(self.timezone).date())
        periods = await self.session.scalars(
            select(ReadingPeriod).where(
                ReadingPeriod.building_id == building_id,
                ReadingPeriod.period_code.in_([previous_period_code(current), current]),
            )
        )
        return {period.period_code: period for period in periods}

    async def _targets(
        self,
        building_id: uuid.UUID,
        meter_ids: list[uuid.UUID],
        now: datetime,
        recent: dict[str, ReadingPeriod] | None = None,
    ) -> dict[uuid.UUID, SubmissionTarget]:
        """The period each meter's next resident reading goes to (docs/API.md section 2).

        `recent` (from _recent_periods) saves the query of the previous month's period."""
        if not meter_ids:
            return {}
        current = period_code_of(now.astimezone(self.timezone).date())
        previous_code = previous_period_code(current)
        if recent is not None:
            previous = recent.get(previous_code)
        else:
            previous = await self.session.scalar(
                select(ReadingPeriod).where(
                    ReadingPeriod.building_id == building_id,
                    ReadingPeriod.period_code == previous_code,
                )
            )
        if previous is None:
            no_previous = submission_target(now, self.timezone, None, has_previous_reading=False)
            return dict.fromkeys(meter_ids, no_previous)
        # Meters with a reading for the previous month (an estimate does not count) or later.
        counted = set(
            await self.session.scalars(
                select(MeterReading.meter_id)
                .join(ReadingPeriod, ReadingPeriod.id == MeterReading.period_id)
                .where(
                    MeterReading.meter_id.in_(meter_ids),
                    or_(
                        ReadingPeriod.period_code > previous_code,
                        and_(
                            ReadingPeriod.period_code == previous_code,
                            MeterReading.source != ReadingSource.AUTO_ESTIMATED,
                        ),
                    ),
                )
                .distinct()
            )
        )
        state = PreviousPeriod(status=PeriodStatus(previous.status), due_date=previous.due_date)
        return {
            meter_id: submission_target(now, self.timezone, state, meter_id in counted)
            for meter_id in meter_ids
        }

    async def _has_later_reading(self, meter_id: uuid.UUID, period: ReadingPeriod) -> bool:
        """Changing a reading would silently break the next period's previous_value snapshot."""
        later = await self.session.scalar(
            select(MeterReading.id)
            .join(ReadingPeriod, ReadingPeriod.id == MeterReading.period_id)
            .where(
                MeterReading.meter_id == meter_id, ReadingPeriod.period_code > period.period_code
            )
            .limit(1)
        )
        return later is not None

    async def _readings_by_meter(
        self, period: ReadingPeriod, meter_ids: list[uuid.UUID] | None = None
    ) -> dict[uuid.UUID, MeterReading]:
        """The period's readings by meter; only those of `meter_ids` when given."""
        statement = select(MeterReading).where(MeterReading.period_id == period.id)
        if meter_ids is not None:
            statement = statement.where(MeterReading.meter_id.in_(meter_ids))
        readings = await self.session.scalars(statement)
        return {reading.meter_id: reading for reading in readings}

    async def _meter_histories(self, meter_ids: list[uuid.UUID]) -> _MeterHistories:
        """Every reading of the meters with its period, newest first (see _MeterHistories).

        Unbounded on purpose: one row per meter and month, about 120 rows per meter after ten
        years, for one user's meters or the building's matrix (some 24,000 rows for 200 meters
        then). Add a lower bound if that ever matters."""
        rows: dict[uuid.UUID, list[_PastReading]] = {meter_id: [] for meter_id in meter_ids}
        if not meter_ids:
            return _MeterHistories(rows)
        result = await self.session.execute(
            select(
                MeterReading.meter_id,
                ReadingPeriod.period_code,
                MeterReading.value,
                MeterReading.consumption_delta,
                MeterReading.source,
                MeterReading.is_anomaly_confirmed,
                MeterReading.previous_origin,
            )
            .join(ReadingPeriod, ReadingPeriod.id == MeterReading.period_id)
            .where(MeterReading.meter_id.in_(meter_ids))
            .order_by(MeterReading.meter_id, ReadingPeriod.period_code.desc())
        )
        for meter_id, code, value, delta, source, confirmed, origin in result:
            start = origin == PreviousOrigin.START
            rows[meter_id].append(
                _PastReading(
                    code,
                    value,
                    delta,
                    source in HISTORY_SOURCES and not confirmed and not start,
                    start,
                )
            )
        return _MeterHistories(rows)

    async def _previous(
        self, meter: MeterDevice, period: ReadingPeriod | None
    ) -> tuple[Decimal | None, PreviousOrigin | None]:
        """The meter's reading in the latest earlier period (HISTORY), else its initial value
        (INITIAL); (None, None) for a meter without a start (epic E13 R3b)."""
        statement = (
            select(MeterReading.value)
            .join(ReadingPeriod, ReadingPeriod.id == MeterReading.period_id)
            .where(MeterReading.meter_id == meter.id)
            .order_by(ReadingPeriod.period_code.desc())
            .limit(1)
        )
        if period is not None:
            statement = statement.where(ReadingPeriod.period_code < period.period_code)
        value = await self.session.scalar(statement)
        if value is not None:
            return value, PreviousOrigin.HISTORY
        if meter.initial_value is not None:
            return meter.initial_value, PreviousOrigin.INITIAL
        return None, None

    async def _history_deltas(self, meter_id: uuid.UUID, period: ReadingPeriod) -> list[Decimal]:
        """Last 3 qualifying deltas before the period, oldest first (ROADMAP section C)."""
        deltas = await self.session.scalars(
            select(MeterReading.consumption_delta)
            .join(ReadingPeriod, ReadingPeriod.id == MeterReading.period_id)
            .where(
                MeterReading.meter_id == meter_id,
                ReadingPeriod.period_code < period.period_code,
                MeterReading.source.in_(HISTORY_SOURCES),
                MeterReading.is_anomaly_confirmed.is_(False),
                MeterReading.previous_origin != PreviousOrigin.START,
            )
            .order_by(ReadingPeriod.period_code.desc())
            .limit(3)
        )
        return list(reversed(list(deltas)))

    @staticmethod
    def _reading_response(reading: MeterReading, period: ReadingPeriod) -> ReadingResponse:
        return ReadingResponse(
            reading_id=reading.id,
            meter_id=reading.meter_id,
            period_code=period.period_code,
            value=reading.value,
            consumption_delta=reading.consumption_delta,
            source=reading.source,
            is_anomaly_confirmed=reading.is_anomaly_confirmed,
            previous_origin=reading.previous_origin,
        )

    def _writer_outbox(self) -> EventOutbox:
        """The request outbox; a system-level reader (no outbox) must never write."""
        if self.outbox is None:
            raise RuntimeError("MetersService writes need the request outbox")
        return self.outbox

    def _add_submitted_event(
        self, reading: MeterReading, meter: MeterDevice, period: ReadingPeriod
    ) -> None:
        self._writer_outbox().add(
            MeterReadingSubmitted(
                reading_id=reading.id,
                building_id=meter.building_id,
                meter_id=meter.id,
                apartment_id=meter.apartment_id,
                period_code=period.period_code,
                value=reading.value,
                consumption_delta=reading.consumption_delta,
                source=reading.source,
                is_anomaly_confirmed=reading.is_anomaly_confirmed,
                submitted_by_user_id=reading.submitted_by_user_id,
            )
        )


def get_meters_service(
    session: DbSession,
    property_service: PropertyService = Depends(get_property_service),
    outbox: EventOutbox = Depends(get_event_outbox),
) -> MetersService:
    return MetersService(session, property_service, outbox)
