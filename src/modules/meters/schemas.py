"""Public enums, value types and DTOs of the meters module.

Meter values are always Decimal with at most 3 decimal places (NUMERIC(12, 3)). JSON floats are
rejected on input: a float like 1254.1 cannot be represented exactly, and the value goes to
billing. Clients send values as strings ("1254.100"), and responses return them as strings.
"""

import re
import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Annotated, Any

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictInt,
    WithJsonSchema,
)

from src.core.validation import optional_safe_text
from src.modules.property.schemas import AuthorBadgeDTO


class ResourceType(StrEnum):
    COLD_WATER = "COLD_WATER"
    HOT_WATER = "HOT_WATER"
    ELECTRICITY = "ELECTRICITY"
    HEAT = "HEAT"
    GAS = "GAS"


class MeterUnit(StrEnum):
    M3 = "m3"
    KWH = "kWh"
    MWH = "MWh"


class PeriodStatus(StrEnum):
    OPEN_FOR_RESIDENTS = "OPEN_FOR_RESIDENTS"
    REVIEW_BY_BOARD = "REVIEW_BY_BOARD"
    LOCKED = "LOCKED"


class SubmissionStatus(StrEnum):
    """Per meter and per apartment in the chairman matrix."""

    SUBMITTED = "SUBMITTED"
    MISSING = "MISSING"
    AUTO_ESTIMATED = "AUTO_ESTIMATED"
    ANOMALY_CONFIRMED = "ANOMALY_CONFIRMED"


class ReadingSource(StrEnum):
    RESIDENT = "RESIDENT"
    ADMIN_OVERRIDE = "ADMIN_OVERRIDE"
    AUTO_ESTIMATED = "AUTO_ESTIMATED"
    IOT_WEBHOOK = "IOT_WEBHOOK"


class PreviousOrigin(StrEnum):
    """Where a reading's previous_value came from (epic E13 R3b, docs/API.md section 2)."""

    HISTORY = "HISTORY"  # the reading of an earlier period
    INITIAL = "INITIAL"  # the meter's initial value
    SUBMITTED = "SUBMITTED"  # given with the first reading of a meter without a start
    START = "START"  # the reading started the meter: previous_value == value, no consumption


# ASCII digits only, at most 9 integer digits and 3 decimals: no exponents, signs, separators
# ("1_000"), commas or non-ASCII digits that Python's Decimal would otherwise accept.
_METER_VALUE_TEXT = re.compile(r"[0-9]{1,9}(\.[0-9]{1,3})?")


METER_PRECISION = Decimal("0.001")  # NUMERIC(12, 3)
METER_VALUE_MAX = Decimal("999999999.999")


def canonical_meter_value(value: Decimal) -> Decimal:
    """NUMERIC(12, 3) canonical form: exactly 3 decimals and never -0.

    Raises ValueError instead of rounding: losing a digit of a meter value is never silent.
    """
    quantized = value.quantize(METER_PRECISION)
    if quantized != value:
        raise ValueError(f"{value} has more than 3 decimal places")
    return quantized.copy_abs() if quantized.is_zero() else quantized


def _parse_meter_value(value: Any) -> Any:
    if isinstance(value, bool | float):
        raise ValueError('meter values must be sent as strings (e.g. "1254.100"), not floats')
    if isinstance(value, str) and not _METER_VALUE_TEXT.fullmatch(value):
        raise ValueError('meter values are plain decimals with up to 3 places, e.g. "1254.100"')
    return value


ReasonText = optional_safe_text(max_length=500)

# NUMERIC(12, 3): 0 .. 999 999 999.999, always returned with exactly 3 decimals ("1254.000").
MeterValue = Annotated[
    Decimal,
    BeforeValidator(_parse_meter_value),
    Field(ge=0, max_digits=12, decimal_places=3, allow_inf_nan=False),
    AfterValidator(canonical_meter_value),
    # The contract (docs/openapi.json) says what the API really accepts: a string, never a number.
    WithJsonSchema(
        {"type": "string", "pattern": f"^{_METER_VALUE_TEXT.pattern}$", "examples": ["1254.100"]},
        mode="validation",
    ),
]

# A meter value or delta in a response: a canonical string with exactly 3 decimals. Deltas such as
# unallocated_loss can be negative.
MeterAmount = Annotated[
    Decimal,
    WithJsonSchema(
        {"type": "string", "pattern": r"^-?[0-9]+\.[0-9]{3}$", "examples": ["1254.000"]},
        mode="serialization",
    ),
]

PERIOD_CODE_PATTERN = r"^[0-9]{4}-(0[1-9]|1[0-2])$"
PeriodCode = Annotated[str, Field(pattern=PERIOD_CODE_PATTERN, examples=["2026-10"])]


class NewMeter(BaseModel):
    """A meter of a new building, already checked by the filling core (epic E13 R3)."""

    model_config = ConfigDict(frozen=True)

    apartment_id: uuid.UUID | None  # None: a Building Master Meter
    resource_type: ResourceType
    unit: MeterUnit
    serial_number: str | None
    location_label: str
    initial_value: Decimal | None  # None: no known start (R3b)
    max_monthly_delta: Decimal


class ReadingSubmitRequest(BaseModel):
    """Body of POST /api/v1/meters/readings (the 2-step anomaly flow uses confirmation_level)."""

    model_config = ConfigDict(extra="forbid")

    meter_id: uuid.UUID
    period_code: PeriodCode
    value: MeterValue
    # Only for a meter without a start (no initial value, no earlier reading): the reading of
    # the last bill. Any other meter refuses it (422 PREVIOUS_VALUE_NOT_ALLOWED).
    previous_value: MeterValue | None = None
    # docs/API.md: 0 -> popup #1, 1 -> popup #2, >= 2 -> save as a confirmed anomaly.
    # Strict: true, "2" and 1.0 are not confirmation levels.
    confirmation_level: StrictInt = Field(default=0, ge=0, le=100)
    # No control characters (a NUL byte would be a 500 from PostgreSQL); blank means None.
    reason: ReasonText = None


# --- Response DTOs (docs/API.md, sections 2 and 3) -----------------------------------------------
# Decimal fields serialize as canonical strings ("1254.000"), never as JSON numbers.


class PeriodDTO(BaseModel):
    period_code: str
    status: PeriodStatus
    due_date: datetime


class DuePeriodRefDTO(BaseModel):
    """An open period with a deadline, for the reading reminders (system-level, notifications)."""

    model_config = ConfigDict(frozen=True)

    period_id: uuid.UUID
    building_id: uuid.UUID
    period_code: str
    due_date: datetime


class PeriodListResponse(BaseModel):
    periods: list[PeriodDTO]  # newest first


class ReadingSummary(BaseModel):
    reading_id: uuid.UUID
    value: MeterAmount
    # The floor it was checked against; for a SUBMITTED start the bill's reading it keeps.
    previous_value: MeterAmount
    consumption_delta: MeterAmount
    source: ReadingSource
    is_anomaly_confirmed: bool
    previous_origin: PreviousOrigin


class ReadingResponse(BaseModel):
    reading_id: uuid.UUID
    meter_id: uuid.UUID
    period_code: str
    value: MeterAmount
    consumption_delta: MeterAmount
    source: ReadingSource
    is_anomaly_confirmed: bool
    previous_origin: PreviousOrigin


APARTMENT_HISTORY_PERIODS = 24  # periods in GET /meters/apartments/{id}/readings


class ApartmentReading(BaseModel):
    period_code: str
    reading_id: uuid.UUID
    value: MeterAmount
    consumption_delta: MeterAmount
    source: ReadingSource
    is_anomaly_confirmed: bool
    previous_origin: PreviousOrigin


class ApartmentMeterHistory(BaseModel):
    meter_id: uuid.UUID
    resource_type: ResourceType
    serial_number: str | None  # None until set (optional since epic E13 R3)
    location_label: str
    unit: MeterUnit
    is_active: bool
    readings: list[ApartmentReading]  # newest first, only periods with a reading


class ApartmentReadingsResponse(BaseModel):
    """One apartment's readings across the latest periods (the E8 card and the resident's chart)."""

    apartment_id: uuid.UUID
    apartment_number: str
    periods: list[PeriodDTO]  # newest first
    meters: list[ApartmentMeterHistory]


# --- Consumption per month (docs/API.md section 3) ----------------------------------------------

CONSUMPTION_MONTHS_DEFAULT = 12
CONSUMPTION_MONTHS_MAX = 24

# Consumption per m2 in a response: a canonical string with exactly 4 decimals ("0.0951").
AreaRate = Annotated[
    Decimal,
    WithJsonSchema(
        {"type": "string", "pattern": r"^-?[0-9]+\.[0-9]{4}$", "examples": ["0.0951"]},
        mode="serialization",
    ),
]


class ApartmentConsumptionMonth(BaseModel):
    period_code: str
    consumption: MeterAmount | None  # None: no reading of this type in the period
    estimated: bool


class ApartmentConsumptionSeries(BaseModel):
    resource_type: ResourceType
    unit: MeterUnit
    months: list[ApartmentConsumptionMonth]  # one per period, in the order of `periods`


class ApartmentConsumptionResponse(BaseModel):
    """One apartment's consumption per month, ready for a chart; never building averages."""

    apartment_id: uuid.UUID
    apartment_number: str
    periods: list[PeriodDTO]  # oldest first
    resources: list[ApartmentConsumptionSeries]


class BuildingConsumptionMonth(BaseModel):
    period_code: str
    total: MeterAmount | None  # None: no apartment has a reading of this type in the period
    apartments_counted: int
    average_per_apartment: MeterAmount | None
    average_per_m2: AreaRate | None
    estimated_readings: int


class BuildingConsumptionSeries(BaseModel):
    resource_type: ResourceType
    unit: MeterUnit
    months: list[BuildingConsumptionMonth]  # one per period, in the order of `periods`


class BuildingConsumptionResponse(BaseModel):
    """The building's apartment meters per month (staff only); master meters are left out."""

    periods: list[PeriodDTO]  # oldest first
    resources: list[BuildingConsumptionSeries]


class NextSubmission(BaseModel):
    """Where a meter's next resident reading goes (docs/API.md section 2)."""

    period_code: str
    due_date: datetime
    # A late reading for the previous month: the resident cannot change it afterwards.
    final: bool
    # The form's floor and hints, against this period (the shown period may be another one).
    # None with needs_start: the meter has no start before this period and no reading in it.
    previous_value: MeterAmount | None
    needs_start: bool
    average_delta: MeterAmount | None
    reading: ReadingSummary | None  # what the user already submitted for this period


class DashboardMeter(BaseModel):
    meter_id: uuid.UUID
    resource_type: ResourceType
    serial_number: str | None  # None until set (optional since epic E13 R3)
    location_label: str
    unit: MeterUnit
    previous_value: MeterAmount | None  # None with needs_start and no reading yet
    # No initial value and no reading before the shown period (epic E13 R3b).
    needs_start: bool
    # Hints before submitting: the anomaly check's 3-period average and last period's consumption.
    average_delta: MeterAmount | None
    previous_delta: MeterAmount | None
    reading: ReadingSummary | None
    # None when nothing can be submitted: no right to, or the target period is missing or closed.
    next_submission: NextSubmission | None


class DashboardApartment(BaseModel):
    apartment_id: uuid.UUID
    apartment_number: str
    can_submit_readings: bool
    meters: list[DashboardMeter]


class DashboardResponse(BaseModel):
    period: PeriodDTO | None
    apartments: list[DashboardApartment]


class MatrixMeter(BaseModel):
    meter_id: uuid.UUID
    resource_type: ResourceType
    location_label: str
    unit: MeterUnit
    # The board's entry form needs both (epic E13 R3b): the floor of a new value, and whether
    # the meter still has no start, so the form offers the reading of the last bill.
    previous_value: MeterAmount | None  # None with needs_start and no reading yet
    needs_start: bool
    status: SubmissionStatus
    reading: ReadingSummary | None


class MatrixApartment(BaseModel):
    apartment_id: uuid.UUID
    apartment_number: str
    entrance: int | None
    floor: int | None
    status: SubmissionStatus
    meters: list[MatrixMeter]


class MasterMeterRow(MatrixMeter):
    """A Building Master Meter in the matrix: its id is what the board submits against."""


class ResourceBalance(BaseModel):
    resource_type: ResourceType
    unit: MeterUnit
    master_total: MeterAmount | None  # None while any master meter of this type has no reading
    apartments_sum: MeterAmount
    unallocated_loss: MeterAmount | None
    # Apartment meters of this kind whose reading in the period started them (counted as 0).
    starting_meters: int


class MatrixResponse(BaseModel):
    period: PeriodDTO
    balances: list[ResourceBalance]
    master_meters: list[MasterMeterRow]
    apartments: list[MatrixApartment]


class EstimatedReading(BaseModel):
    reading_id: uuid.UUID
    meter_id: uuid.UUID
    apartment_id: uuid.UUID
    value: MeterAmount
    consumption_delta: MeterAmount


class EstimateResponse(BaseModel):
    period_code: str
    estimated_count: int
    estimated: list[EstimatedReading]
    # Meters without a start cannot be estimated (epic E13 R3b).
    skipped_without_start: list[uuid.UUID]


class PeriodStatusUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: PeriodStatus


class PeriodStatusUpdateResponse(BaseModel):
    period_code: str
    previous_status: PeriodStatus
    status: PeriodStatus


class HistoryEntry(BaseModel):
    changed_at: datetime
    old_value: MeterAmount | None
    new_value: MeterAmount
    source: ReadingSource
    reason: str | None
    changed_by: AuthorBadgeDTO | None  # masked; None for the system


class ReadingHistoryResponse(BaseModel):
    reading_id: uuid.UUID
    meter_id: uuid.UUID
    period_code: str
    entries: list[HistoryEntry]
