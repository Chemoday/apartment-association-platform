import { onBeforeUnmount, ref } from 'vue'
import { asApiErrorLike } from '@/api/client.js'
import { getApartmentConsumption } from '@/api/endpoints/meters.js'
import type { ApartmentConsumptionResponse } from '@/api/schema.js'

/**
 * Recognizes aborted requests across both native fetch (`AbortError`) and `api/client.ts` (`REQUEST_ABORTED`).
 */
export function isAbortLikeError(err: unknown, signal?: AbortSignal | null): boolean {
  const errLike = asApiErrorLike(err)
  return Boolean(
    signal?.aborted ||
      errLike.name === 'AbortError' ||
      errLike.errorCode === 'REQUEST_ABORTED' ||
      errLike.payload?.error_code === 'REQUEST_ABORTED',
  )
}

export type ApartmentConsumptionFetcher = (
  apartmentId: string,
  months?: number | string,
  options?: { signal?: AbortSignal },
) => Promise<Partial<ApartmentConsumptionResponse> | null | undefined>

/**
 * Shared loader state machine for apartment consumption charts (`ReadingsView` & `ApartmentCardView`).
 * Guards against stale responses via sequence counters, aborts in-flight requests on reload/unmount,
 * and silently ignores `REQUEST_ABORTED` / `AbortError`.
 */
export function useApartmentConsumption(
  fetcher: ApartmentConsumptionFetcher = getApartmentConsumption,
) {
  const data = ref<ApartmentConsumptionResponse | null>(null)
  const loading = ref<boolean>(false)
  const error = ref<unknown>(null)

  let requestSeq = 0
  let activeController: AbortController | null = null
  let activeApartmentId = ''

  function abortActive(): void {
    if (activeController) {
      activeController.abort()
      activeController = null
    }
  }

  function reset(): void {
    requestSeq += 1
    activeApartmentId = ''
    abortActive()
    data.value = null
    error.value = null
    loading.value = false
  }

  async function load(
    apartmentId: string | null | undefined,
    months: number | string = 12,
    { preserveDataOnReload = false }: { preserveDataOnReload?: boolean } = {},
  ): Promise<ApartmentConsumptionResponse | null> {
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
      const normalized = (res as ApartmentConsumptionResponse | null | undefined) ?? null
      data.value = normalized
      return normalized
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
