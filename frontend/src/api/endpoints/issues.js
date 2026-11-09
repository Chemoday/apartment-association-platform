import { apiRequest } from '../client.js'

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
 * @returns {Promise<import('../schema.d.ts').IssueView>}
 */
export function getIssue(issueId) {
  return apiRequest(`/issues/${encodeURIComponent(issueId)}`, { method: 'GET' })
}

/**
 * POST /api/v1/issues
 * Reports a common-area issue.
 * @param {import('../schema.d.ts').IssueReport} payload
 * @returns {Promise<import('../schema.d.ts').IssueView>}
 */
export function createIssue(payload) {
  return apiRequest('/issues', {
    method: 'POST',
    body: payload,
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
