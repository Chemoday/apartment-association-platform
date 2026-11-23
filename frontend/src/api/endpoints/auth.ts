import { apiRequest } from '../client.js'
import type {
  AcceptResponse,
  BuildingRole,
  MagicLinkAccepted,
  PasswordLoginRequest,
  PasswordRemove,
  PasswordStatus,
  PasswordUpdate,
  PeopleResponse,
  RegistrationRequest,
  RoleUpdate,
  RoleUpdateResponse,
  SessionResponse,
  SessionView,
  SignInResponse,
} from '../schema.js'

/**
 * Request a magic sign-in link via e-mail (always 202).
 */
export function requestMagicLink(email: string): Promise<MagicLinkAccepted> {
  return apiRequest<MagicLinkAccepted>('/auth/magic-link', { method: 'POST', body: { email } })
}

/**
 * Redeem a magic link token from the URL fragment.
 */
export function redeemLink(token: string): Promise<SignInResponse> {
  return apiRequest<SignInResponse>('/auth/magic-link/redeem', { method: 'POST', body: { token } })
}

/**
 * End the current session and clear the refresh cookie (204).
 */
export function logout(): Promise<null> {
  return apiRequest<null>('/auth/logout', { method: 'POST' })
}

/**
 * List the caller's active sessions, newest first.
 */
export function listSessions(): Promise<SessionView[]> {
  return apiRequest<SessionView[]>('/auth/sessions')
}

/**
 * End a specific session by session_id.
 */
export function endSession(sessionId: string): Promise<null> {
  return apiRequest<null>(`/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
}

/**
 * End all sessions everywhere for the current user.
 */
export function endAllSessions(): Promise<null> {
  return apiRequest<null>('/auth/sessions', { method: 'DELETE' })
}

/**
 * Complete account registration from an invitation link (Section 7, A4).
 */
export function completeRegistration(payload: RegistrationRequest): Promise<SignInResponse> {
  return apiRequest<SignInResponse>('/auth/registration', { method: 'POST', body: payload })
}

/**
 * Accept an invitation for an already-registered user (Section 7, A4).
 */
export function acceptInvitation(token: string): Promise<AcceptResponse> {
  return apiRequest<AcceptResponse>('/auth/invitations/accept', { method: 'POST', body: { token } })
}

/**
 * Sign in with email + password (POST /api/v1/auth/password/login).
 */
export function passwordLogin(
  emailOrPayload: string | PasswordLoginRequest,
  passwordArg?: string,
): Promise<SessionResponse> {
  const email =
    typeof emailOrPayload === 'object' && emailOrPayload !== null
      ? emailOrPayload.email
      : emailOrPayload
  const password =
    typeof emailOrPayload === 'object' && emailOrPayload !== null
      ? emailOrPayload.password
      : passwordArg || ''
  return apiRequest<SessionResponse>('/auth/password/login', {
    method: 'POST',
    body: { email, password },
  })
}

/**
 * Get current user's password status (GET /api/v1/auth/password).
 */
export function getPasswordStatus(): Promise<PasswordStatus> {
  return apiRequest<PasswordStatus>('/auth/password')
}

/**
 * Set or change the current user's password (PUT /api/v1/auth/password).
 */
export function setPassword(
  newPasswordOrPayload: string | PasswordUpdate,
  currentPasswordArg?: string | null,
): Promise<null> {
  const new_password =
    typeof newPasswordOrPayload === 'object' && newPasswordOrPayload !== null
      ? newPasswordOrPayload.new_password
      : newPasswordOrPayload
  const current_password =
    typeof newPasswordOrPayload === 'object' && newPasswordOrPayload !== null
      ? newPasswordOrPayload.current_password
      : currentPasswordArg
  const body: PasswordUpdate = { new_password }
  if (current_password) {
    body.current_password = current_password
  }
  return apiRequest<null>('/auth/password', {
    method: 'PUT',
    body,
  })
}

/**
 * Remove the current user's password (DELETE /api/v1/auth/password).
 */
export function removePassword(currentPasswordOrPayload?: string | PasswordRemove | null): Promise<null> {
  const current_password =
    typeof currentPasswordOrPayload === 'object' && currentPasswordOrPayload !== null
      ? currentPasswordOrPayload.current_password
      : currentPasswordOrPayload
  const options: { method: string; body?: PasswordRemove } = { method: 'DELETE' }
  if (current_password) {
    options.body = { current_password }
  }
  return apiRequest<null>('/auth/password', options)
}

/**
 * List all building people for Chairman administration (A4).
 */
export function listPeople(): Promise<PeopleResponse> {
  return apiRequest<PeopleResponse>('/auth/users')
}

/**
 * Change a person's building role (A4).
 */
export function setRole(
  userId: string,
  roleOrPayload: BuildingRole | RoleUpdate,
): Promise<RoleUpdateResponse> {
  const building_role =
    typeof roleOrPayload === 'object' && roleOrPayload !== null
      ? roleOrPayload.building_role
      : roleOrPayload
  return apiRequest<RoleUpdateResponse>(`/auth/users/${encodeURIComponent(userId)}/role`, {
    method: 'PUT',
    body: { building_role },
  })
}

/**
 * End an apartment membership for a user (A4).
 */
export function endMembership(userId: string, membershipId: string): Promise<null> {
  return apiRequest<null>(
    `/auth/users/${encodeURIComponent(userId)}/memberships/${encodeURIComponent(membershipId)}`,
    {
      method: 'DELETE',
    },
  )
}

/**
 * Close a user's account immediately (A4).
 */
export function closeAccount(userId: string): Promise<null> {
  return apiRequest<null>(`/auth/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  })
}
