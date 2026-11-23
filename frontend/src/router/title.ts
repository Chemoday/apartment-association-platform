import { ref } from 'vue'
import type { RouteMeta } from 'vue-router'

const ROUTE_NAME_TITLE_KEYS: Record<string, string> = {
  dashboard: 'nav.dashboard',
  building: 'nav.building',
  readings: 'nav.readings',
  forum: 'nav.forum',
  'forum-detail': 'nav.forum',
  messages: 'nav.messages',
  'message-thread': 'nav.messages',
  chat: 'nav.chat',
  polls: 'nav.polls',
  'poll-new': 'nav.polls',
  'poll-edit': 'nav.polls',
  'poll-detail': 'nav.polls',
  'poll-results': 'nav.polls',
  issues: 'nav.issues',
  'issue-detail': 'nav.issues',
  documents: 'nav.documents',
  accounting: 'nav.accounting',
  apartments: 'nav.apartments',
  'apartment-card': 'nav.apartments',
  'board-room': 'nav.boardRoom',
  'board-room-detail': 'nav.boardRoom',
  people: 'nav.people',
  maintenance: 'nav.maintenance',
  'maintenance-new': 'nav.maintenance',
  'maintenance-edit': 'nav.maintenance',
  'maintenance-log': 'nav.maintenanceLog',
  'maintenance-detail': 'nav.maintenance',
  'settings-association': 'nav.associationSettings',
  welcome: 'pageTitles.welcome',
  login: 'pageTitles.login',
  'login-link': 'pageTitles.loginLink',
  unsubscribe: 'pageTitles.unsubscribe',
  notifications: 'pageTitles.notifications',
  'settings-profile': 'pageTitles.profile',
  'settings-notifications': 'pageTitles.notificationSettings',
  'settings-security': 'pageTitles.security',
  'theme-lab': 'pageTitles.themeLab',
  forbidden: 'pageTitles.forbidden',
  'not-found': 'pageTitles.notFound',
}

/** Reactive polite live-region announcement updated on every SPA route transition. */
export const routeAnnouncement = ref<string>('')

export interface RouteTitleTarget {
  name?: string | symbol | null
  meta?: Partial<RouteMeta> | null
}

/**
 * Resolve localized page title and full document.title (`<Page Title> — <Building Name>`).
 */
export function resolveRoutePageTitle(
  route?: RouteTitleTarget | null,
  t?: ((key: string, params?: Record<string, unknown>) => string) | null,
  buildingName: string = 'KÜ Sõpruse 12',
): { pageTitle: string; documentTitle: string } {
  const name = typeof route?.name === 'string' ? route.name : ''
  const titleKey =
    (route?.meta?.titleKey as string | undefined) ||
    (route?.meta?.navKey ? `nav.${String(route.meta.navKey)}` : '') ||
    ROUTE_NAME_TITLE_KEYS[name] ||
    'nav.dashboard'

  const translated = typeof t === 'function' ? t(titleKey) : ''
  const pageTitle = translated && translated !== titleKey ? translated : buildingName
  const documentTitle =
    pageTitle && buildingName && pageTitle !== buildingName
      ? `${pageTitle} — ${buildingName}`
      : buildingName || pageTitle

  return { pageTitle, documentTitle }
}

/**
 * Apply document.title and update aria-live route announcement.
 */
export function applyRouteA11yMetadata(
  route: RouteTitleTarget,
  session?: {
    t?: (k: string, p?: Record<string, unknown>) => string
    buildingName?: string
  } | null,
  options: { announce?: boolean } = {},
): { pageTitle: string; documentTitle: string } {
  const { announce = false } = options
  const buildingName = session?.buildingName || 'KÜ Sõpruse 12'
  const { pageTitle, documentTitle } = resolveRoutePageTitle(route, session?.t, buildingName)

  if (typeof document !== 'undefined') {
    document.title = documentTitle
  }

  if (announce && typeof session?.t === 'function') {
    routeAnnouncement.value = session.t('a11y.navigatedTo', { page: pageTitle })
  }

  return { pageTitle, documentTitle }
}
