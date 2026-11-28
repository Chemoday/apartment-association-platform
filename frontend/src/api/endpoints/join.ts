import { apiRequest } from '../client.js'
import type {
  InvitationView,
  JoinAccepted,
  JoinDecisionView,
  JoinLookup,
  JoinRequestView,
  JoinSubmit,
  JoinTarget,
  Locale,
  PrivacyNotice,
} from '../schema.js'

/**
 * Step 1 of public /join: look up a paper join code without authentication (#060 + #069).
 */
export function lookupJoinCode(joinCode: string): Promise<JoinTarget> {
  const body: JoinLookup = { join_code: joinCode }
  return apiRequest<JoinTarget>('/auth/join/lookup', {
    method: 'POST',
    body,
    noAuth: true,
  })
}

/**
 * Fetch the association's privacy notice (custom_url or Markdown template text) (#060).
 */
export function getJoinPrivacyNotice(locale: Locale): Promise<PrivacyNotice> {
  return apiRequest<PrivacyNotice>(
    `/auth/join/privacy-notice?locale=${encodeURIComponent(locale)}`,
    { noAuth: true },
  )
}

/**
 * Step 2 of public /join: submit a join request for chairman verification (#060).
 */
export function submitJoinRequest(payload: JoinSubmit): Promise<JoinAccepted> {
  return apiRequest<JoinAccepted>('/auth/join', {
    method: 'POST',
    body: payload,
    noAuth: true,
  })
}

/**
 * List pending join requests (chairman only, oldest first, no-store) (#061 + #069).
 */
export function listJoinRequests(
  options: { signal?: AbortSignal } = {},
): Promise<JoinRequestView[]> {
  return apiRequest<JoinRequestView[]>(
    '/auth/join-requests',
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Confirm a join request -> queues an OWNER invitation (#061).
 */
export function confirmJoinRequest(requestId: string): Promise<InvitationView> {
  return apiRequest<InvitationView>(
    `/auth/join-requests/${encodeURIComponent(requestId)}/confirm`,
    { method: 'POST' },
  )
}

/**
 * Reject a join request (#061).
 */
export function rejectJoinRequest(requestId: string): Promise<null> {
  return apiRequest<null>(
    `/auth/join-requests/${encodeURIComponent(requestId)}/reject`,
    { method: 'POST' },
  )
}

/**
 * List join decisions log (chairman & board, newest first, zero personal data) (#061 + #069).
 */
export function listJoinDecisions(
  params: { limit?: number; offset?: number; signal?: AbortSignal } = {},
): Promise<JoinDecisionView[]> {
  const qs = new URLSearchParams()
  if (typeof params.limit === 'number') qs.set('limit', String(params.limit))
  if (typeof params.offset === 'number') qs.set('offset', String(params.offset))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return apiRequest<JoinDecisionView[]>(
    `/auth/join-decisions${suffix}`,
    params.signal ? { signal: params.signal } : {},
  )
}
