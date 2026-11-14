import { onBeforeUnmount, ref } from 'vue'
import { getApartmentConsumption } from '@/api/endpoints/meters.js'

/**
 * Recognizes aborted requests across both native fetch (`AbortError`) and `api/client.js` (`REQUEST_ABORTED`).
 * @param {any} err
 * @param {AbortSignal | null | undefined} [signal]
 * @returns {boolean}
 */
export function isAbortLikeError(err, signal) {
  return Boolean(
    signal?.aborted ||
      err?.name === 'AbortError' ||
      err?.errorCode === 'REQUEST_ABORTED' ||
      err?.payload?.error_code === 'REQUEST_ABORTED',
  )
}

/**
 * Shared loader state machine for apartment consumption charts (`ReadingsView` & `ApartmentCardView`).
 * Guards against stale responses via sequence counters, aborts in-flight requests on reload/unmount,
 * and silently ignores `REQUEST_ABORTED` / `AbortError`.
 *
 * @param {(apartmentId: string, months?: number, options?: { signal?: AbortSignal }) => Promise<any>} [fetcher]
 */
export function useApartmentConsumption(fetcher = getApartmentConsumption) {
  /** @type {import('vue').Ref<import('../api/schema.d.ts').ApartmentConsumptionResponse | null>} */
  const data = ref(null)
  const loading = ref(false)
  /** @type {import('vue').Ref<any>} */
  const error = ref(null)

  let requestSeq = 0
  let activeController = null
  let activeApartmentId = ''

  function abortActive() {
    if (activeController) {
      activeController.abort()
      activeController = null
    }
  }

  function reset() {
    requestSeq += 1
    activeApartmentId = ''
    abortActive()
    data.value = null
    error.value = null
    loading.value = false
  }

  async function load(apartmentId, months = 12, { preserveDataOnReload = false } = {}) {
    const normalizedId = apartmentId ? String(apartmentId) : ''
    abortActive()
    if (!normalizedId) {
      reset()
      return null
    }

    if (!preserveDataOnReload || normalizedId !== activeApartmentId) {
      data.value = null
    }
    activeApartmentId = normalizedId

    const seq = ++requestSeq
    const controller = new AbortController()
    activeController = controller
    loading.value = true
    error.value = null

    try {
      const res = await fetcher(normalizedId, months, { signal: controller.signal })
      if (seq !== requestSeq || controller.signal.aborted) return null
      data.value = res
      return res
    } catch (err) {
      if (seq !== requestSeq || isAbortLikeError(err, controller.signal)) {
        return null
      }
      error.value = err
      return null
    } finally {
      if (activeController === controller) {
        activeController = null
      }
      if (seq === requestSeq) {
        loading.value = false
      }
    }
  }

  onBeforeUnmount(() => {
    requestSeq += 1
    abortActive()
  })

  return {
    data,
    loading,
    error,
    load,
    reset,
  }
}
