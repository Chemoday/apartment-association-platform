"""Thin HTTP layer of the property module."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Response

from src.core.exceptions import AUTH_ERRORS, error_responses
from src.core.security import get_current_user, require_building_roles
from src.modules.property.policies import CARD_VIEWER_ROLES
from src.modules.property.registry import BuildingRegistryService, get_building_registry_service
from src.modules.property.schemas import (
    ApartmentCard,
    ApartmentListResponse,
    BuildingResponse,
    BuildingRole,
    CurrentUserDTO,
    LocaleUpdate,
    MeResponse,
    PrivacyUpdateRequest,
    PrivacyUpdateResponse,
    RegistryProposalRequest,
    RegistrySearchRequest,
    RegistrySearchResponse,
    RegistryState,
)
from src.modules.property.service import PropertyService, get_property_service

router = APIRouter(
    prefix="/api/v1/property",
    tags=["property"],
    responses=error_responses({401: AUTH_ERRORS, 500: ["INTERNAL_SERVER_ERROR"]}),
)

card_viewer = require_building_roles(*sorted(CARD_VIEWER_ROLES))
Registry = Annotated[BuildingRegistryService, Depends(get_building_registry_service)]


@router.get("/me", response_model=MeResponse)
async def get_me(
    current_user: CurrentUserDTO = Depends(get_current_user),
    service: PropertyService = Depends(get_property_service),
) -> MeResponse:
    return await service.get_me(current_user)


@router.patch(
    "/me/locale",
    response_model=LocaleUpdate,
    responses=error_responses({422: ["VALIDATION_ERROR"]}),
)
async def update_locale(
    body: LocaleUpdate,
    current_user: CurrentUserDTO = Depends(get_current_user),
    service: PropertyService = Depends(get_property_service),
) -> LocaleUpdate:
    """Language of the caller's notifications sent outside the app; null = the instance default."""
    return await service.update_locale(current_user, body.locale)


@router.get("/building", response_model=BuildingResponse)
async def get_building(
    registry: Registry,
    current_user: CurrentUserDTO = Depends(get_current_user),
    service: PropertyService = Depends(get_property_service),
) -> BuildingResponse:
    building = await service.get_building(current_user)
    if building.registry_facts is not None and not registry.has_provider(building.country_code):
        # The provider was disabled (or the country changed): no stale passport is shown.
        building = building.model_copy(update={"registry_facts": None})
    return building


@router.patch(
    "/memberships/{membership_id}/privacy",
    response_model=PrivacyUpdateResponse,
    responses=error_responses({404: ["MEMBERSHIP_NOT_FOUND"], 422: ["VALIDATION_ERROR"]}),
)
async def update_privacy(
    membership_id: uuid.UUID,
    body: PrivacyUpdateRequest,
    current_user: CurrentUserDTO = Depends(get_current_user),
    service: PropertyService = Depends(get_property_service),
) -> PrivacyUpdateResponse:
    return await service.update_privacy_mode(current_user, membership_id, body.privacy_display_mode)


@router.get(
    "/apartments",
    response_model=ApartmentListResponse,
    responses=error_responses({403: ["FORBIDDEN"]}),
)
async def list_apartment_cards(
    current_user: CurrentUserDTO = Depends(card_viewer),
    service: PropertyService = Depends(get_property_service),
) -> ApartmentListResponse:
    """The board's apartment cards (epic E8): relations and counts, never people."""
    return await service.list_apartment_cards(current_user)


@router.get(
    "/apartments/{apartment_id}",
    response_model=ApartmentCard,
    responses=error_responses(
        {403: ["FORBIDDEN"], 404: ["APARTMENT_NOT_FOUND"], 422: ["VALIDATION_ERROR"]}
    ),
)
async def get_apartment_card(
    apartment_id: uuid.UUID,
    current_user: CurrentUserDTO = Depends(card_viewer),
    service: PropertyService = Depends(get_property_service),
) -> ApartmentCard:
    """One apartment card: the list fields plus residents as relation and start date."""
    return await service.get_apartment_card(current_user, apartment_id)


# --- Building register facts (epic E12; docs/API.md section 1) ----------------------------------

chairman_only = require_building_roles(BuildingRole.CHAIRMAN)
registry_viewer = require_building_roles(BuildingRole.CHAIRMAN, BuildingRole.BOARD)
_REGISTRY_ERRORS = {403: ["FORBIDDEN"], 404: ["REGISTRY_NOT_ENABLED"]}
_REGISTRY_CALL = {
    **_REGISTRY_ERRORS,
    422: ["VALIDATION_ERROR"],
    429: ["RATE_LIMITED"],
    503: ["REGISTRY_UNAVAILABLE"],
}


@router.get(
    "/building/registry",
    response_model=RegistryState,
    responses=error_responses(_REGISTRY_ERRORS),
)
async def registry_state(
    registry: Registry, user: CurrentUserDTO = Depends(registry_viewer)
) -> RegistryState:
    """The accepted block and the proposal waiting for the chairman."""
    return await registry.state(user)


@router.post(
    "/building/registry/search",
    response_model=RegistrySearchResponse,
    responses=error_responses(_REGISTRY_CALL),
)
async def registry_search(
    body: RegistrySearchRequest, registry: Registry, user: CurrentUserDTO = Depends(chairman_only)
) -> RegistrySearchResponse:
    """Buildings of the register that match an address (the building's own by default).

    A POST with a body, not a query string: the address must not reach URLs in traces.
    """
    return await registry.search(user, body.query)


@router.post(
    "/building/registry/proposal",
    response_model=RegistryState,
    responses=error_responses(
        {**_REGISTRY_CALL, 404: ["REGISTRY_NOT_ENABLED", "REGISTRY_BUILDING_NOT_FOUND"]}
    ),
)
async def registry_propose(
    body: RegistryProposalRequest, registry: Registry, user: CurrentUserDTO = Depends(chairman_only)
) -> RegistryState:
    """Fetch one building from the register as the proposal."""
    return await registry.propose(user, body.code)


@router.post(
    "/building/registry/accept",
    response_model=RegistryState,
    responses=error_responses({**_REGISTRY_ERRORS, 409: ["NO_REGISTRY_PROPOSAL"]}),
)
async def registry_accept(
    registry: Registry, user: CurrentUserDTO = Depends(chairman_only)
) -> RegistryState:
    """Make the proposal what residents see as registry_facts."""
    return await registry.accept(user)


@router.delete(
    "/building/registry",
    status_code=204,
    response_class=Response,
    responses=error_responses({403: ["FORBIDDEN"]}),
)
async def registry_clear(
    registry: Registry, user: CurrentUserDTO = Depends(chairman_only)
) -> Response:
    """Remove the accepted block and the proposal."""
    await registry.clear(user)
    return Response(status_code=204)
