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
from collections.abc import Iterable, Sequence
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Annotated, NamedTuple

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


# Every module shares this enum, `TargetDTO` and the one rule `apartment_in_target` below.
class TargetScope(StrEnum):
    """Who an alert, a notice or a poll is meant for. ALL_BUILDING: the apartments;
    ALL_OBJECTS: every object of every kind; KINDS: the objects of `target_kinds`."""

    ALL_BUILDING = "ALL_BUILDING"
    ENTRANCE = "ENTRANCE"
    APARTMENT_LIST = "APARTMENT_LIST"
    ALL_OBJECTS = "ALL_OBJECTS"
    KINDS = "KINDS"


class ObjectKind(StrEnum):
    """The kind of an object of ownership (epic E14): an "apartment" in the code, the tables and
    the API is an object of any kind. Listed in the order objects are shown."""

    APARTMENT = "APARTMENT"
    PARKING = "PARKING"
    GARAGE = "GARAGE"


class TargetDTO(BaseModel):
    """The target of a post, a poll or a maintenance notice: the one shape every check and every
    targeting rule takes. `apartment_ids` is empty unless the scope is APARTMENT_LIST, `kinds`
    unless it is KINDS."""

    model_config = ConfigDict(frozen=True)

    scope: TargetScope
    entrance: int | None = None
    apartment_ids: frozenset[uuid.UUID] = frozenset()
    kinds: frozenset[ObjectKind] = frozenset()

    @classmethod
    def of(
        cls,
        scope: TargetScope,
        entrance: int | None,
        apartment_ids: Iterable[uuid.UUID | str] | None,
        kinds: Iterable[ObjectKind | str] | None = None,
    ) -> "TargetDTO":
        """From the target fields of a request or a stored row (ids as UUIDs or JSON strings,
        kinds as enum members or their values)."""
        return cls(
            scope=scope,
            entrance=entrance,
            apartment_ids=frozenset(uuid.UUID(str(value)) for value in apartment_ids or ()),
            kinds=frozenset(ObjectKind(value) for value in kinds or ()),
        )

    @property
    def stored_kinds(self) -> list[str] | None:
        """`kinds` as a JSONB column stores them: in the order of kinds, NULL without any."""
        return [kind.value for kind in ObjectKind if kind in self.kinds] or None


def _unique_kinds(kinds: list[ObjectKind] | None) -> list[ObjectKind] | None:
    """Drop duplicates, in the order of kinds; an empty list means "not given"."""
    return [kind for kind in ObjectKind if kind in kinds] if kinds else None


# `target_kinds` of a request: the kinds of a KINDS target (epic E14).
TargetKinds = Annotated[list[ObjectKind] | None, AfterValidator(_unique_kinds)]


class ObjectRef(NamedTuple):
    """An object named by its kind and number, as people write it (numbers repeat across
    kinds, so a number alone names no object)."""

    kind: ObjectKind
    number: str


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
    kind: ObjectKind
    number: str
    # None for an object without an entrance or a floor (a parking space, a garage).
    entrance: int | None
    floor: int | None


class NewApartment(BaseModel):
    """An apartment of a new building, already checked by the filling core (epic E13 R3)."""

    model_config = ConfigDict(frozen=True)

    kind: ObjectKind = ObjectKind.APARTMENT
    number: str
    entrance: int | None
    floor: int | None
    area_m2: Decimal | None


class ApartmentMembershipDTO(BaseModel):
    model_config = ConfigDict(frozen=True)

    membership_id: uuid.UUID
    apartment_id: uuid.UUID
    apartment_number: str
    apartment_kind: ObjectKind
    entrance: int | None
    floor: int | None
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


# --- Objects and targets: pure rules every module shares (epic E14, section 2.5) ---------------

_KIND_ORDER = tuple(ObjectKind)
APARTMENT_LABEL = "Apt."
_KIND_LETTERS = {ObjectKind.PARKING: "P", ObjectKind.GARAGE: "G"}


def object_label(kind: ObjectKind, number: str) -> str:
    """The short name of an object in badges, the same in every language: "Apt. 14", "P14",
    "G12". A number that already starts with the kind's letter, in any case, stays as it is
    ("G12", "g12", "P-012"), since the number is stored as the chairman typed it."""
    letter = _KIND_LETTERS.get(kind)
    if letter is None:
        return f"{APARTMENT_LABEL} {number}"
    return number if number[:1].casefold() == letter.casefold() else f"{letter}{number}"


def parse_object_ref(kind: str | None, number: str) -> ObjectRef:
    """An object named in a file or a request; a missing kind means an apartment, so old files
    and requests keep working. Raises ValueError for a kind that is not known."""
    cleaned = (kind or "").strip().upper()
    return ObjectRef(ObjectKind(cleaned) if cleaned else ObjectKind.APARTMENT, number.strip())


def object_sort_key(kind: ObjectKind, entrance: int | None, number: str) -> tuple:
    """The order of objects everywhere: by kind, then entrance (none last), then the number in
    natural order ("2" < "10" < "14" < "14A" < "14a", by code point). The SQL order of the
    property service is kept equal to it by a test."""
    return (_KIND_ORDER.index(kind), entrance is None, entrance or 0, len(number), number)


def target_consistency_problem(target: TargetDTO) -> str | None:
    """Why the fields of a target do not fit its scope, or None when they do. Whether the
    entrance or the apartments exist is `PropertyService.target_problem_in_building`."""
    if target.kinds and target.scope != TargetScope.KINDS:
        return f"{target.scope.value} does not take target_kinds."
    if target.scope in (TargetScope.ALL_BUILDING, TargetScope.ALL_OBJECTS):
        if target.entrance is not None or target.apartment_ids:
            return f"{target.scope.value} takes neither target_entrance nor target_apartment_ids."
    elif target.scope == TargetScope.KINDS:
        if not target.kinds:
            return "KINDS needs at least one kind in target_kinds."
        if target.entrance is not None or target.apartment_ids:
            return "KINDS takes neither target_entrance nor target_apartment_ids."
    elif target.scope == TargetScope.ENTRANCE:
        if target.entrance is None:
            return "ENTRANCE needs target_entrance."
        if target.apartment_ids:
            return "ENTRANCE does not take target_apartment_ids."
    elif not target.apartment_ids:
        return "APARTMENT_LIST needs at least one apartment in target_apartment_ids."
    elif target.entrance is not None:
        return "APARTMENT_LIST does not take target_entrance."
    return None


def apartment_in_target(
    target: TargetDTO, *, apartment_id: uuid.UUID, kind: ObjectKind, entrance: int | None
) -> bool:
    """Whether an object is in a target: the one rule of who is reached, per object (a person is
    reached through each of their objects that the target holds). Recipients and electors use
    it directly; the SQL of `PropertyService.targeting_clause` is kept equal to it by tests.

    The whole building is the apartments: a parking space or a garage is reached by
    ALL_OBJECTS, by its kind, or by its own id."""
    if target.scope == TargetScope.ALL_BUILDING:
        return kind == ObjectKind.APARTMENT
    if target.scope == TargetScope.ALL_OBJECTS:
        return True
    if target.scope == TargetScope.KINDS:
        return kind in target.kinds
    if target.scope == TargetScope.ENTRANCE:
        return (
            kind == ObjectKind.APARTMENT
            and target.entrance is not None
            and entrance == target.entrance
        )
    return apartment_id in target.apartment_ids


def first_object_in(user: CurrentUserDTO, target: TargetDTO | None) -> uuid.UUID | None:
    """The object that signs a forum topic, a comment or a chat message when the author names
    none: the author's first membership (in list order) inside `target`, or the first of all
    without one; None without such a membership. Never an error."""
    for membership in user.memberships:
        if target is None or apartment_in_target(
            target,
            apartment_id=membership.apartment_id,
            kind=membership.apartment_kind,
            entrance=membership.entrance,
        ):
            return membership.apartment_id
    return None


class ObjectNotHeld(ValueError):
    """The object named is not one of the candidates."""


class ObjectNotChosen(ValueError):
    """No object was named and there are several to choose from."""


def chosen_object(
    candidates: Sequence[tuple[uuid.UUID, ObjectKind]], requested: uuid.UUID | None
) -> uuid.UUID | None:
    """The object an issue report or a ballot is made from: the requested one, which must be a
    candidate (else ObjectNotHeld); without one the only candidate; with several the only
    apartment among them (an owner of Apt. 14 who also gets a parking space keeps working with a
    client that leaves the object out), else ObjectNotChosen; None without candidates. Each
    caller answers the errors in its own words."""
    if requested is not None:
        if requested not in {object_id for object_id, _ in candidates}:
            raise ObjectNotHeld
        return requested
    if len(candidates) <= 1:
        return candidates[0][0] if candidates else None
    apartments = [object_id for object_id, kind in candidates if kind == ObjectKind.APARTMENT]
    if len(apartments) == 1:
        return apartments[0]
    raise ObjectNotChosen


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
    # Of the apartments only (epic E14): parking spaces and garages are not heated area.
    apartment_count: int
    entrance_count: int
    heated_area_m2: AreaAmount
    # The number of objects of every kind (0 for a kind the building has none of).
    object_counts: dict[ObjectKind, int]
    # The building passport the chairman accepted (epic E12); null without one.
    registry_facts: RegistryFacts | None = None


class ApartmentSummary(BaseModel):
    """An apartment in the board's list of cards (epic E8): counts of members, no people."""

    apartment_id: uuid.UUID
    apartment_number: str
    apartment_kind: ObjectKind
    entrance: int | None
    floor: int | None
    area_m2: AreaAmount | None
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
    kind: ObjectKind
    number: str


class ConnectionRowDTO(BaseModel):
    """One apartment of the connection overview (epic E13 R4b): counts only, never people."""

    model_config = ConfigDict(frozen=True)

    apartment_id: uuid.UUID
    kind: ObjectKind
    number: str
    entrance: int | None
    on_paper: bool
    owners: int
    tenants: int


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
    apartment_kind: ObjectKind
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
