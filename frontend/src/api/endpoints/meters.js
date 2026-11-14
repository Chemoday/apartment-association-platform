import { apiRequest } from '../client.js'

/**
 * List all billing periods of the building, newest first.
 * Added in PR #31 (GET /api/v1/meters/periods).
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import('../schema').PeriodDTO[]>}
 */
export async function listPeriods({ signal } = {}) {
  const res = await apiRequest('/meters/periods', signal ? { signal } : {})
  if (Array.isArray(res)) return res
  if (res && Array.isArray(res.periods)) return res.periods
  return []
}

/**
 * Load resident meter dashboard for an optional period_code.
 * @param {string | null} [periodCode]
 * @returns {Promise<import('../schema').DashboardResponse>}
 */
export function getMyDashboard(periodCode = null) {
  const query = periodCode ? `?period_code=${encodeURIComponent(periodCode)}` : ''
  return apiRequest(`/meters/my-dashboard${query}`)
}

/**
 * Submit a meter reading (supports confirmation_level 0, 1, 2 and optional reason).
 * @param {import('../schema').ReadingSubmitRequest} payload
 * @returns {Promise<import('../schema').ReadingResponse>}
 */
export function submitReading(payload) {
  return apiRequest('/meters/readings', {
    method: 'POST',
    body: payload,
  })
}

/**
 * Get audit history for a specific reading_id.
 * @param {string} readingId
 * @returns {Promise<import('../schema').ReadingHistoryResponse>}
 */
export function getReadingHistory(readingId) {
  return apiRequest(`/meters/readings/${encodeURIComponent(readingId)}/history`)
}

/**
 * Get period consumption matrix for board/chairman/accountant.
 * @param {string} periodCode
 * @returns {Promise<import('../schema').MatrixResponse>}
 */
export function getPeriodMatrix(periodCode, { signal } = {}) {
  return apiRequest(
    `/meters/periods/${encodeURIComponent(periodCode)}/matrix`,
    signal ? { signal } : {},
  )
}

/**
 * Auto-estimate missing readings in a period (only in REVIEW_BY_BOARD).
 * @param {string} periodCode
 * @returns {Promise<import('../schema').EstimateResponse>}
 */
export function estimateMissingReadings(periodCode) {
  return apiRequest(`/meters/periods/${encodeURIComponent(periodCode)}/estimate-missing`, {
    method: 'POST',
  })
}

/**
 * Transition period status (OPEN_FOR_RESIDENTS <-> REVIEW_BY_BOARD <-> LOCKED).
 * @param {string} periodCode
 * @param {import('../schema').PeriodStatus} status
 * @returns {Promise<import('../schema').PeriodStatusUpdateResponse>}
 */
export function changePeriodStatus(periodCode, status) {
  return apiRequest(`/meters/periods/${encodeURIComponent(periodCode)}/status`, {
    method: 'PATCH',
    body: { status },
  })
}

/**
 * Export period readings as CSV (raw Response for Blob download).
 * @param {string} periodCode
 * @returns {Promise<Response>}
 */
export function exportPeriodCsv(periodCode) {
  return apiRequest(`/meters/periods/${encodeURIComponent(periodCode)}/export-csv`, {
    raw: true,
  })
}

/**
 * Get the reading history of one apartment across the latest 24 periods.
 * @param {string} apartmentId
 * @returns {Promise<import('../schema').ApartmentReadingsResponse>}
 */
export function getApartmentReadings(apartmentId) {
  return apiRequest(`/meters/apartments/${encodeURIComponent(apartmentId)}/readings`)
}

/**
 * Get one apartment's monthly consumption chart series (oldest first).
 * @param {string} apartmentId
 * @param {number | string} [months=12] - 1..24
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import('../schema').ApartmentConsumptionResponse>}
 */
export function getApartmentConsumption(apartmentId, months = 12, { signal } = {}) {
  const query =
    months !== undefined && months !== null && String(months).trim() !== ''
      ? `?months=${encodeURIComponent(String(months))}`
      : ''
  const requestOptions = signal ? { signal } : {}
  return apiRequest(
    `/meters/apartments/${encodeURIComponent(apartmentId)}/consumption${query}`,
    requestOptions,
  )
}

/**
 * Get whole-building monthly consumption totals and averages for staff (CHAIRMAN, BOARD, ACCOUNTANT).
 * @param {number | string} [months=12] - 1..24
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import('../schema').BuildingConsumptionResponse>}
 */
export function getBuildingConsumption(months = 12, { signal } = {}) {
  const query =
    months !== undefined && months !== null && String(months).trim() !== ''
      ? `?months=${encodeURIComponent(String(months))}`
      : ''
  const requestOptions = signal ? { signal } : {}
  return apiRequest(`/meters/consumption${query}`, requestOptions)
}

