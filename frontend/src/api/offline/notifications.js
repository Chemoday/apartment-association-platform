import {
  UNHANDLED,
  makeOfflineError,
  getOfflineUserPreferences,
  getOfflineUserNotifications,
} from './state.js'

export async function handleOfflineNotifications(ctx) {
  const { urlObj, pathname, method, body, user } = ctx

  // 12. Notifications & Auth in offline demo mode
  if (pathname === '/notifications/unread-count' && method === 'GET') {
    const items = getOfflineUserNotifications(user.user_id)
    return { unread: items.filter((i) => !i.read_at).length }
  }

  if (pathname === '/notifications/feed' && method === 'GET') {
    const unreadOnly = urlObj.searchParams.get('unread_only') === 'true'
    const limit = Number(urlObj.searchParams.get('limit') || '50')
    const offset = Number(urlObj.searchParams.get('offset') || '0')
    const items = getOfflineUserNotifications(user.user_id)
    const filtered = unreadOnly ? items.filter((i) => !i.read_at) : items
    return JSON.parse(JSON.stringify(filtered.slice(offset, offset + limit)))
  }

  if (pathname === '/notifications/feed/read-all' && method === 'POST') {
    const items = getOfflineUserNotifications(user.user_id)
    const nowIso = new Date().toISOString()
    let updated = 0
    for (const item of items) {
      if (!item.read_at) {
        item.read_at = nowIso
        updated += 1
      }
    }
    return { updated }
  }

  const readOneMatch = pathname.match(/^\/notifications\/feed\/([^/]+)\/read$/)
  if (readOneMatch && method === 'POST') {
    const items = getOfflineUserNotifications(user.user_id)
    const found = items.find((i) => i.id === readOneMatch[1])
    if (!found) {
      throw makeOfflineError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.')
    }
    if (!found.read_at) {
      found.read_at = new Date().toISOString()
    }
    return { id: found.id, read_at: found.read_at }
  }

  if (pathname === '/notifications/preferences') {
    const preferences = getOfflineUserPreferences(user.user_id)
    if (method === 'PUT') {
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const changes = Array.isArray(reqBody.preferences) ? reqBody.preferences : []
      if (changes.length < 1 || changes.length > 56) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          'Provide between 1 and 56 preference changes.',
        )
      }
      for (const chg of changes) {
        const match = preferences.find(
          (p) => p.event_type === chg.event_type && p.channel === chg.channel,
        )
        if (match?.mandatory && chg.enabled === false) {
          throw makeOfflineError(
            422,
            'PREFERENCE_MANDATORY',
            'Mandatory notifications cannot be switched off.',
          )
        }
      }
      for (const chg of changes) {
        const match = preferences.find(
          (p) => p.event_type === chg.event_type && p.channel === chg.channel,
        )
        if (match && !match.mandatory) {
          match.enabled = Boolean(chg.enabled)
        }
      }
    }
    return {
      channels: [
        { channel: 'in_app', available: true, reason: null },
        { channel: 'email', available: false, reason: 'DEMO_MODE' },
        { channel: 'telegram', available: false, reason: 'DEMO_MODE' },
        { channel: 'webpush', available: false, reason: 'DEMO_MODE' },
      ],
      preferences: JSON.parse(JSON.stringify(preferences)),
    }
  }

  if (pathname === '/notifications/bindings' && method === 'GET') {
    return []
  }

  if (pathname === '/notifications/unsubscribe' && method === 'POST') {
    const token = urlObj.searchParams.get('token') || ''
    if (!token || token.length > 128) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Validation error')
    }
    if (token.startsWith('demo-')) {
      const lower = token.toLowerCase()
      const eventType = lower.includes('emergency')
        ? 'EMERGENCY_RESOLVED'
        : lower.includes('review')
          ? 'PERIOD_REVIEW'
          : lower.includes('poll')
            ? 'POLL_OPENED'
            : lower.includes('issue-reported')
              ? 'ISSUE_REPORTED'
              : lower.includes('issue')
                ? 'ISSUE_STATUS_CHANGED'
                : lower.includes('storage')
                  ? 'STORAGE_ALMOST_FULL'
                  : lower.includes('energy') || lower.includes('certificate')
                    ? 'ENERGY_CERTIFICATE_EXPIRING'
                    : lower.includes('board')
                      ? 'APARTMENT_MESSAGE_TO_BOARD'
                      : lower.includes('message')
                        ? 'APARTMENT_MESSAGE'
                        : 'READING_DEADLINE'
      const prefs = getOfflineUserPreferences(user.user_id)
      const match = prefs.find((p) => p.event_type === eventType && p.channel === 'email')
      if (match && !match.mandatory) {
        match.enabled = false
      }
      return {
        event_type: eventType,
        channel: 'email',
      }
    }
    throw makeOfflineError(400, 'INVALID_LINK', 'Invalid link')
  }


  return UNHANDLED
}
