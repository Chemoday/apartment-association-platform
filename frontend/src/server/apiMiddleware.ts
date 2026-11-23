import type { IncomingMessage, ServerResponse } from 'http';
import type { DemoUserView } from '../api/schema.js';
import { sendError, sendJson, type RouteContext, type RouteHandler } from './http.js';
import { DEMO_USERS, getActingUser, resetApiMiddlewareStateForTest, type SeedUser } from './state.js';
import { handlePropertyRoutes } from './routes/property.js';
import { handleMetersRoutes } from './routes/meters.js';
import { handleCommunicationRoutes } from './routes/communication.js';
import { handleAuthRoutes } from './routes/auth.js';
import { handleNotificationsRoutes } from './routes/notifications.js';
import { handleGovernanceRoutes } from './routes/governance.js';
import { handleSettingsRoutes } from './routes/settings.js';
import { handleIssuesRoutes } from './routes/issues.js';
import { handleDocumentsRoutes } from './routes/documents.js';
import { handleMaintenanceRoutes } from './routes/maintenance.js';
import { handleChatRoutes } from './routes/chat.js';

export { resetApiMiddlewareStateForTest };

function selectRouteHandler(pathname: string): RouteHandler<SeedUser> | null {
  if (pathname.startsWith('/api/v1/property/')) return handlePropertyRoutes;
  if (pathname.startsWith('/api/v1/meters/')) return handleMetersRoutes;
  if (pathname.startsWith('/api/v1/communication/')) return handleCommunicationRoutes;
  if (pathname.startsWith('/api/v1/auth/')) return handleAuthRoutes;
  if (pathname.startsWith('/api/v1/notifications/')) return handleNotificationsRoutes;
  if (pathname.startsWith('/api/v1/governance/')) return handleGovernanceRoutes;
  if (pathname === '/api/v1/settings' || pathname.startsWith('/api/v1/settings/')) return handleSettingsRoutes;
  if (pathname === '/api/v1/issues' || pathname.startsWith('/api/v1/issues/')) return handleIssuesRoutes;
  if (
    pathname === '/api/v1/documents' ||
    pathname.startsWith('/api/v1/documents/') ||
    pathname.startsWith('/api/v1/files/')
  ) {
    return handleDocumentsRoutes;
  }
  if (pathname.startsWith('/api/v1/maintenance/')) return handleMaintenanceRoutes;
  if (pathname === '/api/v1/chat' || pathname.startsWith('/api/v1/chat/')) return handleChatRoutes;
  return null;
}

export function createApiMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const rawUrl = req.url || '';
    const urlObj = new URL(rawUrl, 'http://localhost:3000');
    const pathname = urlObj.pathname;
    const method = req.method || 'GET';

    if (pathname === '/health' && method === 'GET') {
      sendJson(res, 200, { status: 'ok', service: 'apartment-association-backend' });
      return;
    }
    if (pathname === '/health/ready' && method === 'GET') {
      sendJson(res, 200, { status: 'ready', checks: { database: 'ok' } });
      return;
    }

    if (!pathname.startsWith('/api/v1/')) {
      return next();
    }

    // 1. GET /api/v1/demo/users
    if (pathname === '/api/v1/demo/users' && method === 'GET') {
      const views: DemoUserView[] = DEMO_USERS.map((u) => ({
        user_id: u.user_id,
        label: u.label,
        building_role: u.building_role,
        apartment_number: u.apartment_number,
        relation_type: u.relation_type,
      }));
      sendJson(res, 200, views);
      return;
    }

    const user = getActingUser(req);
    const ctx: RouteContext<SeedUser> = {
      req,
      res,
      urlObj,
      pathname,
      method,
      user,
      isBoardOrAccountant: ['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role),
      isBoard: ['CHAIRMAN', 'BOARD'].includes(user.building_role),
      state: undefined,
    };

    const handler = selectRouteHandler(pathname);
    if (handler && (await handler(ctx))) {
      return;
    }

    sendError(res, 404, 'NOT_FOUND', `Endpoint ${method} ${pathname} not found.`);
  };
}
