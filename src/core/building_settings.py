"""Building settings: values of the association that the chairman changes in the app.

docs/ARCHITECTURE.md section 6, docs/SCHEMA.md section 9, docs/API.md section 9.
- A module declares its settings in its own `settings.py` (a tuple `SETTINGS` of `IntSetting` /
  `BoolSetting`); core loads those files lazily from `_MODULE_SETTING_MODULES`, like the event
  registry, so core never imports a module at import time.
- `BuildingSettings.get` gives a module the typed value of its building (the default while the
  chairman has not changed it). Only `PUT /api/v1/settings` writes, and every change is logged.
"""

import importlib
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, overload

import structlog
from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt
from sqlalchemy import DateTime, ForeignKey, Index, String, func, select
from sqlalchemy.dialects.postgresql import JSONB, UUID, insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Mapped, mapped_column

from src.core.database import Base, DbSession, uuid_pk
from src.core.exceptions import AUTH_ERRORS, DomainError, error_responses
from src.core.security import get_current_user
from src.modules.property.schemas import BuildingRole, CurrentUserDTO

logger = structlog.get_logger(__name__)

_MODULE_SETTING_MODULES = ("src.modules.issues.settings",)

KEY_MAX_LENGTH = 64
MAX_VALUES_PER_REQUEST = 50
_READERS = frozenset({BuildingRole.CHAIRMAN, BuildingRole.BOARD})


# --- Declarations --------------------------------------------------------------------------------


@dataclass(frozen=True)
class IntSetting:
    key: str
    default: int
    minimum: int
    maximum: int

    type: Literal["INTEGER"] = "INTEGER"

    def problem(self, value: object) -> str | None:
        """Why the value does not fit, or None (a bool is not an integer here)."""
        if not isinstance(value, int) or isinstance(value, bool):
            return "must be an integer"
        if not self.minimum <= value <= self.maximum:
            return f"must be between {self.minimum} and {self.maximum}"
        return None


@dataclass(frozen=True)
class BoolSetting:
    key: str
    default: bool

    type: Literal["BOOLEAN"] = "BOOLEAN"
    minimum: None = None
    maximum: None = None

    def problem(self, value: object) -> str | None:
        return None if isinstance(value, bool) else "must be true or false"


type SettingSpec = IntSetting | BoolSetting


class SettingsRegistry:
    def __init__(self, specs: Sequence[SettingSpec] = ()) -> None:
        self._by_key: dict[str, SettingSpec] = {}
        for spec in specs:
            self.register(spec)

    def register(self, spec: SettingSpec) -> None:
        """A key once; its default must fit its own bounds; at most 64 characters."""
        if spec.key in self._by_key:
            raise ValueError(f"setting {spec.key!r} is declared twice")
        if not spec.key or len(spec.key) > KEY_MAX_LENGTH or "." not in spec.key:
            raise ValueError(f"setting key {spec.key!r} must be '<module>.<name>', 64 chars max")
        if problem := spec.problem(spec.default):
            raise ValueError(f"default of {spec.key!r} {problem}")
        self._by_key[spec.key] = spec

    def get(self, key: str) -> SettingSpec | None:
        return self._by_key.get(key)

    def specs(self) -> list[SettingSpec]:
        return [self._by_key[key] for key in sorted(self._by_key)]


def _load_module_settings(registry: SettingsRegistry) -> None:
    for module_name in _MODULE_SETTING_MODULES:
        for spec in importlib.import_module(module_name).SETTINGS:
            registry.register(spec)


_registry: SettingsRegistry | None = None


def get_settings_registry() -> SettingsRegistry:
    """The process-wide registry, with every module's settings declared on first use."""
    global _registry
    if _registry is None:
        registry = SettingsRegistry()
        _load_module_settings(registry)
        _registry = registry
    return _registry


# --- Tables (infrastructure owned by core, not domain models) ------------------------------------


def _utc_now() -> datetime:
    return datetime.now(UTC)


class BuildingSettingRecord(Base):
    """A setting the chairman changed; a missing row means the default."""

    __tablename__ = "core_building_settings"

    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("property_buildings.id", ondelete="CASCADE"),
        primary_key=True,
    )
    key: Mapped[str] = mapped_column(String(KEY_MAX_LENGTH), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id", ondelete="SET NULL"), nullable=True
    )


class BuildingSettingChange(Base):
    """One change of a setting: old and new value (None = the default), who and when."""

    __tablename__ = "core_building_setting_changes"
    __table_args__ = (
        Index("ix_core_building_setting_changes_building_time", "building_id", "changed_at"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    building_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("property_buildings.id", ondelete="CASCADE"),
        nullable=False,
    )
    key: Mapped[str] = mapped_column(String(KEY_MAX_LENGTH), nullable=False)
    old_value: Mapped[Any | None] = mapped_column(JSONB, nullable=True)
    new_value: Mapped[Any | None] = mapped_column(JSONB, nullable=True)
    changed_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("core_users.id", ondelete="SET NULL"), nullable=True
    )
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=_utc_now, server_default=func.now()
    )


# --- API shapes ----------------------------------------------------------------------------------


class SettingView(BaseModel):
    key: str
    type: Literal["INTEGER", "BOOLEAN"]
    value: int | bool
    default: int | bool
    minimum: int | None
    maximum: int | None
    is_default: bool
    updated_at: datetime | None


class SettingsView(BaseModel):
    settings: list[SettingView]


class SettingsUpdate(BaseModel):
    """Body of PUT /api/v1/settings: a value of the setting's type sets it, null resets it."""

    model_config = ConfigDict(extra="forbid")

    values: Annotated[
        dict[
            Annotated[str, Field(max_length=KEY_MAX_LENGTH)],
            StrictBool | StrictInt | None,
        ],
        Field(min_length=1, max_length=MAX_VALUES_PER_REQUEST),
    ]


# --- Reading and writing -------------------------------------------------------------------------


def _forbidden() -> DomainError:
    return DomainError(
        status_code=403, error_code="FORBIDDEN", message="Only the board sees these settings."
    )


class BuildingSettings:
    def __init__(self, session: AsyncSession, registry: SettingsRegistry | None = None):
        self.session = session
        self.registry = registry or get_settings_registry()

    @overload
    async def get(self, building_id: uuid.UUID, spec: IntSetting) -> int: ...
    @overload
    async def get(self, building_id: uuid.UUID, spec: BoolSetting) -> bool: ...
    async def get(self, building_id: uuid.UUID, spec: SettingSpec) -> int | bool:
        """The building's value of a declared setting; the default when it is not set (or a
        stored value no longer fits the declaration, e.g. after its bounds were narrowed)."""
        value = await self.session.scalar(
            select(BuildingSettingRecord.value).where(
                BuildingSettingRecord.building_id == building_id,
                BuildingSettingRecord.key == spec.key,
            )
        )
        return spec.default if value is None or spec.problem(value) else value

    async def view(self, user: CurrentUserDTO) -> SettingsView:
        if user.building_role not in _READERS:
            raise _forbidden()
        return await self._view(user.building_id)

    async def update(self, user: CurrentUserDTO, request: SettingsUpdate) -> SettingsView:
        """All or nothing; changes of one building run one after another, so the log keeps the
        real old values."""
        if user.building_role != BuildingRole.CHAIRMAN:
            raise DomainError(
                status_code=403,
                error_code="FORBIDDEN",
                message="Only the chairman changes these settings.",
            )
        problems: list[dict[str, Any]] = []
        specs: dict[str, SettingSpec] = {}
        for key, value in request.values.items():
            spec = self.registry.get(key)
            if spec is not None:
                specs[key] = spec
            if spec is None:
                problems.append(_problem(key, "unknown setting"))
            elif value is not None and (problem := spec.problem(value)):
                problems.append(_problem(key, problem))
        if problems:
            raise DomainError(
                status_code=422,
                error_code="VALIDATION_ERROR",
                message="The request is invalid.",
                extra={"errors": problems},
            )

        # One writer per building at a time: a row lock alone would not cover keys that have
        # no row yet, so two first changes of one key would both log "from the default".
        await self.session.execute(
            select(
                func.pg_advisory_xact_lock(
                    func.hashtextextended(f"core:settings:{user.building_id}", 0)
                )
            )
        )
        current = await self._stored(user.building_id)
        now = _utc_now()
        for key, value in sorted(request.values.items()):
            old = current.get(key)
            if _same(None if old is None else old.value, value) or (
                old is None and _same(specs[key].default, value)
            ):
                continue  # the current value (a missing row is the default)
            if old is not None and value is None:
                await self.session.delete(old)
            elif value is not None:
                await self.session.execute(
                    insert(BuildingSettingRecord)
                    .values(
                        building_id=user.building_id,
                        key=key,
                        value=value,
                        updated_at=now,
                        updated_by_user_id=user.id,
                    )
                    .on_conflict_do_update(
                        index_elements=["building_id", "key"],
                        set_={"value": value, "updated_at": now, "updated_by_user_id": user.id},
                    )
                )
            self.session.add(
                BuildingSettingChange(
                    building_id=user.building_id,
                    key=key,
                    old_value=None if old is None else old.value,
                    new_value=value,
                    changed_by_user_id=user.id,
                    changed_at=now,
                )
            )
            logger.info("building_setting_changed", key=key)
        await self.session.flush()
        return await self._view(user.building_id)

    async def _stored(self, building_id: uuid.UUID) -> dict[str, BuildingSettingRecord]:
        """The building's rows as the database has them now (an upsert above does not refresh
        objects already loaded into the session)."""
        statement = (
            select(BuildingSettingRecord)
            .where(BuildingSettingRecord.building_id == building_id)
            .execution_options(populate_existing=True)
        )
        return {row.key: row for row in await self.session.scalars(statement)}

    async def _view(self, building_id: uuid.UUID) -> SettingsView:
        stored = await self._stored(building_id)
        views = []
        for spec in self.registry.specs():
            row = stored.get(spec.key)
            valid = row is not None and spec.problem(row.value) is None
            views.append(
                SettingView(
                    key=spec.key,
                    type=spec.type,
                    value=row.value if valid and row is not None else spec.default,
                    default=spec.default,
                    minimum=spec.minimum,
                    maximum=spec.maximum,
                    is_default=not valid,
                    updated_at=row.updated_at if valid and row is not None else None,
                )
            )
        return SettingsView(settings=views)


def _same(old: object, new: object) -> bool:
    """No change: also None == None; True and 1 differ (JSON keeps their types)."""
    return type(old) is type(new) and old == new


def _problem(key: str, message: str) -> dict[str, Any]:
    return {"loc": ["body", "values", key], "message": message, "type": "value_error"}


def get_building_settings(session: DbSession) -> BuildingSettings:
    return BuildingSettings(session)


# --- HTTP ----------------------------------------------------------------------------------------

router = APIRouter(
    prefix="/api/v1/settings",
    tags=["settings"],
    responses=error_responses(
        {401: AUTH_ERRORS, 403: ["FORBIDDEN"], 500: ["INTERNAL_SERVER_ERROR"]}
    ),
)

Service = Annotated[BuildingSettings, Depends(get_building_settings)]
Caller = Annotated[CurrentUserDTO, Depends(get_current_user)]


@router.get("", response_model=SettingsView)
async def read_settings(user: Caller, service: Service) -> SettingsView:
    """Every declared setting of the caller's building (the chairman and the board)."""
    return await service.view(user)


@router.put("", response_model=SettingsView, responses=error_responses({422: ["VALIDATION_ERROR"]}))
async def change_settings(body: SettingsUpdate, user: Caller, service: Service) -> SettingsView:
    """Change or reset (null) some settings at once (the chairman); all or nothing."""
    return await service.update(user, body)
