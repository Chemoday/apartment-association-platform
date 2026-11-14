import { apiRequest, apiUpload } from '../client.js'

/**
 * GET /api/v1/issues/form
 * Returns form options for reporting an issue:
 * { urgent_enabled, apartment_ids, entrances }
 * @returns {Promise<import('../schema.d.ts').IssueForm>}
 */
export function getIssueForm() {
  return apiRequest('/issues/form', { method: 'GET' })
}

/**
 * GET /api/v1/issues
 * Lists open issues and issues that ended within the last 30 days (or older when include_old=true for board).
 * @param {Object} [params]
 * @param {string} [params.status] - 'OPEN' | 'ENDED' | IssueStatus
 * @param {string} [params.category] - IssueCategory
 * @param {number|string} [params.entrance] - 0 for outside/whole building, 1..N for entrance
 * @param {boolean} [params.include_old] - Board only: include ended issues older than 30 days and withdrawn issues
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 * @returns {Promise<import('../schema.d.ts').IssueSummary[]>}
 */
export function listIssues(params = {}) {
  const search = new URLSearchParams()
  if (params.status) search.set('status', String(params.status))
  if (params.category) search.set('category', String(params.category))
  if (params.entrance !== undefined && params.entrance !== null && params.entrance !== '') {
    search.set('entrance', String(params.entrance))
  }
  if (params.include_old) {
    search.set('include_old', 'true')
  }
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const qs = search.toString()
  return apiRequest(`/issues${qs ? `?${qs}` : ''}`, { method: 'GET' })
}

/**
 * GET /api/v1/issues/{issue_id}
 * Returns full details of a single issue including description and timeline.
 * @param {string} issueId
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import('../schema.d.ts').IssueView>}
 */
export function getIssue(issueId, { signal } = {}) {
  return apiRequest(`/issues/${encodeURIComponent(issueId)}`, { method: 'GET', signal })
}

/**
 * POST /api/v1/issues
 * Reports a common-area issue.
 * @param {import('../schema.d.ts').IssueReport} payload
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import('../schema.d.ts').IssueView>}
 */
export function createIssue(payload, { signal } = {}) {
  return apiRequest('/issues', {
    method: 'POST',
    body: payload,
    signal,
  })
}

/**
 * PATCH /api/v1/issues/{issue_id}
 * Edits a reported issue while its status is still REPORTED.
 * @param {string} issueId
 * @param {import('../schema.d.ts').IssueEdit} payload
 * @returns {Promise<import('../schema.d.ts').IssueView>}
 */
export function editIssue(issueId, payload) {
  return apiRequest(`/issues/${encodeURIComponent(issueId)}`, {
    method: 'PATCH',
    body: payload,
  })
}

/**
 * POST /api/v1/issues/{issue_id}/withdraw
 * Withdraws a reported issue while its status is still REPORTED.
 * @param {string} issueId
 * @returns {Promise<import('../schema.d.ts').IssueView>}
 */
export function withdrawIssue(issueId) {
  return apiRequest(`/issues/${encodeURIComponent(issueId)}/withdraw`, {
    method: 'POST',
  })
}

/**
 * PUT /api/v1/issues/{issue_id}/follow
 * Follows an open issue ("+1 / I see it too"). Idempotent.
 * @param {string} issueId
 * @returns {Promise<import('../schema.d.ts').IssueView>}
 */
export function followIssue(issueId) {
  return apiRequest(`/issues/${encodeURIComponent(issueId)}/follow`, {
    method: 'PUT',
  })
}

/**
 * DELETE /api/v1/issues/{issue_id}/follow
 * Stops following an open issue. Idempotent.
 * @param {string} issueId
 * @returns {Promise<import('../schema.d.ts').IssueView>}
 */
export function unfollowIssue(issueId) {
  return apiRequest(`/issues/${encodeURIComponent(issueId)}/follow`, {
    method: 'DELETE',
  })
}

/**
 * POST /api/v1/issues/{issue_id}/status
 * Board & Chairman workflow: moves an issue on, marks duplicate, declines, or reopens within 30 days.
 * @param {string} issueId
 * @param {import('../schema.d.ts').StatusChange} payload
 * @returns {Promise<import('../schema.d.ts').IssueView>}
 */
export function changeIssueStatus(issueId, payload) {
  return apiRequest(`/issues/${encodeURIComponent(issueId)}/status`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * POST /api/v1/issues/{issue_id}/urgent/clear
 * Board & Chairman workflow: clears a false urgent flag on an open issue.
 * @param {string} issueId
 * @returns {Promise<import('../schema.d.ts').IssueView>}
 */
export function clearIssueUrgent(issueId) {
  return apiRequest(`/issues/${encodeURIComponent(issueId)}/urgent/clear`, {
    method: 'POST',
  })
}

/**
 * POST /api/v1/issues/{issue_id}/photos
 * Uploads a single client-scaled JPEG photo with upload progress and idempotency key.
 * @param {string} issueId
 * @param {Blob} jpegBlob
 * @param {Object} [options]
 * @param {string} [options.idempotencyKey]
 * @param {(loaded: number, total: number) => void} [options.onProgress]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<import('../schema.d.ts').IssuePhoto>}
 */
export function uploadIssuePhoto(issueId, jpegBlob, { idempotencyKey, onProgress, signal } = {}) {
  return apiUpload(`/issues/${encodeURIComponent(issueId)}/photos`, {
    method: 'POST',
    body: jpegBlob,
    contentType: 'image/jpeg',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    onProgress,
    signal,
  })
}

/**
 * GET /api/v1/issues/{issue_id}/photos/{photo_id}?variant=display|thumb
 * Fetches an authenticated image variant as a Blob.
 * @param {string} issueId
 * @param {string} photoId
 * @param {import('../schema.d.ts').PhotoVariant} [variant]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Blob>}
 */
export async function fetchIssuePhotoBlob(issueId, photoId, variant = 'display', { signal } = {}) {
  const qs = variant ? `?variant=${encodeURIComponent(variant)}` : ''
  const response = await apiRequest(
    `/issues/${encodeURIComponent(issueId)}/photos/${encodeURIComponent(photoId)}${qs}`,
    {
      method: 'GET',
      raw: true,
      signal,
    },
  )
  return response.blob()
}

/**
 * DELETE /api/v1/issues/{issue_id}/photos/{photo_id}
 * Deletes a photo (uploader while issue is open; chairman/board anytime). Returns 204.
 * @param {string} issueId
 * @param {string} photoId
 * @returns {Promise<null>}
 */
export function deleteIssuePhoto(issueId, photoId) {
  return apiRequest(
    `/issues/${encodeURIComponent(issueId)}/photos/${encodeURIComponent(photoId)}`,
    {
      method: 'DELETE',
    },
  )
}
