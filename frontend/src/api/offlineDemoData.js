/**
 * Lazy-loaded offline demo API responder facade (`src/api/offlineDemoData.js`, #041).
 * Dispatches requests in O(1) by URL prefix to focused domain modules under `src/api/offline/`.
 */

import {
  OFFLINE_DEMO_USERS,
  UNHANDLED,
  disableOfflineDemo,
  enableOfflineDemo,
  getActingUser,
  isOfflineDemoMode,
} from './offline/state.js'
import { handleOfflineProperty } from './offline/property.js'
import { handleOfflineMeters } from './offline/meters.js'
import { handleOfflineCommunication } from './offline/communication.js'
import { handleOfflineNotifications } from './offline/notifications.js'
import { handleOfflineAuth } from './offline/auth.js'
import { handleOfflineGovernance } from './offline/governance.js'
import { handleOfflineSettings } from './offline/settings.js'
import { handleOfflineIssues } from './offline/issues.js'
import { handleOfflineDocuments } from './offline/documents.js'
import { handleOfflineMaintenance } from './offline/maintenance.js'
import { handleOfflineChat } from './offline/chat.js'

export { disableOfflineDemo, enableOfflineDemo, isOfflineDemoMode }

function selectOfflineHandler(pathname) {
  if (pathname.startsWith('/property/')) return handleOfflineProperty
  if (pathname.startsWith('/meters/')) return handleOfflineMeters
  if (pathname.startsWith('/communication/')) return handleOfflineCommunication
  if (pathname.startsWith('/notifications/')) return handleOfflineNotifications
  if (pathname.startsWith('/auth/')) return handleOfflineAuth
  if (pathname.startsWith('/governance/')) return handleOfflineGovernance
  if (pathname === '/settings' || pathname.startsWith('/settings/')) return handleOfflineSettings
  if (pathname === '/issues' || pathname.startsWith('/issues/')) return handleOfflineIssues
  if (
    pathname === '/documents' ||
    pathname.startsWith('/documents/') ||
    pathname.startsWith('/files/')
  ) {
    return handleOfflineDocuments
  }
  if (pathname.startsWith('/maintenance/')) return handleOfflineMaintenance
  if (pathname === '/chat' || pathname.startsWith('/chat/')) return handleOfflineChat
  return null
}

/**
 * Resolves API requests locally from seeded demo fixtures when offlineDemoMode is enabled.
 * @param {string} path
 * @param {{ method?: string, body?: any, raw?: boolean, actingUserId?: string, contentType?: string, headers?: Record<string, string>, signal?: AbortSignal }} [options]
 */
export async function resolveOfflineDemoRequest(
  path,
  { method = 'GET', body = null, raw = false, actingUserId = '', contentType = '', headers = {}, signal } = {},
) {
  const urlObj = new URL(path, 'http://localhost')
  const pathname = urlObj.pathname
  const user = getActingUser(actingUserId)

  if (pathname === '/demo/users' && method === 'GET') {
    return OFFLINE_DEMO_USERS.map((u) => ({
      user_id: u.user_id,
      label: u.label,
      building_role: u.building_role,
      apartment_number: u.apartment_number,
      relation_type: u.relation_type,
    }))
  }

  const handler = selectOfflineHandler(pathname)
  if (handler) {
    const result = await handler({
      urlObj,
      pathname,
      method,
      body,
      raw,
      user,
      contentType,
      headers,
      signal,
    })
    if (result !== UNHANDLED) {
      return result
    }
  }

  return null
}
