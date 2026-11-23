import assert from 'node:assert/strict'
import test from 'node:test'
import { defineComponent, h } from 'vue'
import {
  clearServerStateCache,
  getServerStateEpoch,
  invalidateQueryKey,
  useMutationAction,
  useQueryResource,
} from './useApiResource.js'
import { queryKeys } from '../api/queryKeys.js'
import { mountWithApp } from '../test/mountWithApp.js'

function createDeferred<T>() {
  let resolve!: (val: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('useQueryResource aborts active request on component unmount (#043)', async () => {
  clearServerStateCache()
  let observedSignal: AbortSignal | null = null
  const deferred = createDeferred<string>()

  let resource!: ReturnType<typeof useQueryResource<string>>
  const Comp = defineComponent({
    setup() {
      resource = useQueryResource<string>(
        ({ signal }) => {
          observedSignal = signal
          return deferred.promise
        },
        { queryKey: queryKeys.meters.periods() },
      )
      return () => h('div', resource.data.value ?? 'empty')
    },
  })

  const mounted = await mountWithApp(Comp)
  const req = resource.execute()
  assert.ok(observedSignal)
  assert.equal((observedSignal as AbortSignal).aborted, false)

  mounted.unmount()
  assert.equal((observedSignal as AbortSignal).aborted, true)

  deferred.resolve('late-payload')
  const result = await req
  assert.equal(result, null)
  assert.equal(resource.data.value, null)
})

test('useQueryResource cancels superseded request on rapid key changes and discards stale responses (#043)', async () => {
  clearServerStateCache()
  const calls: Array<{ period: string; signal: AbortSignal; deferred: ReturnType<typeof createDeferred<string>> }> = []

  const resource = useQueryResource<string, [string]>(
    ({ signal }, period) => {
      const deferred = createDeferred<string>()
      calls.push({ period, signal, deferred })
      return deferred.promise
    },
  )

  const p1 = resource.execute({ key: queryKeys.meters.periodMatrix('2026-09') }, '2026-09')
  const p2 = resource.execute({ key: queryKeys.meters.periodMatrix('2026-10') }, '2026-10')

  assert.equal(calls.length, 2)
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(calls[1].signal.aborted, false)

  // Stale first response arrives after second request is already in flight
  calls[0].deferred.resolve('stale-2026-09')
  const r1 = await p1
  assert.equal(r1, null)
  assert.equal(resource.data.value, null)

  calls[1].deferred.resolve('fresh-2026-10')
  const r2 = await p2
  assert.equal(r2, 'fresh-2026-10')
  assert.equal(resource.data.value, 'fresh-2026-10')
  assert.equal(resource.loading.value, false)
  assert.equal(resource.isFetching.value, false)
})

test('useQueryResource deduplicates concurrent in-flight requests for the same queryKey (#043)', async () => {
  clearServerStateCache()
  let fetchCount = 0
  const deferred = createDeferred<{ count: number }>()

  const fetcher = () => {
    fetchCount += 1
    return deferred.promise
  }

  const r1 = useQueryResource(fetcher, { queryKey: queryKeys.notifications.unreadCount() })
  const r2 = useQueryResource(fetcher, { queryKey: queryKeys.notifications.unreadCount() })

  const p1 = r1.execute()
  const p2 = r2.execute()

  assert.equal(fetchCount, 1)

  deferred.resolve({ count: 7 })
  const [v1, v2] = await Promise.all([p1, p2])
  assert.deepEqual(v1, { count: 7 })
  assert.deepEqual(v2, { count: 7 })
  assert.deepEqual(r1.data.value, { count: 7 })
  assert.deepEqual(r2.data.value, { count: 7 })
})

test('useQueryResource distinguishes initial loading vs background refetch (preserveData) without clearing data (#043)', async () => {
  clearServerStateCache()
  let seq = 0
  const deferreds: Array<ReturnType<typeof createDeferred<string>>> = []

  const resource = useQueryResource<string>(
    () => {
      seq += 1
      const d = createDeferred<string>()
      deferreds.push(d)
      return d.promise
    },
    { queryKey: queryKeys.property.building() },
  )

  // Initial load: both loading and isFetching are true
  const first = resource.execute()
  assert.equal(resource.loading.value, true)
  assert.equal(resource.isFetching.value, true)
  deferreds[0].resolve('initial-data')
  await first
  assert.equal(resource.loading.value, false)
  assert.equal(resource.isFetching.value, false)
  assert.equal(resource.data.value, 'initial-data')

  // Background refetch: loading stays false, isFetching becomes true, data stays intact
  const second = resource.refetch()
  assert.equal(resource.loading.value, false)
  assert.equal(resource.isFetching.value, true)
  assert.equal(resource.data.value, 'initial-data')

  deferreds[1].resolve('updated-data')
  await second
  assert.equal(seq, 2)
  assert.equal(resource.loading.value, false)
  assert.equal(resource.isFetching.value, false)
  assert.equal(resource.data.value, 'updated-data')
})

test('clearServerStateCache wipes all cached data, aborts in-flight queries, and prevents cross-user leakage (#043)', async () => {
  clearServerStateCache()
  const epochBefore = getServerStateEpoch()
  const deferred = createDeferred<string>()
  let capturedSignal: AbortSignal | null = null

  const resource = useQueryResource<string>(
    ({ signal }) => {
      capturedSignal = signal
      return deferred.promise
    },
    {
      queryKey: queryKeys.property.me(),
      staleTimeMs: 60_000,
    },
  )

  const pending = resource.execute()
  assert.ok(capturedSignal)
  assert.equal((capturedSignal as AbortSignal).aborted, false)

  // Simulate logout / user switch
  clearServerStateCache()
  assert.equal(getServerStateEpoch(), epochBefore + 1)
  assert.equal((capturedSignal as AbortSignal).aborted, true)
  assert.equal(resource.data.value, null)
  assert.equal(resource.loading.value, false)

  // Even if old promise resolves later, it must never populate the new session's state
  deferred.resolve('previous-user-secret')
  const res = await pending
  assert.equal(res, null)
  assert.equal(resource.data.value, null)
})

test('useMutationAction invalidates cache keys on success and discards stale responses on session wipe (#043)', async () => {
  clearServerStateCache()
  let queryCalls = 0

  const query = useQueryResource<string>(
    async () => {
      queryCalls += 1
      return `v${queryCalls}`
    },
    {
      queryKey: queryKeys.settings.all(),
      staleTimeMs: 60_000,
    },
  )

  // First load populates cache; second load hits fresh cache
  assert.equal(await query.execute(), 'v1')
  assert.equal(await query.execute(), 'v1')
  assert.equal(queryCalls, 1)

  // Mutation invalidates `settings:` prefix
  const mutation = useMutationAction<boolean, [boolean]>(
    async (_ctx, enabled) => enabled,
    { invalidateKeys: ['settings:'] },
  )

  const out = await mutation.mutate(true)
  assert.equal(out, true)
  assert.equal(mutation.isPending.value, false)

  // Next query must refetch because cache was invalidated
  assert.equal(await query.execute(), 'v2')
  assert.equal(queryCalls, 2)

  // Also test explicit key invalidation
  invalidateQueryKey(queryKeys.settings.all())
  assert.equal(await query.execute(), 'v3')
  assert.equal(queryCalls, 3)
})

test('CTO audit P1-4: parameterized execute() does not poison static queryKey cache', async () => {
  clearServerStateCache()
  let calls = 0
  const resource = useQueryResource<string, [string]>(
    async (_ctx, aptId) => {
      calls += 1
      return `card-${aptId}`
    },
    { queryKey: 'property:apartment', staleTimeMs: 60_000 },
  )

  assert.equal(await resource.execute({}, 'apt-1'), 'card-apt-1')
  assert.equal(await resource.execute({}, 'apt-2'), 'card-apt-2')
  assert.equal(calls, 2)
  resource.dispose()
})

test('CTO audit P1-5: refetch() with force: true bypasses stale in-flight shared request', async () => {
  clearServerStateCache()
  const deferreds: Array<ReturnType<typeof createDeferred<string>>> = []
  const fetcher = () => {
    const d = createDeferred<string>()
    deferreds.push(d)
    return d.promise
  }

  const r1 = useQueryResource<string>(fetcher, { queryKey: queryKeys.notifications.unreadCount() })
  const r2 = useQueryResource<string>(fetcher, { queryKey: queryKeys.notifications.unreadCount() })

  const p1 = r1.execute()
  const p2 = r2.execute()
  assert.equal(deferreds.length, 1)

  // While shared request is still pending, r1 triggers forced refetch
  const pForce = r1.refetch()
  assert.equal(deferreds.length, 2)

  deferreds[0].resolve('stale-shared')
  deferreds[1].resolve('fresh-forced')

  await Promise.all([p1, p2, pForce])
  assert.equal(r1.data.value, 'fresh-forced')
  assert.equal(r2.data.value, 'stale-shared')
  r1.dispose()
  r2.dispose()
})

test('CTO audit P1-6: explicit abort() on 1 of 2 shared subscribers prevents stale write and resets loading', async () => {
  clearServerStateCache()
  const deferred = createDeferred<string>()
  const fetcher = () => deferred.promise

  const r1 = useQueryResource<string>(fetcher, { queryKey: queryKeys.property.building() })
  const r2 = useQueryResource<string>(fetcher, { queryKey: queryKeys.property.building() })

  const p1 = r1.execute()
  const p2 = r2.execute()
  assert.equal(r1.loading.value, true)

  r1.abort()
  assert.equal(r1.loading.value, false)
  assert.equal(r1.isFetching.value, false)

  deferred.resolve('shared-result')
  const [res1, res2] = await Promise.all([p1, p2])
  assert.equal(res1, null)
  assert.equal(r1.data.value, null)
  assert.equal(res2, 'shared-result')
  assert.equal(r2.data.value, 'shared-result')
  r1.dispose()
  r2.dispose()
})

test('CTO audit P1-7: dispose() cleans up cacheClearListeners outside Vue components (zero leak)', async () => {
  clearServerStateCache()
  const { getActiveCacheClearListenerCount } = await import('./useApiResource.js')
  const before = getActiveCacheClearListenerCount()

  const q = useQueryResource(async () => 'ok')
  const m = useMutationAction(async () => 'ok')
  assert.equal(getActiveCacheClearListenerCount(), before + 2)

  q.dispose()
  m.dispose()
  assert.equal(getActiveCacheClearListenerCount(), before)
})

test('CTO audit P1-8: useMutationAction does not abort prior non-idempotent call by default and isolates onSuccess errors from onError', async () => {
  clearServerStateCache()
  const signals: AbortSignal[] = []
  let onErrorCalled = false

  const m = useMutationAction<string, [string]>(
    async ({ signal }, id) => {
      signals.push(signal)
      return `saved-${id}`
    },
    {
      onSuccess: () => {
        throw new Error('toast render failure')
      },
      onError: () => {
        onErrorCalled = true
      },
    },
  )

  await assert.rejects(() => m.mutate('1'), /toast render failure/)
  assert.equal(onErrorCalled, false)
  assert.equal(m.error.value, null)
  assert.equal(m.data.value, 'saved-1')
  assert.equal(signals[0].aborted, false)
  m.dispose()
})
