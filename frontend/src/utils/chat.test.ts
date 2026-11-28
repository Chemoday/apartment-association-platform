import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CHAT_MAX_AFTER_CURSOR,
  CHAT_POLL_HOT_MS,
  CHAT_POLL_IDLE_MS,
  CHAT_POLL_NORMAL_MS,
  CHAT_STATE_POLL_OFF_MS,
  CHAT_STATE_POLL_ON_MS,
  buildMockChatPage,
  buildMockChatState,
  canUserParticipateInChat,
  computeOpenChatPollDelayMs,
  computeStatePollDelayMs,
  evaluateChatRateLimit,
  mergeChatMessages,
  pruneExpiredChatMessages,
  resolveChatAuthorBadge,
  validateChatAfterParam,
  validateChatLimitParam,
  validateChatMessageInput,
} from './chat.js'

test('computeStatePollDelayMs returns 60s when enabled and 5m when disabled', () => {
  assert.equal(computeStatePollDelayMs(true), CHAT_STATE_POLL_ON_MS)
  assert.equal(computeStatePollDelayMs(false), CHAT_STATE_POLL_OFF_MS)
})

test('computeOpenChatPollDelayMs enforces 0ms hasMore, 3s hot window, 15s normal, 30s idle', () => {
  const t0 = 1_700_000_000_000

  assert.equal(
    computeOpenChatPollDelayMs({ nowMs: t0, lastMessageAtMs: t0 - 5_000, hasMore: true }),
    0,
  )

  // Within 60s of newest message -> 3s
  assert.equal(
    computeOpenChatPollDelayMs({ nowMs: t0, lastMessageAtMs: t0 - 59_999, openedAtMs: t0 - 120_000 }),
    CHAT_POLL_HOT_MS,
  )

  // After 60s -> 15s
  assert.equal(
    computeOpenChatPollDelayMs({ nowMs: t0, lastMessageAtMs: t0 - 60_000, openedAtMs: t0 - 120_000 }),
    CHAT_POLL_NORMAL_MS,
  )

  // After 5 quiet minutes without message or typing -> 30s
  assert.equal(
    computeOpenChatPollDelayMs({
      nowMs: t0,
      lastMessageAtMs: t0 - 300_000,
      lastTypingAtMs: t0 - 300_000,
      openedAtMs: t0 - 300_000,
    }),
    CHAT_POLL_IDLE_MS,
  )

  // Recent typing drops delay back to 15s even when last message was > 5 min ago
  assert.equal(
    computeOpenChatPollDelayMs({
      nowMs: t0,
      lastMessageAtMs: t0 - 360_000,
      lastTypingAtMs: t0 - 10_000,
      openedAtMs: t0 - 360_000,
    }),
    CHAT_POLL_NORMAL_MS,
  )
})

test('mergeChatMessages deduplicates by id and keeps oldest-first ordering', () => {
  const merged = mergeChatMessages(
    [
      { id: 10, body: 'first' },
      { id: 12, body: 'third' },
    ] as any[],
    [
      { id: 11, body: 'second' },
      { id: 12, body: 'third-updated' },
    ] as any[],
  )
  assert.deepEqual(
    merged.map((m) => [m.id, m.body]),
    [
      [10, 'first'],
      [11, 'second'],
      [12, 'third-updated'],
    ],
  )
})

test('pruneExpiredChatMessages drops expired entries and calculates nextExpiryMs', () => {
  const now = Date.parse('2026-11-15T10:00:00Z')
  const outcome = pruneExpiredChatMessages(
    [
      { id: 1, expires_at: '2026-11-15T09:59:59Z' },
      { id: 2, expires_at: '2026-11-15T10:00:00Z' },
      { id: 3, expires_at: '2026-11-15T10:30:00Z' },
      { id: 4, expires_at: '2026-11-15T10:15:00Z' },
    ] as any[],
    now,
  )
  assert.equal(outcome.removedCount, 2)
  assert.deepEqual(
    outcome.messages.map((m) => m.id),
    [3, 4],
  )
  assert.equal(outcome.nextExpiryMs, Date.parse('2026-11-15T10:15:00Z'))
})

test('validateChatAfterParam rejects non-integers and > 2^63-1 cursors', () => {
  assert.deepEqual(validateChatAfterParam(undefined), { ok: true, value: null })
  assert.deepEqual(validateChatAfterParam('0'), { ok: true, value: 0n })
  assert.deepEqual(validateChatAfterParam(CHAT_MAX_AFTER_CURSOR.toString()), {
    ok: true,
    value: CHAT_MAX_AFTER_CURSOR,
  })
  assert.equal(validateChatAfterParam('9223372036854775808').ok, false)
  assert.equal(validateChatAfterParam('-1').ok, false)
  assert.equal(validateChatAfterParam('abc').ok, false)

  assert.deepEqual(validateChatLimitParam(undefined), { ok: true, value: 100 })
  assert.equal(validateChatLimitParam('0').ok, false)
  assert.equal(validateChatLimitParam('201').ok, false)
})

test('canUserParticipateInChat excludes apartmentless accountants and parking/garage-only users (#066)', () => {
  assert.equal(canUserParticipateInChat({ building_role: 'ACCOUNTANT' }, []), false)
  assert.equal(
    canUserParticipateInChat({ building_role: 'ACCOUNTANT' }, [{ apartment_id: 'a1' }]),
    true,
  )
  assert.equal(canUserParticipateInChat({ building_role: 'CHAIRMAN' }, []), true)
  assert.equal(canUserParticipateInChat({ building_role: 'BOARD' }, []), true)
  assert.equal(canUserParticipateInChat({ building_role: 'USER' }, []), false)
  assert.equal(canUserParticipateInChat({ building_role: 'USER' }, [{ apartment_id: 'a2' }]), true)
  assert.equal(
    canUserParticipateInChat({ building_role: 'USER' }, [
      { apartment_id: 'g12', apartment_kind: 'GARAGE', relation_type: 'OWNER' },
    ]),
    false,
  )
  assert.equal(
    canUserParticipateInChat({ building_role: 'USER' }, [
      { apartment_id: 'p1', apartment_kind: 'PARKING', relation_type: 'TENANT' },
    ]),
    false,
  )
})

test('evaluateChatRateLimit enforces 10/min and 60/hour with longer wait winning', () => {
  const now = 1_700_000_000_000
  const okOutcome = evaluateChatRateLimit([now - 5_000, now - 10_000], now)
  assert.equal(okOutcome.ok, true)

  // 10 in last minute -> MINUTE_LIMIT
  const tenInMin = Array.from({ length: 10 }, (_, idx) => now - 20_000 + idx * 1000)
  const minBlocked = evaluateChatRateLimit(tenInMin, now)
  assert.equal(minBlocked.ok, false)
  if (!minBlocked.ok) {
    assert.equal(minBlocked.reason, 'MINUTE_LIMIT')
    assert.equal(minBlocked.retryAfterSeconds, 40)
  }

  // 60 in last hour (including 10 in last min where oldest hour msg expires in 1800s > 50s) -> HOUR_LIMIT
  const fiftyOlder = Array.from({ length: 50 }, (_, idx) => now - 1_800_000 + idx * 1000)
  const tenRecent = Array.from({ length: 10 }, (_, idx) => now - 50_000 + idx * 1000)
  const hourBlocked = evaluateChatRateLimit([...fiftyOlder, ...tenRecent], now)
  assert.equal(hourBlocked.ok, false)
  if (!hourBlocked.ok) {
    assert.equal(hourBlocked.reason, 'HOUR_LIMIT')
    assert.equal(hourBlocked.retryAfterSeconds, 1800)
  }
})

test('resolveChatAuthorBadge & validateChatMessageInput handle Chairman without apt and invalid apartment', () => {
  assert.deepEqual(resolveChatAuthorBadge({ building_role: 'CHAIRMAN' }, [], null), {
    ok: true,
    badge: { display_label: 'Chairman', role_badge: 'BOARD' },
  })
  assert.deepEqual(resolveChatAuthorBadge({ building_role: 'BOARD' }, [], undefined), {
    ok: true,
    badge: { display_label: 'Board', role_badge: 'BOARD' },
  })

  const mems = [
    {
      apartment_id: 'apt-14',
      apartment_number: '14',
      relation_type: 'OWNER',
      preview_badge: { display_label: 'Apt. 14', role_badge: 'OWNER' },
    },
  ]
  const badApt = validateChatMessageInput({
    payload: { body: 'Hello neighbours', author_apartment_id: 'apt-99' },
    user: { building_role: 'USER' },
    memberships: mems,
  })
  assert.equal(badApt.ok, false)
  if (!badApt.ok) {
    assert.equal(badApt.errorCode, 'INVALID_AUTHOR_APARTMENT')
  }

  const whitespaceOnly = validateChatMessageInput({
    payload: { body: '   \n  ' },
    user: { building_role: 'USER' },
    memberships: mems,
  })
  assert.equal(whitespaceOnly.ok, false)

  const ok = validateChatMessageInput({
    payload: { body: '  Water shutoff at 14:00  ', author_apartment_id: 'apt-14' },
    user: { building_role: 'USER' },
    memberships: mems,
  })
  assert.deepEqual(ok, {
    ok: true,
    body: 'Water shutoff at 14:00',
    badge: { display_label: 'Apt. 14', role_badge: 'OWNER' },
  })
})

test('buildMockChatState and buildMockChatPage enforce epoch, expiry, and cursor semantics', () => {
  const now = Date.parse('2026-11-15T10:00:00Z')
  const turnedOnAt = '2026-11-15T09:30:00Z'
  const msgs = [
    {
      id: 1,
      body: 'before toggle',
      author_user_id: 'u1',
      author_badge: { display_label: 'Apt. 1', role_badge: 'OWNER' },
      created_at: '2026-11-15T09:20:00Z',
      expires_at: '2026-11-15T11:20:00Z',
    },
    {
      id: 2,
      body: 'older valid',
      author_user_id: 'u2',
      author_badge: { display_label: 'Apt. 2', role_badge: 'OWNER' },
      created_at: '2026-11-15T09:40:00Z',
      expires_at: '2026-11-15T11:40:00Z',
    },
    {
      id: 3,
      body: 'recent own',
      author_user_id: 'u1',
      author_badge: { display_label: 'Apt. 1', role_badge: 'OWNER' },
      created_at: '2026-11-15T09:55:00Z',
      expires_at: '2026-11-15T11:55:00Z',
    },
  ]

  const state = buildMockChatState({
    enabled: true,
    turnedOnAt,
    canTakePart: true,
    messages: msgs,
    nowMs: now,
  })
  assert.equal(state.recent_count, 1)
  assert.equal(state.last_message_at, '2026-11-15T09:55:00Z')

  const nonParticipantState = buildMockChatState({
    enabled: true,
    turnedOnAt,
    canTakePart: false,
    messages: msgs,
    nowMs: now,
  })
  assert.equal(nonParticipantState.recent_count, 0)
  assert.equal(nonParticipantState.last_message_at, null)

  const page1 = buildMockChatPage({
    messages: msgs,
    turnedOnAt,
    afterCursor: null,
    limit: 100,
    callerUserId: 'u1',
    nowMs: now,
  })
  assert.deepEqual(
    page1.messages.map((m) => [m.id, m.is_own]),
    [
      [2, false],
      [3, true],
    ],
  )
  assert.equal(page1.cursor, 3)

  const page2 = buildMockChatPage({
    messages: msgs,
    turnedOnAt,
    afterCursor: 2n,
    limit: 1,
    callerUserId: 'u1',
    nowMs: now,
  })
  assert.equal(page2.messages.length, 1)
  assert.equal(page2.has_more, false)

  // Int64 (> 2^53 - 1) IDs retain exact ordering and has_more pagination works across pages
  const bigMsgs = [
    {
      id: '9007199254740993' as any,
      body: 'msg-b',
      author_user_id: 'u1',
      author_badge: { display_label: 'Apt. 1', role_badge: 'OWNER' },
      created_at: '2026-11-15T09:50:00Z',
      expires_at: '2026-11-15T11:50:00Z',
    },
    {
      id: '9007199254740992' as any,
      body: 'msg-a',
      author_user_id: 'u2',
      author_badge: { display_label: 'Apt. 2', role_badge: 'OWNER' },
      created_at: '2026-11-15T09:45:00Z',
      expires_at: '2026-11-15T11:45:00Z',
    },
    {
      id: '9007199254740994' as any,
      body: 'msg-c',
      author_user_id: 'u3',
      author_badge: { display_label: 'Apt. 3', role_badge: 'OWNER' },
      created_at: '2026-11-15T09:55:00Z',
      expires_at: '2026-11-15T11:55:00Z',
    },
  ]
  const bigMerged = mergeChatMessages([bigMsgs[0]] as any[], [bigMsgs[1], bigMsgs[2]] as any[])
  assert.deepEqual(
    bigMerged.map((m) => m.id),
    ['9007199254740992', '9007199254740993', '9007199254740994'],
  )

  const bigPage = buildMockChatPage({
    messages: bigMsgs,
    turnedOnAt,
    afterCursor: 9007199254740992n,
    limit: 1,
    callerUserId: 'u1',
    nowMs: now,
  })
  assert.equal(bigPage.has_more, true)
  assert.deepEqual(
    bigPage.messages.map((m) => m.id),
    ['9007199254740993'],
  )

  // Empty string author_apartment_id must be rejected instead of falling back to first membership
  const emptyAptRes = validateChatMessageInput({
    payload: { body: 'Explicit empty apt', author_apartment_id: '' },
    user: { building_role: 'USER' },
    memberships: [
      {
        apartment_id: 'apt-14',
        apartment_number: '14',
        relation_type: 'OWNER',
      },
    ],
  })
  assert.equal(emptyAptRes.ok, false)
  if (!emptyAptRes.ok) {
    assert.equal(emptyAptRes.errorCode, 'INVALID_AUTHOR_APARTMENT')
  }
})

