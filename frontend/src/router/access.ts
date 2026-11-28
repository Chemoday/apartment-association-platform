import type { RouteMeta } from 'vue-router'
import type { BuildingRole, MembershipView } from '@/api/schema.js'
import { stashJoinCode, stashLinkToken } from '@/utils/linkToken.js'
import { isApartmentKindStrict } from '@/utils/objectName.js'

const BOARD_ROLES = new Set<string>(['CHAIRMAN', 'BOARD'])
const STAFF_ROLES = new Set<string>(['CHAIRMAN', 'BOARD', 'ACCOUNTANT'])

interface MembershipAccessLike {
  apartment_kind?: string | null
  relation_type?: string | null
}

export interface SessionAccessSnapshot {
  buildingRole?: BuildingRole | string | null
  sharedAccess?: boolean | null
  me?: {
    building_role?: BuildingRole | string | null
    shared_access?: boolean | null
    memberships?: MembershipView[] | MembershipAccessLike[] | unknown[] | null
  } | null
  memberships?: MembershipView[] | MembershipAccessLike[] | unknown[] | null
  authMode?: 'signed_in' | 'demo' | 'none' | string
  backendOffline?: boolean
  bootstrap?: () => Promise<unknown>
}

export interface RouteAccessTarget {
  name?: string | symbol | null
  path?: string
  fullPath?: string
  hash?: string
  meta?: (Omit<Partial<RouteMeta>, 'roles'> & { roles?: readonly (BuildingRole | string)[] }) | null
}

/**
 * Resolve the effective building role from a session store / snapshot.
 * Defaults fail-closed to 'USER' when unknown.
 */
export function resolveEffectiveRole(session?: SessionAccessSnapshot | null): BuildingRole {
  const role = session?.buildingRole || session?.me?.building_role || 'USER'
  return role as BuildingRole
}

function getSessionMemberships(session?: SessionAccessSnapshot | null): MembershipAccessLike[] {
  const raw = Array.isArray(session?.memberships)
    ? session.memberships
    : Array.isArray(session?.me?.memberships)
      ? session.me.memberships
      : []
  return raw.filter((m): m is MembershipAccessLike => Boolean(m && typeof m === 'object'))
}

/**
 * Compute membership-only `shared_access` per docs/API.md §1 (epic E14, #066).
 * Every membership grants shared access EXCEPT a `TENANT` of a `PARKING` or `GARAGE`.
 * Role precedence is applied by `canAccessDocuments` / `canAccessIssues`.
 */
export function hasSharedAccess(session?: SessionAccessSnapshot | null): boolean {
  if (typeof session?.me?.shared_access === 'boolean') {
    return session.me.shared_access
  }
  if (typeof session?.sharedAccess === 'boolean') {
    return session.sharedAccess
  }
  const mems = getSessionMemberships(session)
  return mems.some(
    (m) => isApartmentKindStrict(m.apartment_kind) || m.relation_type === 'OWNER',
  )
}

/**
 * Documents access (#066): hidden/forbidden when `!shared_access && role === 'USER'`.
 * Staff (`CHAIRMAN`, `BOARD`, `ACCOUNTANT`) keep access by their role.
 */
export function canAccessDocuments(session?: SessionAccessSnapshot | null): boolean {
  const role = resolveEffectiveRole(session)
  if (STAFF_ROLES.has(role)) return true
  return hasSharedAccess(session)
}

/**
 * Issue tracker access (#066): hidden/forbidden when `!shared_access && (role === 'USER' || role === 'ACCOUNTANT')`.
 * Only `CHAIRMAN` and `BOARD` see it by their role.
 */
export function canAccessIssues(session?: SessionAccessSnapshot | null): boolean {
  const role = resolveEffectiveRole(session)
  if (BOARD_ROLES.has(role)) return true
  return hasSharedAccess(session)
}

/**
 * Building chat access (#066): requires either `CHAIRMAN`/`BOARD` role or at least one
 * active membership of kind `APARTMENT`. Parking-only and garage-only users (even owners)
 * and apartment-less accountants cannot participate.
 */
export function canAccessChat(session?: SessionAccessSnapshot | null): boolean {
  const role = resolveEffectiveRole(session)
  if (BOARD_ROLES.has(role)) return true
  const mems = getSessionMemberships(session)
  return mems.some((m) => isApartmentKindStrict(m.apartment_kind))
}

/**
 * Pure RBAC & membership access predicate shared between router.beforeEach and AppLayout.
 * Fail-closed: if `route.meta.roles` is non-empty, the caller's effective role must match.
 */
export function canAccessRoute(
  route?: RouteAccessTarget | null,
  session?: SessionAccessSnapshot | null,
): boolean {
  const meta = route?.meta
  if (!meta || meta.public) return true

  const role = resolveEffectiveRole(session)
  if (meta.requiresApartmentOrBoard) {
    const isBoardOrChairman = BOARD_ROLES.has(role)
    const hasMemberships = getSessionMemberships(session).length > 0
    if (!isBoardOrChairman && !hasMemberships) {
      return false
    }
  }

  if (meta.requiresSharedAccess === 'documents' && !canAccessDocuments(session)) {
    return false
  }

  if (meta.requiresSharedAccess === 'issues' && !canAccessIssues(session)) {
    return false
  }

  if (meta.requiresChatAccess && !canAccessChat(session)) {
    return false
  }

  const allowedRoles = meta.roles
  if (Array.isArray(allowedRoles) && allowedRoles.length > 0) {
    return allowedRoles.includes(role)
  }

  return true
}

/**
 * Build the Vue Router beforeEach navigation guard with injectable session getter for unit testing.
 */
export function createAuthGuard(getSession: () => SessionAccessSnapshot | null | undefined) {
  return async function authAndRbacGuard(to: RouteAccessTarget) {
    // 1. Magic sign-in link & one-click unsubscribe: stash token from URL fragment and strip hash
    if ((to.name === 'login-link' || to.name === 'unsubscribe') && to.hash && to.hash.length > 1) {
      stashLinkToken(to.hash.slice(1))
      if (typeof window !== 'undefined' && window.history?.replaceState && to.path) {
        window.history.replaceState(null, '', to.path)
      }
      return { name: to.name as string, hash: '', replace: true }
    }

    // 1b. Paper join code (/join#code=...): stash in volatile memory and strip hash immediately (#060, P1-3)
    if (to.name === 'join' && to.hash && to.hash.length > 1) {
      stashJoinCode(to.hash.slice(1))
      if (typeof window !== 'undefined' && window.history?.replaceState && to.path) {
        window.history.replaceState(null, '', to.path)
      }
      return { name: 'join', hash: '', replace: true }
    }

    // 2. Bootstrap session once per page load (isolated so public pages remain reachable on unexpected error)
    const session = getSession()
    if (typeof session?.bootstrap === 'function') {
      try {
        await session.bootstrap()
      } catch {
        /* fail-closed below for protected routes; public pages stay accessible */
      }
    }

    // 3. Public pages are always allowed
    if (to.meta?.public) return true

    // 4. Require signed-in user or demo user (fail-closed if session is missing)
    if ((!session || session.authMode === 'none') && !session?.backendOffline) {
      return { name: 'welcome' }
    }

    // 5. Fail-closed router-level RBAC enforcement (skip recursion on error views)
    if (to.name !== 'forbidden' && to.name !== 'not-found' && !canAccessRoute(to, session)) {
      return {
        name: 'forbidden',
        query: to.fullPath && to.fullPath !== '/forbidden' ? { from: to.fullPath } : undefined,
        replace: true,
      }
    }

    return true
  }
}
