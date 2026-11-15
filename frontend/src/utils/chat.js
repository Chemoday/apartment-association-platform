/**
 * Pure domain, polling schedule, expiry pruning, and mock backend helpers for Building Chat (#033).
 * Contract: docs/API.md section 14 & docs/FRONTEND_GUIDE.md section 20.
 */

export const CHAT_STATE_POLL_ON_MS = 60_000
export const CHAT_STATE_POLL_OFF_MS = 300_000

export const CHAT_POLL_HOT_MS = 3_000
export const CHAT_POLL_NORMAL_MS = 15_000
export const CHAT_POLL_IDLE_MS = 30_000
export const CHAT_HOT_WINDOW_MS = 60_000
export const CHAT_IDLE_WINDOW_MS = 300_000

export const CHAT_HISTORY_HOURS = 2
export const CHAT_HISTORY_MS = CHAT_HISTORY_HOURS * 3_600_000
export const CHAT_RECENT_MINUTES = 10
export const CHAT_RECENT_MS = CHAT_RECENT_MINUTES * 60_000
export const CHAT_MAX_LENGTH = 500
export const CHAT_RATE_LIMIT_MINUTE = 10
export const CHAT_RATE_LIMIT_HOUR = 60
export const CHAT_MAX_AFTER_CURSOR = 9223372036854775807n

/**
 * Compute adaptive poll delay for `GET /api/v1/chat` indicator polling.
 * 60 s while chat is enabled, 5 min (300 s) while disabled.
 * @param {boolean} enabled
 * @returns {number}
 */
export function computeStatePollDelayMs(enabled) {
  return enabled ? CHAT_STATE_POLL_ON_MS : CHAT_STATE_POLL_OFF_MS
}

/**
 * Compute adaptive poll delay for open `/chat` (`GET /api/v1/chat/messages`).
 * - Immediately (`0 ms`) while `hasMore` is true.
 * - `3_000 ms` only during the 60 s after the newest message.
 * - `15_000 ms` otherwise.
 * - `30_000 ms` after 5 quiet minutes without a new message AND without typing.
 * @param {{ nowMs: number, lastMessageAtMs?: number | null, lastTypingAtMs?: number | null, openedAtMs?: number | null, hasMore?: boolean }} params
 * @returns {number}
 */
export function computeOpenChatPollDelayMs({
  nowMs,
  lastMessageAtMs = null,
  lastTypingAtMs = null,
  openedAtMs = null,
  hasMore = false,
}) {
  if (hasMore) return 0

  if (typeof lastMessageAtMs === 'number' && Number.isFinite(lastMessageAtMs)) {
    const sinceLastMsg = Math.max(0, nowMs - lastMessageAtMs)
    if (sinceLastMsg < CHAT_HOT_WINDOW_MS) {
      return CHAT_POLL_HOT_MS
    }
  }

  const lastActivityMs = Math.max(
    typeof lastMessageAtMs === 'number' && Number.isFinite(lastMessageAtMs) ? lastMessageAtMs : 0,
    typeof lastTypingAtMs === 'number' && Number.isFinite(lastTypingAtMs) ? lastTypingAtMs : 0,
    typeof openedAtMs === 'number' && Number.isFinite(openedAtMs) ? openedAtMs : 0,
  )

  if (lastActivityMs > 0 && nowMs - lastActivityMs >= CHAT_IDLE_WINDOW_MS) {
    return CHAT_POLL_IDLE_MS
  }

  return CHAT_POLL_NORMAL_MS
}

function compareChatIds(aId, bId) {
  try {
    const a = BigInt(aId)
    const b = BigInt(bId)
    return a < b ? -1 : a > b ? 1 : 0
  } catch {
    return Number(aId) - Number(bId)
  }
}

/**
 * Merge incoming chat messages with existing messages, deduplicating by integer `id`
 * and sorting ascending by `id` (oldest first).
 * @param {Array<import('../api/schema').ChatMessageView>} existing
 * @param {Array<import('../api/schema').ChatMessageView>} incoming
 * @returns {Array<import('../api/schema').ChatMessageView>}
 */
export function mergeChatMessages(existing, incoming) {
  const byId = new Map()
  for (const msg of Array.isArray(existing) ? existing : []) {
    if (msg && msg.id !== undefined && msg.id !== null) {
      byId.set(msg.id, msg)
    }
  }
  for (const msg of Array.isArray(incoming) ? incoming : []) {
    if (msg && msg.id !== undefined && msg.id !== null) {
      byId.set(msg.id, msg)
    }
  }
  return Array.from(byId.values()).sort((a, b) => compareChatIds(a.id, b.id))
}

/**
 * Drop expired messages (`expires_at <= nowMs`) and compute milliseconds until next expiry.
 * @param {Array<import('../api/schema').ChatMessageView>} messages
 * @param {number} nowMs
 * @returns {{ messages: Array<import('../api/schema').ChatMessageView>, removedCount: number, nextExpiryMs: number | null }}
 */
export function pruneExpiredChatMessages(messages, nowMs) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: [], removedCount: 0, nextExpiryMs: null }
  }
  const kept = []
  let removedCount = 0
  let nextExpiryMs = null

  for (const msg of messages) {
    const expMs = Date.parse(msg?.expires_at || '')
    if (!Number.isFinite(expMs) || expMs <= nowMs) {
      removedCount += 1
      continue
    }
    kept.push(msg)
    if (nextExpiryMs === null || expMs < nextExpiryMs) {
      nextExpiryMs = expMs
    }
  }

  return { messages: kept, removedCount, nextExpiryMs }
}

/**
 * Whether user participates in building chat (any active apartment member, CHAIRMAN, or BOARD).
 * @param {{ building_role?: string } | null | undefined} user
 * @param {Array<any> | null | undefined} memberships
 * @returns {boolean}
 */
export function canUserParticipateInChat(user, memberships) {
  if (!user) return false
  if (user.building_role === 'CHAIRMAN' || user.building_role === 'BOARD') {
    return true
  }
  return Array.isArray(memberships) && memberships.length > 0
}

/**
 * Parse and validate `?after` cursor for `GET /api/v1/chat/messages`.
 * Must be a non-negative integer <= 2^63 - 1.
 * @param {string | number | null | undefined} rawAfter
 * @returns {{ ok: true, value: bigint | null } | { ok: false, error: { loc: string[], message: string, type: string } }}
 */
export function validateChatAfterParam(rawAfter) {
  if (rawAfter === undefined || rawAfter === null || rawAfter === '') {
    return { ok: true, value: null }
  }
  const str = String(rawAfter).trim()
  if (!/^(0|[1-9][0-9]*)$/.test(str)) {
    return {
      ok: false,
      error: {
        loc: ['query', 'after'],
        message: 'Cursor must be a non-negative integer.',
        type: 'type_error.integer',
      },
    }
  }
  let parsed
  try {
    parsed = BigInt(str)
  } catch {
    return {
      ok: false,
      error: {
        loc: ['query', 'after'],
        message: 'Invalid cursor.',
        type: 'value_error.integer',
      },
    }
  }
  if (parsed < 0n || parsed > CHAT_MAX_AFTER_CURSOR) {
    return {
      ok: false,
      error: {
        loc: ['query', 'after'],
        message: 'Cursor is out of allowed 64-bit signed integer range.',
        type: 'value_error.number.not_in_range',
      },
    }
  }
  return { ok: true, value: parsed }
}

/**
 * Parse and validate `?limit` query parameter (`1..200`, default `100`).
 * @param {string | number | null | undefined} rawLimit
 * @returns {{ ok: true, value: number } | { ok: false, error: { loc: string[], message: string, type: string } }}
 */
export function validateChatLimitParam(rawLimit) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === '') {
    return { ok: true, value: 100 }
  }
  const str = String(rawLimit).trim()
  if (!/^[0-9]+$/.test(str)) {
    return {
      ok: false,
      error: {
        loc: ['query', 'limit'],
        message: 'Limit must be an integer between 1 and 200.',
        type: 'type_error.integer',
      },
    }
  }
  const num = Number(str)
  if (!Number.isInteger(num) || num < 1 || num > 200) {
    return {
      ok: false,
      error: {
        loc: ['query', 'limit'],
        message: 'Limit must be between 1 and 200.',
        type: 'value_error.number.not_in_range',
      },
    }
  }
  return { ok: true, value: num }
}

/**
 * Evaluate per-user rate limit (10/min and 60/hour). When both are exceeded, returns the longer wait.
 * Does NOT mutate timestamps; call after check passes to record `nowMs`.
 * @param {number[]} timestampsMs
 * @param {number} nowMs
 * @returns {{ ok: true, pruned: number[] } | { ok: false, retryAfterSeconds: number, reason: 'MINUTE_LIMIT' | 'HOUR_LIMIT', pruned: number[] }}
 */
export function evaluateChatRateLimit(timestampsMs, nowMs) {
  const hourCutoff = nowMs - 3_600_000
  const minCutoff = nowMs - 60_000
  const pruned = (Array.isArray(timestampsMs) ? timestampsMs : [])
    .filter((ts) => Number.isFinite(ts) && ts > hourCutoff && ts <= nowMs)
    .sort((a, b) => a - b)

  const inMinute = pruned.filter((ts) => ts > minCutoff)
  let minuteWait = 0
  if (inMinute.length >= CHAT_RATE_LIMIT_MINUTE) {
    minuteWait = Math.max(1, Math.ceil((inMinute[0] + 60_000 - nowMs) / 1000))
  }

  let hourWait = 0
  if (pruned.length >= CHAT_RATE_LIMIT_HOUR) {
    hourWait = Math.max(1, Math.ceil((pruned[0] + 3_600_000 - nowMs) / 1000))
  }

  if (minuteWait > 0 || hourWait > 0) {
    if (hourWait >= minuteWait && hourWait > 0) {
      return {
        ok: false,
        retryAfterSeconds: hourWait,
        reason: 'HOUR_LIMIT',
        pruned,
      }
    }
    return {
      ok: false,
      retryAfterSeconds: minuteWait,
      reason: 'MINUTE_LIMIT',
      pruned,
    }
  }

  return { ok: true, pruned }
}

/**
 * Build `GET /api/v1/chat` state payload from store values.
 */
export function buildMockChatState({ enabled, turnedOnAt, canTakePart, messages, nowMs }) {
  if (!enabled) {
    return {
      enabled: false,
      turned_on_at: null,
      can_take_part: canTakePart,
      recent_count: 0,
      recent_minutes: CHAT_RECENT_MINUTES,
      last_message_at: null,
      history_hours: CHAT_HISTORY_HOURS,
      max_length: CHAT_MAX_LENGTH,
    }
  }
  if (!canTakePart) {
    return {
      enabled: true,
      turned_on_at: turnedOnAt || null,
      can_take_part: false,
      recent_count: 0,
      recent_minutes: CHAT_RECENT_MINUTES,
      last_message_at: null,
      history_hours: CHAT_HISTORY_HOURS,
      max_length: CHAT_MAX_LENGTH,
    }
  }

  const turnedOnMs = turnedOnAt ? Date.parse(turnedOnAt) : null
  const recentCutoff = nowMs - CHAT_RECENT_MS
  const live = (Array.isArray(messages) ? messages : []).filter((m) => {
    const expMs = Date.parse(m.expires_at)
    const createdMs = Date.parse(m.created_at)
    if (!Number.isFinite(expMs) || expMs <= nowMs) return false
    if (turnedOnMs !== null && Number.isFinite(turnedOnMs) && createdMs < turnedOnMs) return false
    return true
  })

  let recentCount = 0
  let lastCreatedMs = null
  let lastCreatedIso = null
  for (const m of live) {
    const createdMs = Date.parse(m.created_at)
    if (createdMs > recentCutoff) {
      recentCount += 1
    }
    if (lastCreatedMs === null || createdMs >= lastCreatedMs) {
      lastCreatedMs = createdMs
      lastCreatedIso = m.created_at
    }
  }

  return {
    enabled: true,
    turned_on_at: turnedOnAt || null,
    can_take_part: true,
    recent_count: recentCount,
    recent_minutes: CHAT_RECENT_MINUTES,
    last_message_at: lastCreatedIso,
    history_hours: CHAT_HISTORY_HOURS,
    max_length: CHAT_MAX_LENGTH,
  }
}

/**
 * Build `GET /api/v1/chat/messages` page payload from store values.
 */
export function buildMockChatPage({
  messages,
  turnedOnAt,
  afterCursor,
  limit,
  callerUserId,
  nowMs,
}) {
  const turnedOnMs = turnedOnAt ? Date.parse(turnedOnAt) : null
  const live = (Array.isArray(messages) ? messages : [])
    .filter((m) => {
      const expMs = Date.parse(m.expires_at)
      const createdMs = Date.parse(m.created_at)
      if (!Number.isFinite(expMs) || expMs <= nowMs) return false
      if (turnedOnMs !== null && Number.isFinite(turnedOnMs) && createdMs < turnedOnMs) return false
      return true
    })
    .sort((a, b) => compareChatIds(a.id, b.id))

  let selected = []
  let hasMore = false
  let cursor = null

  if (afterCursor !== null) {
    const newer = live.filter((m) => BigInt(m.id) > afterCursor)
    hasMore = newer.length > limit
    selected = newer.slice(0, limit)
    cursor = selected.length > 0 ? selected[selected.length - 1].id : Number(afterCursor)
  } else {
    selected = live.slice(-limit)
    hasMore = false
    cursor = selected.length > 0 ? selected[selected.length - 1].id : null
  }

  return {
    messages: selected.map((m) => ({
      id: m.id,
      body: m.body,
      author_badge: m.author_badge,
      created_at: m.created_at,
      expires_at: m.expires_at,
      is_own: m.author_user_id === callerUserId,
    })),
    cursor,
    has_more: hasMore,
    turned_on_at: turnedOnAt || null,
  }
}

const CHAT_CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/**
 * Resolve `AuthorBadgeDTO` for a mock chat post (`author_apartment_id` or fallback to first
 * membership or Chairman/Board when staff has no apartment).
 * @param {{ building_role?: string, full_name?: string }} user
 * @param {Array<any>} memberships
 * @param {string | null | undefined} authorApartmentId
 * @returns {{ ok: true, badge: { display_label: string, role_badge: string } } | { ok: false }}
 */
export function resolveChatAuthorBadge(user, memberships, authorApartmentId) {
  const mems = Array.isArray(memberships) ? memberships : []
  let targetMem = null
  if (authorApartmentId !== undefined && authorApartmentId !== null) {
    if (typeof authorApartmentId !== 'string' || authorApartmentId === '') {
      return { ok: false }
    }
    targetMem = mems.find((m) => m.apartment_id === authorApartmentId) || null
    if (!targetMem) {
      return { ok: false }
    }
  } else {
    targetMem = mems[0] || null
  }

  if (targetMem) {
    if (targetMem.preview_badge) {
      return { ok: true, badge: { ...targetMem.preview_badge } }
    }
    const roleBadge =
      user?.building_role === 'CHAIRMAN' || user?.building_role === 'BOARD'
        ? 'BOARD'
        : targetMem.relation_type === 'OWNER'
          ? 'OWNER'
          : 'RESIDENT'
    return {
      ok: true,
      badge: {
        display_label: `Apt. ${targetMem.apartment_number}`,
        role_badge: roleBadge,
      },
    }
  }

  if (user?.building_role === 'CHAIRMAN' || user?.building_role === 'BOARD') {
    return {
      ok: true,
      badge: {
        display_label: user.building_role === 'CHAIRMAN' ? 'Chairman' : 'Board',
        role_badge: 'BOARD',
      },
    }
  }

  return { ok: false }
}

/**
 * Validate `POST /api/v1/chat/messages` body and `author_apartment_id`.
 * Assumes participant & chat-enabled checks already passed.
 * @param {{ payload: any, user: { building_role?: string, full_name?: string }, memberships: Array<any>, maxLength?: number }} params
 * @returns {{ ok: true, body: string, badge: { display_label: string, role_badge: string } } | { ok: false, status: number, errorCode: string, message: string, errors?: Array<{ loc: string[], message: string, type: string }> }}
 */
export function validateChatMessageInput({ payload, user, memberships, maxLength = CHAT_MAX_LENGTH }) {
  const rawBody = payload?.body
  if (typeof rawBody !== 'string') {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Message body must be a string.',
      errors: [{ loc: ['body', 'body'], message: 'Message body is required.', type: 'type_error.str' }],
    }
  }
  if (CHAT_CONTROL_CHAR_RE.test(rawBody)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Message contains invalid control characters.',
      errors: [
        {
          loc: ['body', 'body'],
          message: 'Message contains invalid control characters.',
          type: 'value_error.control_chars',
        },
      ],
    }
  }
  const trimmed = rawBody.trim()
  if (trimmed.length < 1 || trimmed.length > maxLength) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `Message must be between 1 and ${maxLength} characters.`,
      errors: [
        {
          loc: ['body', 'body'],
          message: `Message must be between 1 and ${maxLength} characters.`,
          type: 'value_error.any_str.length',
        },
      ],
    }
  }

  const badgeOutcome = resolveChatAuthorBadge(user, memberships, payload?.author_apartment_id)
  if (!badgeOutcome.ok) {
    return {
      ok: false,
      status: 422,
      errorCode: 'INVALID_AUTHOR_APARTMENT',
      message: 'Selected apartment is not linked to your membership.',
    }
  }

  return { ok: true, body: trimmed, badge: badgeOutcome.badge }
}

