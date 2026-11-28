import type { SeedUser } from '../state.js';
import { type RouteContext, sendJson, sendError, readBody } from '../http.js';
import {
  DEMO_APARTMENT_CARDS,
  DEMO_USERS,
  membershipsByUser,
  passwordsByUser,
  APARTMENT_ID_TO_NUMBER,
  NUMBER_TO_APARTMENT_ID,
  maskEmailServerSide,
  toInvitationView,
  isValidEmailFormat,
  resolveEmailToDemoUserId,
  getBearerAuthenticatedUser,
  serverStore,
  type MockPersonSummary,
  type MockInvitation,
} from '../state.js';
import {
  evaluateBulkInvitationsText,
  type BulkEvaluationError,
} from '../../utils/bulkInvitations.js';
import {
  buildConnectionItems,
  buildConnectionOverview,
} from '../../utils/connections.js';
import { normalizePhoneToE164 } from '../../utils/phone.js';

export async function handleAuthRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, urlObj, pathname, method, user } = ctx;

    if (pathname === '/api/v1/auth/refresh' && method === 'POST') {
      if (serverStore.activeSignedInUserId && serverStore.activeSessionsStore.some((s) => s.current)) {
        return sendJson(res, 200, {
          access_token: `mock-jwt-${serverStore.activeSignedInUserId}`,
          token_type: 'Bearer',
          expires_in: 900,
          session_id: '018f0000-0000-7000-8000-000000009901',
        });
      }
      return sendError(res, 401, 'SESSION_EXPIRED', 'No active session cookie in demo mode.');
    }

    if (pathname === '/api/v1/auth/logout' && method === 'POST') {
      serverStore.activeSignedInUserId = null;
      serverStore.activeSessionsStore = [];
      res.statusCode = 204;
      { res.end(); return true; }
    }

    if (pathname === '/api/v1/auth/magic-link' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      if (!email || !email.includes('@') || !email.split('@')[1]?.includes('.')) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Enter a valid e-mail address.');
      }
      serverStore.pendingMagicLinkEmail = email;
      serverStore.magicLinkTokenUsed = false;
      return sendJson(res, 202, { accepted: true });
    }

    if (pathname === '/api/v1/auth/magic-link/redeem' && method === 'POST') {
      const body = await readBody(req);
      const tokenStr = String(body.token || '');

      if (tokenStr.startsWith('demo-register-')) {
        // Format: demo-register-owner-14 | demo-register-tenant-14 | demo-register-staff-BOARD
        const parts = tokenStr.split('-');
        const kindRaw = (parts[2] || 'owner').toUpperCase();
        const targetVal = parts[3] || '14';
        const objKindRaw = (parts[4] || '').toUpperCase();
        const objKind =
          objKindRaw === 'PARKING' || objKindRaw === 'GARAGE' ? objKindRaw : 'APARTMENT';
        const invitation =
          kindRaw === 'STAFF'
            ? {
                kind: 'STAFF',
                apartment_number: null,
                apartment_kind: null,
                building_role: ['BOARD', 'ACCOUNTANT', 'CHAIRMAN'].includes(targetVal)
                  ? targetVal
                  : 'BOARD',
                country_code: 'EE',
              }
            : {
                kind: kindRaw === 'TENANT' ? 'TENANT' : 'OWNER',
                apartment_number: targetVal,
                apartment_kind: objKind,
                building_role: null,
                country_code: 'EE',
              };
        return sendJson(res, 200, {
          status: 'REGISTRATION_REQUIRED',
          registration_token: `reg-${Date.now()}`,
          expires_in: 1800,
          invitation,
        });
      }

      if (tokenStr.startsWith('demo-accept-')) {
        const parts = tokenStr.split('-');
        const kindRaw = (parts[2] || 'tenant').toUpperCase();
        const targetVal = parts[3] || '14';
        const objKindRaw = (parts[4] || '').toUpperCase();
        const objKind =
          objKindRaw === 'PARKING' || objKindRaw === 'GARAGE' ? objKindRaw : 'APARTMENT';
        return sendJson(res, 200, {
          status: 'SIGN_IN_TO_ACCEPT',
          invitation: {
            kind: kindRaw === 'OWNER' ? 'OWNER' : 'TENANT',
            apartment_number: targetVal,
            apartment_kind: objKind,
            building_role: null,
            country_code: 'EE',
          },
        });
      }

      if (
        (tokenStr === 'demo-valid-token' && !serverStore.magicLinkTokenUsed) ||
        tokenStr.startsWith('demo-user-')
      ) {
        if (tokenStr === 'demo-valid-token') {
          serverStore.magicLinkTokenUsed = true;
          serverStore.activeSignedInUserId = resolveEmailToDemoUserId(serverStore.pendingMagicLinkEmail);
        } else {
          const requestedId = tokenStr.replace('demo-user-', '');
          const matchedUser = DEMO_USERS.find((u) => u.user_id === requestedId);
          serverStore.activeSignedInUserId = matchedUser ? matchedUser.user_id : DEMO_USERS[0].user_id;
        }
        const nowIso = new Date().toISOString();
        serverStore.activeSessionsStore = [
          {
            session_id: '018f0000-0000-7000-8000-000000009901',
            device_kind: 'DESKTOP_BROWSER',
            auth_method: 'MAGIC_LINK',
            authenticated_at: nowIso,
            last_used_at: nowIso,
            current: true,
          },
          {
            session_id: '018f0000-0000-7000-8000-000000009902',
            device_kind: 'MOBILE_BROWSER',
            auth_method: 'MAGIC_LINK',
            authenticated_at: '2026-10-28T18:30:00Z',
            last_used_at: '2026-10-30T11:20:00Z',
            current: false,
          },
        ];
        return sendJson(res, 200, {
          status: 'SIGNED_IN',
          session: {
            access_token: `mock-jwt-${serverStore.activeSignedInUserId}`,
            token_type: 'Bearer',
            expires_in: 900,
            session_id: '018f0000-0000-7000-8000-000000009901',
          },
        });
      }
      return sendError(
        res,
        400,
        'INVALID_LINK',
        'This link was already used, has expired or is no longer valid.'
      );
    }

    // A5: POST /api/v1/auth/password/login
    if (pathname === '/api/v1/auth/password/login' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      const rawPassword = typeof body.password === 'string' ? body.password : '';
      if (
        email.length < 3 ||
        email.length > 320 ||
        !isValidEmailFormat(email) ||
        rawPassword.length < 1 ||
        rawPassword.length > 1024
      ) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid email or password format.');
      }
      if (email.toLowerCase().includes('ratelimit')) {
        return sendError(res, 429, 'RATE_LIMITED', 'Too many attempts.', {
          retry_after_seconds: 30,
        });
      }
      const password = rawPassword.normalize('NFKC');
      const resolvedUserId = resolveEmailToDemoUserId(email);
      const expectedPassword = passwordsByUser[resolvedUserId];
      const isPasswordValid =
        password === 'demo-password-ok' ||
        (Boolean(expectedPassword) && password === expectedPassword);

      if (!isPasswordValid) {
        serverStore.passwordLoginFailures += 1;
        if (serverStore.passwordLoginFailures >= 6) {
          serverStore.passwordLoginFailures = 0;
          return sendError(res, 429, 'RATE_LIMITED', 'Too many attempts.', {
            retry_after_seconds: 30,
          });
        }
        return sendError(res, 401, 'INVALID_CREDENTIALS', 'Wrong email or password.');
      }

      serverStore.passwordLoginFailures = 0;
      serverStore.activeSignedInUserId = resolvedUserId;
      const nowIso = new Date().toISOString();
      serverStore.activeSessionsStore = [
        {
          session_id: '018f0000-0000-7000-8000-000000009901',
          device_kind: 'DESKTOP_BROWSER',
          auth_method: 'PASSWORD',
          authenticated_at: nowIso,
          last_used_at: nowIso,
          current: true,
        },
        {
          session_id: '018f0000-0000-7000-8000-000000009902',
          device_kind: 'MOBILE_BROWSER',
          auth_method: 'MAGIC_LINK',
          authenticated_at: '2026-10-28T18:30:00Z',
          last_used_at: '2026-10-30T11:20:00Z',
          current: false,
        },
      ];
      return sendJson(res, 200, {
        access_token: `mock-jwt-${serverStore.activeSignedInUserId}`,
        token_type: 'Bearer',
        expires_in: 900,
        session_id: '018f0000-0000-7000-8000-000000009901',
      });
    }

    // A5: GET / PUT / DELETE /api/v1/auth/password
    if (pathname === '/api/v1/auth/password') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (method === 'GET') {
        return sendJson(res, 200, {
          is_set: Boolean(passwordsByUser[authedUser.user_id]),
        });
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const rawNewPassword = typeof body.new_password === 'string' ? body.new_password : '';
        const rawCurrentPassword =
          typeof body.current_password === 'string' ? body.current_password : '';
        if (
          rawNewPassword.length < 1 ||
          rawNewPassword.length > 1024 ||
          rawCurrentPassword.length > 1024
        ) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid password payload.');
        }

        const newPassword = rawNewPassword.normalize('NFKC');
        const currentPassword = rawCurrentPassword ? rawCurrentPassword.normalize('NFKC') : '';
        const existingPassword = passwordsByUser[authedUser.user_id];

        // 10-minute reauthentication window per docs/API.md section 7
        const currentSession = serverStore.activeSessionsStore.find((s) => s.current);
        const isFreshSession =
          Boolean(currentSession) &&
          Date.now() - Date.parse(currentSession!.authenticated_at) <= 10 * 60 * 1000 &&
          !newPassword.includes('reauth');

        if (currentPassword) {
          const matchesCurrent =
            existingPassword &&
            (currentPassword === existingPassword || currentPassword === 'demo-password-ok');
          if (!matchesCurrent || currentPassword === 'wrong') {
            serverStore.passwordLoginFailures += 1;
            if (serverStore.passwordLoginFailures >= 6) {
              serverStore.passwordLoginFailures = 0;
              return sendError(res, 429, 'RATE_LIMITED', 'Too many attempts.', {
                retry_after_seconds: 30,
              });
            }
            return sendError(
              res,
              403,
              'REAUTHENTICATION_REQUIRED',
              'Enter your current password or sign in with a link sent to your email.'
            );
          }
        } else if (!isFreshSession) {
          return sendError(
            res,
            403,
            'REAUTHENTICATION_REQUIRED',
            'Enter your current password or sign in with a link sent to your email.'
          );
        }

        const codePointLength = [...newPassword].length;
        if (codePointLength < 15) {
          return sendError(res, 422, 'PASSWORD_TOO_WEAK', 'Password is too short.', {
            reason: 'TOO_SHORT',
          });
        }
        if (codePointLength > 128) {
          return sendError(res, 422, 'PASSWORD_TOO_WEAK', 'Password is too long.', {
            reason: 'TOO_LONG',
          });
        }
        const commonPasswords = [
          'password123password',
          'password1234567',
          '123456789012345',
          'qwertyuiopasdfg',
          'passwordpassword',
        ];
        const strippedLower = newPassword.toLowerCase().replace(/\s+/g, '');
        const distinctChars = new Set([...newPassword]).size;
        if (commonPasswords.includes(strippedLower) || distinctChars < 5) {
          return sendError(res, 422, 'PASSWORD_TOO_WEAK', 'Password is too common.', {
            reason: 'TOO_COMMON',
          });
        }

        passwordsByUser[authedUser.user_id] = newPassword;
        serverStore.activeSessionsStore = serverStore.activeSessionsStore.filter((s) => s.current);
        res.statusCode = 204;
        { res.end(); return true; }
      }
      if (method === 'DELETE') {
        const body = await readBody(req);
        const rawCurrentPassword =
          typeof body.current_password === 'string' ? body.current_password : '';
        if (rawCurrentPassword.length > 1024) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid password payload.');
        }
        const currentPassword = rawCurrentPassword ? rawCurrentPassword.normalize('NFKC') : '';
        const existingPassword = passwordsByUser[authedUser.user_id];

        // Also 204 when no password is set, without any check; then nothing is revoked or sent
        if (!existingPassword) {
          res.statusCode = 204;
          { res.end(); return true; }
        }

        const currentSession = serverStore.activeSessionsStore.find((s) => s.current);
        const isFreshSession =
          Boolean(currentSession) &&
          Date.now() - Date.parse(currentSession!.authenticated_at) <= 10 * 60 * 1000;

        if (currentPassword) {
          const matchesCurrent =
            currentPassword === existingPassword || currentPassword === 'demo-password-ok';
          if (!matchesCurrent || currentPassword === 'wrong') {
            serverStore.passwordLoginFailures += 1;
            if (serverStore.passwordLoginFailures >= 6) {
              serverStore.passwordLoginFailures = 0;
              return sendError(res, 429, 'RATE_LIMITED', 'Too many attempts.', {
                retry_after_seconds: 30,
              });
            }
            return sendError(
              res,
              403,
              'REAUTHENTICATION_REQUIRED',
              'Enter your current password or sign in with a link sent to your email.'
            );
          }
        } else if (!isFreshSession) {
          return sendError(
            res,
            403,
            'REAUTHENTICATION_REQUIRED',
            'Enter your current password or sign in with a link sent to your email.'
          );
        }

        passwordsByUser[authedUser.user_id] = null;
        serverStore.activeSessionsStore = serverStore.activeSessionsStore.filter((s) => s.current);
        res.statusCode = 204;
        { res.end(); return true; }
      }
    }

    if (pathname === '/api/v1/auth/registration' && method === 'POST') {
      const body = await readBody(req);
      const fullName = String(body.full_name || '').trim();
      if (!fullName || fullName.length > 255) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Full name is required.');
      }
      serverStore.activeSignedInUserId = DEMO_USERS[0].user_id;
      const nowIso = new Date().toISOString();
      serverStore.activeSessionsStore = [
        {
          session_id: '018f0000-0000-7000-8000-000000009901',
          device_kind: 'DESKTOP_BROWSER',
          auth_method: 'INVITATION',
          authenticated_at: nowIso,
          last_used_at: nowIso,
          current: true,
        },
      ];
      return sendJson(res, 200, {
        status: 'SIGNED_IN',
        session: {
          access_token: `mock-jwt-${serverStore.activeSignedInUserId}`,
          token_type: 'Bearer',
          expires_in: 900,
          session_id: '018f0000-0000-7000-8000-000000009901',
        },
      });
    }

    if (pathname === '/api/v1/auth/invitations/accept' && method === 'POST') {
      return sendJson(res, 200, { applied: true });
    }

    // A4: GET / POST /api/v1/auth/invitations
    if (pathname === '/api/v1/auth/invitations' && method === 'GET') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      return sendJson(
        res,
        200,
        serverStore.buildingInvitationsStore.map((inv) => toInvitationView(inv, authedUser.user_id))
      );
    }

    if (pathname === '/api/v1/auth/invitations' && method === 'POST') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const body = await readBody(req);
      const kind = body.kind as 'OWNER' | 'TENANT' | 'STAFF';
      const email = String(body.email || '').trim();
      const rawApt = body.apartment_number ? String(body.apartment_number).trim() : null;
      const apartmentIdFromBody = body.apartment_id ? String(body.apartment_id).trim() : null;
      let apartmentNumber = rawApt
        ? rawApt.padStart(2, '0')
        : apartmentIdFromBody
          ? APARTMENT_ID_TO_NUMBER[apartmentIdFromBody] || null
          : null;
      let apartmentId =
        apartmentIdFromBody || (apartmentNumber ? NUMBER_TO_APARTMENT_ID[apartmentNumber] || null : null);
      const buildingRole = (body.building_role || null) as
        | 'CHAIRMAN'
        | 'BOARD'
        | 'ACCOUNTANT'
        | null;

      if (!isValidEmailFormat(email) || !['OWNER', 'TENANT', 'STAFF'].includes(kind)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid invitation parameters.');
      }

      if (email.toLowerCase() === 'ratelimit@demo.invalid') {
        return sendError(res, 429, 'RATE_LIMITED', 'Too many invitations sent.', {
          retry_after_seconds: 600,
        });
      }

      if (kind === 'TENANT') {
        const callerMems = membershipsByUser[authedUser.user_id] || [];
        const ownedMem = callerMems.find(
          (m) =>
            m.relation_type === 'OWNER' &&
            ((apartmentId && m.apartment_id === apartmentId) ||
              (apartmentNumber && m.apartment_number === apartmentNumber))
        );
        if (!apartmentId && !apartmentNumber) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Apartment ID is required.');
        }
        if (!ownedMem) {
          return sendError(res, 403, 'FORBIDDEN', 'Only the apartment owner can invite tenants.');
        }
        apartmentId = ownedMem.apartment_id;
        apartmentNumber = ownedMem.apartment_number;

        const duplicateTenant = serverStore.buildingInvitationsStore.find(
          (i) =>
            i.status === 'PENDING' &&
            i.kind === 'TENANT' &&
            i.apartment_number === apartmentNumber &&
            (i.raw_email.toLowerCase() === email.toLowerCase() ||
              i.masked_email === maskEmailServerSide(email))
        );
        if (duplicateTenant) {
          return sendError(
            res,
            409,
            'INVITATION_ALREADY_PENDING',
            'This person is already invited. Resend the invitation instead.'
          );
        }

        // Count active tenants + pending tenant invitations for this apartment
        let activeTenants = 0;
        for (const p of serverStore.buildingUsersStore) {
          for (const m of p.memberships) {
            if (m.apartment_number === apartmentNumber && m.relation_type === 'TENANT') {
              activeTenants += 1;
            }
          }
        }
        const pendingTenants = serverStore.buildingInvitationsStore.filter(
          (i) =>
            i.kind === 'TENANT' &&
            i.status === 'PENDING' &&
            i.apartment_number === apartmentNumber
        ).length;

        if (activeTenants + pendingTenants >= 3) {
          return sendError(
            res,
            409,
            'TENANT_LIMIT_REACHED',
            'At most 3 tenants per apartment, pending invitations included.'
          );
        }
      } else {
        // OWNER or STAFF requires CHAIRMAN
        if (authedUser.building_role !== 'CHAIRMAN') {
          return sendError(res, 403, 'FORBIDDEN', 'Only the chairman can invite owners or staff.');
        }
        if (kind === 'OWNER') {
          if (!apartmentNumber) {
            return sendError(res, 422, 'VALIDATION_ERROR', 'Apartment number is required.');
          }
          const aptNumInt = Number(apartmentNumber);
          if (!Number.isInteger(aptNumInt) || aptNumInt < 1 || aptNumInt > 36) {
            return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'There is no apartment with this number.');
          }
          apartmentId =
            NUMBER_TO_APARTMENT_ID[apartmentNumber] ||
            `018f0000-0000-7000-8000-0000000003${apartmentNumber.padStart(2, '0')}`;
        }
        if (kind === 'STAFF') {
          if (!buildingRole || !['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(buildingRole)) {
            return sendError(res, 422, 'VALIDATION_ERROR', 'Building role is required.');
          }
          apartmentId = null;
          apartmentNumber = null;
        }
      }

      const rawKind = body.apartment_kind ? String(body.apartment_kind).toUpperCase() : 'APARTMENT';
      if (kind === 'OWNER' && !['APARTMENT', 'PARKING', 'GARAGE'].includes(rawKind)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid object kind.');
      }
      let apartmentKind: 'APARTMENT' | 'PARKING' | 'GARAGE' | null =
        kind === 'STAFF' ? null : (rawKind as 'APARTMENT' | 'PARKING' | 'GARAGE');
      if (kind === 'OWNER' && apartmentNumber) {
        const matchedCard = DEMO_APARTMENT_CARDS.find(
          (c) => (c.apartment_kind || 'APARTMENT') === apartmentKind && c.apartment_number === apartmentNumber,
        );
        apartmentId =
          matchedCard?.apartment_id ||
          NUMBER_TO_APARTMENT_ID[apartmentNumber] ||
          `018f0000-0000-7000-8000-0000000003${apartmentNumber.padStart(2, '0')}`;
      }
      if (kind === 'TENANT' && apartmentId) {
        const matchedCard = DEMO_APARTMENT_CARDS.find((c) => c.apartment_id === apartmentId);
        apartmentKind = matchedCard?.apartment_kind || 'APARTMENT';
      }

      const duplicate = serverStore.buildingInvitationsStore.find(
        (i) =>
          i.status === 'PENDING' &&
          i.kind === kind &&
          i.apartment_number === apartmentNumber &&
          (i.apartment_kind ?? null) === apartmentKind &&
          (i.raw_email.toLowerCase() === email.toLowerCase() ||
            i.masked_email === maskEmailServerSide(email))
      );
      if (duplicate) {
        return sendError(
          res,
          409,
          'INVITATION_ALREADY_PENDING',
          'This person is already invited. Resend the invitation instead.'
        );
      }

      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      const newInv: MockInvitation = {
        invitation_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        kind,
        status: 'PENDING',
        masked_email: maskEmailServerSide(email),
        raw_email: email.toLowerCase(),
        invited_by_user_id: authedUser.user_id,
        apartment_id: kind === 'STAFF' ? null : apartmentId,
        apartment_number: kind === 'STAFF' ? null : apartmentNumber,
        apartment_kind: kind === 'STAFF' ? null : apartmentKind,
        building_role: kind === 'STAFF' ? buildingRole : null,
        created_at: nowIso,
        expires_at: expiresIso,
      };
      serverStore.buildingInvitationsStore.unshift(newInv);
      return sendJson(res, 201, toInvitationView(newInv, authedUser.user_id));
    }

    // E13/R4a (#057 + #069): POST /api/v1/auth/invitations/bulk/preview & /bulk
    if (
      (pathname === '/api/v1/auth/invitations/bulk/preview' ||
        pathname === '/api/v1/auth/invitations/bulk') &&
      method === 'POST'
    ) {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const body = await readBody(req);
      const text = typeof body.text === 'string' ? body.text : '';
      const isSend = pathname.endsWith('/bulk');
      const existingPending = serverStore.buildingInvitationsStore
        .filter((i) => i.status === 'PENDING' && i.kind === 'OWNER')
        .map((i) => ({
          apartment_id: i.apartment_id,
          apartment_number: i.apartment_number,
          apartment_kind: i.apartment_kind,
          raw_email: i.raw_email,
        }));
      try {
        const { report, invitedRows } = evaluateBulkInvitationsText(text, {
          apartments: DEMO_APARTMENT_CARDS,
          existingPending,
          limitRemaining: 50,
          mode: isSend ? 'send' : 'preview',
        });
        if (isSend && invitedRows.length > 0) {
          const nowIso = new Date().toISOString();
          const expiresIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
          for (const row of invitedRows) {
            serverStore.buildingInvitationsStore.unshift({
              invitation_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
              kind: 'OWNER',
              status: 'PENDING',
              masked_email: maskEmailServerSide(row.email),
              raw_email: row.email.toLowerCase(),
              invited_by_user_id: authedUser.user_id,
              apartment_id: row.apartment_id,
              apartment_number: row.apartment_number,
              apartment_kind: row.apartment_kind,
              building_role: null,
              created_at: nowIso,
              expires_at: expiresIso,
            });
          }
        }
        return sendJson(res, 200, report);
      } catch (err) {
        const bulkErr = err as BulkEvaluationError;
        if (bulkErr && (bulkErr.status === 422 || bulkErr.status === 429)) {
          return sendError(
            res,
            bulkErr.status,
            bulkErr.errorCode,
            bulkErr.message,
            bulkErr.retry_after_seconds
              ? { retry_after_seconds: bulkErr.retry_after_seconds }
              : undefined,
          );
        }
        throw err;
      }
    }

    // E13/R4b (#058 + #069): GET /api/v1/auth/connections & PUT /api/v1/auth/connections/{id}/paper
    if (pathname === '/api/v1/auth/connections' && method === 'GET') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const allMemberships = serverStore.buildingUsersStore.flatMap((p) => p.memberships);
      const overview = buildConnectionOverview({
        apartments: DEMO_APARTMENT_CARDS,
        memberships: allMemberships,
        invitations: serverStore.buildingInvitationsStore,
        paperApartmentIds: serverStore.paperApartmentIds,
        activeJoinCodeApartmentIds: new Set(serverStore.joinCodesStore.map((c) => c.apartment_id)),
        pendingJoinRequestApartmentIds: new Set(
          serverStore.joinRequestsStore.map((r) => r.apartment_id),
        ),
        statusFilter: urlObj.searchParams.get('status'),
        limit: Number(urlObj.searchParams.get('limit') || 50),
        offset: Number(urlObj.searchParams.get('offset') || 0),
      });
      return sendJson(res, 200, overview);
    }

    const connPaperMatch = pathname.match(/^\/api\/v1\/auth\/connections\/([^/]+)\/paper$/);
    if (connPaperMatch && method === 'PUT') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const aptId = connPaperMatch[1];
      const apt = DEMO_APARTMENT_CARDS.find((c) => c.apartment_id === aptId);
      if (!apt) {
        return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'Object not found.');
      }
      const body = await readBody(req);
      const onPaper = Boolean(body.on_paper);
      if (onPaper) {
        serverStore.paperApartmentIds.add(aptId);
      } else {
        serverStore.paperApartmentIds.delete(aptId);
      }
      const allMemberships = serverStore.buildingUsersStore.flatMap((p) => p.memberships);
      const item = buildConnectionItems({
        apartments: [apt],
        memberships: allMemberships,
        invitations: serverStore.buildingInvitationsStore,
        paperApartmentIds: serverStore.paperApartmentIds,
        activeJoinCodeApartmentIds: new Set(serverStore.joinCodesStore.map((c) => c.apartment_id)),
        pendingJoinRequestApartmentIds: new Set(
          serverStore.joinRequestsStore.map((r) => r.apartment_id),
        ),
      })[0];
      return sendJson(res, 200, item);
    }

    // E13/R4c (#059 + #069): POST/GET /api/v1/auth/join-codes & DELETE /api/v1/auth/join-codes/{code_id}
    if (pathname === '/api/v1/auth/join-codes' && method === 'GET') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const list = serverStore.joinCodesStore.map((c) => ({
        code_id: c.code_id,
        apartment_id: c.apartment_id,
        apartment_number: c.apartment_number,
        apartment_kind: c.apartment_kind,
        created_at: c.created_at,
        expires_at: c.expires_at,
      }));
      return sendJson(res, 200, list);
    }

    if (pathname === '/api/v1/auth/join-codes' && method === 'POST') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const body = await readBody(req);
      const requestedIds = Array.isArray(body.apartment_ids) ? (body.apartment_ids as string[]) : null;
      const allMemberships = serverStore.buildingUsersStore.flatMap((p) => p.memberships);
      const ownerAptIds = new Set(
        allMemberships.filter((m) => m.relation_type === 'OWNER').map((m) => m.apartment_id),
      );
      const pendingInvAptIds = new Set(
        serverStore.buildingInvitationsStore
          .filter((i) => i.status === 'PENDING' && i.kind === 'OWNER' && i.apartment_id)
          .map((i) => i.apartment_id as string),
      );
      const activeCodeAptIds = new Set(serverStore.joinCodesStore.map((c) => c.apartment_id));
      const pendingReqAptIds = new Set(serverStore.joinRequestsStore.map((r) => r.apartment_id));

      let targets: typeof DEMO_APARTMENT_CARDS;
      if (requestedIds !== null) {
        if (requestedIds.length === 0 || new Set(requestedIds).size !== requestedIds.length) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Provide unique non-empty apartment_ids.');
        }
        targets = [];
        for (const id of requestedIds) {
          const found = DEMO_APARTMENT_CARDS.find((c) => c.apartment_id === id);
          if (!found) {
            return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'Object not found.');
          }
          targets.push(found);
        }
      } else {
        targets = DEMO_APARTMENT_CARDS.filter(
          (c) =>
            !ownerAptIds.has(c.apartment_id) &&
            !pendingInvAptIds.has(c.apartment_id) &&
            !activeCodeAptIds.has(c.apartment_id) &&
            !pendingReqAptIds.has(c.apartment_id),
        );
      }

      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const makeCode = () => {
        const pick = (n: number) =>
          Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
        return `${pick(4)}-${pick(4)}-${pick(2)}`;
      };
      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
      const issued = targets.map((apt) => {
        const rec = {
          code_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
          apartment_id: apt.apartment_id,
          apartment_number: apt.apartment_number,
          apartment_kind: (apt.apartment_kind || 'APARTMENT') as 'APARTMENT' | 'PARKING' | 'GARAGE',
          join_code: makeCode(),
          created_at: nowIso,
          expires_at: expiresIso,
        };
        serverStore.joinCodesStore.unshift(rec);
        return {
          code_id: rec.code_id,
          apartment_id: rec.apartment_id,
          apartment_number: rec.apartment_number,
          apartment_kind: rec.apartment_kind,
          join_code: rec.join_code,
          expires_at: rec.expires_at,
        };
      });
      const host = req.headers.host || 'localhost:3000';
      const assocName =
        serverStore.associationSettingsStore.find((s) => s.key === 'association_name')?.value ||
        'KÜ Tamme 14';
      res.setHeader('Cache-Control', 'no-store');
      return sendJson(res, 201, {
        association_name: assocName,
        join_url: `http://${host}/join`,
        codes: issued,
      });
    }

    const joinCodeDelMatch = pathname.match(/^\/api\/v1\/auth\/join-codes\/([^/]+)$/);
    if (joinCodeDelMatch && method === 'DELETE') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const codeId = joinCodeDelMatch[1];
      const idx = serverStore.joinCodesStore.findIndex((c) => c.code_id === codeId);
      if (idx === -1) {
        return sendError(res, 404, 'JOIN_CODE_NOT_FOUND', 'Join code not found.');
      }
      serverStore.joinCodesStore.splice(idx, 1);
      res.statusCode = 204;
      { res.end(); return true; }
    }

    const normalizeCrockfordJoinCode = (raw: unknown) =>
      String(raw || '')
        .replace(/[\s-]/g, '')
        .toUpperCase()
        .replace(/[IL]/g, '1')
        .replace(/O/g, '0');

    // E13/R4c (#060 + #069): Public /join lookup, privacy-notice, submit
    if (pathname === '/api/v1/auth/join/lookup' && method === 'POST') {
      const body = await readBody(req);
      const normalized = normalizeCrockfordJoinCode(body.join_code);
      const matched = serverStore.joinCodesStore.find(
        (c) => normalizeCrockfordJoinCode(c.join_code) === normalized,
      );
      if (!matched) {
        return sendError(res, 400, 'INVALID_JOIN_CODE', 'This code is wrong, used or expired.');
      }
      const assocName =
        serverStore.associationSettingsStore.find((s) => s.key === 'association_name')?.value ||
        'KÜ Tamme 14';
      return sendJson(res, 200, {
        association_name: assocName,
        apartment_number: matched.apartment_number,
        apartment_kind: matched.apartment_kind,
        country_code: 'EE',
      });
    }

    if (pathname === '/api/v1/auth/join/privacy-notice' && method === 'GET') {
      const rawLocale = String(urlObj.searchParams.get('locale') || 'en').toLowerCase();
      const locale = (['en', 'et', 'ru'].includes(rawLocale) ? rawLocale : 'en') as 'en' | 'et' | 'ru';
      const customUrl =
        serverStore.associationSettingsStore.find((s) => s.key === 'privacy_notice_url')?.value || null;
      return sendJson(res, 200, {
        custom_url: customUrl,
        locale,
        text: customUrl
          ? null
          : 'Your name, phone number, and e-mail address are used only so the chairman of the apartment association can verify that you are the owner of an apartment, a parking space or a garage. This request data is deleted immediately after the decision (or automatically after 30 days).',
      });
    }

    if (pathname === '/api/v1/auth/join' && method === 'POST') {
      const body = await readBody(req);
      const normalized = normalizeCrockfordJoinCode(body.join_code);
      const idx = serverStore.joinCodesStore.findIndex(
        (c) => normalizeCrockfordJoinCode(c.join_code) === normalized,
      );
      if (idx === -1) {
        return sendError(res, 400, 'INVALID_JOIN_CODE', 'This code is wrong, used or expired.');
      }
      const fullName = String(body.full_name || '').trim();
      const email = String(body.email || '').trim();
      const e164Phone = normalizePhoneToE164(typeof body.phone === 'string' ? body.phone : '');
      if (!fullName || fullName.length > 200 || !isValidEmailFormat(email)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid join request details.');
      }
      if (!e164Phone) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid phone number.', {
          errors: [{ loc: ['body', 'phone'], message: 'Invalid phone number', type: 'value_error' }],
        });
      }
      const [usedCode] = serverStore.joinCodesStore.splice(idx, 1);
      const rawLocale = String(body.locale || 'en').toLowerCase();
      const locale = (['en', 'et', 'ru'].includes(rawLocale) ? rawLocale : 'en') as 'en' | 'et' | 'ru';
      serverStore.joinRequestsStore.push({
        request_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        apartment_id: usedCode.apartment_id,
        apartment_number: usedCode.apartment_number,
        apartment_kind: usedCode.apartment_kind,
        full_name: fullName,
        phone: e164Phone,
        email,
        locale,
        created_at: new Date().toISOString(),
      });
      return sendJson(res, 202, { accepted: true });
    }

    // E13/R4c (#061 + #069): Join requests (chairman only) & join decisions (chairman + board)
    if (pathname === '/api/v1/auth/join-requests' && method === 'GET') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      res.setHeader('Cache-Control', 'no-store');
      const oldestFirst = [...serverStore.joinRequestsStore].sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
      );
      return sendJson(res, 200, oldestFirst);
    }

    const joinReqActionMatch = pathname.match(
      /^\/api\/v1\/auth\/join-requests\/([^/]+)\/(confirm|reject)$/,
    );
    if (joinReqActionMatch && method === 'POST') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const [, reqId, action] = joinReqActionMatch;
      const idx = serverStore.joinRequestsStore.findIndex((r) => r.request_id === reqId);
      if (idx === -1) {
        return sendError(res, 404, 'JOIN_REQUEST_NOT_FOUND', 'Join request not found.');
      }
      const [request] = serverStore.joinRequestsStore.splice(idx, 1);
      const nowIso = new Date().toISOString();
      serverStore.joinDecisionsStore.unshift({
        apartment_id: request.apartment_id,
        apartment_number: request.apartment_number,
        apartment_kind: request.apartment_kind,
        outcome: action === 'confirm' ? 'CONFIRMED' : 'REJECTED',
        decided_by_user_id: authedUser.user_id,
        decided_at: nowIso,
      });

      if (action === 'reject') {
        res.statusCode = 204;
        { res.end(); return true; }
      }

      const expiresIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      const newInv: MockInvitation = {
        invitation_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        kind: 'OWNER',
        status: 'PENDING',
        masked_email: maskEmailServerSide(request.email),
        raw_email: request.email.toLowerCase(),
        invited_by_user_id: authedUser.user_id,
        apartment_id: request.apartment_id,
        apartment_number: request.apartment_number,
        apartment_kind: request.apartment_kind,
        building_role: null,
        created_at: nowIso,
        expires_at: expiresIso,
      };
      serverStore.buildingInvitationsStore.unshift(newInv);
      return sendJson(res, 200, toInvitationView(newInv, authedUser.user_id));
    }

    if (pathname === '/api/v1/auth/join-decisions' && method === 'GET') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN' && authedUser.building_role !== 'BOARD') {
        return sendError(res, 403, 'FORBIDDEN', 'Board or chairman access required.');
      }
      const limit = Math.min(Math.max(Number(urlObj.searchParams.get('limit') || 20), 1), 100);
      const offset = Math.max(Number(urlObj.searchParams.get('offset') || 0), 0);
      const newestFirst = [...serverStore.joinDecisionsStore].sort(
        (a, b) => Date.parse(b.decided_at) - Date.parse(a.decided_at),
      );
      return sendJson(res, 200, newestFirst.slice(offset, offset + limit));
    }

    // A4: POST /api/v1/auth/invitations/{id}/resend
    const invResendMatch = pathname.match(/^\/api\/v1\/auth\/invitations\/([^/]+)\/resend$/);
    if (invResendMatch && method === 'POST') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const invId = invResendMatch[1];
      const inv = serverStore.buildingInvitationsStore.find((i) => i.invitation_id === invId);
      if (!inv) {
        return sendError(res, 404, 'INVITATION_NOT_FOUND', 'Invitation not found.');
      }
      if (inv.status === 'ACCEPTED') {
        return sendError(
          res,
          409,
          'INVITATION_ACCEPTED',
          'The invitation was accepted. To take access away, end the membership.'
        );
      }
      if (inv.status === 'NO_LONGER_VALID') {
        return sendError(
          res,
          409,
          'INVITATION_NO_LONGER_VALID',
          'This invitation no longer applies. Delete it and invite again.'
        );
      }
      if (inv.status === 'EXPIRED' && inv.kind === 'TENANT' && inv.apartment_number) {
        let activeTenants = 0;
        for (const p of serverStore.buildingUsersStore) {
          for (const m of p.memberships) {
            if (m.apartment_number === inv.apartment_number && m.relation_type === 'TENANT') {
              activeTenants += 1;
            }
          }
        }
        const pendingTenants = serverStore.buildingInvitationsStore.filter(
          (i) =>
            i.kind === 'TENANT' &&
            i.status === 'PENDING' &&
            i.apartment_number === inv.apartment_number
        ).length;
        if (activeTenants + pendingTenants >= 3) {
          return sendError(
            res,
            409,
            'TENANT_LIMIT_REACHED',
            'At most 3 tenants per apartment, pending invitations included.'
          );
        }
      }
      inv.status = 'PENDING';
      inv.created_at = new Date().toISOString();
      inv.expires_at = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      return sendJson(res, 200, toInvitationView(inv, authedUser.user_id));
    }

    // A4: DELETE /api/v1/auth/invitations/{id}
    const invDeleteMatch = pathname.match(/^\/api\/v1\/auth\/invitations\/([^/]+)$/);
    if (invDeleteMatch && method === 'DELETE') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const invId = invDeleteMatch[1];
      const idx = serverStore.buildingInvitationsStore.findIndex((i) => i.invitation_id === invId);
      if (idx === -1) {
        return sendError(res, 404, 'INVITATION_NOT_FOUND', 'Invitation not found.');
      }
      if (serverStore.buildingInvitationsStore[idx].status === 'ACCEPTED') {
        return sendError(
          res,
          409,
          'INVITATION_ACCEPTED',
          'The invitation was accepted. To take access away, end the membership.'
        );
      }
      serverStore.buildingInvitationsStore.splice(idx, 1);
      res.statusCode = 204;
      { res.end(); return true; }
    }

    // A4: GET /api/v1/auth/apartments/{apartment_id}/residents
    const aptResidentsMatch = pathname.match(/^\/api\/v1\/auth\/apartments\/([^/]+)\/residents$/);
    if (aptResidentsMatch && method === 'GET') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const aptId = aptResidentsMatch[1];
      const callerMems = membershipsByUser[authedUser.user_id] || [];
      const ownedMem = callerMems.find(
        (m) => m.apartment_id === aptId && m.relation_type === 'OWNER'
      );
      const aptNumber = ownedMem?.apartment_number || APARTMENT_ID_TO_NUMBER[aptId];
      if (!aptNumber) {
        return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'Apartment not found.');
      }
      if (!ownedMem) {
        return sendError(res, 403, 'FORBIDDEN', 'Only an owner of this apartment can view residents.');
      }

      const residents: Array<{
        user_id: string;
        membership_id: string;
        relation_type: 'OWNER' | 'TENANT';
        display_label: string;
        since: string;
        invited_email: string | null;
      }> = [];

      for (const person of serverStore.buildingUsersStore) {
        for (const m of person.memberships) {
          if (m.apartment_number === aptNumber) {
            const isInvitedByMe = m.invited_by_user_id === authedUser.user_id;
            residents.push({
              user_id: person.user_id,
              membership_id: m.membership_id,
              relation_type: m.relation_type,
              display_label: m.display_label,
              since: m.since,
              invited_email:
                m.relation_type === 'TENANT'
                  ? isInvitedByMe
                    ? m.invited_email
                    : m.invited_email
                      ? maskEmailServerSide(m.invited_email)
                      : null
                  : null,
            });
          }
        }
      }

      const pendingInvitations = serverStore.buildingInvitationsStore
        .filter(
          (i) =>
            i.kind === 'TENANT' &&
            (i.status === 'PENDING' || i.status === 'EXPIRED') &&
            i.apartment_number === aptNumber
        )
        .map((inv) => toInvitationView(inv, authedUser.user_id));

      return sendJson(res, 200, {
        residents,
        pending_invitations: pendingInvitations,
      });
    }

    // A4: DELETE /api/v1/auth/apartments/{apartment_id}/tenants/{user_id}
    const removeTenantMatch = pathname.match(
      /^\/api\/v1\/auth\/apartments\/([^/]+)\/tenants\/([^/]+)$/
    );
    if (removeTenantMatch && method === 'DELETE') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const [, aptId, targetId] = removeTenantMatch;
      const callerMems = membershipsByUser[authedUser.user_id] || [];
      const ownedMem = callerMems.find(
        (m) => m.apartment_id === aptId && m.relation_type === 'OWNER'
      );
      if (!ownedMem) {
        return sendError(res, 403, 'FORBIDDEN', 'Only an owner can remove tenants.');
      }

      let foundPerson: MockPersonSummary | null = null;
      for (const person of serverStore.buildingUsersStore) {
        const idx = person.memberships.findIndex(
          (m) =>
            (person.user_id === targetId || m.membership_id === targetId) &&
            m.apartment_number === ownedMem.apartment_number &&
            m.relation_type === 'TENANT'
        );
        if (idx !== -1) {
          person.memberships.splice(idx, 1);
          foundPerson = person;
          break;
        }
      }
      if (!foundPerson) {
        return sendError(res, 404, 'MEMBERSHIP_NOT_FOUND', 'Tenant membership not found.');
      }
      if (foundPerson.memberships.length === 0 && foundPerson.building_role === 'USER') {
        serverStore.buildingUsersStore = serverStore.buildingUsersStore.filter((p) => p.user_id !== foundPerson!.user_id);
      }
      res.statusCode = 204;
      { res.end(); return true; }
    }

    // A4: POST /api/v1/auth/apartments/{apartment_id}/tenants/{user_id}/replace
    const replaceTenantMatch = pathname.match(
      /^\/api\/v1\/auth\/apartments\/([^/]+)\/tenants\/([^/]+)\/replace$/
    );
    if (replaceTenantMatch && method === 'POST') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const [, aptId, targetId] = replaceTenantMatch;
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      if (!isValidEmailFormat(email)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid email address.');
      }
      const callerMems = membershipsByUser[authedUser.user_id] || [];
      const ownedMem = callerMems.find(
        (m) => m.apartment_id === aptId && m.relation_type === 'OWNER'
      );
      if (!ownedMem) {
        return sendError(res, 403, 'FORBIDDEN', 'Only an owner can replace tenants.');
      }

      const duplicate = serverStore.buildingInvitationsStore.find(
        (i) =>
          i.status === 'PENDING' &&
          i.kind === 'TENANT' &&
          i.apartment_number === ownedMem.apartment_number &&
          (i.raw_email.toLowerCase() === email.toLowerCase() ||
            i.masked_email === maskEmailServerSide(email))
      );
      if (duplicate) {
        return sendError(
          res,
          409,
          'INVITATION_ALREADY_PENDING',
          'This person is already invited. Resend the invitation instead.'
        );
      }

      let foundPerson: MockPersonSummary | null = null;
      for (const person of serverStore.buildingUsersStore) {
        const idx = person.memberships.findIndex(
          (m) =>
            (person.user_id === targetId || m.membership_id === targetId) &&
            m.apartment_number === ownedMem.apartment_number &&
            m.relation_type === 'TENANT'
        );
        if (idx !== -1) {
          person.memberships.splice(idx, 1);
          foundPerson = person;
          break;
        }
      }
      if (!foundPerson) {
        return sendError(res, 404, 'MEMBERSHIP_NOT_FOUND', 'Tenant membership not found.');
      }
      if (foundPerson.memberships.length === 0 && foundPerson.building_role === 'USER') {
        serverStore.buildingUsersStore = serverStore.buildingUsersStore.filter((p) => p.user_id !== foundPerson!.user_id);
      }

      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      const newInv: MockInvitation = {
        invitation_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        kind: 'TENANT',
        status: 'PENDING',
        masked_email: maskEmailServerSide(email),
        raw_email: email.toLowerCase(),
        invited_by_user_id: authedUser.user_id,
        apartment_id: ownedMem.apartment_id,
        apartment_number: ownedMem.apartment_number,
        apartment_kind: ownedMem.apartment_kind || 'APARTMENT',
        building_role: null,
        created_at: nowIso,
        expires_at: expiresIso,
      };
      serverStore.buildingInvitationsStore.unshift(newInv);
      return sendJson(res, 201, toInvitationView(newInv, authedUser.user_id));
    }

    // A4: GET /api/v1/auth/users (Chairman People directory)
    if (pathname === '/api/v1/auth/users' && method === 'GET') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const people = serverStore.buildingUsersStore.map((p) => ({
        user_id: p.user_id,
        is_me: p.user_id === authedUser.user_id,
        display_label: p.display_label,
        building_role: p.building_role,
        invited_email:
          p.invited_by_user_id === authedUser.user_id ? p.invited_email : null,
        memberships: p.memberships.map((m) => ({
          membership_id: m.membership_id,
          apartment_id: m.apartment_id,
          apartment_number: m.apartment_number,
          apartment_kind: m.apartment_kind || 'APARTMENT',
          relation_type: m.relation_type,
          display_label: m.display_label,
          since: m.since,
          invited_email:
            m.invited_by_user_id === authedUser.user_id ? m.invited_email : null,
        })),
      }));
      return sendJson(res, 200, { people });
    }

    // A4: PUT /api/v1/auth/users/{user_id}/role
    const userRoleMatch = pathname.match(/^\/api\/v1\/auth\/users\/([^/]+)\/role$/);
    if (userRoleMatch && method === 'PUT') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const targetUserId = userRoleMatch[1];
      const body = await readBody(req);
      const nextRole = body.building_role as 'CHAIRMAN' | 'BOARD' | 'ACCOUNTANT' | 'USER';
      if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT', 'USER'].includes(nextRole)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid building role.');
      }
      const person = serverStore.buildingUsersStore.find((p) => p.user_id === targetUserId);
      if (!person) {
        return sendError(res, 404, 'USER_NOT_FOUND', 'User not found.');
      }
      if (person.building_role === 'CHAIRMAN' && nextRole !== 'CHAIRMAN') {
        const chairmenCount = serverStore.buildingUsersStore.filter(
          (p) => p.building_role === 'CHAIRMAN'
        ).length;
        if (chairmenCount <= 1) {
          return sendError(
            res,
            409,
            'LAST_CHAIRMAN',
            'The building needs a chairman. Make someone else chairman first.'
          );
        }
      }
      person.building_role = nextRole;
      const seedMatch = DEMO_USERS.find((u) => u.user_id === targetUserId);
      if (seedMatch) {
        seedMatch.building_role = nextRole;
      }

      if (nextRole === 'USER' && person.memberships.length === 0) {
        serverStore.buildingUsersStore = serverStore.buildingUsersStore.filter((p) => p.user_id !== targetUserId);
        return sendJson(res, 200, {
          user_id: targetUserId,
          building_role: nextRole,
          account_closed: true,
        });
      }
      return sendJson(res, 200, {
        user_id: targetUserId,
        building_role: nextRole,
        account_closed: false,
      });
    }

    // A4: DELETE /api/v1/auth/users/{user_id}/memberships/{membership_id}
    const endMemMatch = pathname.match(
      /^\/api\/v1\/auth\/users\/([^/]+)\/memberships\/([^/]+)$/
    );
    if (endMemMatch && method === 'DELETE') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const [, targetUserId, membershipId] = endMemMatch;
      const person = serverStore.buildingUsersStore.find((p) => p.user_id === targetUserId);
      if (!person) {
        return sendError(res, 404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found.');
      }
      const memIdx = person.memberships.findIndex((m) => m.membership_id === membershipId);
      if (memIdx === -1) {
        return sendError(res, 404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found.');
      }
      const [removedMem] = person.memberships.splice(memIdx, 1);

      if (removedMem.relation_type === 'OWNER') {
        const remainingOwners = serverStore.buildingUsersStore.some((p) =>
          p.memberships.some(
            (m) =>
              m.apartment_number === removedMem.apartment_number &&
              m.relation_type === 'OWNER'
          )
        );
        if (!remainingOwners) {
          for (const inv of serverStore.buildingInvitationsStore) {
            if (
              inv.kind === 'TENANT' &&
              inv.status === 'PENDING' &&
              inv.apartment_number === removedMem.apartment_number
            ) {
              inv.status = 'NO_LONGER_VALID';
            }
          }
        }
      }

      if (person.memberships.length === 0 && person.building_role === 'USER') {
        serverStore.buildingUsersStore = serverStore.buildingUsersStore.filter((p) => p.user_id !== targetUserId);
      }
      res.statusCode = 204;
      { res.end(); return true; }
    }

    // A4: DELETE /api/v1/auth/users/{user_id}
    const closeUserMatch = pathname.match(/^\/api\/v1\/auth\/users\/([^/]+)$/);
    if (closeUserMatch && method === 'DELETE') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const targetUserId = closeUserMatch[1];
      const person = serverStore.buildingUsersStore.find((p) => p.user_id === targetUserId);
      if (!person) {
        return sendError(res, 404, 'USER_NOT_FOUND', 'User not found.');
      }
      if (person.building_role === 'CHAIRMAN') {
        const chairmenCount = serverStore.buildingUsersStore.filter(
          (p) => p.building_role === 'CHAIRMAN'
        ).length;
        if (chairmenCount <= 1) {
          return sendError(
            res,
            409,
            'LAST_CHAIRMAN',
            'The building needs a chairman. Make someone else chairman first.'
          );
        }
      }
      serverStore.buildingUsersStore = serverStore.buildingUsersStore.filter((p) => p.user_id !== targetUserId);
      for (const mem of person.memberships) {
        if (mem.relation_type === 'OWNER') {
          const remainingOwners = serverStore.buildingUsersStore.some((p) =>
            p.memberships.some(
              (m) =>
                m.apartment_number === mem.apartment_number && m.relation_type === 'OWNER'
            )
          );
          if (!remainingOwners) {
            for (const inv of serverStore.buildingInvitationsStore) {
              if (
                inv.kind === 'TENANT' &&
                inv.status === 'PENDING' &&
                inv.apartment_number === mem.apartment_number
              ) {
                inv.status = 'NO_LONGER_VALID';
              }
            }
          }
        }
      }
      res.statusCode = 204;
      { res.end(); return true; }
    }

    if (pathname === '/api/v1/auth/sessions' && method === 'GET') {
      const authHeader = req.headers['authorization'] || '';
      if (!String(authHeader).startsWith('Bearer ')) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      return sendJson(res, 200, serverStore.activeSessionsStore);
    }

    if (pathname === '/api/v1/auth/sessions' && method === 'DELETE') {
      serverStore.activeSignedInUserId = null;
      serverStore.activeSessionsStore = [];
      res.statusCode = 204;
      { res.end(); return true; }
    }

    const sessionDeleteMatch = pathname.match(/^\/api\/v1\/auth\/sessions\/([^/]+)$/);
    if (sessionDeleteMatch && method === 'DELETE') {
      const targetId = sessionDeleteMatch[1];
      const idx = serverStore.activeSessionsStore.findIndex((s) => s.session_id === targetId);
      if (idx === -1) {
        return sendError(res, 404, 'SESSION_NOT_FOUND', 'Session not found.');
      }
      const removed = serverStore.activeSessionsStore[idx];
      serverStore.activeSessionsStore.splice(idx, 1);
      if (removed.current) {
        serverStore.activeSignedInUserId = null;
      }
      res.statusCode = 204;
      { res.end(); return true; }
    }

    // 18. NOTIFICATIONS ENDPOINTS (Epic E1)

  return false;
}
