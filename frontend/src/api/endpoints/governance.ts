import { apiRequest } from '../client.js'
import type {
  BallotRequest,
  DeadlineUpdate,
  PollDraftRequest,
  PollResults,
  PollStatus,
  PollSummary,
  PollView,
} from '../schema.js'

/**
 * List polls visible to the caller with optional status filter and pagination.
 */
export function listPolls(
  params: { status?: PollStatus | string | null; limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<PollSummary[]> {
  const search = new URLSearchParams()
  if (params.status) search.set('status', params.status)
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const qs = search.toString()
  return apiRequest<PollSummary[]>(
    `/governance/polls${qs ? `?${qs}` : ''}`,
    params.signal ? { signal: params.signal } : {},
  )
}

/**
 * Get a single poll detail with questions, options, and caller's ballots.
 */
export function getPoll(
  pollId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PollView> {
  return apiRequest<PollView>(
    `/governance/polls/${encodeURIComponent(pollId)}`,
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Submit or replace a ballot for a poll.
 * Sends apartment_id only when unit is APARTMENT and answerable_apartment_ids has >1 item;
 * never sends apartment_id for unit PERSON.
 */
export function submitBallot(pollId: string, payload: BallotRequest): Promise<PollView> {
  const body: BallotRequest = {
    answers: Array.isArray(payload.answers) ? payload.answers : [],
  }
  if (payload.apartment_id) {
    body.apartment_id = payload.apartment_id
  }
  return apiRequest<PollView>(`/governance/polls/${encodeURIComponent(pollId)}/ballot`, {
    method: 'PUT',
    body,
  })
}

/**
 * Create a new draft poll (board only).
 */
export function createPollDraft(payload: PollDraftRequest): Promise<PollView> {
  return apiRequest<PollView>('/governance/polls', {
    method: 'POST',
    body: payload,
  })
}

/**
 * Replace an existing draft poll (board only).
 */
export function replacePollDraft(pollId: string, payload: PollDraftRequest): Promise<PollView> {
  return apiRequest<PollView>(`/governance/polls/${encodeURIComponent(pollId)}`, {
    method: 'PUT',
    body: payload,
  })
}

/**
 * Delete a draft poll (board only).
 */
export function deletePollDraft(pollId: string): Promise<null> {
  return apiRequest<null>(`/governance/polls/${encodeURIComponent(pollId)}`, {
    method: 'DELETE',
  })
}

/**
 * Open a draft poll, fixing its questions and electorate (board only).
 */
export function openPoll(pollId: string): Promise<PollView> {
  return apiRequest<PollView>(`/governance/polls/${encodeURIComponent(pollId)}/open`, {
    method: 'POST',
  })
}

/**
 * Close an open poll early (board only).
 */
export function closePoll(pollId: string): Promise<PollView> {
  return apiRequest<PollView>(`/governance/polls/${encodeURIComponent(pollId)}/close`, {
    method: 'POST',
  })
}

/**
 * Cancel an open poll (board only).
 */
export function cancelPoll(pollId: string): Promise<PollView> {
  return apiRequest<PollView>(`/governance/polls/${encodeURIComponent(pollId)}/cancel`, {
    method: 'POST',
  })
}

/**
 * Extend the closing deadline of an open poll (board only).
 */
export function extendPollDeadline(
  pollId: string,
  closesAt: string | DeadlineUpdate,
): Promise<PollView> {
  const body: DeadlineUpdate =
    typeof closesAt === 'string' ? { closes_at: closesAt } : closesAt
  return apiRequest<PollView>(`/governance/polls/${encodeURIComponent(pollId)}`, {
    method: 'PATCH',
    body,
  })
}

/**
 * Get aggregated poll results (board while open or closed; everyone else once closed).
 */
export function getPollResults(
  pollId: string,
  options: { signal?: AbortSignal } = {},
): Promise<PollResults> {
  return apiRequest<PollResults>(
    `/governance/polls/${encodeURIComponent(pollId)}/results`,
    options.signal ? { signal: options.signal } : {},
  )
}
