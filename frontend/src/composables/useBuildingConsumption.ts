import { onBeforeUnmount, ref } from 'vue'
import { getBuildingConsumption } from '@/api/endpoints/meters.js'
import type { BuildingConsumptionResponse } from '@/api/schema.js'
import { isAbortLikeError } from './useApartmentConsumption.js'

export type BuildingConsumptionFetcher = (
  months?: number | string,
  options?: { signal?: AbortSignal },
) => Promise<BuildingConsumptionResponse>

/**
 * Loader state machine for staff whole-building consumption (`GET /meters/consumption`).
 * Cancels in-flight requests on 12/24 window switches, role switches, or unmount,
 * ignores `REQUEST_ABORTED` / `AbortError`, and drops stale responses.
 */
export function useBuildingConsumption(
  fetcher: BuildingConsumptionFetcher = getBuildingConsumption,
) {
  const data = ref<BuildingConsumptionResponse | null>(null)
  const loading = ref<boolean>(false)
  const error = ref<unknown>(null)

  let requestSeq = 0
  let activeController: AbortController | null = null

  function abortActive(): void {
    if (activeController) {
      activeController.abort()
      activeController = null
    }
  }

  function reset(): void {
    requestSeq += 1
    abortActive()
    data.value = null
    error.value = null
    loading.value = false
  }

  async function load(
    months: number | string = 12,
    { preserveDataOnReload = false }: { preserveDataOnReload?: boolean } = {},
  ): Promise<BuildingConsumptionResponse | null> {
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
