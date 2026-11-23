import {
  UNHANDLED,
  BUILDING_ID,
  OFFLINE_MEMBERSHIPS_BY_USER,
  OFFLINE_BUILDING,
  consumeOfflineRegistryQuota,
  makeOfflineError,
  offlineStore,
} from './state.js'
import {
  createDemoEeBuildingFactsForCode,
  createDemoRegistryCandidates,
  normalizeRegistrySearchQuery,
  REGISTRY_CODE_PATTERN,
  REGISTRY_QUERY_MAX_LENGTH,
  REGISTRY_QUERY_MIN_LENGTH,
} from '../../utils/buildingPassport.js'
import {
  computeMockPreviewBadge,
} from '../../mocks/domains/index.js'

export async function handleOfflineProperty(ctx) {
  const { pathname, method, body, user } = ctx

  // 2. GET /property/me
  if (pathname === '/property/me' && method === 'GET') {
    const memberships = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    return {
      user_id: user.user_id,
      building_id: BUILDING_ID,
      building_role: user.building_role,
      privacy_display_mode: memberships[0]?.privacy_display_mode || 'FULL_NAME',
      locale: user.locale ?? null,
      memberships: JSON.parse(JSON.stringify(memberships)),
    }
  }

  // 2a. PATCH /property/me/locale
  if (pathname === '/property/me/locale' && method === 'PATCH') {
    const nextLocale =
      body && typeof body.locale === 'string' && ['en', 'et', 'ru'].includes(body.locale)
        ? body.locale
        : null
    user.locale = nextLocale
    return { locale: nextLocale }
  }

  // 3. GET /property/building
  if (pathname === '/property/building' && method === 'GET') {
    const cloned = JSON.parse(JSON.stringify(OFFLINE_BUILDING))
    cloned.registry_facts = offlineStore.offlineRegistryState.accepted
      ? JSON.parse(JSON.stringify(offlineStore.offlineRegistryState.accepted))
      : null
    return cloned
  }

  // 3a. Building register endpoints (#035 E12/X1-X2)
  if (pathname === '/property/building/registry' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only chairman and board members can view building register state.')
    }
    return JSON.parse(JSON.stringify(offlineStore.offlineRegistryState))
  }

  if (pathname === '/property/building/registry/search' && method === 'POST') {
    if (user.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only chairman can search the building register.')
    }
    let normalizedQuery = ''
    if (body && body.query !== undefined && body.query !== null) {
      if (typeof body.query !== 'string') {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Search query must be a string or null.')
      }
      normalizedQuery = normalizeRegistrySearchQuery(body.query)
      if (
        normalizedQuery.length < REGISTRY_QUERY_MIN_LENGTH ||
        normalizedQuery.length > REGISTRY_QUERY_MAX_LENGTH
      ) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          'Search query must be between 3 and 200 characters.',
        )
      }
    }
    consumeOfflineRegistryQuota()
    const searchNeedle = (normalizedQuery || OFFLINE_BUILDING.address).toLowerCase()
    const allCandidates = createDemoRegistryCandidates()
    const matched =
      searchNeedle.includes('sõpruse') ||
      searchNeedle.includes('sopruse') ||
      searchNeedle.includes('tallinn') ||
      searchNeedle.includes('kristiine')
        ? allCandidates
        : allCandidates.filter(
            (c) =>
              c.address.toLowerCase().includes(searchNeedle) ||
              c.code.toLowerCase().includes(searchNeedle),
          )
    return {
      candidates: JSON.parse(JSON.stringify(matched.slice(0, 10))),
    }
  }

  if (pathname === '/property/building/registry/proposal' && method === 'POST') {
    if (user.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only chairman can fetch a building register proposal.')
    }
    const code = typeof body?.code === 'string' ? body.code.trim() : ''
    if (!REGISTRY_CODE_PATTERN.test(code)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Building register code must be 6–12 digits.')
    }
    consumeOfflineRegistryQuota()
    const nowIso = new Date().toISOString()
    const nextFacts = createDemoEeBuildingFactsForCode(code, nowIso)
    if (!nextFacts) {
      throw makeOfflineError(404, 'REGISTRY_BUILDING_NOT_FOUND', 'Building code not found in register.')
    }
    offlineStore.offlineRegistryState.proposal = nextFacts
    offlineStore.offlineRegistryState.proposal_fetched_at = nowIso
    return JSON.parse(JSON.stringify(offlineStore.offlineRegistryState))
  }

  if (pathname === '/property/building/registry/accept' && method === 'POST') {
    if (user.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only chairman can accept a building register proposal.')
    }
    if (!offlineStore.offlineRegistryState.proposal) {
      throw makeOfflineError(409, 'NO_REGISTRY_PROPOSAL', 'No waiting register proposal to accept.')
    }
    const nowIso = new Date().toISOString()
    offlineStore.offlineRegistryState.accepted = JSON.parse(JSON.stringify(offlineStore.offlineRegistryState.proposal))
    offlineStore.offlineRegistryState.accepted_at = nowIso
    offlineStore.offlineRegistryState.proposal = null
    offlineStore.offlineRegistryState.proposal_fetched_at = null
    return JSON.parse(JSON.stringify(offlineStore.offlineRegistryState))
  }

  if (pathname === '/property/building/registry' && method === 'DELETE') {
    if (user.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only chairman can remove building register data.')
    }
    offlineStore.offlineRegistryState.accepted = null
    offlineStore.offlineRegistryState.accepted_at = null
    offlineStore.offlineRegistryState.proposal = null
    offlineStore.offlineRegistryState.proposal_fetched_at = null
    return null
  }

  // 3b. GET /property/apartments & GET /property/apartments/:id (E8/P1)
  const OFFLINE_APARTMENT_CARDS = [
    {
      apartment_id: '018f0000-0000-7000-8000-000000000301',
      apartment_number: '01',
      entrance: 1,
      floor: 1,
      area_m2: '48.50',
      owner_count: 1,
      tenant_count: 0,
      resident_count: 0,
      residents: [{ relation_type: 'OWNER', since: '2021-03-10T10:00:00Z' }],
    },
    {
      apartment_id: '018f0000-0000-7000-8000-000000000302',
      apartment_number: '02',
      entrance: 1,
      floor: 1,
      area_m2: '54.30',
      owner_count: 0,
      tenant_count: 1,
      resident_count: 0,
      residents: [{ relation_type: 'TENANT', since: '2026-06-15T10:00:00Z' }],
    },
    {
      apartment_id: '018f0000-0000-7000-8000-000000000305',
      apartment_number: '05',
      entrance: 1,
      floor: 2,
      area_m2: '62.10',
      owner_count: 0,
      tenant_count: 0,
      resident_count: 0,
      residents: [],
    },
    {
      apartment_id: '018f0000-0000-7000-8000-000000000309',
      apartment_number: '09',
      entrance: 2,
      floor: 3,
      area_m2: '51.00',
      owner_count: 1,
      tenant_count: 0,
      resident_count: 1,
      residents: [
        { relation_type: 'OWNER', since: '2023-04-01T09:00:00Z' },
        { relation_type: 'RESIDENT', since: '2024-09-01T12:00:00Z' },
      ],
    },
    {
      apartment_id: '018f0000-0000-7000-8000-000000000314',
      apartment_number: '14',
      entrance: 2,
      floor: 4,
      area_m2: '54.30',
      owner_count: 1,
      tenant_count: 1,
      resident_count: 0,
      residents: [
        { relation_type: 'OWNER', since: '2022-01-12T10:00:00Z' },
        { relation_type: 'TENANT', since: '2025-09-03T10:00:00Z' },
      ],
    },
    {
      apartment_id: '018f0000-0000-7000-8000-000000000315',
      apartment_number: '15',
      entrance: 2,
      floor: 4,
      area_m2: '59.00',
      owner_count: 1,
      tenant_count: 1,
      resident_count: 0,
      residents: [
        { relation_type: 'OWNER', since: '2022-05-18T10:00:00Z' },
        { relation_type: 'TENANT', since: '2025-05-01T10:00:00Z' },
      ],
    },
  ]

  if (pathname === '/property/apartments' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      const err = new Error('Forbidden')
      err.status = 403
      err.errorCode = 'FORBIDDEN'
      err.payload = { error_code: 'FORBIDDEN' }
      throw err
    }
    return {
      apartments: OFFLINE_APARTMENT_CARDS.map(({ residents, ...rest }) => rest),
    }
  }

  const offlineAptCardMatch = pathname.match(/^\/property\/apartments\/([^/]+)$/)
  if (offlineAptCardMatch && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      const err = new Error('Forbidden')
      err.status = 403
      err.errorCode = 'FORBIDDEN'
      err.payload = { error_code: 'FORBIDDEN' }
      throw err
    }
    const found = OFFLINE_APARTMENT_CARDS.find((a) => a.apartment_id === offlineAptCardMatch[1])
    if (!found) {
      const err = new Error('Apartment not found')
      err.status = 404
      err.errorCode = 'APARTMENT_NOT_FOUND'
      err.payload = { error_code: 'APARTMENT_NOT_FOUND' }
      throw err
    }
    return JSON.parse(JSON.stringify(found))
  }


  const privacyMatch = pathname.match(/^\/property\/memberships\/([^/]+)\/privacy$/)
  if (privacyMatch && method === 'PATCH') {
    const membershipId = decodeURIComponent(privacyMatch[1])
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const current = userMems.find((m) => m.membership_id === membershipId) || userMems[0]
    const nextMode = body?.privacy_display_mode
    const allowedModes = ['FULL_NAME', 'INITIALS', 'APARTMENT_ONLY']
    if (current && allowedModes.includes(nextMode)) {
      current.privacy_display_mode = nextMode
      current.preview_badge = computeMockPreviewBadge(user, current.apartment_number, nextMode)
    }
    const target = current || {
      membership_id: membershipId,
      privacy_display_mode: allowedModes.includes(nextMode) ? nextMode : 'FULL_NAME',
      preview_badge: computeMockPreviewBadge(
        user,
        user.apartment_number || null,
        allowedModes.includes(nextMode) ? nextMode : 'FULL_NAME',
      ),
    }
    return {
      membership_id: target.membership_id,
      privacy_display_mode: target.privacy_display_mode,
      preview_badge: target.preview_badge,
    }
  }

  return UNHANDLED
}
