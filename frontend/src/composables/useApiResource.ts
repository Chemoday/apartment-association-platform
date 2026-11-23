/**
 * Unified server-state query & mutation layer (`src/composables/useApiResource.ts`, #043).
 *
 * ADR Decision:
 *   Uses a lightweight, zero-dependency, strict-TypeScript internal server-state engine
 *   tailored to Vue 3 + Pinia rather than pulling an external query runtime into the bundle.
 *
 * Guarantees:
 *   1. In-flight request deduplication per `(epoch, key)` (bypassed on `force: true`).
 *   2. Automatic `AbortController` creation, cancellation of superseded requests on rapid key changes,
 *      and automatic cleanup via `onScopeDispose` (covers components, Pinia stores, and `effectScope`)
 *      plus explicit `dispose()` for non-scoped usage.
 *   3. Clear separation between initial `loading` (no data yet) and background `isFetching` /
 *      `refreshing` so child modals and tabs stay mounted during silent reloads.
 *   4. Safe parameterized caching: `queryKey` supports `(...args: A) => string`; static keys
 *      are never read/written from `queryCache` when dynamic `args` are passed without an
 *      explicit `execOptions.key` (preventing cache poisoning).
 *   5. Central `clearServerStateCache()` epoch invalidation invoked synchronously on every
 *      `session.sessionRevision` change (login, logout, 401 session end, demo user switch),
 *      guaranteeing zero cross-user data leakage.
 */

import { getCurrentScope, onScopeDispose, ref, type Ref } from 'vue'

interface CacheEntry<T = unknown> {
  data: T
  updatedAt: number
}

interface InFlightEntry<T = unknown> {
  promise: Promise<T>
  controller: AbortController
  subscribers: number
  epoch: number
}

let serverStateEpoch = 0
const queryCache = new Map<string, CacheEntry>()
const inFlightQueries = new Map<string, InFlightEntry>()
const cacheClearListeners = new Set<() => void>()

export function getServerStateEpoch(): number {
  return serverStateEpoch
}

export function getActiveCacheClearListenerCount(): number {
  return cacheClearListeners.size
}

export function isAbortLikeError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: unknown; errorCode?: unknown; code?: unknown }
  return (
    e.name === 'AbortError' ||
    e.errorCode === 'REQUEST_ABORTED' ||
    e.code === 'ABORT_ERR'
  )
}

/**
 * Subscribe a reactive resource to central cache clears (e.g. logout / user switch).
 * Returns an unsubscribe function.
 */
export function onServerStateCacheClear(listener: () => void): () => void {
  cacheClearListeners.add(listener)
  return () => {
    cacheClearListeners.delete(listener)
  }
}

/**
 * Invalidate one or more cached query keys (or prefix matches ending with `:`).
 */
export function invalidateQueryKey(keyOrPrefix: string): void {
  if (!keyOrPrefix) return
  if (keyOrPrefix.endsWith(':')) {
    for (const key of [...queryCache.keys()]) {
      if (key.startsWith(keyOrPrefix)) {
        queryCache.delete(key)
      }
    }
    return
  }
  queryCache.delete(keyOrPrefix)
}

/**
 * Centrally wipe all cached server state, abort all active shared queries, and
 * advance the epoch so any in-flight responses from the previous user/session
 * are guaranteed to be discarded.
 */
export function clearServerStateCache(): void {
  serverStateEpoch += 1
  queryCache.clear()
  for (const [, entry] of [...inFlightQueries.entries()]) {
    try {
      entry.controller.abort()
    } catch {
      /* ignore abort errors */
    }
  }
  inFlightQueries.clear()
  for (const listener of [...cacheClearListeners]) {
    try {
      listener()
    } catch {
      /* isolate listener errors */
    }
  }
}

export interface UseQueryResourceOptions<T, A extends unknown[] = []> {
  /** Structured cache & deduplication key (static string or parameterized getter). */
  queryKey?: string | ((...args: A) => string)
  /** Initial value before first fetch resolves. Defaults to `null`. */
  initialValue?: T | null
  /** Optional cache TTL in milliseconds. Defaults to 0 (always revalidate on explicit execute, still deduplicates in-flight). */
  staleTimeMs?: number
  /** Reset local refs automatically when `clearServerStateCache()` runs. Defaults to `true`. */
  resetOnSessionChange?: boolean
}

export interface QueryExecuteOptions {
  /** Keep existing `data` visible while fetching (`loading` stays `false`, `isFetching` becomes `true`). */
  preserveData?: boolean
  /** Force bypass of cached data AND in-flight shared deduplication. */
  force?: boolean
  /** Override query key for this specific execution. */
  key?: string
}

export function useQueryResource<T, A extends unknown[] = []>(
  fetcher: (ctx: { signal: AbortSignal }, ...args: A) => Promise<T>,
  options: UseQueryResourceOptions<T, A> = {},
) {
  const initialValue = (options.initialValue ?? null) as T | null
  const staleTimeMs = options.staleTimeMs ?? 0
  const resetOnSessionChange = options.resetOnSessionChange ?? true

  const data = ref(initialValue) as Ref<T | null>
  const loading = ref<boolean>(false)
  const isFetching = ref<boolean>(false)
  const error = ref<unknown>(null)

  let activeController: AbortController | null = null
  let activeSharedKey: string | null = null
  let requestSeq = 0
  let disposed = false

  function resolveKey(overrideKey: string | undefined, args: A): string | null {
    if (overrideKey) return overrideKey
    if (typeof options.queryKey === 'function') return options.queryKey(...args)
    // Static string keys cannot distinguish parameterized calls — avoid cache poisoning
    if (args.length > 0) return null
    return options.queryKey ?? null
  }

  function releaseInFlight(): void {
    if (activeController) {
      try {
        activeController.abort()
      } catch {
        /* ignore */
      }
      activeController = null
    }
    if (activeSharedKey) {
      const shared = inFlightQueries.get(activeSharedKey)
      if (shared) {
        shared.subscribers = Math.max(0, shared.subscribers - 1)
        if (shared.subscribers === 0) {
          try {
            shared.controller.abort()
          } catch {
            /* ignore */
          }
          inFlightQueries.delete(activeSharedKey)
        }
      }
      activeSharedKey = null
    }
  }

  function abort(): void {
    requestSeq += 1
    releaseInFlight()
    loading.value = false
    isFetching.value = false
  }

  function reset(): void {
    abort()
    data.value = initialValue
    error.value = null
  }

  const unsubscribeClear = resetOnSessionChange
    ? onServerStateCacheClear(() => {
        reset()
      })
    : () => {}

  function dispose(): void {
    if (disposed) return
    disposed = true
    abort()
    unsubscribeClear()
  }

  if (getCurrentScope()) {
    onScopeDispose(dispose)
  }

  async function execute(
    execOptions: QueryExecuteOptions = {},
    ...args: A
  ): Promise<T | null> {
    if (disposed) return null
    const key = resolveKey(execOptions.key, args)
    const epochAtStart = serverStateEpoch

    // Serve fresh cache if configured and not forced
    if (key && staleTimeMs > 0 && !execOptions.force) {
      const cached = queryCache.get(key)
      if (cached && Date.now() - cached.updatedAt < staleTimeMs) {
        data.value = cached.data as T
        error.value = null
        loading.value = false
        isFetching.value = false
        return cached.data as T
      }
    }

    // Cancel any previous in-flight request owned by this composable instance
    releaseInFlight()
    const seq = ++requestSeq
    const preserve = Boolean(execOptions.preserveData) && data.value !== null

    if (!preserve) {
      loading.value = true
    }
    isFetching.value = true
    error.value = null

    let promise: Promise<T>

    if (key && !execOptions.force) {
      const existing = inFlightQueries.get(key)
      if (existing && existing.epoch === epochAtStart && !existing.controller.signal.aborted) {
        existing.subscribers += 1
        activeSharedKey = key
        promise = existing.promise as Promise<T>
      } else {
        const controller = new AbortController()
        let rawPromise: Promise<T>
        try {
          rawPromise = Promise.resolve(fetcher({ signal: controller.signal }, ...args))
        } catch (syncErr) {
          rawPromise = Promise.reject(syncErr)
        }
        const sharedPromise = rawPromise
          .then((result) => {
            if (serverStateEpoch === epochAtStart) {
              queryCache.set(key, { data: result, updatedAt: Date.now() })
            }
            return result
          })
          .finally(() => {
            const current = inFlightQueries.get(key)
            if (current && current.promise === sharedPromise) {
              inFlightQueries.delete(key)
            }
          })

        inFlightQueries.set(key, {
          promise: sharedPromise,
          controller,
          subscribers: 1,
          epoch: epochAtStart,
        })
        activeSharedKey = key
        promise = sharedPromise
      }
    } else {
      const controller = new AbortController()
      activeController = controller
      let rawPromise: Promise<T>
      try {
        rawPromise = Promise.resolve(fetcher({ signal: controller.signal }, ...args))
      } catch (syncErr) {
        rawPromise = Promise.reject(syncErr)
      }
      promise = rawPromise.then((result) => {
        if (key && serverStateEpoch === epochAtStart) {
          queryCache.set(key, { data: result, updatedAt: Date.now() })
        }
        return result
      })
    }

    try {
      const result = await promise
      if (disposed || seq !== requestSeq || serverStateEpoch !== epochAtStart) {
        return null
      }
      data.value = result
      error.value = null
      return result
    } catch (err) {
      if (
        disposed ||
        seq !== requestSeq ||
        serverStateEpoch !== epochAtStart ||
        isAbortLikeError(err)
      ) {
        return null
      }
      error.value = err
      throw err
    } finally {
      if (!disposed && seq === requestSeq && serverStateEpoch === epochAtStart) {
        loading.value = false
        isFetching.value = false
        activeController = null
        activeSharedKey = null
      }
    }
  }

  return {
    data,
    loading,
    isFetching,
    refreshing: isFetching,
    error,
    execute,
    refetch: (opts: Omit<QueryExecuteOptions, 'preserveData'> = {}, ...args: A) =>
      execute({ ...opts, preserveData: true, force: true }, ...args),
    abort,
    reset,
    dispose,
  }
}

export type MutationConcurrencyMode = 'latest' | 'ignore' | 'abort'

export interface UseMutationActionOptions<TResult> {
  /** Query keys (or `prefix:` patterns) to invalidate upon successful mutation. */
  invalidateKeys?: string[]
  /**
   * Behavior when `mutate()` is called while a previous mutation is still in flight:
   * - `'latest'` (default): allows prior non-idempotent HTTP call to finish on server, tracks latest in UI.
   * - `'ignore'`: drops duplicate concurrent calls while `isPending` is true.
   * - `'abort'`: explicitly aborts the prior request's `AbortController` (only safe for idempotent ops).
   */
  concurrency?: MutationConcurrencyMode
  onSuccess?: (result: TResult) => void | Promise<void>
  onError?: (err: unknown) => void | Promise<void>
}

export function useMutationAction<TResult, A extends unknown[] = unknown[]>(
  mutator: (ctx: { signal: AbortSignal }, ...args: A) => Promise<TResult>,
  options: UseMutationActionOptions<TResult> = {},
) {
  const concurrency: MutationConcurrencyMode = options.concurrency ?? 'latest'
  const data = ref<TResult | null>(null) as Ref<TResult | null>
  const isPending = ref<boolean>(false)
  const error = ref<unknown>(null)

  let activeController: AbortController | null = null
  let mutationSeq = 0
  let disposed = false

  function abort(): void {
    mutationSeq += 1
    if (activeController) {
      try {
        activeController.abort()
      } catch {
        /* ignore */
      }
      activeController = null
    }
    isPending.value = false
  }

  function reset(): void {
    abort()
    data.value = null
    error.value = null
  }

  const unsubscribeClear = onServerStateCacheClear(() => {
    reset()
  })

  function dispose(): void {
    if (disposed) return
    disposed = true
    abort()
    unsubscribeClear()
  }

  if (getCurrentScope()) {
    onScopeDispose(dispose)
  }

  async function mutate(...args: A): Promise<TResult | null> {
    if (disposed) return null
    if (concurrency === 'ignore' && isPending.value) {
      return null
    }
    if (concurrency === 'abort') {
      abort()
    }
    const seq = ++mutationSeq
    const epochAtStart = serverStateEpoch
    const controller = new AbortController()
    activeController = controller

    isPending.value = true
    error.value = null

    let result: TResult
    try {
      result = await mutator({ signal: controller.signal }, ...args)
    } catch (err) {
      if (
        disposed ||
        seq !== mutationSeq ||
        serverStateEpoch !== epochAtStart ||
        isAbortLikeError(err)
      ) {
        return null
      }
      isPending.value = false
      activeController = null
      error.value = err
      if (options.onError) {
        await options.onError(err)
      }
      throw err
    }

    if (disposed || seq !== mutationSeq || serverStateEpoch !== epochAtStart) {
      return null
    }

    data.value = result
    isPending.value = false
    activeController = null

    if (Array.isArray(options.invalidateKeys)) {
      for (const key of options.invalidateKeys) {
        invalidateQueryKey(key)
      }
    }

    // Run onSuccess outside the mutator try/catch so UI callback errors never trigger onError
    // or mark a committed server mutation as failed.
    if (options.onSuccess) {
      await options.onSuccess(result)
    }
    return result
  }

  return {
    data,
    isPending,
    loading: isPending,
    error,
    mutate,
    abort,
    reset,
    dispose,
  }
}

/**
 * Legacy simple wrapper preserved for backwards compatibility.
 * New code should prefer `useQueryResource` or `useMutationAction`.
 */
export function useApiResource<T, A extends unknown[] = unknown[]>(
  fetcher: (...args: A) => Promise<T>,
  initialValue: T | null = null,
) {
  const data = ref(initialValue) as Ref<T | null>
  const loading = ref<boolean>(false)
  const error = ref<unknown>(null)

  async function execute(...args: A): Promise<T> {
    loading.value = true
    error.value = null
    try {
      const result = await fetcher(...args)
      data.value = result
      return result
    } catch (err) {
      error.value = err
      throw err
    } finally {
      loading.value = false
    }
  }

  function reset(): void {
    data.value = initialValue
    loading.value = false
    error.value = null
  }

  return {
    data,
    loading,
    error,
    execute,
    reset,
  }
}
