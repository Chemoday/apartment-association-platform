import { apiRequest } from '../client.js'

/**
 * Request a magic sign-in link via e-mail (always 202).
 * @param {string} email
 * @returns {Promise<import('../schema').components['schemas']['MagicLinkAccepted']>}
 */
export function requestMagicLink(email) {
  return apiRequest('/auth/magic-link', { method: 'POST', body: { email } })
}

/**
 * Redeem a magic link token from the URL fragment.
 * @param {string} token
 * @returns {Promise<import('../schema').components['schemas']['SignInResponse']>}
 */
export function redeemLink(token) {
  return apiRequest('/auth/magic-link/redeem', { method: 'POST', body: { token } })
}

/**
 * End the current session and clear the refresh cookie (204).
 * @returns {Promise<null>}
 */
export function logout() {
  return apiRequest('/auth/logout', { method: 'POST' })
}

/**
 * List the caller's active sessions, newest first.
 * @returns {Promise<import('../schema').components['schemas']['SessionView'][]>}
 */
export function listSessions() {
  return apiRequest('/auth/sessions')
}

/**
 * End a specific session by session_id.
 * @param {string} sessionId
 * @returns {Promise<null>}
 */
export function endSession(sessionId) {
  return apiRequest(`/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

/**
 * End all sessions everywhere for the current user.
 * @returns {Promise<null>}
 */
export function endAllSessions() {
  return apiRequest('/auth/sessions', { method: 'DELETE' })
}

/**
 * Complete account registration from an invitation link (Section 7, A4).
 * @param {import('../schema').components['schemas']['RegistrationRequest']} payload
 * @returns {Promise<import('../schema').components['schemas']['SignInResponse']>}
 */
export function completeRegistration(payload) {
  return apiRequest('/auth/registration', { method: 'POST', body: payload })
}

/**
 * Accept an invitation for an already-registered user (Section 7, A4).
 * @param {string} token
 * @returns {Promise<import('../schema').components['schemas']['AcceptResponse']>}
 */
export function acceptInvitation(token) {
  return apiRequest('/auth/invitations/accept', { method: 'POST', body: { token } })
}

/**
 * Sign in with email + password (POST /api/v1/auth/password/login).
 * @param {string | import('../schema').components['schemas']['PasswordLoginRequest']} emailOrPayload
 * @param {string} [passwordArg]
 * @returns {Promise<import('../schema').components['schemas']['SessionResponse']>}
 */
export function passwordLogin(emailOrPayload, passwordArg) {
  const email =
    typeof emailOrPayload === 'object' && emailOrPayload !== null
      ? emailOrPayload.email
      : emailOrPayload
  const password =
    typeof emailOrPayload === 'object' && emailOrPayload !== null
      ? emailOrPayload.password
      : passwordArg
  return apiRequest('/auth/password/login', {
    method: 'POST',
    body: { email, password },
  })
}

/**
 * Get current user's password status (GET /api/v1/auth/password).
 * @returns {Promise<import('../schema').components['schemas']['PasswordStatus']>}
 */
export function getPasswordStatus() {
  return apiRequest('/auth/password')
}

/**
 * Set or change the current user's password (PUT /api/v1/auth/password).
 * @param {string | import('../schema').components['schemas']['PasswordUpdate']} newPasswordOrPayload
 * @param {string} [currentPasswordArg]
 * @returns {Promise<null>}
 */
export function setPassword(newPasswordOrPayload, currentPasswordArg) {
  const new_password =
    typeof newPasswordOrPayload === 'object' && newPasswordOrPayload !== null
      ? newPasswordOrPayload.new_password
      : newPasswordOrPayload
  const current_password =
    typeof newPasswordOrPayload === 'object' && newPasswordOrPayload !== null
      ? newPasswordOrPayload.current_password
      : currentPasswordArg
  const body = { new_password }
  if (current_password) {
    body.current_password = current_password
  }
  return apiRequest('/auth/password', {
    method: 'PUT',
    body,
  })
}

/**
 * Remove the current user's password (DELETE /api/v1/auth/password).
 * @param {string | import('../schema').components['schemas']['PasswordRemove']} [currentPasswordOrPayload]
 * @returns {Promise<null>}
 */
export function removePassword(currentPasswordOrPayload) {
  const current_password =
    typeof currentPasswordOrPayload === 'object' && currentPasswordOrPayload !== null
      ? currentPasswordOrPayload.current_password
      : currentPasswordOrPayload
  const options = { method: 'DELETE' }
  if (current_password) {
    options.body = { current_password }
  }
  return apiRequest('/auth/password', options)
}

/**
 * List all building people for Chairman administration (A4).
 * @returns {Promise<import('../schema').components['schemas']['PeopleResponse']>}
 */
export function listPeople() {
  return apiRequest('/auth/users')
}

/**
 * Change a person's building role (A4).
 * @param {string} userId
 * @param {import('../schema').components['schemas']['BuildingRole'] | import('../schema').components['schemas']['RoleUpdate']} roleOrPayload
 * @returns {Promise<import('../schema').components['schemas']['RoleUpdateResponse']>}
 */
export function setRole(userId, roleOrPayload) {
  const building_role =
    typeof roleOrPayload === 'object' && roleOrPayload !== null
      ? roleOrPayload.building_role
      : roleOrPayload
  return apiRequest(`/auth/users/${encodeURIComponent(userId)}/role`, {
    method: 'PUT',
    body: { building_role },
  })
}

/**
 * End an apartment membership for a user (A4).
 * @param {string} userId
 * @param {string} membershipId
 * @returns {Promise<null>}
 */
export function endMembership(userId, membershipId) {
  return apiRequest(
    `/auth/users/${encodeURIComponent(userId)}/memberships/${encodeURIComponent(membershipId)}`,
    {
      method: 'DELETE',
    },
  )
}

/**
 * Close a user's account immediately (A4).
 * @param {string} userId
 * @returns {Promise<null>}
 */
export function closeAccount(userId) {
  return apiRequest(`/auth/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
}
