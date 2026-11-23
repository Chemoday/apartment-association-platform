import { apiRequest } from '../client.js'
import type {
  BindingView,
  LinkCodeResponse,
  NotificationView,
  PreferenceChange,
  PreferencesResponse,
  ReadAllResponse,
  ReadResponse,
  UnreadCountResponse,
  UnsubscribeResponse,
  VapidPublicKeyResponse,
  WebPushKeys,
} from '../schema.js'

/**
 * Fetch unread notifications count for the current user.
 */
export function getUnreadCount(
  options: { signal?: AbortSignal } = {},
): Promise<UnreadCountResponse> {
  return apiRequest<UnreadCountResponse>(
    '/notifications/unread-count',
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Fetch the caller's in-app notifications feed, newest first.
 */
export function getFeed({
  unreadOnly = false,
  limit = 50,
  offset = 0,
  signal,
}: {
  unreadOnly?: boolean
  limit?: number
  offset?: number
  signal?: AbortSignal
} = {}): Promise<NotificationView[]> {
  const search = new URLSearchParams()
  if (unreadOnly) search.set('unread_only', 'true')
  if (limit !== undefined) search.set('limit', String(limit))
  if (offset !== undefined) search.set('offset', String(offset))
  const qs = search.toString()
  return apiRequest<NotificationView[]>(
    `/notifications/feed${qs ? `?${qs}` : ''}`,
    signal ? { signal } : {},
  )
}

/**
 * Mark a single notification as read (idempotent).
 */
export function markRead(id: string): Promise<ReadResponse> {
  return apiRequest<ReadResponse>(`/notifications/feed/${encodeURIComponent(id)}/read`, {
    method: 'POST',
  })
}

/**
 * Mark all unread notifications as read.
 */
export function markAllRead(): Promise<ReadAllResponse> {
  return apiRequest<ReadAllResponse>('/notifications/feed/read-all', {
    method: 'POST',
  })
}

/**
 * Get the caller's notification channel availability and 4x4 preference matrix.
 */
export function getPreferences(
  options: { signal?: AbortSignal } = {},
): Promise<PreferencesResponse> {
  return apiRequest<PreferencesResponse>(
    '/notifications/preferences',
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Update changed notification preferences (only modified non-mandatory cells).
 */
export function updatePreferences(changes: PreferenceChange[]): Promise<PreferencesResponse> {
  return apiRequest<PreferencesResponse>('/notifications/preferences', {
    method: 'PUT',
    body: { preferences: changes },
  })
}

/**
 * Generate a one-time 10-minute Telegram link code.
 */
export function createTelegramLinkCode(): Promise<LinkCodeResponse> {
  return apiRequest<LinkCodeResponse>('/notifications/telegram/link-code', {
    method: 'POST',
  })
}

/**
 * Fetch the server's WebPush VAPID public key.
 */
export function getVapidPublicKey(
  options: { signal?: AbortSignal } = {},
): Promise<VapidPublicKeyResponse> {
  return apiRequest<VapidPublicKeyResponse>(
    '/notifications/webpush/vapid-public-key',
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Register this browser's PushSubscription with a user-readable label.
 */
export function subscribeWebPush(
  subscriptionJson: { endpoint: string; keys: WebPushKeys },
  label: string,
): Promise<BindingView> {
  return apiRequest<BindingView>('/notifications/webpush/subscriptions', {
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
 */
export function listBindings(options: { signal?: AbortSignal } = {}): Promise<BindingView[]> {
  return apiRequest<BindingView[]>(
    '/notifications/bindings',
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Unlink a notification chat or browser push device by binding_id.
 */
export function deleteBinding(bindingId: string): Promise<null> {
  return apiRequest<null>(`/notifications/bindings/${encodeURIComponent(bindingId)}`, {
    method: 'DELETE',
  })
}

/**
 * Turn off a single non-mandatory email notification preference via one-click token (N8).
 * Calls POST /api/v1/notifications/unsubscribe?token=<token> with no body, no auth header, and no CSRF header.
 */
export function unsubscribeByToken(token: string): Promise<UnsubscribeResponse> {
  return apiRequest<UnsubscribeResponse>(
    `/notifications/unsubscribe?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      noAuth: true,
    },
  )
}
