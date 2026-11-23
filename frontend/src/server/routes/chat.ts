import type { SeedUser } from '../state.js';
import { type RouteContext, sendJson, sendError, readBody } from '../http.js';
import {
  membershipsByUser,
  serverStore,
} from '../state.js';
import {
  readSettingFromStore,
} from '../../utils/issues.js';
import {
  CHAT_HISTORY_MS,
  CHAT_MAX_LENGTH,
  buildMockChatPage,
  buildMockChatState,
  canUserParticipateInChat,
  evaluateChatRateLimit,
  validateChatAfterParam,
  validateChatLimitParam,
  validateChatMessageInput,
} from '../../utils/chat.js';

export async function handleChatRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, urlObj, pathname, method, user } = ctx;

    if (pathname === '/api/v1/chat' && method === 'GET') {
      const enabled = Boolean(
        readSettingFromStore(serverStore.associationSettingsStore, 'chat.enabled', false)
      );
      const userMems = membershipsByUser[user.user_id] || [];
      const canTakePart = canUserParticipateInChat(user, userMems);
      return sendJson(
        res,
        200,
        buildMockChatState({
          enabled,
          turnedOnAt: serverStore.chatTurnedOnAt,
          canTakePart,
          messages: serverStore.chatMessagesStore,
          nowMs: Date.now(),
        })
      );
    }

    if (pathname === '/api/v1/chat/messages' && method === 'GET') {
      const userMems = membershipsByUser[user.user_id] || [];
      if (!canUserParticipateInChat(user, userMems)) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Only building apartment members and board members can participate in the building chat.'
        );
      }
      const enabled = Boolean(
        readSettingFromStore(serverStore.associationSettingsStore, 'chat.enabled', false)
      );
      if (!enabled) {
        return sendError(res, 409, 'CHAT_DISABLED', 'Building chat is currently turned off.');
      }
      const afterOutcome = validateChatAfterParam(urlObj.searchParams.get('after'));
      if (!afterOutcome.ok) {
        return sendError(res, 422, 'VALIDATION_ERROR', afterOutcome.error.message, {
          errors: [afterOutcome.error],
        });
      }
      const limitOutcome = validateChatLimitParam(urlObj.searchParams.get('limit'));
      if (!limitOutcome.ok) {
        return sendError(res, 422, 'VALIDATION_ERROR', limitOutcome.error.message, {
          errors: [limitOutcome.error],
        });
      }
      const nowMs = Date.now();
      serverStore.chatMessagesStore = serverStore.chatMessagesStore.filter((m) => Date.parse(m.expires_at) > nowMs);
      return sendJson(
        res,
        200,
        buildMockChatPage({
          messages: serverStore.chatMessagesStore,
          turnedOnAt: serverStore.chatTurnedOnAt,
          afterCursor: afterOutcome.value,
          limit: limitOutcome.value,
          callerUserId: user.user_id,
          nowMs,
        })
      );
    }

    if (pathname === '/api/v1/chat/messages' && method === 'POST') {
      const userMems = membershipsByUser[user.user_id] || [];
      if (!canUserParticipateInChat(user, userMems)) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Only building apartment members and board members can participate in the building chat.'
        );
      }
      const enabled = Boolean(
        readSettingFromStore(serverStore.associationSettingsStore, 'chat.enabled', false)
      );
      if (!enabled) {
        return sendError(res, 409, 'CHAT_DISABLED', 'Building chat is currently turned off.');
      }
      const body = await readBody(req);
      const inputOutcome = validateChatMessageInput({
        payload: body,
        user,
        memberships: userMems,
        maxLength: CHAT_MAX_LENGTH,
      });
      if (!inputOutcome.ok) {
        return sendError(
          res,
          inputOutcome.status,
          inputOutcome.errorCode,
          inputOutcome.message,
          inputOutcome.errors ? { errors: inputOutcome.errors } : {}
        );
      }
      const nowMs = Date.now();
      const rateOutcome = evaluateChatRateLimit(
        serverStore.chatPostTimestampsByUser[user.user_id],
        nowMs
      );
      if (!rateOutcome.ok) {
        serverStore.chatPostTimestampsByUser[user.user_id] = rateOutcome.pruned;
        return sendError(
          res,
          429,
          'RATE_LIMITED',
          'Too many messages sent. Please wait before sending again.',
          {
            retry_after_seconds: rateOutcome.retryAfterSeconds,
            reason: rateOutcome.reason,
          }
        );
      }
      serverStore.chatPostTimestampsByUser[user.user_id] = [...rateOutcome.pruned, nowMs];
      serverStore.chatMessagesStore = serverStore.chatMessagesStore.filter((m) => Date.parse(m.expires_at) > nowMs);
      const createdAtIso = new Date(nowMs).toISOString();
      const expiresAtIso = new Date(nowMs + CHAT_HISTORY_MS).toISOString();
      const storedMsg = {
        id: serverStore.chatNextId++,
        body: inputOutcome.body,
        author_badge: inputOutcome.badge,
        author_user_id: user.user_id,
        created_at: createdAtIso,
        expires_at: expiresAtIso,
      };
      serverStore.chatMessagesStore.push(storedMsg);
      return sendJson(res, 201, {
        id: storedMsg.id,
        body: storedMsg.body,
        author_badge: storedMsg.author_badge,
        created_at: storedMsg.created_at,
        expires_at: storedMsg.expires_at,
        is_own: true,
      });
    }


  return false;
}
