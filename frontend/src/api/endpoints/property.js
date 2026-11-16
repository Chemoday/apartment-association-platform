import { apiRequest } from '../client.js'

/**
 * Get current acting user's building role, privacy mode, and apartment memberships.
 * @returns {Promise<import('../schema').MeResponse>}
 */
export function getMe() {
  return apiRequest('/property/me')
}

/**
 * Get building metadata: name, registry_code, address with district, apartment/entrance counts, heated area.
 * Added in PR #31 (GET /api/v1/property/building).
 * @returns {Promise<import('../schema').BuildingResponse>}
 */
export function getBuilding() {
  return apiRequest('/property/building')
}

/**
 * Update privacy display mode for a specific apartment membership.
 * @param {string} membershipId
 * @param {import('../schema').DisplayMode} privacyDisplayMode
 * @returns {Promise<import('../schema').PrivacyUpdateResponse>}
 */
export function updatePrivacy(membershipId, privacyDisplayMode) {
  return apiRequest(`/property/memberships/${encodeURIComponent(membershipId)}/privacy`, {
    method: 'PATCH',
    body: { privacy_display_mode: privacyDisplayMode },
  })
}

/**
 * Update language of the caller's external notifications (e-mail, Telegram, WebPush); null = building default.
 * @param {import('../schema').Locale | null} locale
 * @returns {Promise<import('../schema').LocaleUpdate>}
 */
export function updateLocale(locale) {
  return apiRequest('/property/me/locale', {
    method: 'PATCH',
    body: { locale },
  })
}

/**
 * List all apartments of the caller's building (requires CHAIRMAN or BOARD).
 * @returns {Promise<import('../schema').ApartmentListResponse>}
 */
export function listApartments() {
  return apiRequest('/property/apartments')
}

/**
 * Get a single apartment card with resident relations and start dates (requires CHAIRMAN or BOARD).
 * @param {string} apartmentId
 * @returns {Promise<import('../schema').ApartmentCard>}
 */
export function getApartmentCard(apartmentId) {
  return apiRequest(`/property/apartments/${encodeURIComponent(apartmentId)}`)
}

/**
 * Get current building register state (accepted block & waiting proposal) for CHAIRMAN or BOARD.
 * @param {Record<string, any>} [options]
 * @returns {Promise<import('../schema').RegistryState>}
 */
export function getRegistryState(options = {}) {
  return apiRequest('/property/building/registry', options)
}

/**
 * Search the public building register by optional address query (CHAIRMAN only).
 * Sends `{}` when query is null/empty (uses the building's own address) or `{ query }` with POST body.
 * @param {string | null | undefined} [query]
 * @param {Record<string, any>} [options]
 * @returns {Promise<import('../schema').RegistrySearchResponse>}
 */
export function searchRegistry(query = null, options = {}) {
  let body = {}
  if (typeof query === 'string') {
    const normalized = query.replace(/\s+/g, ' ').trim()
    if (normalized) {
      body = { query: normalized }
    }
  }
  return apiRequest('/property/building/registry/search', {
    ...options,
    method: 'POST',
    body,
  })
}

/**
 * Fetch a building proposal from the public register by its register code (CHAIRMAN only).
 * @param {string} code
 * @param {Record<string, any>} [options]
 * @returns {Promise<import('../schema').RegistryState>}
 */
export function proposeRegistry(code, options = {}) {
  return apiRequest('/property/building/registry/proposal', {
    ...options,
    method: 'POST',
    body: { code },
  })
}

/**
 * Accept the fetched proposal so it becomes visible to residents as building.registry_facts (CHAIRMAN only).
 * @param {Record<string, any>} [options]
 * @returns {Promise<import('../schema').RegistryState>}
 */
export function acceptRegistry(options = {}) {
  return apiRequest('/property/building/registry/accept', {
    ...options,
    method: 'POST',
  })
}

/**
 * Remove both the accepted block and any waiting proposal (CHAIRMAN only).
 * @param {Record<string, any>} [options]
 * @returns {Promise<void>}
 */
export function removeRegistry(options = {}) {
  return apiRequest('/property/building/registry', {
    ...options,
    method: 'DELETE',
  })
}

