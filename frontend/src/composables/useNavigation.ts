import { computed } from 'vue'
import { useRoute, type RouteRecordRaw } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { useChatState } from '@/composables/useChatState.js'
import { APP_ROUTES, NAV_GROUPS, type NavGroupDefinition } from '@/router/routes.js'
import { canAccessRoute } from '@/router/access.js'

export type NavRouteItem = RouteRecordRaw & { meta: NonNullable<RouteRecordRaw['meta']> }

export interface VisibleNavGroup extends NavGroupDefinition {
  items: NavRouteItem[]
}

export function resolveActiveNavPath(
  currentPath: string,
  routes: ReadonlyArray<Pick<RouteRecordRaw, 'path'>>,
): string | null {
  let bestPath: string | null = null
  for (const item of routes) {
    const matches =
      item.path === '/'
        ? currentPath === '/'
        : currentPath === item.path || currentPath.startsWith(`${item.path}/`)
    if (matches && (bestPath === null || item.path.length > bestPath.length)) {
      bestPath = item.path
    }
  }
  return bestPath
}

export function useNavigation() {
  const route = useRoute()
  const session = useSessionStore()
  const { buildingRole } = useRole()
  const { canShowChat } = useChatState()

  const visibleNavRoutes = computed<NavRouteItem[]>(() =>
    APP_ROUTES.filter((r): r is NavRouteItem => {
      if (!r.meta?.navKey) return false
      if (r.meta?.requiresChatEnabled && !canShowChat.value) {
        return false
      }
      if (!canAccessRoute(r, session)) {
        return false
      }
      const allowed = r.meta?.navRoles || r.meta?.roles
      if (!allowed || allowed.length === 0) return true
      return allowed.includes(buildingRole.value)
    }),
  )

  const visibleNavGroups = computed<VisibleNavGroup[]>(() =>
    NAV_GROUPS.map((group) => {
      const items = visibleNavRoutes.value.filter(
        (r) => (r.meta?.navGroup || 'services') === group.id,
      )
      return {
        ...group,
        items,
      }
    }).filter((group) => group.items.length > 0),
  )

  const activeNavPath = computed<string | null>(() =>
    resolveActiveNavPath(route.path, visibleNavRoutes.value),
  )

  function isRouteActive(item: RouteRecordRaw): boolean {
    return activeNavPath.value === item.path
  }

  function isGroupActive(group: { items: RouteRecordRaw[] }): boolean {
    return group.items.some((item) => isRouteActive(item))
  }

  return {
    visibleNavRoutes,
    visibleNavGroups,
    activeNavPath,
    isRouteActive,
    isGroupActive,
  }
}
