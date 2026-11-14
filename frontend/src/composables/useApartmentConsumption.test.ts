import test from 'node:test'
import assert from 'node:assert/strict'
import { createSSRApp, defineComponent, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import {
  isAbortLikeError,
  useApartmentConsumption,
} from './useApartmentConsumption.js'

function mountComposable<T>(factory: () => T) {
  let result!: T
  const Comp = defineComponent({
    setup() {
      result = factory()
      return () => h('div')
    },
  })
  const app = createSSRApp(Comp)
  return { app, getResult: () => result, mount: () => renderToString(app) }
}

test('isAbortLikeError detects AbortError and client ApiError REQUEST_ABORTED', () => {
  const err1 = new Error('Aborted')
  err1.name = 'AbortError'
  assert.equal(isAbortLikeError(err1), true)

  const err2 = Object.assign(new Error('Request aborted'), {
    errorCode: 'REQUEST_ABORTED',
    status: 0,
  })
  assert.equal(isAbortLikeError(err2), true)

  const err3 = new Error('Network down')
  assert.equal(isAbortLikeError(err3), false)

  const ac = new AbortController()
  ac.abort()
  assert.equal(isAbortLikeError(err3, ac.signal), true)
})

test('useApartmentConsumption ignores REQUEST_ABORTED, cancels stale apartment requests, and supports retry', async () => {
  const calls: Array<{ apartmentId: string; months: number; signal: AbortSignal }> = []
  let resolvers: Array<{
    resolve: (v: any) => void
    reject: (e: any) => void
    signal: AbortSignal
  }> = []

  const fetcher = (apartmentId: string, months = 12, { signal }: { signal: AbortSignal }) => {
    calls.push({ apartmentId, months, signal })
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal }
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('Request aborted'), { errorCode: 'REQUEST_ABORTED' }))
      })
      resolvers.push(entry)
    })
  }

  let loader!: ReturnType<typeof useApartmentConsumption>
  const Harness = defineComponent({
    setup() {
      loader = useApartmentConsumption(fetcher as any)
      return () => h('div')
    },
  })
  await renderToString(createSSRApp(Harness))

  // 1. Rapid switch Apt A -> Apt B: Apt A signal aborts with REQUEST_ABORTED and NEVER sets error
  const pA = loader.load('apt-a', 12)
  assert.equal(calls.length, 1)
  assert.equal(loader.loading.value, true)

  const pB = loader.load('apt-b', 12)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(calls[1].signal.aborted, false)

  await pA
  assert.equal(loader.error.value, null)

  // Resolve Apt B
  resolvers[1].resolve({ apartment_id: 'apt-b', periods: [], resources: [] })
  await pB
  assert.equal(loader.data.value?.apartment_id, 'apt-b')
  assert.equal(loader.loading.value, false)
  assert.equal(loader.error.value, null)

  // 2. Non-abort error sets error state, then retry with preserveDataOnReload recovers
  const pErr = loader.load('apt-b', 12, { preserveDataOnReload: true })
  assert.equal(loader.data.value?.apartment_id, 'apt-b') // preserved during reload
  resolvers[2].reject(Object.assign(new Error('Server down'), { status: 500 }))
  await pErr
  assert.equal((loader.error.value as any)?.status, 500)
  assert.equal(loader.loading.value, false)

  const pRetry = loader.load('apt-b', 12)
  assert.equal(loader.error.value, null)
  resolvers[3].resolve({ apartment_id: 'apt-b', periods: [{ period_code: '2026-10', status: 'LOCKED' }], resources: [] })
  await pRetry
  assert.equal(loader.data.value?.periods?.length, 1)
  assert.equal(loader.loading.value, false)
})

test('useApartmentConsumption resets state cleanly on empty apartmentId', async () => {
  const { mount, getResult } = mountComposable(() =>
    useApartmentConsumption(async (apartmentId: string) => ({
      apartment_id: apartmentId,
      periods: [],
      resources: [],
    })),
  )
  await mount()
  const loader = getResult()
  await loader.load('apt-14', 12)
  assert.equal(loader.data.value?.apartment_id, 'apt-14')

  await loader.load('', 12)
  assert.equal(loader.data.value, null)
  assert.equal(loader.error.value, null)
  assert.equal(loader.loading.value, false)
})
