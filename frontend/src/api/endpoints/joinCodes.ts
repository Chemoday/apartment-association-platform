import { apiRequest } from '../client.js'
import type {
  JoinCodesIssue,
  JoinCodesIssued,
  JoinCodeView,
} from '../schema.js'

/**
 * Issue paper join codes for specific objects or for all objects without an owner/pending flow (`null`).
 * Plaintext codes are returned ONLY in this response (#059 + #069).
 */
export function issueJoinCodes(apartmentIds: string[] | null): Promise<JoinCodesIssued> {
  const body: JoinCodesIssue = { apartment_ids: apartmentIds }
  return apiRequest<JoinCodesIssued>('/auth/join-codes', {
    method: 'POST',
    body,
  })
}

/**
 * List currently unused join codes (without the plaintext code itself) (#059 + #069).
 */
export function listJoinCodes(options: { signal?: AbortSignal } = {}): Promise<JoinCodeView[]> {
  return apiRequest<JoinCodeView[]>(
    '/auth/join-codes',
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Cancel an unused join code (#059).
 */
export function cancelJoinCode(codeId: string): Promise<null> {
  return apiRequest<null>(`/auth/join-codes/${encodeURIComponent(codeId)}`, {
    method: 'DELETE',
  })
}
