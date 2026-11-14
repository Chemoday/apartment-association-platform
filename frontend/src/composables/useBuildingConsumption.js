import { onBeforeUnmount, ref } from 'vue'
import { getBuildingConsumption } from '@/api/endpoints/meters.js'
import { isAbortLikeError } from './useApartmentConsumption.js'

/**
 * Loader state machine for staff whole-building consumption (`GET /meters/consumption`).
 * Cancels in-flight requests on 12/24 window switches, role switches, or unmount,
 * ignores `REQUEST_ABORTED` / `AbortError`, and drops stale responses.
 *
 * @param {(months?: number, options?: { signal?: AbortSignal }) => Promise<import('../api/schema.d.ts').BuildingConsumptionResponse>} [fetcher]
 */
export function useBuildingConsumption(fetcher = getBuildingConsumption) {
  /** @type {import('vue').Ref<import('../api/schema.d.ts').BuildingConsumptionResponse | null>} */
  const data = ref(null)
  const loading = ref(false)
  /** @type {import('vue').Ref<any>} */
  const error = ref(null)

  let requestSeq = 0
  /** @type {AbortController | null} */
  let activeController = null

  function abortActive() {
    if (activeController) {
      activeController.abort()
      activeController = null
    }
  }

  function reset() {
    requestSeq += 1
    abortActive()
    data.value = null
    error.value = null
    loading.value = false
  }

  /**
   * @param {number} [months=12]
   * @param {{ preserveDataOnReload?: boolean }} [options]
   */
  async function load(months = 12, { preserveDataOnReload = false } = {}) {
    abortActive()
    if (!preserveDataOnReload) {
      data.value = null
    }

    const seq = ++requestSeq
    const controller = new AbortController()
    activeController = controller
    loading.value = true
    error.value = null

    try {
      const res = await fetcher(months, { signal: controller.signal })
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
