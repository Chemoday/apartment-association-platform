import { apiRequest } from '../client.js'
import type {
  BulkInvitationReport,
  BulkInvitationRequest,
  InvitationView,
  OwnerInvitationCreate,
  ReplaceTenantRequest,
  ResidentsResponse,
  StaffInvitationCreate,
  TenantInvitationCreate,
} from '../schema.js'

export type InvitationCreate =
  | OwnerInvitationCreate
  | TenantInvitationCreate
  | StaffInvitationCreate

/**
 * Send an invitation (Owner -> TENANT, Chairman -> OWNER | STAFF).
 * Uses discriminated union shapes from docs/openapi.json (additionalProperties: false).
 */
export function createInvitation(payload: InvitationCreate): Promise<InvitationView> {
  let body: InvitationCreate
  if (payload.kind === 'OWNER') {
    const ownerPayload = payload as OwnerInvitationCreate
    body = {
      kind: 'OWNER',
      email: ownerPayload.email,
      apartment_number: ownerPayload.apartment_number,
      ...(ownerPayload.apartment_kind ? { apartment_kind: ownerPayload.apartment_kind } : {}),
    }
  } else if (payload.kind === 'TENANT') {
    body = {
      kind: 'TENANT',
      email: payload.email,
      apartment_id: (payload as TenantInvitationCreate).apartment_id,
    }
  } else {
    body = {
      kind: 'STAFF',
      email: payload.email,
      building_role: (payload as StaffInvitationCreate).building_role,
    }
  }
  return apiRequest<InvitationView>('/auth/invitations', {
    method: 'POST',
    body,
  })
}

/**
 * List all building invitations (Chairman -> all; Owner -> their apartments' TENANT invitations), newest first.
 */
export function listInvitations(
  options: { signal?: AbortSignal } = {},
): Promise<InvitationView[]> {
  return apiRequest<InvitationView[]>(
    '/auth/invitations',
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Resend a pending or expired invitation.
 */
export function resendInvitation(invitationId: string): Promise<InvitationView> {
  return apiRequest<InvitationView>(
    `/auth/invitations/${encodeURIComponent(invitationId)}/resend`,
    {
      method: 'POST',
    },
  )
}

/**
 * Delete a pending, expired, or no-longer-valid invitation.
 */
export function deleteInvitation(invitationId: string): Promise<null> {
  return apiRequest<null>(`/auth/invitations/${encodeURIComponent(invitationId)}`, {
    method: 'DELETE',
  })
}

/**
 * Get active residents and pending tenant invitations for an owned apartment.
 */
export function getResidents(
  apartmentId: string,
  options: { signal?: AbortSignal } = {},
): Promise<ResidentsResponse> {
  return apiRequest<ResidentsResponse>(
    `/auth/apartments/${encodeURIComponent(apartmentId)}/residents`,
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Remove a tenant from an owned apartment by user_id.
 */
export function removeTenant(apartmentId: string, userId: string): Promise<null> {
  return apiRequest<null>(
    `/auth/apartments/${encodeURIComponent(apartmentId)}/tenants/${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
    },
  )
}

/**
 * Atomically end a tenant's membership and invite a replacement tenant for an owned apartment.
 */
export function replaceTenant(
  apartmentId: string,
  userId: string,
  emailOrPayload: string | ReplaceTenantRequest,
): Promise<InvitationView> {
  const email =
    typeof emailOrPayload === 'object' && emailOrPayload !== null
      ? emailOrPayload.email
      : emailOrPayload
  return apiRequest<InvitationView>(
    `/auth/apartments/${encodeURIComponent(apartmentId)}/tenants/${encodeURIComponent(userId)}/replace`,
    {
      method: 'POST',
      body: { email },
    },
  )
}

/**
 * Preview a bulk owner-invitation list without sending any invitations (#057 + #069).
 */
export function previewBulkInvitations(text: string): Promise<BulkInvitationReport> {
  const body: BulkInvitationRequest = { text }
  return apiRequest<BulkInvitationReport>('/auth/invitations/bulk/preview', {
    method: 'POST',
    body,
  })
}

/**
 * Send all READY owner invitations from a pasted/loaded list (#057 + #069).
 */
export function sendBulkInvitations(text: string): Promise<BulkInvitationReport> {
  const body: BulkInvitationRequest = { text }
  return apiRequest<BulkInvitationReport>('/auth/invitations/bulk', {
    method: 'POST',
    body,
  })
}
