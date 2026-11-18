"""Public enums and DTOs of the property module (API payloads and inter-module contracts).

None of these DTOs carries a raw full name, email or phone: identity leaves the module only as
an AuthorBadgeDTO, already masked according to the user's privacy display mode. The one documented
exception (docs/ARCHITECTURE.md 3.4) is DeliveryContactDTO: the notifications dispatcher asks for
one user's address right before sending, keeps it in memory for that send, and never logs or
stores it.
"""

import re
import unicodedata
import uuid
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Annotated

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    ValidationInfo,
    WithJsonSchema,
    field_validator,
    model_validator,
)

from src.core.validation import clean_required_text, clean_text
from src.plugins.registry import RegistryFacts


class BuildingRole(StrEnum):
    CHAIRMAN = "CHAIRMAN"
    BOARD = "BOARD"
    ACCOUNTANT = "ACCOUNTANT"
    USER = "USER"


class RelationType(StrEnum):
    OWNER = "OWNER"
    TENANT = "TENANT"
    RESIDENT = "RESIDENT"


class DisplayMode(StrEnum):
    APARTMENT_ONLY = "APARTMENT_ONLY"
    INITIALS = "INITIALS"
    FULL_NAME = "FULL_NAME"


class Locale(StrEnum):
    """Language of notifications sent outside the app (the API itself is English only)."""

    ET = "et"
    RU = "ru"
    EN = "en"


class TargetScope(StrEnum):
    """Who an alert or notice is meant for. Communication posts and notification recipients
    share this enum and the matching rule `property.policies.apartment_in_target`."""

    ALL_BUILDING = "ALL_BUILDING"
    ENTRANCE = "ENTRANCE"
    APARTMENT_LIST = "APARTMENT_LIST"


class RoleBadge(StrEnum):
    OWNER = "OWNER"
    RESIDENT = "RESIDENT"
    BOARD = "BOARD"
    ACCOUNTANT = "ACCOUNTANT"


class AuthorBadgeDTO(BaseModel):
    model_config = ConfigDict(frozen=True)

    display_label: str
    role_badge: RoleBadge


class ApartmentDTO(BaseModel):
    """An apartment as other modules see it (no residents, no names)."""

    model_config = ConfigDict(frozen=True)

    id: uuid.UUID
    number: str
    entrance: int
    floor: int


class ApartmentMembershipDTO(BaseModel):
    model_config = ConfigDict(frozen=True)

    membership_id: uuid.UUID
    apartment_id: uuid.UUID
    apartment_number: str
    entrance: int
    floor: int
    relation_type: RelationType
    can_submit_readings: bool
    can_view_bills: bool
    can_vote: bool
    privacy_display_mode: DisplayMode
    # When the membership started (reopening sets it to now): threads with the board started
    # before it stay hidden from this member (docs/API.md section 4).
    since: datetime


class CurrentUserDTO(BaseModel):
    """The authenticated user as seen by every module (returned by core.security)."""

    model_config = ConfigDict(frozen=True)

    id: uuid.UUID
    building_id: uuid.UUID
    building_role: BuildingRole
    privacy_display_mode: DisplayMode
    memberships: tuple[ApartmentMembershipDTO, ...] = ()

    def membership_for(self, apartment_id: uuid.UUID) -> ApartmentMembershipDTO | None:
        return next((m for m in self.memberships if m.apartment_id == apartment_id), None)

    @property
    def apartment_ids(self) -> frozenset[uuid.UUID]:
        return frozenset(m.apartment_id for m in self.memberships)


class MembershipView(ApartmentMembershipDTO):
    preview_badge: AuthorBadgeDTO


class MeResponse(BaseModel):
    user_id: uuid.UUID
    building_id: uuid.UUID
    building_role: BuildingRole
    privacy_display_mode: DisplayMode
    # Language of notifications sent outside the app; None = the instance default.
    locale: Locale | None
    memberships: list[MembershipView]


class LocaleUpdate(BaseModel):
    """Request and response of PATCH /api/v1/property/me/locale."""

    model_config = ConfigDict(extra="forbid")

    locale: Locale | None


class DeliveryContactDTO(BaseModel):
    """The documented exception to "no raw e-mail in a DTO": only for sending one message."""

    model_config = ConfigDict(frozen=True)

    email: str

    def __repr__(self) -> str:  # never print the address by accident
        return "DeliveryContactDTO(email=***)"

    __str__ = __repr__


class UserRefDTO(BaseModel):
    """An active user as module auth needs it (docs/ARCHITECTURE.md 4.2): ids, role, language."""

    model_config = ConfigDict(frozen=True)

    user_id: uuid.UUID
    building_id: uuid.UUID
    building_role: BuildingRole
    locale: Locale | None


class ElectorDTO(BaseModel):
    """Someone who may take part in a poll through one apartment (epic E3): ids only."""

    model_config = ConfigDict(frozen=True)

    user_id: uuid.UUID
    apartment_id: uuid.UUID


class RecipientDTO(BaseModel):
    """A notification recipient: an id and a language, never contact data."""

    model_config = ConfigDict(frozen=True)

    user_id: uuid.UUID
    locale: Locale | None


# An area in m2 in a response: a string with exactly 2 decimals ("329.20"), never a JSON number.
AreaAmount = Annotated[
    Decimal,
    PlainSerializer(lambda value: f"{value:.2f}", return_type=str),
    WithJsonSchema(
        {"type": "string", "pattern": r"^[0-9]+\.[0-9]{2}$", "examples": ["329.20"]},
        mode="serialization",
    ),
]


_COUNTRY_CODE = re.compile(r"[A-Za-z]{2}")
_REGISTRY_CODE = re.compile(r"(?=.*[A-Za-z0-9])[A-Za-z0-9-]{1,20}")
# Single-line fields: no control characters (Cc: C0 and C1, tab and line breaks included), no
# invisible format characters (Cf: a right-to-left override, a zero-width space) and no line or
# paragraph separators (Zl, Zp).
_NOT_ONE_LINE = frozenset({"Cc", "Cf", "Zl", "Zp"})
_ESTONIAN_REGISTRY_CODE = re.compile(r"[0-9]{8}")


class NewBuilding(BaseModel):
    """The building of a new installation (operator command create-building, docs/API.md 1)."""

    name: str
    address: str
    country_code: str = "EE"
    registry_code: str | None = None
    reading_deadline_day: int = Field(default=4, ge=1, le=31)

    @field_validator("name", "address", mode="after")
    @classmethod
    def _required_text(cls, value: str, info: ValidationInfo) -> str:
        cleaned = clean_required_text(value)
        if any(unicodedata.category(char) in _NOT_ONE_LINE for char in cleaned):
            raise ValueError("one line of visible text")
        limit = 255 if info.field_name == "name" else 500
        if len(cleaned) > limit:
            raise ValueError(f"at most {limit} characters")
        return cleaned

    @field_validator("country_code", mode="after")
    @classmethod
    def _country(cls, value: str) -> str:
        code = value.strip()
        if not _COUNTRY_CODE.fullmatch(code):  # ASCII only, before upper() ("ß" is not "SS")
            raise ValueError("two letters (ISO 3166-1 alpha-2)")
        return code.upper()

    @field_validator("registry_code", mode="after")
    @classmethod
    def _registry_code(cls, value: str | None) -> str | None:
        if value is None:
            return None
        code = value.strip()
        if not _REGISTRY_CODE.fullmatch(code):
            raise ValueError("1 to 20 letters, digits or '-', at least one letter or digit")
        return code

    @model_validator(mode="after")
    def _estonian_registry_code(self) -> "NewBuilding":
        code = self.registry_code
        if code is not None and self.country_code == "EE":
            if not _ESTONIAN_REGISTRY_CODE.fullmatch(code):
                raise ValueError("registry_code: an Estonian registry code has exactly 8 digits")
        return self


class BuildingResponse(BaseModel):
    """The association and its building; public within the building (no people in it)."""

    building_id: uuid.UUID
    name: str
    registry_code: str | None
    address: str
    country_code: str
    reading_deadline_day: int
    apartment_count: int
    entrance_count: int
    heated_area_m2: AreaAmount
    # The building passport the chairman accepted (epic E12); null without one.
    registry_facts: RegistryFacts | None = None


class ApartmentSummary(BaseModel):
    """An apartment in the board's list of cards (epic E8): counts of members, no people."""

    apartment_id: uuid.UUID
    apartment_number: str
    entrance: int
    floor: int
    area_m2: AreaAmount
    owner_count: int
    tenant_count: int
    resident_count: int


class ApartmentListResponse(BaseModel):
    apartments: list[ApartmentSummary]


class CardResident(BaseModel):
    """A member on an apartment card: only the relation and since when, never who."""

    relation_type: RelationType
    since: datetime


class ApartmentCard(ApartmentSummary):
    residents: list[CardResident]


class PrivacyUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    privacy_display_mode: DisplayMode


class PrivacyUpdateResponse(BaseModel):
    membership_id: uuid.UUID
    privacy_display_mode: DisplayMode
    preview_badge: AuthorBadgeDTO


# --- System-level contracts with module auth (docs/ARCHITECTURE.md 4.2) --------------------------


class ApartmentRefDTO(BaseModel):
    model_config = ConfigDict(frozen=True)

    apartment_id: uuid.UUID
    building_id: uuid.UUID
    number: str


class MembershipRefDTO(BaseModel):
    """An active membership as module auth needs it: ids and the relation, no people."""

    model_config = ConfigDict(frozen=True)

    membership_id: uuid.UUID
    user_id: uuid.UUID
    apartment_id: uuid.UUID
    building_id: uuid.UUID
    relation_type: RelationType


class ResidentDTO(BaseModel):
    """A member of one apartment, shown under the badge rules (no name beyond consent)."""

    model_config = ConfigDict(frozen=True)

    user_id: uuid.UUID
    membership_id: uuid.UUID
    relation_type: RelationType
    display_label: str
    since: datetime


class PersonMembershipDTO(BaseModel):
    model_config = ConfigDict(frozen=True)

    membership_id: uuid.UUID
    apartment_id: uuid.UUID
    apartment_number: str
    relation_type: RelationType
    display_label: str
    since: datetime


class PersonDTO(BaseModel):
    """An active person of the building for the chairman's list, under the badge rules."""

    model_config = ConfigDict(frozen=True)

    user_id: uuid.UUID
    building_role: BuildingRole
    display_label: str
    memberships: tuple[PersonMembershipDTO, ...]


# --- Building register facts (epic E12, docs/API.md section 1) ----------------------------------

REGISTRY_QUERY_MIN, REGISTRY_QUERY_MAX = 3, 200


def _clean_query(value: str | None) -> str | None:
    """No control characters, spaces collapsed, at least 3 characters besides spaces."""
    if value is None:
        return None
    value = " ".join(clean_text(value).split())
    if len(value) < REGISTRY_QUERY_MIN:
        raise ValueError(f"at least {REGISTRY_QUERY_MIN} characters besides spaces")
    return value


class RegistryCandidateView(BaseModel):
    code: str
    address: str
    kind_label: str | None


class RegistrySearchResponse(BaseModel):
    candidates: list[RegistryCandidateView]


class RegistrySearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Trimmed; omitted or null: the building's own address.
    query: Annotated[str | None, AfterValidator(_clean_query)] = Field(
        default=None, max_length=REGISTRY_QUERY_MAX
    )


class RegistryLookup(BaseModel):
    """The operator command find-building (docs/API.md section 1): the address as `query` above."""

    address: Annotated[str, AfterValidator(_clean_query)] = Field(max_length=REGISTRY_QUERY_MAX)
    country_code: str = "EE"

    @field_validator("country_code", mode="after")
    @classmethod
    def _country(cls, value: str) -> str:
        code = value.strip()
        if not _COUNTRY_CODE.fullmatch(code):
            raise ValueError("two letters (ISO 3166-1 alpha-2)")
        return code.upper()


class RegistryProposalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1, max_length=32)


class RegistryState(BaseModel):
    accepted: RegistryFacts | None
    accepted_at: datetime | None
    proposal: RegistryFacts | None
    proposal_fetched_at: datetime | None
