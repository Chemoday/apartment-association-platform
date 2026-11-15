import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive, nextTick } from 'vue'
import {
  markChatDisabledFromApi,
  resetChatStateForTest,
  setChatScreenOpen,
  startChatStatePolling,
  stopChatStatePolling,
  syncChatStateFromMessagesPage,
  useChatState,
} from './useChatState.js'

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

test('two consumers share one GET /api/v1/chat poll: 60s enabled, 300s disabled', async (t) => {
  const docEnv = installFakeDocument('visible')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  resetChatStateForTest()

  try {
    const session = reactive({
      authMode: 'demo',
      backendOffline: false,
      actingUserId: 'user-1',
      sessionRevision: 1,
    })

    let enabledResponse = true
    let calls = 0
    const fetchStateFn = async () => {
      calls += 1
      return {
        enabled: enabledResponse,
        turned_on_at: enabledResponse ? '2026-11-15T09:00:00Z' : null,
        can_take_part: true,
        recent_count: enabledResponse ? 4 : 0,
        recent_minutes: 10,
        last_message_at: enabledResponse ? '2026-11-15T09:58:00Z' : null,
        history_hours: 2,
        max_length: 500,
      }
    }

    // Two distinct consumers (e.g., AppNavbar + AppSidebar + DashboardCommunityPulse)
    const navbarConsumer = useChatState()
    const sidebarConsumer = useChatState()
    const dashboardConsumer = useChatState()

    startChatStatePolling(session, null, { fetchStateFn })
    await flushMicrotasks()

    assert.equal(calls, 1)
    assert.equal(navbarConsumer.canShowChat.value, true)
    assert.equal(sidebarConsumer.canShowChat.value, true)
    assert.equal(dashboardConsumer.recentCount.value, 4)

    // 59s elapsed -> still only 1 call
    t.mock.timers.tick(59_000)
    await flushMicrotasks()
    assert.equal(calls, 1)

    // Switch next response to disabled, tick 1s (total 60s) -> 2nd call, then interval switches to 300s
    enabledResponse = false
    t.mock.timers.tick(1_000)
    await flushMicrotasks()
    assert.equal(calls, 2)
    assert.equal(navbarConsumer.canShowChat.value, false)
    assert.equal(sidebarConsumer.canShowChat.value, false)

    // While disabled: 299s -> no extra call
    t.mock.timers.tick(299_000)
    await flushMicrotasks()
    assert.equal(calls, 2)

    // At 300s -> 3rd call
    t.mock.timers.tick(1_000)
    await flushMicrotasks()
    assert.equal(calls, 3)
  } finally {
    resetChatStateForTest()
    t.mock.timers.reset()
    docEnv.restore()
  }
})

test('shared chat state pauses while /chat is open or tab is hidden, polls once on return', async (t) => {
  const docEnv = installFakeDocument('visible')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  resetChatStateForTest()

  try {
    const session = reactive({
      authMode: 'demo',
      backendOffline: false,
      actingUserId: 'user-1',
      sessionRevision: 1,
    })

    let calls = 0
    const fetchStateFn = async () => {
      calls += 1
      return {
        enabled: true,
        turned_on_at: '2026-11-15T09:00:00Z',
        can_take_part: true,
        recent_count: calls,
        recent_minutes: 10,
        last_message_at: '2026-11-15T09:58:00Z',
        history_hours: 2,
        max_length: 500,
      }
    }

    const consumer = useChatState()
    startChatStatePolling(session, null, { fetchStateFn })
    await flushMicrotasks()
    assert.equal(calls, 1)

    // Opening /chat pauses indicator poll indefinitely
    setChatScreenOpen(true)
    t.mock.timers.tick(180_000)
    await flushMicrotasks()
    assert.equal(calls, 1)

    // Leaving /chat triggers one immediate poll and resumes 60s schedule
    setChatScreenOpen(false)
    await flushMicrotasks()
    assert.equal(calls, 2)

    // Hiding tab stops indicator polling even over 5 minutes
    docEnv.fakeDoc.setVisibility('hidden')
    t.mock.timers.tick(300_000)
    await flushMicrotasks()
    assert.equal(calls, 2)

    // Returning tab visible asks once immediately
    docEnv.fakeDoc.setVisibility('visible')
    await flushMicrotasks()
    assert.equal(calls, 3)

    // markChatDisabledFromApi immediately hides indicator across all consumers
    markChatDisabledFromApi()
    assert.equal(consumer.canShowChat.value, false)
    assert.equal(consumer.recentCount.value, 0)
  } finally {
    resetChatStateForTest()
    t.mock.timers.reset()
    docEnv.restore()
  }
})

test('session change resets shared chat state and refetches for new acting user', async (t) => {
  const docEnv = installFakeDocument('visible')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  resetChatStateForTest()

  try {
    const session = reactive({
      authMode: 'demo',
      backendOffline: false,
      actingUserId: 'resident-1',
      sessionRevision: 1,
    })

    let calls = 0
    const fetchStateFn = async () => {
      calls += 1
      return {
        enabled: true,
        turned_on_at: '2026-11-15T09:00:00Z',
        can_take_part: session.actingUserId !== 'accountant-no-apt',
        recent_count: 2,
        recent_minutes: 10,
        last_message_at: '2026-11-15T09:58:00Z',
        history_hours: 2,
        max_length: 500,
      }
    }

    const consumer = useChatState()
    startChatStatePolling(session, null, { fetchStateFn })
    await flushMicrotasks()
    assert.equal(calls, 1)
    assert.equal(consumer.canShowChat.value, true)

    // Switch to accountant without apartment
    session.actingUserId = 'accountant-no-apt'
    session.sessionRevision = 2
    await flushMicrotasks()
    assert.equal(calls, 2)
    assert.equal(consumer.canTakePart.value, false)
    assert.equal(consumer.canShowChat.value, false)
  } finally {
    resetChatStateForTest()
    t.mock.timers.reset()
    docEnv.restore()
  }
})

test('syncChatStateFromMessagesPage initializes null state, 500 preserves state, 401/403 hides state, stopChatStatePolling cleans up', async (t) => {
  const docEnv = installFakeDocument('visible')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  resetChatStateForTest()

  try {
    const consumer = useChatState()
    assert.equal(consumer.chatState.value, null)
    assert.equal(consumer.canShowChat.value, false)

    // P1-2: direct /chat entry initializes shared state from /chat/messages page even if chatState was null
    syncChatStateFromMessagesPage({
      messages: [
        {
          id: 5,
          body: 'Hi',
          author_badge: { display_label: 'Apt. 1', role_badge: 'OWNER' },
          created_at: '2026-11-15T10:02:00Z',
          expires_at: '2026-11-15T12:02:00Z',
          is_own: false,
        },
      ],
      cursor: 5,
      has_more: false,
      turned_on_at: '2026-11-15T09:00:00Z',
    })
    assert.equal(consumer.canShowChat.value, true)
    assert.equal(consumer.turnedOnAt.value, '2026-11-15T09:00:00Z')
    assert.equal(consumer.lastMessageAt.value, '2026-11-15T10:02:00Z')

    // Start polling: 1st GET ok -> 2nd GET 500 preserves state -> 3rd GET 403 hides state
    const session = reactive({
      authMode: 'demo',
      backendOffline: false,
      actingUserId: 'user-1',
      sessionRevision: 1,
    })

    let pollStep = 0
    let calls = 0
    const fetchStateFn = async () => {
      calls += 1
      pollStep += 1
      if (pollStep === 1) {
        return {
          enabled: true,
          turned_on_at: '2026-11-15T09:00:00Z',
          can_take_part: true,
          recent_count: 3,
          recent_minutes: 10,
          last_message_at: '2026-11-15T10:02:00Z',
          history_hours: 2,
          max_length: 500,
        }
      }
      if (pollStep === 2) {
        const err: any = new Error('Server error')
        err.status = 500
        throw err
      }
      const err: any = new Error('Forbidden')
      err.status = 403
      throw err
    }

    startChatStatePolling(session, null, { fetchStateFn })
    await flushMicrotasks()
    assert.equal(calls, 1)
    assert.equal(consumer.canShowChat.value, true)
    assert.equal(consumer.recentCount.value, 3)

    // 500 at 60s preserves state
    t.mock.timers.tick(60_000)
    await flushMicrotasks()
    assert.equal(calls, 2)
    assert.equal(consumer.canShowChat.value, true)
    assert.equal(consumer.recentCount.value, 3)

    // 403 at +60s hides state
    t.mock.timers.tick(60_000)
    await flushMicrotasks()
    assert.equal(calls, 3)
    assert.equal(consumer.canShowChat.value, false)
    assert.equal(consumer.recentCount.value, 0)

    // stopChatStatePolling removes listeners and timers cleanly
    stopChatStatePolling()
    docEnv.fakeDoc.setVisibility('hidden')
    docEnv.fakeDoc.setVisibility('visible')
    t.mock.timers.tick(600_000)
    await flushMicrotasks()
    assert.equal(calls, 3)
  } finally {
    resetChatStateForTest()
    t.mock.timers.reset()
    docEnv.restore()
  }
})

