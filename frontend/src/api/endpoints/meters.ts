import { apiRequest } from '../client.js'
import type {
  ApartmentConsumptionResponse,
  ApartmentReadingsResponse,
  BuildingConsumptionResponse,
  DashboardResponse,
  EstimateResponse,
  MatrixResponse,
  PeriodDTO,
  PeriodListResponse,
  PeriodStatus,
  PeriodStatusUpdateResponse,
  ReadingHistoryResponse,
  ReadingResponse,
  ReadingSubmitRequest,
} from '../schema.js'

/**
 * List all billing periods of the building, newest first.
 * Added in PR #31 (GET /api/v1/meters/periods).
 */
export async function listPeriods({
  signal,
}: { signal?: AbortSignal } = {}): Promise<PeriodDTO[]> {
  const res = await apiRequest<PeriodDTO[] | PeriodListResponse>(
    '/meters/periods',
    signal ? { signal } : {},
  )
  if (Array.isArray(res)) return res
  if (res && Array.isArray(res.periods)) return res.periods
  return []
}

/**
 * Load resident meter dashboard for an optional period_code.
 */
export function getMyDashboard(
  periodCode: string | null = null,
  { signal }: { signal?: AbortSignal } = {},
): Promise<DashboardResponse> {
  const query = periodCode ? `?period_code=${encodeURIComponent(periodCode)}` : ''
  return apiRequest<DashboardResponse>(`/meters/my-dashboard${query}`, signal ? { signal } : {})
}

/**
 * Submit a meter reading (supports confirmation_level 0, 1, 2 and optional reason).
 */
export function submitReading(payload: ReadingSubmitRequest): Promise<ReadingResponse> {
  return apiRequest<ReadingResponse>('/meters/readings', {
    method: 'POST',
    body: payload,
  })
}

/**
 * Get audit history for a specific reading_id.
 */
export function getReadingHistory(
  readingId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ReadingHistoryResponse> {
  return apiRequest<ReadingHistoryResponse>(
    `/meters/readings/${encodeURIComponent(readingId)}/history`,
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Get period consumption matrix for board/chairman/accountant.
 */
export function getPeriodMatrix(
  periodCode: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<MatrixResponse> {
  return apiRequest<MatrixResponse>(
    `/meters/periods/${encodeURIComponent(periodCode)}/matrix`,
    signal ? { signal } : {},
  )
}

/**
 * Auto-estimate missing readings in a period (only in REVIEW_BY_BOARD).
 */
export function estimateMissingReadings(periodCode: string): Promise<EstimateResponse> {
  return apiRequest<EstimateResponse>(
    `/meters/periods/${encodeURIComponent(periodCode)}/estimate-missing`,
    {
      method: 'POST',
    },
  )
}

/**
 * Transition period status (OPEN_FOR_RESIDENTS <-> REVIEW_BY_BOARD <-> LOCKED).
 */
export function changePeriodStatus(
  periodCode: string,
  status: PeriodStatus,
): Promise<PeriodStatusUpdateResponse> {
  return apiRequest<PeriodStatusUpdateResponse>(
    `/meters/periods/${encodeURIComponent(periodCode)}/status`,
    {
      method: 'PATCH',
      body: { status },
    },
  )
}

/**
 * Export period readings as CSV (raw Response for Blob download).
 */
export function exportPeriodCsv(
  periodCode: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<Response> {
  return apiRequest<Response>(`/meters/periods/${encodeURIComponent(periodCode)}/export-csv`, {
    raw: true,
    ...(signal ? { signal } : {}),
  })
}

/**
 * Get the reading history of one apartment across the latest 24 periods.
 */
export function getApartmentReadings(
  apartmentId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ApartmentReadingsResponse> {
  return apiRequest<ApartmentReadingsResponse>(
    `/meters/apartments/${encodeURIComponent(apartmentId)}/readings`,
    signal ? { signal } : {},
  )
}

/**
 * Get one apartment's monthly consumption chart series (oldest first).
 */
export function getApartmentConsumption(
  apartmentId: string,
  months: number | string = 12,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ApartmentConsumptionResponse> {
  const query =
    months !== undefined && months !== null && String(months).trim() !== ''
      ? `?months=${encodeURIComponent(String(months))}`
      : ''
  const requestOptions = signal ? { signal } : {}
  return apiRequest<ApartmentConsumptionResponse>(
    `/meters/apartments/${encodeURIComponent(apartmentId)}/consumption${query}`,
    requestOptions,
  )
}

/**
 * Get whole-building monthly consumption totals and averages for staff (CHAIRMAN, BOARD, ACCOUNTANT).
 */
export function getBuildingConsumption(
  months: number | string = 12,
  { signal }: { signal?: AbortSignal } = {},
): Promise<BuildingConsumptionResponse> {
  const query =
    months !== undefined && months !== null && String(months).trim() !== ''
      ? `?months=${encodeURIComponent(String(months))}`
      : ''
  const requestOptions = signal ? { signal } : {}
  return apiRequest<BuildingConsumptionResponse>(`/meters/consumption${query}`, requestOptions)
}
