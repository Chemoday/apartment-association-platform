import {
  UNHANDLED,
  makeOfflineError,
  offlineStore,
} from './state.js'
import {
  compareSettingKeys,
  validateAndApplySettingsUpdate,
} from '../../utils/associationSettings.js'
import {
  readSettingFromStore,
} from '../../utils/issues.js'

export async function handleOfflineSettings(ctx) {
  const { pathname, method, body, user } = ctx

  if (pathname === '/settings' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only board members and the chairman can view association settings.',
      )
    }
    const ordered = [...offlineStore.offlineSettings]
      .sort(compareSettingKeys)
      .map((s) => ({ ...s }))
    return { settings: ordered }
  }

  if (pathname === '/settings' && method === 'PUT') {
    if (user.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only the chairman can update association settings.',
      )
    }
    const prevChatEnabled = Boolean(readSettingFromStore(offlineStore.offlineSettings, 'chat.enabled', false))
    const outcome = validateAndApplySettingsUpdate(offlineStore.offlineSettings, body)
    if (!outcome.ok) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid association settings update.', {
        errors: outcome.errors,
      })
    }
    offlineStore.offlineSettings = outcome.settings
    const nextChatEnabled = Boolean(readSettingFromStore(offlineStore.offlineSettings, 'chat.enabled', false))
    if (!prevChatEnabled && nextChatEnabled) {
      offlineStore.offlineChatTurnedOnAt = new Date().toISOString()
      offlineStore.offlineChatMessages = []
    } else if (prevChatEnabled && !nextChatEnabled) {
      offlineStore.offlineChatTurnedOnAt = null
      offlineStore.offlineChatMessages = []
    }
    return { settings: offlineStore.offlineSettings.map((s) => ({ ...s })) }
  }

  // =========================================================================
  // Issue Tracker (/issues) - #012 (E9/I1)
  // =========================================================================

  return UNHANDLED
}
