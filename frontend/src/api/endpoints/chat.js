import { apiRequest } from '../client.js'

/**
 * Fetch building chat status & recent activity indicator (#033).
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import('../schema').ChatState>}
 */
export function getChatState(options = {}) {
  return apiRequest('/chat', {
    ...(options?.signal ? { signal: options.signal } : {}),
  })
}

/**
 * Fetch building chat messages (newest page without `after`, or newer than `after` cursor).
 * @param {{ after?: number | null, limit?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<import('../schema').ChatPage>}
 */
export function getChatMessages(options = {}) {
  const params = new URLSearchParams()
  if (options.after !== undefined && options.after !== null && options.after !== '') {
    params.set('after', String(options.after))
  }
  if (options.limit !== undefined && options.limit !== null) {
    params.set('limit', String(options.limit))
  }
  const qs = params.toString()
  return apiRequest(`/chat/messages${qs ? `?${qs}` : ''}`, {
    ...(options?.signal ? { signal: options.signal } : {}),
  })
}

/**
 * Post a new message to the building chat (#033).
 * @param {import('../schema').ChatMessageCreate} payload
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import('../schema').ChatMessageView>}
 */
export function postChatMessage(payload, options = {}) {
  const body = { body: payload?.body ?? '' }
  if (payload?.author_apartment_id !== undefined) {
    body.author_apartment_id = payload.author_apartment_id
  }
  return apiRequest('/chat/messages', {
    method: 'POST',
    body,
    ...(options?.signal ? { signal: options.signal } : {}),
  })
}
