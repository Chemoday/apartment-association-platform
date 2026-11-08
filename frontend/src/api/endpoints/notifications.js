import { apiRequest } from '../client.js'

/**
 * Fetch unread notifications count for the current user.
 * @returns {Promise<import('../schema').UnreadCountResponse>}
 */
export function getUnreadCount() {
  return apiRequest('/notifications/unread-count')
}

/**
 * Fetch the caller's in-app notifications feed, newest first.
 * @param {{ unreadOnly?: boolean, limit?: number, offset?: number }} [params]
 * @returns {Promise<import('../schema').NotificationView[]>}
 */
export function getFeed({ unreadOnly = false, limit = 50, offset = 0 } = {}) {
  const search = new URLSearchParams()
  if (unreadOnly) search.set('unread_only', 'true')
  if (limit !== undefined) search.set('limit', String(limit))
  if (offset !== undefined) search.set('offset', String(offset))
  const qs = search.toString()
  return apiRequest(`/notifications/feed${qs ? `?${qs}` : ''}`)
}

/**
 * Mark a single notification as read (idempotent).
 * @param {string} id
 * @returns {Promise<import('../schema').ReadResponse>}
 */
export function markRead(id) {
  return apiRequest(`/notifications/feed/${encodeURIComponent(id)}/read`, {
    method: 'POST',
  })
}

/**
 * Mark all unread notifications as read.
 * @returns {Promise<import('../schema').ReadAllResponse>}
 */
export function markAllRead() {
  return apiRequest('/notifications/feed/read-all', {
    method: 'POST',
  })
}

/**
 * Get the caller's notification channel availability and 4x4 preference matrix.
 * @returns {Promise<import('../schema').PreferencesResponse>}
 */
export function getPreferences() {
  return apiRequest('/notifications/preferences')
}

/**
 * Update changed notification preferences (only modified non-mandatory cells).
 * @param {import('../schema').PreferenceChange[]} changes
 * @returns {Promise<import('../schema').PreferencesResponse>}
 */
export function updatePreferences(changes) {
  return apiRequest('/notifications/preferences', {
    method: 'PUT',
    body: { preferences: changes },
  })
}

/**
 * Generate a one-time 10-minute Telegram link code.
 * @returns {Promise<import('../schema').LinkCodeResponse>}
 */
export function createTelegramLinkCode() {
  return apiRequest('/notifications/telegram/link-code', {
    method: 'POST',
  })
}

/**
 * Fetch the server's WebPush VAPID public key.
 * @returns {Promise<import('../schema').VapidPublicKeyResponse>}
 */
export function getVapidPublicKey() {
  return apiRequest('/notifications/webpush/vapid-public-key')
}

/**
 * Register this browser's PushSubscription with a user-readable label.
 * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscriptionJson
 * @param {string} label
 * @returns {Promise<import('../schema').BindingView>}
 */
export function subscribeWebPush(subscriptionJson, label) {
  return apiRequest('/notifications/webpush/subscriptions', {
    method: 'POST',
    body: {
      endpoint: subscriptionJson.endpoint,
      keys: subscriptionJson.keys,
      label,
    },
  })
}

/**
 * List the caller's linked notification chats and browser push devices.
 * @returns {Promise<import('../schema').BindingView[]>}
 */
export function listBindings() {
  return apiRequest('/notifications/bindings')
}

/**
 * Unlink a notification chat or browser push device by binding_id.
 * @param {string} bindingId
 * @returns {Promise<null>}
 */
export function deleteBinding(bindingId) {
  return apiRequest(`/notifications/bindings/${encodeURIComponent(bindingId)}`, {
    method: 'DELETE',
  })
}

/**
 * Turn off a single non-mandatory email notification preference via one-click token (N8).
 * Calls POST /api/v1/notifications/unsubscribe?token=<token> with no body, no auth header, and no CSRF header.
 * @param {string} token
 * @returns {Promise<import('../schema').UnsubscribeResponse>}
 */
export function unsubscribeByToken(token) {
  return apiRequest(`/notifications/unsubscribe?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    noAuth: true,
  })
}
