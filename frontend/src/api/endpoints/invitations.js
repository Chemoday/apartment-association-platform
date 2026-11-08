import { apiRequest } from '../client.js'

/**
 * Send an invitation (Owner -> TENANT, Chairman -> OWNER | STAFF).
 * Uses discriminated union shapes from docs/openapi.json (additionalProperties: false).
 * @param {import('../schema').components['schemas']['OwnerInvitationCreate'] | import('../schema').components['schemas']['TenantInvitationCreate'] | import('../schema').components['schemas']['StaffInvitationCreate']} payload
 * @returns {Promise<import('../schema').components['schemas']['InvitationView']>}
 */
export function createInvitation(payload) {
  let body
  if (payload.kind === 'OWNER') {
    body = {
      kind: 'OWNER',
      email: payload.email,
      apartment_number: payload.apartment_number,
    }
  } else if (payload.kind === 'TENANT') {
    body = {
      kind: 'TENANT',
      email: payload.email,
      apartment_id: payload.apartment_id,
    }
  } else {
    body = {
      kind: 'STAFF',
      email: payload.email,
      building_role: payload.building_role,
    }
  }
  return apiRequest('/auth/invitations', {
    method: 'POST',
    body,
  })
}

/**
 * List all building invitations (Chairman -> all; Owner -> their apartments' TENANT invitations), newest first.
 * @returns {Promise<import('../schema').components['schemas']['InvitationView'][]>}
 */
export function listInvitations() {
  return apiRequest('/auth/invitations')
}

/**
 * Resend a pending or expired invitation.
 * @param {string} invitationId
 * @returns {Promise<import('../schema').components['schemas']['InvitationView']>}
 */
export function resendInvitation(invitationId) {
  return apiRequest(`/auth/invitations/${encodeURIComponent(invitationId)}/resend`, {
    method: 'POST',
  })
}

/**
 * Delete a pending, expired, or no-longer-valid invitation.
 * @param {string} invitationId
 * @returns {Promise<null>}
 */
export function deleteInvitation(invitationId) {
  return apiRequest(`/auth/invitations/${encodeURIComponent(invitationId)}`, {
    method: 'DELETE',
  })
}

/**
 * Get active residents and pending tenant invitations for an owned apartment.
 * @param {string} apartmentId
 * @returns {Promise<import('../schema').components['schemas']['ResidentsResponse']>}
 */
export function getResidents(apartmentId) {
  return apiRequest(`/auth/apartments/${encodeURIComponent(apartmentId)}/residents`)
}

/**
 * Remove a tenant from an owned apartment by user_id.
 * @param {string} apartmentId
 * @param {string} userId
 * @returns {Promise<null>}
 */
export function removeTenant(apartmentId, userId) {
  return apiRequest(
    `/auth/apartments/${encodeURIComponent(apartmentId)}/tenants/${encodeURIComponent(userId)}`,
    {
      method: 'DELETE',
    },
  )
}

/**
 * Atomically end a tenant's membership and invite a replacement tenant for an owned apartment.
 * @param {string} apartmentId
 * @param {string} userId
 * @param {string | import('../schema').components['schemas']['ReplaceTenantRequest']} emailOrPayload
 * @returns {Promise<import('../schema').components['schemas']['InvitationView']>}
 */
export function replaceTenant(apartmentId, userId, emailOrPayload) {
  const email =
    typeof emailOrPayload === 'object' && emailOrPayload !== null
      ? emailOrPayload.email
      : emailOrPayload
  return apiRequest(
    `/auth/apartments/${encodeURIComponent(apartmentId)}/tenants/${encodeURIComponent(userId)}/replace`,
    {
      method: 'POST',
      body: { email },
    },
  )
}
