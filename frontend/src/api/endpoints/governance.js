import { apiRequest } from '../client.js'

/**
 * List polls visible to the caller with optional status filter and pagination.
 * @param {{ status?: import('../schema').PollStatus | null, limit?: number, offset?: number }} [params]
 * @returns {Promise<import('../schema').PollSummary[]>}
 */
export function listPolls(params = {}) {
  const search = new URLSearchParams()
  if (params.status) search.set('status', params.status)
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const qs = search.toString()
  return apiRequest(`/governance/polls${qs ? `?${qs}` : ''}`)
}

/**
 * Get a single poll detail with questions, options, and caller's ballots.
 * @param {string} pollId
 * @returns {Promise<import('../schema').PollView>}
 */
export function getPoll(pollId) {
  return apiRequest(`/governance/polls/${encodeURIComponent(pollId)}`)
}

/**
 * Submit or replace a ballot for a poll.
 * Sends apartment_id only when unit is APARTMENT and answerable_apartment_ids has >1 item;
 * never sends apartment_id for unit PERSON.
 * @param {string} pollId
 * @param {import('../schema').BallotRequest} payload
 * @returns {Promise<import('../schema').PollView>}
 */
export function submitBallot(pollId, payload) {
  const body = {
    answers: Array.isArray(payload.answers) ? payload.answers : [],
  }
  if (payload.apartment_id) {
    body.apartment_id = payload.apartment_id
  }
  return apiRequest(`/governance/polls/${encodeURIComponent(pollId)}/ballot`, {
    method: 'PUT',
    body,
  })
}

/**
 * Create a new draft poll (board only).
 * @param {import('../schema').PollDraftRequest} payload
 * @returns {Promise<import('../schema').PollView>}
 */
export function createPollDraft(payload) {
  return apiRequest('/governance/polls', {
    method: 'POST',
    body: payload,
  })
}

/**
 * Replace an existing draft poll (board only).
 * @param {string} pollId
 * @param {import('../schema').PollDraftRequest} payload
 * @returns {Promise<import('../schema').PollView>}
 */
export function replacePollDraft(pollId, payload) {
  return apiRequest(`/governance/polls/${encodeURIComponent(pollId)}`, {
    method: 'PUT',
    body: payload,
  })
}

/**
 * Delete a draft poll (board only).
 * @param {string} pollId
 * @returns {Promise<null>}
 */
export function deletePollDraft(pollId) {
  return apiRequest(`/governance/polls/${encodeURIComponent(pollId)}`, {
    method: 'DELETE',
  })
}

/**
 * Open a draft poll, fixing its questions and electorate (board only).
 * @param {string} pollId
 * @returns {Promise<import('../schema').PollView>}
 */
export function openPoll(pollId) {
  return apiRequest(`/governance/polls/${encodeURIComponent(pollId)}/open`, {
    method: 'POST',
  })
}

/**
 * Close an open poll early (board only).
 * @param {string} pollId
 * @returns {Promise<import('../schema').PollView>}
 */
export function closePoll(pollId) {
  return apiRequest(`/governance/polls/${encodeURIComponent(pollId)}/close`, {
    method: 'POST',
  })
}

/**
 * Cancel an open poll (board only).
 * @param {string} pollId
 * @returns {Promise<import('../schema').PollView>}
 */
export function cancelPoll(pollId) {
  return apiRequest(`/governance/polls/${encodeURIComponent(pollId)}/cancel`, {
    method: 'POST',
  })
}

/**
 * Extend the closing deadline of an open poll (board only).
 * @param {string} pollId
 * @param {string | { closes_at: string }} closesAt
 * @returns {Promise<import('../schema').PollView>}
 */
export function extendPollDeadline(pollId, closesAt) {
  const body = typeof closesAt === 'string' ? { closes_at: closesAt } : closesAt
  return apiRequest(`/governance/polls/${encodeURIComponent(pollId)}`, {
    method: 'PATCH',
    body,
  })
}

/**
 * Get aggregated poll results (board while open or closed; everyone else once closed).
 * @param {string} pollId
 * @returns {Promise<import('../schema').PollResults>}
 */
export function getPollResults(pollId) {
  return apiRequest(`/governance/polls/${encodeURIComponent(pollId)}/results`)
}

