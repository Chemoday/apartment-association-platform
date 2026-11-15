"""The building passport from a public register (epic E12 X1; docs/API.md section 1).

The chairman searches the register of the building's country, fetches a proposal and accepts
it; residents see the accepted block as `registry_facts`. The register is reached only through
the country's provider plugin (src/plugins/registry.py); this module stores the blocks.
"""

import math
import uuid
from datetime import UTC, datetime, time, timedelta
from typing import Any

import structlog
from fastapi import Depends
from pydantic import TypeAdapter, ValidationError
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.database import DbSession
from src.core.exceptions import DomainError
from src.modules.property.models import Building, BuildingRegistryRecord, RegistryCallDay
from src.modules.property.schemas import (
    CurrentUserDTO,
    RegistryCandidateView,
    RegistrySearchResponse,
    RegistryState,
)
from src.plugins.registry import (
    BuildingRegistryProvider,
    PluginRegistry,
    RegistryBuildingNotFound,
    RegistryFacts,
    RegistryUnavailable,
    get_plugin_registry,
)

logger = structlog.get_logger(__name__)
_BLOCK = TypeAdapter(RegistryFacts)


def _now() -> datetime:
    return datetime.now(UTC)


def dump_block(block: RegistryFacts) -> dict[str, Any]:
    return block.model_dump(mode="json", by_alias=True)


def load_block(stored: dict[str, Any] | None) -> RegistryFacts | None:
    """A stored block, or None when there is none or it no longer fits its model (logged
    without content)."""
    if stored is None:
        return None
    try:
        return _BLOCK.validate_python(stored)
    except ValidationError:
        logger.warning("registry_block_unreadable", schema=str(stored.get("schema", ""))[:16])
        return None


def _not_enabled() -> DomainError:
    return DomainError(
        status_code=404,
        error_code="REGISTRY_NOT_ENABLED",
        message="No building register is available for the country of this building.",
    )


def _unavailable() -> DomainError:
    return DomainError(
        status_code=503,
        error_code="REGISTRY_UNAVAILABLE",
        message="The building register does not answer right now; try again later.",
    )


def _not_found() -> DomainError:
    return DomainError(
        status_code=404,
        error_code="REGISTRY_BUILDING_NOT_FOUND",
        message="The register does not know this building.",
    )


def _invalid_code() -> DomainError:
    return DomainError(
        status_code=422,
        error_code="VALIDATION_ERROR",
        message="The request is invalid.",
        extra={
            "errors": [
                {
                    "loc": ["body", "code"],
                    "message": "not a building id of this register",
                    "type": "value_error",
                }
            ]
        },
    )


class BuildingRegistryService:
    def __init__(self, session: AsyncSession, plugins: PluginRegistry):
        self.session = session
        self.plugins = plugins

    async def state(self, user: CurrentUserDTO) -> RegistryState:
        await self._provider(user)
        return self._state(await self._record(user.building_id))

    def has_provider(self, country_code: str) -> bool:
        return self.plugins.building_registry(country_code) is not None

    async def search(self, user: CurrentUserDTO, query: str | None) -> RegistrySearchResponse:
        provider = await self._provider(user)
        if query is None:
            building = await self.session.get_one(Building, user.building_id)
            query = building.address
        await self._use_quota()
        try:
            candidates = await provider.search(query)
        except RegistryUnavailable:
            raise _unavailable() from None
        return RegistrySearchResponse(
            candidates=[
                RegistryCandidateView(code=c.code, address=c.address, kind_label=c.kind_label)
                for c in candidates
            ]
        )

    async def propose(self, user: CurrentUserDTO, code: str) -> RegistryState:
        provider = await self._provider(user)
        code = code.strip()
        if not provider.valid_code(code):
            raise _invalid_code()
        await self._use_quota()
        try:
            block = await provider.fetch(code)
        except RegistryBuildingNotFound:
            raise _not_found() from None
        except RegistryUnavailable:
            raise _unavailable() from None
        now = _now()
        await self._lock_building(user.building_id)
        # Under the building's lock: no fetch, accept or remove of this building runs meanwhile.
        await self.session.execute(
            pg_insert(BuildingRegistryRecord)
            .values(building_id=user.building_id, updated_at=now)
            .on_conflict_do_nothing(index_elements=["building_id"])
        )
        record = await self._record(user.building_id)
        if record is None:  # cannot happen under the lock; never an assert (stripped by -O)
            raise _unavailable()
        record.proposal = dump_block(block)
        record.proposal_fetched_at = now
        record.proposal_by_user_id = user.id
        record.updated_at = now
        await self.session.flush()
        logger.info("registry_proposal_fetched", country_code=provider.country_code)
        return self._state(record)

    async def accept(self, user: CurrentUserDTO) -> RegistryState:
        await self._provider(user)
        await self._lock_building(user.building_id)
        record = await self._record(user.building_id)
        if record is None or load_block(record.proposal) is None:
            raise DomainError(
                status_code=409,
                error_code="NO_REGISTRY_PROPOSAL",
                message="There is no proposal to accept; fetch one first.",
            )
        now = _now()
        record.accepted = record.proposal
        record.accepted_at = now
        record.accepted_by_user_id = user.id
        record.proposal = None
        record.proposal_fetched_at = None
        record.proposal_by_user_id = None
        record.updated_at = now
        await self.session.flush()
        logger.info("registry_block_accepted")
        return self._state(record)

    async def clear(self, user: CurrentUserDTO) -> None:
        """Works without a provider too, so a block left from a removed plugin can go."""
        await self._lock_building(user.building_id)
        record = await self._record(user.building_id)
        if record is not None:
            await self.session.delete(record)
            await self.session.flush()
            logger.info("registry_block_removed")

    async def _provider(self, user: CurrentUserDTO) -> BuildingRegistryProvider:
        building = await self.session.get_one(Building, user.building_id)
        provider = self.plugins.building_registry(building.country_code)
        if provider is None:
            raise _not_enabled()
        return provider

    async def _use_quota(self) -> None:
        """Count one register call of the installation today, or refuse when the daily quota is
        used up. Committed at once: a call that then fails still counted (it reached the
        register), and no transaction stays open while the register answers."""
        now = _now()
        today = now.date()
        limit = self.plugins.settings.REGISTRY_CALLS_PER_DAY
        await self.session.execute(
            delete(RegistryCallDay).where(RegistryCallDay.day < today - timedelta(days=7))
        )
        counted = await self.session.scalar(
            pg_insert(RegistryCallDay)
            .values(day=today, calls=1)
            .on_conflict_do_update(
                index_elements=["day"],
                set_={"calls": RegistryCallDay.calls + 1},
                where=RegistryCallDay.calls < limit,
            )
            .returning(RegistryCallDay.calls)
        )
        if counted is None:
            midnight = datetime.combine(today + timedelta(days=1), time.min, tzinfo=UTC)
            wait = max(1, math.ceil((midnight - now).total_seconds()))
            logger.warning("registry_quota_used", limit=limit)
            raise DomainError(
                status_code=429,
                error_code="RATE_LIMITED",
                message="The register may be asked only a few times a day; try again tomorrow.",
                extra={"retry_after_seconds": wait, "reason": "DAILY_LIMIT"},
                headers={"Retry-After": str(wait)},
            )
        await self.session.commit()

    async def _lock_building(self, building_id: uuid.UUID) -> None:
        """One change of a building's register blocks at a time (the row may not exist yet)."""
        await self.session.execute(
            select(Building.id).where(Building.id == building_id).with_for_update()
        )

    async def _record(self, building_id: uuid.UUID) -> BuildingRegistryRecord | None:
        statement = (
            select(BuildingRegistryRecord)
            .where(BuildingRegistryRecord.building_id == building_id)
            .execution_options(populate_existing=True)
        )
        return await self.session.scalar(statement)

    @staticmethod
    def _state(record: BuildingRegistryRecord | None) -> RegistryState:
        if record is None:
            return RegistryState(
                accepted=None, accepted_at=None, proposal=None, proposal_fetched_at=None
            )
        accepted = load_block(record.accepted)
        proposal = load_block(record.proposal)
        return RegistryState(
            accepted=accepted,
            accepted_at=record.accepted_at if accepted is not None else None,
            proposal=proposal,
            proposal_fetched_at=record.proposal_fetched_at if proposal is not None else None,
        )


def get_building_registry_service(
    session: DbSession, plugins: PluginRegistry = Depends(get_plugin_registry)
) -> BuildingRegistryService:
    return BuildingRegistryService(session, plugins)
