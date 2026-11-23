import { apiRequest, type ApiRequestOptions } from '../client.js'
import type {
  ApartmentCard,
  ApartmentListResponse,
  BuildingResponse,
  DisplayMode,
  Locale,
  LocaleUpdate,
  MeResponse,
  PrivacyUpdateResponse,
  RegistrySearchResponse,
  RegistryState,
} from '../schema.js'

/**
 * Get current acting user's building role, privacy mode, and apartment memberships.
 */
export function getMe(options: { signal?: AbortSignal } = {}): Promise<MeResponse> {
  return apiRequest<MeResponse>('/property/me', options.signal ? { signal: options.signal } : {})
}

/**
 * Get building metadata: name, registry_code, address with district, apartment/entrance counts, heated area.
 * Added in PR #31 (GET /api/v1/property/building).
 */
export function getBuilding(options: { signal?: AbortSignal } = {}): Promise<BuildingResponse> {
  return apiRequest<BuildingResponse>(
    '/property/building',
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Update privacy display mode for a specific apartment membership.
 */
export function updatePrivacy(
  membershipId: string,
  privacyDisplayMode: DisplayMode,
): Promise<PrivacyUpdateResponse> {
  return apiRequest<PrivacyUpdateResponse>(
    `/property/memberships/${encodeURIComponent(membershipId)}/privacy`,
    {
      method: 'PATCH',
      body: { privacy_display_mode: privacyDisplayMode },
    },
  )
}

/**
 * Update language of the caller's external notifications (e-mail, Telegram, WebPush); null = building default.
 */
export function updateLocale(locale: Locale | null): Promise<LocaleUpdate> {
  return apiRequest<LocaleUpdate>('/property/me/locale', {
    method: 'PATCH',
    body: { locale },
  })
}

/**
 * List all apartments of the caller's building (requires CHAIRMAN or BOARD).
 */
export function listApartments(
  options: { signal?: AbortSignal } = {},
): Promise<ApartmentListResponse> {
  return apiRequest<ApartmentListResponse>(
    '/property/apartments',
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Get a single apartment card with resident relations and start dates (requires CHAIRMAN or BOARD).
 */
export function getApartmentCard(
  apartmentId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ApartmentCard> {
  return apiRequest<ApartmentCard>(
    `/property/apartments/${encodeURIComponent(apartmentId)}`,
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Get current building register state (accepted block & waiting proposal) for CHAIRMAN or BOARD.
 */
export function getRegistryState(options: ApiRequestOptions = {}): Promise<RegistryState> {
  return apiRequest<RegistryState>('/property/building/registry', options)
}

/**
 * Search the public building register by optional address query (CHAIRMAN only).
 * Sends `{}` when query is null/empty (uses the building's own address) or `{ query }` with POST body.
 */
export function searchRegistry(
  query: string | null | undefined = null,
  options: ApiRequestOptions = {},
): Promise<RegistrySearchResponse> {
  let body: { query?: string } = {}
  if (typeof query === 'string') {
    const normalized = query.replace(/\s+/g, ' ').trim()
    if (normalized) {
      body = { query: normalized }
    }
  }
  return apiRequest<RegistrySearchResponse>('/property/building/registry/search', {
    ...options,
    method: 'POST',
    body,
  })
}

/**
 * Fetch a building proposal from the public register by its register code (CHAIRMAN only).
 */
export function proposeRegistry(
  code: string,
  options: ApiRequestOptions = {},
): Promise<RegistryState> {
  return apiRequest<RegistryState>('/property/building/registry/proposal', {
    ...options,
    method: 'POST',
    body: { code },
  })
}

/**
 * Accept the fetched proposal so it becomes visible to residents as building.registry_facts (CHAIRMAN only).
 */
export function acceptRegistry(options: ApiRequestOptions = {}): Promise<RegistryState> {
  return apiRequest<RegistryState>('/property/building/registry/accept', {
    ...options,
    method: 'POST',
  })
}

/**
 * Remove both the accepted block and any waiting proposal (CHAIRMAN only).
 */
export function removeRegistry(options: ApiRequestOptions = {}): Promise<null> {
  return apiRequest<null>('/property/building/registry', {
    ...options,
    method: 'DELETE',
  })
}
