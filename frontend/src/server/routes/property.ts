import type { SeedUser } from '../state.js';
import type { DisplayMode } from '../../api/schema.js';
import { type RouteContext, sendJson, sendError, readBody } from '../http.js';
import { computeMockSharedAccess } from '../../mocks/domains/index.js';
import {
  BUILDING_ID,
  DEMO_APARTMENT_CARDS,
  membershipsByUser,
  userLocales,
  computePreviewBadge,
  checkAndConsumeRegistryQuota,
  serverStore,
} from '../state.js';
import {
  createDemoEeBuildingFactsForCode,
  createDemoRegistryCandidates,
  normalizeRegistrySearchQuery,
  REGISTRY_CODE_PATTERN,
  REGISTRY_QUERY_MAX_LENGTH,
  REGISTRY_QUERY_MIN_LENGTH,
} from '../../utils/buildingPassport.js';

export async function handlePropertyRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, pathname, method, user, isBoard } = ctx;

    // 2. GET /api/v1/property/me
    if (pathname === '/api/v1/property/me' && method === 'GET') {
      const userMems = membershipsByUser[user.user_id] || [];
      return sendJson(res, 200, {
        user_id: user.user_id,
        building_id: BUILDING_ID,
        building_role: user.building_role,
        privacy_display_mode: userMems[0]?.privacy_display_mode || 'FULL_NAME',
        locale: userLocales[user.user_id] ?? null,
        shared_access: computeMockSharedAccess(userMems),
        memberships: userMems,
      });
    }

    // 2a. PATCH /api/v1/property/me/locale
    if (pathname === '/api/v1/property/me/locale' && method === 'PATCH') {
      const body = await readBody(req);
      const rawLocale = body.locale ?? null;
      if (rawLocale !== null && (typeof rawLocale !== 'string' || !['et', 'ru', 'en'].includes(rawLocale))) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid locale.');
      }
      const nextLocale = rawLocale as 'et' | 'ru' | 'en' | null;
      userLocales[user.user_id] = nextLocale;
      return sendJson(res, 200, { locale: nextLocale });
    }

    // 2b. GET /api/v1/property/building (Added in PR #31, updated #034/#035/#063)
    if (pathname === '/api/v1/property/building' && method === 'GET') {
      return sendJson(res, 200, {
        building_id: BUILDING_ID,
        name: 'KÜ Sõpruse 12',
        registry_code: '80123456',
        address: 'Sõpruse pst 12, Kristiine, Tallinn',
        country_code: 'EE',
        reading_deadline_day: 25,
        district: 'Kristiine',
        apartment_count: 6,
        apartments_count: 6,
        total_apartments: 6,
        entrance_count: 2,
        entrances_count: 2,
        total_entrances: 2,
        heated_area_m2: '329.20',
        object_counts: {
          APARTMENT: DEMO_APARTMENT_CARDS.filter((a) => (a.apartment_kind || 'APARTMENT') === 'APARTMENT').length,
          PARKING: DEMO_APARTMENT_CARDS.filter((a) => a.apartment_kind === 'PARKING').length,
          GARAGE: DEMO_APARTMENT_CARDS.filter((a) => a.apartment_kind === 'GARAGE').length,
        },
        registry_facts: serverStore.buildingRegistryState.accepted
          ? JSON.parse(JSON.stringify(serverStore.buildingRegistryState.accepted))
          : null,
      });
    }

    // 2b-reg. Building register endpoints (#035 E12/X1-X2)
    if (pathname === '/api/v1/property/building/registry' && method === 'GET') {
      if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
        return sendError(res, 403, 'FORBIDDEN', 'Only chairman and board members can view building register state.');
      }
      return sendJson(res, 200, JSON.parse(JSON.stringify(serverStore.buildingRegistryState)));
    }

    if (pathname === '/api/v1/property/building/registry/search' && method === 'POST') {
      if (user.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Only chairman can search the building register.');
      }
      const body = await readBody(req);
      let normalizedQuery = '';
      if (body && body.query !== undefined && body.query !== null) {
        if (typeof body.query !== 'string') {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Search query must be a string or null.');
        }
        normalizedQuery = normalizeRegistrySearchQuery(body.query);
        if (
          normalizedQuery.length < REGISTRY_QUERY_MIN_LENGTH ||
          normalizedQuery.length > REGISTRY_QUERY_MAX_LENGTH
        ) {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            'Search query must be between 3 and 200 characters.',
          );
        }
      }
      const quotaErr = checkAndConsumeRegistryQuota();
      if (quotaErr) {
        return sendError(
          res,
          429,
          'RATE_LIMITED',
          'Daily building register lookup limit reached.',
          {
            reason: 'DAILY_LIMIT',
            retry_after_seconds: quotaErr.retry_after_seconds,
          },
        );
      }
      const searchNeedle = (normalizedQuery || 'Sõpruse pst 12, Kristiine, Tallinn').toLowerCase();
      const allCandidates = createDemoRegistryCandidates();
      const matched =
        searchNeedle.includes('sõpruse') ||
        searchNeedle.includes('sopruse') ||
        searchNeedle.includes('tallinn') ||
        searchNeedle.includes('kristiine')
          ? allCandidates
          : allCandidates.filter(
              (c) =>
                c.address.toLowerCase().includes(searchNeedle) ||
                c.code.toLowerCase().includes(searchNeedle),
            );
      return sendJson(res, 200, {
        candidates: JSON.parse(JSON.stringify(matched.slice(0, 10))),
      });
    }

    if (pathname === '/api/v1/property/building/registry/proposal' && method === 'POST') {
      if (user.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Only chairman can fetch a building register proposal.');
      }
      const body = await readBody(req);
      const code = typeof body?.code === 'string' ? body.code.trim() : '';
      if (!REGISTRY_CODE_PATTERN.test(code)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Building register code must be 6–12 digits.');
      }
      const quotaErr = checkAndConsumeRegistryQuota();
      if (quotaErr) {
        return sendError(
          res,
          429,
          'RATE_LIMITED',
          'Daily building register lookup limit reached.',
          {
            reason: 'DAILY_LIMIT',
            retry_after_seconds: quotaErr.retry_after_seconds,
          },
        );
      }
      const nowIso = new Date().toISOString();
      const nextFacts = createDemoEeBuildingFactsForCode(code, nowIso);
      if (!nextFacts) {
        return sendError(res, 404, 'REGISTRY_BUILDING_NOT_FOUND', 'Building code not found in register.');
      }
      serverStore.buildingRegistryState.proposal = nextFacts;
      serverStore.buildingRegistryState.proposal_fetched_at = nowIso;
      return sendJson(res, 200, JSON.parse(JSON.stringify(serverStore.buildingRegistryState)));
    }

    if (pathname === '/api/v1/property/building/registry/accept' && method === 'POST') {
      if (user.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Only chairman can accept a building register proposal.');
      }
      if (!serverStore.buildingRegistryState.proposal) {
        return sendError(res, 409, 'NO_REGISTRY_PROPOSAL', 'No waiting register proposal to accept.');
      }
      const nowIso = new Date().toISOString();
      serverStore.buildingRegistryState.accepted = JSON.parse(JSON.stringify(serverStore.buildingRegistryState.proposal));
      serverStore.buildingRegistryState.accepted_at = nowIso;
      serverStore.buildingRegistryState.proposal = null;
      serverStore.buildingRegistryState.proposal_fetched_at = null;
      return sendJson(res, 200, JSON.parse(JSON.stringify(serverStore.buildingRegistryState)));
    }

    if (pathname === '/api/v1/property/building/registry' && method === 'DELETE') {
      if (user.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Only chairman can remove building register data.');
      }
      serverStore.buildingRegistryState.accepted = null;
      serverStore.buildingRegistryState.accepted_at = null;
      serverStore.buildingRegistryState.proposal = null;
      serverStore.buildingRegistryState.proposal_fetched_at = null;
      res.statusCode = 204;
      { res.end(); return true; }
    }

    // 2c. GET /api/v1/property/apartments & GET /api/v1/property/apartments/{apartment_id} (E8/P1)
    if (pathname === '/api/v1/property/apartments' && method === 'GET') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman or Board role required.');
      }
      const summaries = DEMO_APARTMENT_CARDS.map(({ residents: _residents, ...rest }) => rest);
      return sendJson(res, 200, { apartments: summaries });
    }

    const aptCardMatch = pathname.match(/^\/api\/v1\/property\/apartments\/([^/]+)$/);
    if (aptCardMatch && method === 'GET') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman or Board role required.');
      }
      const aptId = aptCardMatch[1];
      const found = DEMO_APARTMENT_CARDS.find((a) => a.apartment_id === aptId);
      if (!found) {
        return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'Apartment not found.');
      }
      return sendJson(res, 200, found);
    }

    // 3. PATCH /api/v1/property/memberships/{membership_id}/privacy
    const privacyMatch = pathname.match(/^\/api\/v1\/property\/memberships\/([^/]+)\/privacy$/);
    if (privacyMatch && method === 'PATCH') {
      const membershipId = privacyMatch[1];
      const body = await readBody(req);
      const userMems = membershipsByUser[user.user_id] || [];
      const target = userMems.find((m) => m.membership_id === membershipId);
      if (!target) {
        return sendError(res, 403, 'FORBIDDEN', 'Membership does not belong to current user.');
      }
      const newMode: DisplayMode =
        typeof body.privacy_display_mode === 'string' && body.privacy_display_mode
          ? (body.privacy_display_mode as DisplayMode)
          : 'FULL_NAME';
      target.privacy_display_mode = newMode;
      target.preview_badge = computePreviewBadge(
        user,
        target.apartment_number,
        newMode,
        target.apartment_kind,
      );
      return sendJson(res, 200, {
        membership_id: target.membership_id,
        privacy_display_mode: target.privacy_display_mode,
        preview_badge: target.preview_badge,
      });
    }

    // 3b. GET /api/v1/meters/periods (Added in PR #31: all periods, newest first)

  return false;
}
