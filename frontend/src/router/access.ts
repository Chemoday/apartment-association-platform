import type { RouteMeta } from 'vue-router'
import type { BuildingRole, MembershipView } from '@/api/schema.js'
import { stashLinkToken } from '@/utils/linkToken.js'

const BOARD_ROLES = new Set<string>(['CHAIRMAN', 'BOARD'])

export interface SessionAccessSnapshot {
  buildingRole?: BuildingRole | string | null
  me?: {
    building_role?: BuildingRole | string | null
  } | null
  memberships?: MembershipView[] | unknown[] | null
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
    const hasApartments = Array.isArray(session?.memberships) && session.memberships.length > 0
    if (!isBoardOrChairman && !hasApartments) {
      return false
    }
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
