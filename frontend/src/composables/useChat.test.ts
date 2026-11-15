import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, reactive } from 'vue'
import { useChat } from './useChat.js'

function installFakeDocument(initialState = 'visible') {
  const prevDoc = (globalThis as any).document
  const listeners = new Map<string, Set<() => void>>()
  const fakeDoc = {
    visibilityState: initialState,
    addEventListener(event: string, fn: () => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(fn)
    },
    removeEventListener(event: string, fn: () => void) {
      listeners.get(event)?.delete(fn)
    },
    setVisibility(nextState: 'visible' | 'hidden') {
      fakeDoc.visibilityState = nextState
      for (const fn of listeners.get('visibilitychange') || []) {
        fn()
      }
    },
  }
  ;(globalThis as any).document = fakeDoc
  return {
    fakeDoc,
    restore() {
      if (prevDoc === undefined) {
        delete (globalThis as any).document
      } else {
        ;(globalThis as any).document = prevDoc
      }
    },
  }
}

async function flushMicrotasks(count = 6) {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

test('useChat polling cadence: 3s hot, 15s normal, 30s idle, notifyTyping tightens, 0ms has_more', async (t) => {
  const docEnv = installFakeDocument('visible')
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const baseNow = Date.parse('2026-11-15T10:00:00Z')
  t.mock.timers.setTime(baseNow)

  try {
    const session = reactive({
      authMode: 'demo',
      backendOffline: false,
      actingUserId: 'user-1',
      sessionRevision: 1,
    })

    const fetchCalls: Array<{ after?: unknown }> = []
    let pagesQueue: Array<any> = [
      {
        messages: [
          {
            id: 100,
            body: 'Has anyone checked basement?',
            author_badge: { display_label: 'Apt. 1', role_badge: 'BOARD' },
            created_at: new Date(baseNow - 10_000).toISOString(),
            expires_at: new Date(baseNow + 7_190_000).toISOString(),
            is_own: false,
          },
        ],
        cursor: 100,
        has_more: true,
        turned_on_at: '2026-11-15T09:00:00Z',
      },
      {
        messages: [
          {
            id: 101,
            body: 'Omw down now',
            author_badge: { display_label: 'Apt. 14', role_badge: 'OWNER' },
            created_at: new Date(baseNow - 2_000).toISOString(),
            expires_at: new Date(baseNow + 7_198_000).toISOString(),
            is_own: false,
          },
        ],
        cursor: 101,
        has_more: false,
        turned_on_at: '2026-11-15T09:00:00Z',
      },
    ]

    const chat = useChat({
      autoLifecycle: false,
      session,
      nowFn: () => Date.now(),
      onDisabled: () => {},
      onForbidden: () => {},
      onPageSync: () => {},
      fetchMessagesFn: async (params: any) => {
        fetchCalls.push({ after: params.after })
        if (pagesQueue.length > 0) {
          return pagesQueue.shift()
        }
        return {
          messages: [],
          cursor: 101,
          has_more: false,
          turned_on_at: '2026-11-15T09:00:00Z',
        }
      },
    })

    chat.start()
    await flushMicrotasks()

    // Initial request omits `after`; has_more=true fires 2nd request at 0ms with after=100
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].after, undefined)

    t.mock.timers.tick(0)
    await flushMicrotasks()
    assert.equal(fetchCalls.length, 2)
    assert.equal(fetchCalls[1].after, 100)
    assert.equal(chat.messages.value.length, 2)

    // Hot window: newest message is 2s old -> poll at 3s
    t.mock.timers.tick(2_999)
    await flushMicrotasks()
    assert.equal(fetchCalls.length, 2)
    t.mock.timers.tick(1)
    await flushMicrotasks()
    assert.equal(fetchCalls.length, 3)

    // Advance past 60s hot window -> 15s normal polling applies
    t.mock.timers.tick(65_000)
    await flushMicrotasks()
    const countAfterHot = fetchCalls.length
    t.mock.timers.tick(14_999)
    await flushMicrotasks()
    assert.equal(fetchCalls.length, countAfterHot)
    t.mock.timers.tick(1)
    await flushMicrotasks()
    assert.equal(fetchCalls.length, countAfterHot + 1)

    // Advance 5 quiet minutes -> 30s idle polling
    t.mock.timers.tick(300_000)
    await flushMicrotasks()
    const countAtIdle = fetchCalls.length
    t.mock.timers.tick(15_000)
    await flushMicrotasks()
    assert.equal(fetchCalls.length, countAtIdle, 'Should stay idle beyond 15s when quiet for 5 min')
    t.mock.timers.tick(15_000)
    await flushMicrotasks()
    assert.equal(fetchCalls.length, countAtIdle + 1, 'Should poll at 30s when quiet for 5 min')

    // User typing tightens timer back to 15s window without immediate poll
    chat.notifyTyping()
    await flushMicrotasks()
    assert.equal(fetchCalls.length, countAtIdle + 1)
    t.mock.timers.tick(15_000)
    await flushMicrotasks()
    assert.equal(fetchCalls.length, countAtIdle + 2)

    chat.stop()
  } finally {
    t.mock.timers.reset()
    docEnv.restore()
  }
})

test('useChat single-flight concurrency, hidden tab pause, and POST without extra GET or cursor advance', async (t) => {
  const docEnv = installFakeDocument('visible')
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const baseNow = Date.parse('2026-11-15T10:00:00Z')
  t.mock.timers.setTime(baseNow)

  try {
    const session = reactive({
      authMode: 'demo',
      backendOffline: false,
      actingUserId: 'user-1',
      sessionRevision: 1,
    })

    let getCount = 0
    const afterArgs: unknown[] = []
    let resolveDelayedGet: ((val: any) => void) | null = null

    const chat = useChat({
      autoLifecycle: false,
      session,
      nowFn: () => Date.now(),
      onDisabled: () => {},
      onForbidden: () => {},
      onPageSync: () => {},
      fetchMessagesFn: async (params: any) => {
        getCount += 1
        afterArgs.push(params.after)
        if (getCount === 1) {
          return {
            messages: [
              {
                id: 50,
                body: 'Initial',
                author_badge: { display_label: 'Apt. 2', role_badge: 'RESIDENT' },
                created_at: new Date(baseNow - 1_000).toISOString(),
                expires_at: new Date(baseNow + 7_199_000).toISOString(),
                is_own: false,
              },
            ],
            cursor: 50,
            has_more: false,
            turned_on_at: '2026-11-15T09:00:00Z',
          }
        }
        return new Promise((resolve) => {
          resolveDelayedGet = resolve
        })
      },
      sendMessageFn: async ({ body }: { body: string }) => ({
        id: 52, // note gap: 51 arrived on server concurrently
        body,
        author_badge: { display_label: 'Apt. 14', role_badge: 'OWNER' },
        created_at: new Date(Date.now()).toISOString(),
        expires_at: new Date(Date.now() + 7_200_000).toISOString(),
        is_own: true,
      }),
    })

    chat.start()
    await flushMicrotasks()
    assert.equal(getCount, 1)

    // Send message -> returns 201 ChatMessageView, appends locally, NO extra GET fired, cursor remains 50!
    const postRes = await chat.sendMessage({ body: 'My reply' })
    await flushMicrotasks()
    assert.equal(postRes.ok, true)
    assert.equal(getCount, 1, 'POST must not trigger an extra GET poll')
    assert.equal(chat.cursor.value, 50, 'Cursor must not skip parallel message #51')
    assert.deepEqual(
      chat.messages.value.map((m: any) => m.id),
      [50, 52],
    )

    // Tick 3s to start delayed 2nd GET; while in-flight, even reload/visibility cannot overlap
    t.mock.timers.tick(3_000)
    await flushMicrotasks()
    assert.equal(getCount, 2)
    assert.equal(afterArgs[1], 50)

    // Simulate slow network well beyond 3s: single-flight guard prevents a 3rd GET while 2nd is running
    t.mock.timers.tick(10_000)
    await flushMicrotasks()
    assert.equal(getCount, 2)

    // Finish delayed GET with message #51 -> merges cleanly in id order [50, 51, 52]
    resolveDelayedGet!({
      messages: [
        {
          id: 51,
          body: 'Parallel neighbour msg',
          author_badge: { display_label: 'Apt. 3', role_badge: 'OWNER' },
          created_at: new Date(Date.now()).toISOString(),
          expires_at: new Date(Date.now() + 7_200_000).toISOString(),
          is_own: false,
        },
      ],
      cursor: 51,
      has_more: false,
      turned_on_at: '2026-11-15T09:00:00Z',
    })
    await flushMicrotasks()
    assert.deepEqual(
      chat.messages.value.map((m: any) => m.id),
      [50, 51, 52],
    )

    // Hidden tab stops polling; visible triggers exactly one poll on return
    const countBeforeHide = getCount
    docEnv.fakeDoc.setVisibility('hidden')
    t.mock.timers.tick(60_000)
    await flushMicrotasks()
    assert.equal(getCount, countBeforeHide)

    docEnv.fakeDoc.setVisibility('visible')
    await flushMicrotasks()
    assert.equal(getCount, countBeforeHide + 1)

    chat.stop()
  } finally {
    t.mock.timers.reset()
    docEnv.restore()
  }
})

test('useChat handles turned_on_at epoch change, client expiry pruning, 429 cooldown, and 409 disable', async (t) => {
  const docEnv = installFakeDocument('visible')
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const baseNow = Date.parse('2026-11-15T10:00:00Z')
  t.mock.timers.setTime(baseNow)

  try {
    const session = reactive({
      authMode: 'demo',
      backendOffline: false,
      actingUserId: 'user-1',
      sessionRevision: 1,
    })

    let disabledCallbacks = 0
    let step = 0
    const fetchCalls: Array<{ after?: unknown }> = []

    const chat = useChat({
      autoLifecycle: false,
      session,
      nowFn: () => Date.now(),
      onDisabled: () => {
        disabledCallbacks += 1
      },
      onForbidden: () => {},
      onPageSync: () => {},
      fetchMessagesFn: async (params: any) => {
        fetchCalls.push({ after: params.after })
        step += 1
        if (step === 1) {
          return {
            messages: [
              {
                id: 10,
                body: 'Soon expiring',
                author_badge: { display_label: 'Apt. 5', role_badge: 'OWNER' },
                created_at: new Date(baseNow - 30_000).toISOString(),
                expires_at: new Date(baseNow + 2_000).toISOString(),
                is_own: false,
              },
              {
                id: 11,
                body: 'Longer lived',
                author_badge: { display_label: 'Apt. 6', role_badge: 'OWNER' },
                created_at: new Date(baseNow - 5_000).toISOString(),
                expires_at: new Date(baseNow + 7_195_000).toISOString(),
                is_own: false,
              },
            ],
            cursor: 11,
            has_more: false,
            turned_on_at: '2026-11-15T09:00:00Z',
          }
        }
        if (step === 2) {
          // Chairman toggled off/on between polls: turned_on_at changed!
          return {
            messages: [],
            cursor: 11,
            has_more: false,
            turned_on_at: '2026-11-15T10:00:02Z',
          }
        }
        if (step === 3) {
          return {
            messages: [],
            cursor: null,
            has_more: false,
            turned_on_at: '2026-11-15T10:00:02Z',
          }
        }
        const err: any = new Error('Disabled')
        err.status = 409
        err.errorCode = 'CHAT_DISABLED'
        throw err
      },
      sendMessageFn: async () => {
        const err: any = new Error('Too fast')
        err.status = 429
        err.errorCode = 'RATE_LIMITED'
        err.payload = { error_code: 'RATE_LIMITED', retry_after_seconds: 3, reason: 'MINUTE_LIMIT' }
        throw err
      },
    })

    chat.start()
    await flushMicrotasks()
    assert.equal(chat.messages.value.length, 2)

    // Advance 2.1s -> msg #10 expires client-side before poll #2 fires
    t.mock.timers.tick(2_100)
    await flushMicrotasks()
    assert.deepEqual(
      chat.messages.value.map((m: any) => m.id),
      [11],
    )

    // Poll #2 at 3s returns new turned_on_at -> clears screen and immediately restarts without `after`
    t.mock.timers.tick(900)
    await flushMicrotasks()
    t.mock.timers.tick(0)
    await flushMicrotasks()
    assert.equal(chat.messages.value.length, 0)
    assert.equal(fetchCalls.length, 3)
    assert.equal(fetchCalls[2].after, undefined, 'Reset after turned_on_at change must omit after')

    // Send hits 429 RATE_LIMITED -> cooldownSeconds counts down 3 -> 0
    const rateRes = await chat.sendMessage({ body: 'spam' })
    assert.equal(rateRes.rateLimited, true)
    assert.equal(chat.cooldownSeconds.value, 3)
    t.mock.timers.tick(3_000)
    await flushMicrotasks()
    assert.equal(chat.cooldownSeconds.value, 0)

    // Next normal poll hits 409 CHAT_DISABLED -> marks disabled, clears messages, calls onDisabled
    t.mock.timers.tick(15_000)
    await flushMicrotasks()
    assert.equal(chat.disabled.value, true)
    assert.equal(disabledCallbacks, 1)
    assert.equal(chat.messages.value.length, 0)

    chat.stop()
  } finally {
    t.mock.timers.reset()
    docEnv.restore()
  }
})

test('useChat handles rapid hidden->visible pollSeq race, full sendError object, and 403/500 load errors', async (t) => {
  const docEnv = installFakeDocument('visible')
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const baseNow = Date.parse('2026-11-15T10:00:00Z')
  t.mock.timers.setTime(baseNow)

  try {
    const session = reactive({
      authMode: 'demo',
      backendOffline: false,
      actingUserId: 'user-1',
      sessionRevision: 1,
    })

    // 1. P1-1 race: slow initial GET aborted on hidden, rapid bounce to visible starts 2nd GET;
    //    old 1st GET resolving/rejecting later must NOT clear initialLoading or pollInFlight.
    const resolvers: Array<{ resolve: (v: any) => void; reject: (e: any) => void }> = []
    let activeFetches = 0
    let maxParallelFetches = 0
    let fetchCount = 0

    const chat = useChat({
      autoLifecycle: false,
      session,
      nowFn: () => Date.now(),
      onDisabled: () => {},
      onForbidden: () => {},
      onPageSync: () => {},
      fetchMessagesFn: async () => {
        fetchCount += 1
        activeFetches += 1
        maxParallelFetches = Math.max(maxParallelFetches, activeFetches)
        return new Promise((resolve, reject) => {
          resolvers.push({
            resolve: (v: any) => {
              activeFetches -= 1
              resolve(v)
            },
            reject: (e: any) => {
              activeFetches -= 1
              reject(e)
            },
          })
        })
      },
      sendMessageFn: async () => {
        const err: any = new Error('Server error')
        err.status = 500
        err.errorCode = 'INTERNAL_ERROR'
        err.traceId = 'trace-abc-500'
        throw err
      },
    })

    chat.start()
    await flushMicrotasks()
    assert.equal(fetchCount, 1)
    assert.equal(chat.initialLoading.value, true)

    // Hide tab -> aborts poll #1 cleanly; immediate visible starts poll #2 before #1's promise settles
    docEnv.fakeDoc.setVisibility('hidden')
    docEnv.fakeDoc.setVisibility('visible')
    await flushMicrotasks()
    assert.equal(fetchCount, 2)
    assert.equal(chat.initialLoading.value, true)

    // Now stale poll #1 settles late -> must NOT clear initialLoading or break poll #2
    resolvers[0].resolve({
      messages: [
        {
          id: 999,
          body: 'Stale response',
          author_badge: { display_label: 'Apt. 1', role_badge: 'OWNER' },
          created_at: new Date(baseNow - 10_000).toISOString(),
          expires_at: new Date(baseNow + 7_190_000).toISOString(),
          is_own: false,
        },
      ],
      cursor: 999,
      has_more: false,
      turned_on_at: '2026-11-15T09:00:00Z',
    })
    await flushMicrotasks()
    assert.equal(chat.initialLoading.value, true, 'Stale poll #1 must not clear initialLoading')
    assert.equal(chat.messages.value.length, 0, 'Stale poll #1 messages must be ignored')

    // Single-flight guard while poll #2 is in flight: spurious visible event does not start a 3rd fetch
    docEnv.fakeDoc.setVisibility('visible')
    await flushMicrotasks()
    assert.equal(fetchCount, 2)

    // Resolve poll #2
    resolvers[1].resolve({
      messages: [
        {
          id: 1,
          body: 'Fresh msg',
          author_badge: { display_label: 'Apt. 2', role_badge: 'OWNER' },
          created_at: new Date(baseNow - 1_000).toISOString(),
          expires_at: new Date(baseNow + 7_199_000).toISOString(),
          is_own: false,
        },
      ],
      cursor: 1,
      has_more: false,
      turned_on_at: '2026-11-15T09:00:00Z',
    })
    await flushMicrotasks()
    assert.equal(chat.initialLoading.value, false)
    assert.deepEqual(
      chat.messages.value.map((m: any) => m.id),
      [1],
    )
    assert.equal(maxParallelFetches <= 2, true)

    // POST 500 preserves full error object with traceId
    const postErr = await chat.sendMessage({ body: 'Hello' })
    assert.equal(postErr.ok, false)
    assert.equal((chat.sendError.value as any)?.traceId, 'trace-abc-500')
    assert.equal((chat.sendError.value as any)?.errorCode, 'INTERNAL_ERROR')

    chat.stop()

    // 2. Initial GET 500 -> sets loadError, reload() succeeds, subsequent GET 403 -> sets forbidden
    let errPhase: '500' | 'ok' | '403' = '500'
    let forbiddenCalls = 0
    const errChat = useChat({
      autoLifecycle: false,
      session,
      nowFn: () => Date.now(),
      onDisabled: () => {},
      onForbidden: () => {
        forbiddenCalls += 1
      },
      onPageSync: () => {},
      fetchMessagesFn: async () => {
        if (errPhase === '500') {
          const e: any = new Error('Boom')
          e.status = 500
          e.errorCode = 'INTERNAL_ERROR'
          e.traceId = 'trace-load-500'
          throw e
        }
        if (errPhase === '403') {
          const e: any = new Error('Forbidden')
          e.status = 403
          e.errorCode = 'FORBIDDEN'
          throw e
        }
        return {
          messages: [],
          cursor: null,
          has_more: false,
          turned_on_at: '2026-11-15T09:00:00Z',
        }
      },
    })

    errChat.start()
    await flushMicrotasks()
    assert.equal(errChat.initialLoading.value, false)
    assert.equal((errChat.loadError.value as any)?.traceId, 'trace-load-500')

    errPhase = 'ok'
    errChat.reload()
    await flushMicrotasks()
    assert.equal(errChat.loadError.value, null)

    errPhase = '403'
    t.mock.timers.tick(15_000)
    await flushMicrotasks()
    assert.equal(errChat.forbidden.value, true)
    assert.equal(forbiddenCalls, 1)

    errChat.stop()
  } finally {
    t.mock.timers.reset()
    docEnv.restore()
  }
})

