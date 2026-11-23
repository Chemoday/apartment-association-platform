import { apiRequest } from '../client.js'
import type { ChatMessageCreate, ChatMessageView, ChatPage, ChatState } from '../schema.js'

/**
 * Fetch building chat status & recent activity indicator (#033).
 */
export function getChatState(options: { signal?: AbortSignal } = {}): Promise<ChatState> {
  return apiRequest<ChatState>('/chat', {
    ...(options?.signal ? { signal: options.signal } : {}),
  })
}

/**
 * Fetch building chat messages (newest page without `after`, or newer than `after` cursor).
 */
export function getChatMessages(
  options: { after?: number | string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<ChatPage> {
  const params = new URLSearchParams()
  if (options.after !== undefined && options.after !== null && options.after !== '') {
    params.set('after', String(options.after))
  }
  if (options.limit !== undefined && options.limit !== null) {
    params.set('limit', String(options.limit))
  }
  const qs = params.toString()
  return apiRequest<ChatPage>(`/chat/messages${qs ? `?${qs}` : ''}`, {
    ...(options?.signal ? { signal: options.signal } : {}),
  })
}

/**
 * Post a new message to the building chat (#033).
 */
export function postChatMessage(
  payload: ChatMessageCreate,
  options: { signal?: AbortSignal } = {},
): Promise<ChatMessageView> {
  const body: ChatMessageCreate = { body: payload?.body ?? '' }
  if (payload?.author_apartment_id !== undefined) {
    body.author_apartment_id = payload.author_apartment_id
  }
  return apiRequest<ChatMessageView>('/chat/messages', {
    method: 'POST',
    body,
    ...(options?.signal ? { signal: options.signal } : {}),
  })
}
