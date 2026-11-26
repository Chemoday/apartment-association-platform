"""Public enums and DTOs of the auth module (docs/API.md section 7)."""

import re
import unicodedata
import uuid
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field

from src.core.validation import (
    OptionalPhoneNumber,
    PhoneNumber,
    canonical_email,
    clean_text,
    safe_text,
)
from src.modules.property.schemas import BuildingRole, DisplayMode, Locale, ObjectKind, RelationType

MAX_EMAIL_LENGTH = 254


# A basic shape only (owner, 2026-11-22): whether the mailbox exists is never known. Letters of
# any script are allowed; quotes, brackets, commas and the like are not.
_LOCAL_CHARACTER = re.compile(r"[\w.!#$%&'*+/=?^`{|}~-]")
_DOMAIN_LABEL = re.compile(r"[^\W_](?:(?:[^\W_]|-)*[^\W_])?")


def _is_email_shape(local: str, domain: str) -> bool:
    if not local or len(local) > 64 or local.startswith(".") or local.endswith("."):
        return False
    if ".." in local or not all(_LOCAL_CHARACTER.fullmatch(c) for c in local):
        return False
    labels = domain.split(".")
    if len(labels) < 2 or len(labels[-1]) < 2 or labels[-1].isdigit():
        return False
    return all(len(label) <= 63 and _DOMAIN_LABEL.fullmatch(label) for label in labels)


def _email_address(value: str) -> str:
    """The canonical form of an e-mail address, or a validation error (422): one @, a local part
    without dots at its ends or in a row, a domain of dot-separated labels (letters, digits,
    hyphens inside) ending in a label of two or more characters."""
    canonical = canonical_email(clean_text(value))  # control characters (NUL) are refused
    if canonical.count("@") != 1 or len(canonical) > MAX_EMAIL_LENGTH:
        raise ValueError("not an e-mail address")
    local, _, domain = canonical.partition("@")
    if not _is_email_shape(local, domain):
        raise ValueError("not an e-mail address")
    return canonical


EmailAddress = Annotated[str, Field(min_length=3, max_length=320), AfterValidator(_email_address)]


class AuthMethod(StrEnum):
    MAGIC_LINK = "MAGIC_LINK"
    PASSWORD = "PASSWORD"
    REGISTRATION = "REGISTRATION"


class DeviceKind(StrEnum):
    DESKTOP_BROWSER = "DESKTOP_BROWSER"
    MOBILE_BROWSER = "MOBILE_BROWSER"
    UNKNOWN = "UNKNOWN"


class TokenPurpose(StrEnum):
    MAGIC_LINK = "MAGIC_LINK"
    INVITATION = "INVITATION"
    REGISTRATION = "REGISTRATION"


class AttemptKind(StrEnum):
    MAGIC_LINK = "MAGIC_LINK"
    REDEEM = "REDEEM"
    PASSWORD = "PASSWORD"
    INVITATION = "INVITATION"
    BULK_INVITATION = "BULK_INVITATION"
    INVITATION_MAIL = "INVITATION_MAIL"
    JOIN = "JOIN"


class PasswordWeakness(StrEnum):
    TOO_SHORT = "TOO_SHORT"
    TOO_LONG = "TOO_LONG"
    TOO_COMMON = "TOO_COMMON"


class SignInStatus(StrEnum):
    SIGNED_IN = "SIGNED_IN"
    REGISTRATION_REQUIRED = "REGISTRATION_REQUIRED"
    SIGN_IN_TO_ACCEPT = "SIGN_IN_TO_ACCEPT"


class InvitationKind(StrEnum):
    OWNER = "OWNER"
    TENANT = "TENANT"
    STAFF = "STAFF"


class StaffRole(StrEnum):
    """The building roles a STAFF invitation can give (USER is no staff role)."""

    BOARD = "BOARD"
    ACCOUNTANT = "ACCOUNTANT"
    CHAIRMAN = "CHAIRMAN"


class InvitationStatus(StrEnum):
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    EXPIRED = "EXPIRED"
    NO_LONGER_VALID = "NO_LONGER_VALID"


class InvitationDelivery(StrEnum):
    """Whether the e-mail of an invitation went out (the invitation queue, E13 R4a)."""

    QUEUED = "QUEUED"
    SENT = "SENT"
    FAILED = "FAILED"  # the mail server refused it INVITATION_MAX_FAILED_SENDS times in a row


class BulkRowOutcome(StrEnum):
    """docs/API.md 7, "Bulk invitations of owners": the first that applies."""

    INVALID_ROW = "INVALID_ROW"
    INVALID_EMAIL = "INVALID_EMAIL"
    INVALID_LOCALE = "INVALID_LOCALE"
    APARTMENT_NOT_FOUND = "APARTMENT_NOT_FOUND"
    DUPLICATE_IN_LIST = "DUPLICATE_IN_LIST"
    ALREADY_PENDING = "ALREADY_PENDING"
    READY = "READY"
    INVITED = "INVITED"


class MagicLinkRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailAddress


class MagicLinkAccepted(BaseModel):
    accepted: bool = True


class RedeemRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=128)


class SessionResponse(BaseModel):
    """What a sign-in or a refresh returns; the refresh cookie travels next to it."""

    access_token: str
    token_type: str = "Bearer"
    expires_in: int
    session_id: uuid.UUID


class SessionView(BaseModel):
    session_id: uuid.UUID
    device_kind: DeviceKind
    auth_method: AuthMethod
    authenticated_at: datetime
    last_used_at: datetime
    current: bool


@dataclass(frozen=True)
class IssuedSession:
    """A session just started or refreshed: the answer, and the refresh token for the cookie
    (None when the browser already holds the current one: the grace window)."""

    response: SessionResponse
    refresh_token: str | None
    expires_at: datetime  # of the session, for the cookie's Max-Age


class InvitationPreview(BaseModel):
    """What an invitation grants, shown to the holder of its link only."""

    kind: InvitationKind
    apartment_number: str | None
    apartment_kind: ObjectKind | None
    building_role: StaffRole | None
    # The building's country (ISO 3166-1 alpha-2): the default of the phone field.
    country_code: str


class SignInResponse(BaseModel):
    """The answer of redeeming a link or registering (docs/API.md 7)."""

    status: SignInStatus
    session: SessionResponse | None = None
    # REGISTRATION_REQUIRED only:
    registration_token: str | None = None
    expires_in: int | None = None
    # REGISTRATION_REQUIRED and SIGN_IN_TO_ACCEPT:
    invitation: InvitationPreview | None = None


# --- Invitations (A4) ---------------------------------------------------------------------------


class OwnerInvitationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal[InvitationKind.OWNER]
    email: EmailAddress
    apartment_number: safe_text(32)  # type: ignore[valid-type]
    # The instance default or en (checked by the service, which knows the default).
    locale: Locale | None = None


class TenantInvitationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal[InvitationKind.TENANT]
    email: EmailAddress
    apartment_id: uuid.UUID
    # The instance default or en (checked by the service, which knows the default).
    locale: Locale | None = None


class StaffInvitationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal[InvitationKind.STAFF]
    email: EmailAddress
    building_role: StaffRole
    # The instance default or en (checked by the service, which knows the default).
    locale: Locale | None = None


InvitationCreate = Annotated[
    OwnerInvitationCreate | TenantInvitationCreate | StaffInvitationCreate,
    Field(discriminator="kind"),
]


class InvitationView(BaseModel):
    invitation_id: uuid.UUID
    kind: InvitationKind
    # In full only for the person who typed it in (`mine`), masked for everyone else.
    email: str
    apartment_id: uuid.UUID | None
    apartment_number: str | None
    apartment_kind: ObjectKind | None
    building_role: StaffRole | None
    status: InvitationStatus
    mine: bool
    locale: Locale | None
    delivery: InvitationDelivery
    created_at: datetime
    expires_at: datetime


def _no_control(value: str) -> str:
    """Refuse control characters (NUL ...) like clean_text, but keep the text as it is."""
    clean_text(value)
    return value


# A bulk list is at most 1 MB of UTF-8 (422 BULK_LIST_TOO_LONG, checked by the service); this
# bound only keeps an absurd body out of memory.
BULK_TEXT_MAX_CHARS = 4 * 1024 * 1024


class BulkInvitationRequest(BaseModel):
    """The list of POST /auth/invitations/bulk[/preview]: parsed in memory, never stored."""

    model_config = ConfigDict(extra="forbid")

    # Not clean_text: that also trims, and the report counts lines from the very first one.
    text: Annotated[str, Field(max_length=BULK_TEXT_MAX_CHARS), AfterValidator(_no_control)]


class BulkInvitationRow(BaseModel):
    line: int
    # The cells as typed (the e-mail in canonical form when valid); None when the row lacks it.
    apartment_number: str | None
    apartment_kind: ObjectKind | None
    email: str | None
    locale: str | None
    outcome: BulkRowOutcome


class BulkInvitationReport(BaseModel):
    rows: list[BulkInvitationRow]
    counts: dict[BulkRowOutcome, int]
    limit_remaining: int


class ResendExpiredResponse(BaseModel):
    queued: int
    # Expired ones the building limit did not allow this time (the oldest go first).
    left: int


class RegistrationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    registration_token: str = Field(min_length=1, max_length=128)
    full_name: safe_text(255)  # type: ignore[valid-type]
    phone: OptionalPhoneNumber = None
    locale: Locale
    # Ignored for STAFF invitations, which create no membership.
    privacy_display_mode: DisplayMode = DisplayMode.APARTMENT_ONLY


class AcceptRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=1, max_length=128)


class AcceptResponse(BaseModel):
    applied: bool


class ReplaceTenantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailAddress


class ResidentView(BaseModel):
    user_id: uuid.UUID
    membership_id: uuid.UUID
    relation_type: RelationType
    display_label: str
    since: datetime
    # The e-mail the caller typed when inviting this person into this membership, else null.
    invited_email: str | None


class ResidentsResponse(BaseModel):
    residents: list[ResidentView]
    pending_invitations: list[InvitationView]


class PersonMembershipView(BaseModel):
    membership_id: uuid.UUID
    apartment_id: uuid.UUID
    apartment_number: str
    apartment_kind: ObjectKind
    relation_type: RelationType
    display_label: str
    since: datetime
    invited_email: str | None


class PersonView(BaseModel):
    user_id: uuid.UUID
    is_me: bool
    display_label: str
    building_role: BuildingRole
    # From the newest applied STAFF invitation for the current role that the caller typed.
    invited_email: str | None
    memberships: list[PersonMembershipView]


class PeopleResponse(BaseModel):
    people: list[PersonView]


class RoleUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    building_role: BuildingRole


class RoleUpdateResponse(BaseModel):
    user_id: uuid.UUID
    building_role: BuildingRole
    account_closed: bool


# --- Password (A5) ------------------------------------------------------------------------------

# The raw field; the rules (15..128 after NFKC) answer PASSWORD_TOO_WEAK, not a validation error.
PasswordField = Annotated[str, Field(max_length=1024)]


class PasswordLoginRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    email: EmailAddress
    password: PasswordField

    def __repr__(self) -> str:  # never print the password by accident
        return "PasswordLoginRequest(email=***, password=***)"

    __str__ = __repr__


class PasswordUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    new_password: PasswordField
    # Needed only when the sign-in is older than 10 minutes.
    current_password: PasswordField | None = None

    def __repr__(self) -> str:
        return "PasswordUpdate(new_password=***, current_password=***)"

    __str__ = __repr__


class PasswordRemove(BaseModel):
    model_config = ConfigDict(extra="forbid")

    current_password: PasswordField | None = None

    def __repr__(self) -> str:
        return "PasswordRemove(current_password=***)"

    __str__ = __repr__


class PasswordStatus(BaseModel):
    is_set: bool


class ConnectionStatus(StrEnum):
    """docs/API.md 7, "The connection overview": the first that applies. JOIN_REQUEST and
    CODE_ISSUED come with task R4c and are never returned before it."""

    CONNECTED = "CONNECTED"
    JOIN_REQUEST = "JOIN_REQUEST"
    INVITED = "INVITED"
    CODE_ISSUED = "CODE_ISSUED"
    TENANT_ONLY = "TENANT_ONLY"
    PAPER = "PAPER"
    EXPIRED = "EXPIRED"
    NOT_INVITED = "NOT_INVITED"


class ConnectionItem(BaseModel):
    apartment_id: uuid.UUID
    apartment_number: str
    apartment_kind: ObjectKind
    entrance: int | None
    status: ConnectionStatus
    owners: int
    tenants: int
    on_paper: bool
    last_invited_at: datetime | None
    invitation_delivery: InvitationDelivery | None


class ConnectionSummary(BaseModel):
    apartments: int
    connected: int
    by_status: dict[ConnectionStatus, int]


class ConnectionOverview(BaseModel):
    summary: ConnectionSummary
    matching: int
    items: list[ConnectionItem]


class PaperUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    on_paper: bool


# --- Join codes on paper (E13 R4c) ---------------------------------------------------------------

JoinCodeText = Annotated[str, Field(min_length=1, max_length=64), AfterValidator(clean_text)]
MAX_APARTMENTS_PER_ISSUE = 2000


def _one_line(value: str) -> str:
    """A name shown to the chairman: one line, so it cannot be laid out to mislead."""
    # Every control character (tab, line feed, NEL U+0085 ...) and the line and paragraph
    # separators.
    if any(unicodedata.category(c) in {"Cc", "Zl", "Zp"} for c in value):
        raise ValueError("must be one line")
    return value


class JoinOutcome(StrEnum):
    CONFIRMED = "CONFIRMED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"


class JoinCodesIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # None: every apartment without an active owner and with nothing pending.
    apartment_ids: list[uuid.UUID] | None = Field(
        default=None, min_length=1, max_length=MAX_APARTMENTS_PER_ISSUE
    )


class IssuedJoinCode(BaseModel):
    code_id: uuid.UUID
    apartment_id: uuid.UUID
    apartment_number: str
    apartment_kind: ObjectKind
    join_code: str
    expires_at: datetime


class JoinCodesIssued(BaseModel):
    association_name: str
    join_url: str
    codes: list[IssuedJoinCode]


class JoinCodeView(BaseModel):
    code_id: uuid.UUID
    apartment_id: uuid.UUID
    apartment_number: str
    apartment_kind: ObjectKind
    created_at: datetime
    expires_at: datetime


class PrivacyNotice(BaseModel):
    custom_url: str | None
    locale: Locale
    text: str | None


class JoinLookup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    join_code: JoinCodeText


class JoinTarget(BaseModel):
    association_name: str
    apartment_number: str
    apartment_kind: ObjectKind
    # The building's country (ISO 3166-1 alpha-2): the default of the phone field.
    country_code: str


class JoinSubmit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    join_code: JoinCodeText
    full_name: Annotated[safe_text(200), AfterValidator(_one_line)]  # type: ignore[valid-type]
    phone: PhoneNumber
    email: EmailAddress
    locale: Locale | None = None


class JoinAccepted(BaseModel):
    accepted: bool = True


class JoinRequestView(BaseModel):
    """What the person typed, in full, for the chairman only and only until the decision (an
    exception to the masking of personal data listed in AGENTS.md)."""

    request_id: uuid.UUID
    apartment_id: uuid.UUID
    apartment_number: str
    apartment_kind: ObjectKind
    full_name: str
    phone: str
    email: str
    locale: Locale | None
    created_at: datetime


class JoinDecisionView(BaseModel):
    apartment_id: uuid.UUID | None
    apartment_number: str | None
    apartment_kind: ObjectKind | None
    outcome: JoinOutcome
    decided_by_user_id: uuid.UUID | None
    decided_at: datetime
