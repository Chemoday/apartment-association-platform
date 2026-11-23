import {
  UNHANDLED,
  OFFLINE_MEMBERSHIPS_BY_USER,
  makeOfflineError,
  offlineStore,
} from './state.js'
import {
  readSettingFromStore,
} from '../../utils/issues.js'
import {
  CHAT_HISTORY_MS,
  CHAT_MAX_LENGTH,
  buildMockChatPage,
  buildMockChatState,
  canUserParticipateInChat,
  evaluateChatRateLimit,
  validateChatAfterParam,
  validateChatLimitParam,
  validateChatMessageInput,
} from '../../utils/chat.js'

export async function handleOfflineChat(ctx) {
  const { urlObj, pathname, method, body, user } = ctx

  if (pathname === '/chat' && method === 'GET') {
    const enabled = Boolean(readSettingFromStore(offlineStore.offlineSettings, 'chat.enabled', false))
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const canTakePart = canUserParticipateInChat(user, userMems)
    return buildMockChatState({
      enabled,
      turnedOnAt: offlineStore.offlineChatTurnedOnAt,
      canTakePart,
      messages: offlineStore.offlineChatMessages,
      nowMs: Date.now(),
    })
  }

  if (pathname === '/chat/messages' && method === 'GET') {
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (!canUserParticipateInChat(user, userMems)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only building apartment members and board members can participate in the building chat.',
      )
    }
    const enabled = Boolean(readSettingFromStore(offlineStore.offlineSettings, 'chat.enabled', false))
    if (!enabled) {
      throw makeOfflineError(409, 'CHAT_DISABLED', 'Building chat is currently turned off.')
    }
    const afterOutcome = validateChatAfterParam(urlObj.searchParams.get('after'))
    if (!afterOutcome.ok) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', afterOutcome.error.message, {
        errors: [afterOutcome.error],
      })
    }
    const limitOutcome = validateChatLimitParam(urlObj.searchParams.get('limit'))
    if (!limitOutcome.ok) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', limitOutcome.error.message, {
        errors: [limitOutcome.error],
      })
    }
    const nowMs = Date.now()
    offlineStore.offlineChatMessages = offlineStore.offlineChatMessages.filter((m) => Date.parse(m.expires_at) > nowMs)
    return buildMockChatPage({
      messages: offlineStore.offlineChatMessages,
      turnedOnAt: offlineStore.offlineChatTurnedOnAt,
      afterCursor: afterOutcome.value,
      limit: limitOutcome.value,
      callerUserId: user.user_id,
      nowMs,
    })
  }

  if (pathname === '/chat/messages' && method === 'POST') {
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (!canUserParticipateInChat(user, userMems)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only building apartment members and board members can participate in the building chat.',
      )
    }
    const enabled = Boolean(readSettingFromStore(offlineStore.offlineSettings, 'chat.enabled', false))
    if (!enabled) {
      throw makeOfflineError(409, 'CHAT_DISABLED', 'Building chat is currently turned off.')
    }
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const inputOutcome = validateChatMessageInput({
      payload: reqBody,
      user,
      memberships: userMems,
      maxLength: CHAT_MAX_LENGTH,
    })
    if (!inputOutcome.ok) {
      throw makeOfflineError(
        inputOutcome.status,
        inputOutcome.errorCode,
        inputOutcome.message,
        inputOutcome.errors ? { errors: inputOutcome.errors } : {},
      )
    }
    const nowMs = Date.now()
    const rateOutcome = evaluateChatRateLimit(
      offlineStore.offlineChatPostTimestampsByUser[user.user_id],
      nowMs,
    )
    if (!rateOutcome.ok) {
      offlineStore.offlineChatPostTimestampsByUser[user.user_id] = rateOutcome.pruned
      throw makeOfflineError(
        429,
        'RATE_LIMITED',
        'Too many messages sent. Please wait before sending again.',
        {
          retry_after_seconds: rateOutcome.retryAfterSeconds,
          reason: rateOutcome.reason,
        },
      )
    }
    offlineStore.offlineChatPostTimestampsByUser[user.user_id] = [...rateOutcome.pruned, nowMs]
    offlineStore.offlineChatMessages = offlineStore.offlineChatMessages.filter((m) => Date.parse(m.expires_at) > nowMs)
    const createdAtIso = new Date(nowMs).toISOString()
    const expiresAtIso = new Date(nowMs + CHAT_HISTORY_MS).toISOString()
    const storedMsg = {
      id: offlineStore.offlineChatNextId++,
      body: inputOutcome.body,
      author_badge: inputOutcome.badge,
      author_user_id: user.user_id,
      created_at: createdAtIso,
      expires_at: expiresAtIso,
    }
    offlineStore.offlineChatMessages.push(storedMsg)
    return {
      id: storedMsg.id,
      body: storedMsg.body,
      author_badge: storedMsg.author_badge,
      created_at: storedMsg.created_at,
      expires_at: storedMsg.expires_at,
      is_own: true,
    }
  }


  return UNHANDLED
}
