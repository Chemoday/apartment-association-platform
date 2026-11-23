import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive } from 'vue'
import {
  refreshUnreadCount,
  startUnreadPolling,
  stopUnreadPolling,
  unread,
} from './useUnreadCount.js'

test('CTO audit P2-1: useUnreadCount aborts stale poll on session switch and cleans up on stopUnreadPolling', async () => {
  const originalFetch = globalThis.fetch
  const signals: AbortSignal[] = []
  const resolvers: Array<(v: Response) => void> = []

  globalThis.fetch = (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal)
    return new Promise<Response>((resolve, reject) => {
      if (init?.signal) {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('Request aborted'), { name: 'AbortError' }))
        })
      }
      resolvers.push(resolve)
    })
  }

  try {
    const session = reactive({
      authMode: 'demo',
      backendOffline: false,
      sessionRevision: 1,
    })

    startUnreadPolling(session)
    assert.equal(signals.length, 1)
    assert.equal(signals[0].aborted, false)

    // Switch user (bump sessionRevision) while first request is still pending
    session.sessionRevision = 2
    await new Promise((r) => setTimeout(r, 0))

    assert.equal(signals[0].aborted, true)
    assert.equal(signals.length, 2)
    assert.equal(unread.value, 0)

    // First (stale) user's response arrives late — must be ignored
    resolvers[0](
      new Response(JSON.stringify({ unread: 99 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(unread.value, 0)

    // Second (current) user's response arrives
    resolvers[1](
      new Response(JSON.stringify({ unread: 4 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(unread.value, 4)

    // Teardown aborts any future poll cleanly
    const p3 = refreshUnreadCount()
    stopUnreadPolling()
    await p3
    assert.equal(signals[2].aborted, true)
  } finally {
    stopUnreadPolling()
    unread.value = 0
    globalThis.fetch = originalFetch
  }
})
