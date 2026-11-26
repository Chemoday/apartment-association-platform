"""Private SQLAlchemy models of the property module. NEVER import them from another module.

Users live here (tables keep their core_ prefix, see docs/SCHEMA.md); other modules read users
only through DTOs from core.security or PropertyService.
"""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from src.core.database import Base, uuid_pk, varchar_enum
from src.modules.property.schemas import (
    BuildingRole,
    DisplayMode,
    Locale,
    ObjectKind,
    RelationType,
)

# An apartment has an entrance, a floor and an area; another kind has no entrance (epic E14).
KIND_FIELDS_CHECK = (
    "(kind = 'APARTMENT' AND entrance IS NOT NULL AND floor IS NOT NULL "
    "AND area_m2 IS NOT NULL) OR (kind <> 'APARTMENT' AND entrance IS NULL)"
)


class Building(Base):
    __tablename__ = "property_buildings"

    id: Mapped[uuid.UUID] = uuid_pk()
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    # The association's code in the commercial register (Estonia: 8 digits); unknown until entered.
    registry_code: Mapped[str | None] = mapped_column(String(20), nullable=True)
    address: Mapped[str] = mapped_column(String(500), nullable=False)
    country_code: Mapped[str] = mapped_column(
        String(2), nullable=False, default="EE", server_default="EE"
    )
    reading_deadline_day: Mapped[int] = mapped_column(
        Integer, nullable=False, default=4, server_default=text("4")
    )


class User(Base):
    __tablename__ = "core_users"

    id: Mapped[uuid.UUID] = uuid_pk()
    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_buildings.id"), nullable=False, index=True
    )
    email: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    full_name: Mapped[str] = mapped_column(String(255), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    building_role: Mapped[BuildingRole] = mapped_column(
        varchar_enum(BuildingRole, "ck_core_users_building_role"),
        nullable=False,
        default=BuildingRole.USER,
        server_default=BuildingRole.USER.value,
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
    # Language of notifications sent outside the app; NULL = Settings.DEFAULT_LOCALE.
    locale: Mapped[Locale | None] = mapped_column(
        varchar_enum(Locale, "ck_core_users_locale", length=5), nullable=True
    )


class Apartment(Base):
    __tablename__ = "property_apartments"
    __table_args__ = (
        # A number repeats across kinds: "Apartment 1" and "Garage 1" (epic E14).
        UniqueConstraint(
            "building_id", "kind", "number", name="uq_property_apartments_building_kind_number"
        ),
        CheckConstraint(KIND_FIELDS_CHECK, name="ck_property_apartments_kind_fields"),
        # Lets other tables prove an apartment is in their building with a composite FK.
        UniqueConstraint("id", "building_id", name="uq_property_apartments_id_building"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_buildings.id"), nullable=False
    )
    # An object of ownership of any kind (the glossary of docs/ARCHITECTURE.md section 2).
    kind: Mapped[ObjectKind] = mapped_column(
        varchar_enum(ObjectKind, "ck_property_apartments_kind"),
        nullable=False,
        default=ObjectKind.APARTMENT,
        server_default=ObjectKind.APARTMENT.value,
    )
    number: Mapped[str] = mapped_column(String(32), nullable=False)
    # No default: an object written without them never becomes "entrance 1, floor 1".
    entrance: Mapped[int | None] = mapped_column(Integer, nullable=True)
    floor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    riser_group: Mapped[str | None] = mapped_column(String(50), nullable=True)
    area_m2: Mapped[Decimal | None] = mapped_column(Numeric(8, 2), nullable=True)
    # The chairman's mark "worked on paper" (epic E13 R4b; the connection overview).
    on_paper: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )


class ApartmentMembership(Base):
    __tablename__ = "property_memberships"
    __table_args__ = (
        UniqueConstraint("apartment_id", "user_id", name="uq_property_memberships_apartment_user"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    apartment_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("property_apartments.id"), nullable=False, index=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id"), nullable=False, index=True
    )
    relation_type: Mapped[RelationType] = mapped_column(
        varchar_enum(RelationType, "ck_property_memberships_relation_type"), nullable=False
    )
    can_submit_readings: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    can_view_bills: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default=text("true")
    )
    can_vote: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    privacy_display_mode: Mapped[DisplayMode] = mapped_column(
        varchar_enum(DisplayMode, "ck_property_memberships_privacy_display_mode"),
        nullable=False,
        default=DisplayMode.APARTMENT_ONLY,
        server_default=DisplayMode.APARTMENT_ONLY.value,
    )
    # When the membership started; reopening an ended one sets it to now (API `since`).
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(UTC),
        server_default=func.now(),
    )
    # Set when the membership ends; every membership query filters `ended_at IS NULL`
    # (docs/ARCHITECTURE.md 4.3). An ended membership is reopened, never duplicated.
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class BuildingRegistryRecord(Base):
    """The building passport from a public register (epic E12; docs/SCHEMA.md section 2).

    `proposal` and `accepted` are country blocks serialised by their DTOs (no people in them).
    """

    __tablename__ = "property_building_registry"

    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("property_buildings.id", ondelete="CASCADE"),
        primary_key=True,
    )
    proposal: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    proposal_fetched_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    proposal_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id", ondelete="SET NULL"), nullable=True
    )
    accepted: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    accepted_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id", ondelete="SET NULL"), nullable=True
    )
    # The certificate reminder (X2b): the certificate and the last threshold sent for it.
    certificate_reminded_for: Mapped[date | None] = mapped_column(Date, nullable=True)
    certificate_reminded_threshold: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(UTC)
    )

    __table_args__ = (
        CheckConstraint(
            "certificate_reminded_threshold IN (180, 30, 0)",
            name="ck_property_building_registry_threshold",
        ),
    )


class RegistryCallDay(Base):
    """Register calls of the installation per UTC day (the daily quota, S-10)."""

    __tablename__ = "property_registry_calls"
    __table_args__ = (CheckConstraint("calls >= 1", name="ck_property_registry_calls_positive"),)

    day: Mapped[date] = mapped_column(Date, primary_key=True)
    calls: Mapped[int] = mapped_column(Integer, nullable=False)
