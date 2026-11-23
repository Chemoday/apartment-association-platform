import type { SeedUser } from '../state.js';
import { type RouteContext, sendJson, sendError, readBody } from '../http.js';
import {
  serverStore,
} from '../state.js';
import {
  compareSettingKeys,
  validateAndApplySettingsUpdate,
} from '../../utils/associationSettings.js';
import {
  readSettingFromStore,
} from '../../utils/issues.js';

export async function handleSettingsRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, pathname, method, user, isBoard } = ctx;

    if (pathname === '/api/v1/settings' && method === 'GET') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members and the chairman can view association settings.');
      }
      const ordered = [...serverStore.associationSettingsStore].sort(compareSettingKeys);
      return sendJson(res, 200, { settings: ordered });
    }

    if (pathname === '/api/v1/settings' && method === 'PUT') {
      if (user.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Only the chairman can update association settings.');
      }
      const prevChatEnabled = Boolean(
        readSettingFromStore(serverStore.associationSettingsStore, 'chat.enabled', false)
      );
      const body = await readBody(req);
      const outcome = validateAndApplySettingsUpdate(serverStore.associationSettingsStore, body);
      if (!outcome.ok) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid association settings update.', {
          errors: outcome.errors,
        });
      }
      serverStore.associationSettingsStore = outcome.settings;
      const nextChatEnabled = Boolean(
        readSettingFromStore(serverStore.associationSettingsStore, 'chat.enabled', false)
      );
      if (!prevChatEnabled && nextChatEnabled) {
        serverStore.chatTurnedOnAt = new Date().toISOString();
        serverStore.chatMessagesStore = [];
      } else if (prevChatEnabled && !nextChatEnabled) {
        serverStore.chatTurnedOnAt = null;
        serverStore.chatMessagesStore = [];
      }
      return sendJson(res, 200, { settings: serverStore.associationSettingsStore });
    }

    // =========================================================================
    // Issue Tracker (/api/v1/issues) - #012 (E9/I1)
    // =========================================================================

  return false;
}
