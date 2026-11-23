import type { SeedUser } from '../state.js';
import { type RouteContext, sendJson, sendError, readBody } from '../http.js';
import {
  bindingsByUser,
  getUserNotifications,
  getUserPreferences,
} from '../state.js';

export async function handleNotificationsRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, urlObj, pathname, method, user } = ctx;

    if (pathname === '/api/v1/notifications/unread-count' && method === 'GET') {
      const list = getUserNotifications(user.user_id);
      const unreadCount = list.filter((n) => n.read_at === null).length;
      return sendJson(res, 200, { unread: unreadCount });
    }

    if (pathname === '/api/v1/notifications/feed' && method === 'GET') {
      const unreadOnly = urlObj.searchParams.get('unread_only') === 'true';
      const limit = Number(urlObj.searchParams.get('limit') || '50');
      const offset = Number(urlObj.searchParams.get('offset') || '0');
      const list = getUserNotifications(user.user_id);
      const filtered = unreadOnly ? list.filter((n) => n.read_at === null) : list;
      const paged = filtered.slice(offset, offset + limit).map(({ user_id, ...rest }) => rest);
      return sendJson(res, 200, paged);
    }

    if (pathname === '/api/v1/notifications/feed/read-all' && method === 'POST') {
      const list = getUserNotifications(user.user_id);
      const nowIso = new Date().toISOString();
      let updated = 0;
      for (const item of list) {
        if (item.read_at === null) {
          item.read_at = nowIso;
          updated += 1;
        }
      }
      return sendJson(res, 200, { updated });
    }

    const readOneMatch = pathname.match(/^\/api\/v1\/notifications\/feed\/([^/]+)\/read$/);
    if (readOneMatch && method === 'POST') {
      const notifId = readOneMatch[1];
      const list = getUserNotifications(user.user_id);
      const item = list.find((n) => n.id === notifId);
      if (!item) {
        return sendError(res, 404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
      }
      if (!item.read_at) {
        item.read_at = new Date().toISOString();
      }
      return sendJson(res, 200, { id: item.id, read_at: item.read_at });
    }

    if (pathname === '/api/v1/notifications/preferences' && method === 'GET') {
      const prefs = getUserPreferences(user.user_id);
      return sendJson(res, 200, {
        channels: [
          { channel: 'in_app', available: true, reason: null },
          { channel: 'email', available: false, reason: 'DEMO_MODE' },
          { channel: 'telegram', available: false, reason: 'DEMO_MODE' },
          { channel: 'webpush', available: false, reason: 'DEMO_MODE' },
        ],
        preferences: prefs,
      });
    }

    if (pathname === '/api/v1/notifications/preferences' && method === 'PUT') {
      const body = await readBody(req);
      const changes = Array.isArray(body.preferences) ? body.preferences : [];
      if (changes.length < 1 || changes.length > 56) {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          'Provide between 1 and 56 preference changes.'
        );
      }
      const prefs = getUserPreferences(user.user_id);

      for (const chg of changes) {
        const match = prefs.find(
          (p) => p.event_type === chg.event_type && p.channel === chg.channel
        );
        if (match?.mandatory && chg.enabled === false) {
          return sendError(
            res,
            422,
            'PREFERENCE_MANDATORY',
            'Mandatory notifications cannot be switched off.'
          );
        }
      }

      for (const chg of changes) {
        const match = prefs.find(
          (p) => p.event_type === chg.event_type && p.channel === chg.channel
        );
        if (match && !match.mandatory) {
          match.enabled = Boolean(chg.enabled);
        }
      }

      return sendJson(res, 200, {
        channels: [
          { channel: 'in_app', available: true, reason: null },
          { channel: 'email', available: false, reason: 'DEMO_MODE' },
          { channel: 'telegram', available: false, reason: 'DEMO_MODE' },
          { channel: 'webpush', available: false, reason: 'DEMO_MODE' },
        ],
        preferences: prefs,
      });
    }

    if (pathname === '/api/v1/notifications/bindings' && method === 'GET') {
      return sendJson(res, 200, bindingsByUser[user.user_id] || []);
    }

    const deleteBindingMatch = pathname.match(/^\/api\/v1\/notifications\/bindings\/([^/]+)$/);
    if (deleteBindingMatch && method === 'DELETE') {
      const bId = deleteBindingMatch[1];
      const list = bindingsByUser[user.user_id] || [];
      bindingsByUser[user.user_id] = list.filter((b) => b.binding_id !== bId);
      res.statusCode = 204;
      { res.end(); return true; }
    }

    if (pathname === '/api/v1/notifications/telegram/link-code' && method === 'POST') {
      return sendError(res, 404, 'CHANNEL_NOT_ENABLED', 'Telegram channel is not enabled in demo mode.');
    }

    if (pathname === '/api/v1/notifications/webpush/vapid-public-key' && method === 'GET') {
      return sendError(res, 404, 'CHANNEL_NOT_ENABLED', 'WebPush channel is not enabled in demo mode.');
    }

    if (pathname === '/api/v1/notifications/webpush/subscriptions' && method === 'POST') {
      return sendError(res, 404, 'CHANNEL_NOT_ENABLED', 'WebPush channel is not enabled in demo mode.');
    }

    if (pathname === '/api/v1/notifications/unsubscribe') {
      if (method !== 'POST') {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
      }
      const token = urlObj.searchParams.get('token') || '';
      if (!token || token.length > 128) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Missing or invalid token.');
      }
      if (token.startsWith('demo-')) {
        const lower = token.toLowerCase();
        const eventType = lower.includes('emergency')
          ? 'EMERGENCY_RESOLVED'
          : lower.includes('review')
            ? 'PERIOD_REVIEW'
            : lower.includes('poll')
              ? 'POLL_OPENED'
              : lower.includes('issue-reported')
                ? 'ISSUE_REPORTED'
                : lower.includes('issue')
                  ? 'ISSUE_STATUS_CHANGED'
                  : lower.includes('storage')
                    ? 'STORAGE_ALMOST_FULL'
                    : lower.includes('energy') || lower.includes('certificate')
                      ? 'ENERGY_CERTIFICATE_EXPIRING'
                      : lower.includes('board')
                        ? 'APARTMENT_MESSAGE_TO_BOARD'
                        : lower.includes('message')
                          ? 'APARTMENT_MESSAGE'
                          : 'READING_DEADLINE';
        const prefs = getUserPreferences(user.user_id);
        const match = prefs.find((p) => p.event_type === eventType && p.channel === 'email');
        if (match && !match.mandatory) {
          match.enabled = false;
        }
        return sendJson(res, 200, {
          event_type: eventType,
          channel: 'email',
        });
      }
      return sendError(res, 400, 'INVALID_LINK', 'This unsubscribe link is invalid or expired.');
    }

    // =========================================================================
    // Governance Polls (/api/v1/governance/polls)
    // =========================================================================

  return false;
}
