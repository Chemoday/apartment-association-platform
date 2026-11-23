import type { SeedUser } from '../state.js';
import { type RouteContext, sendJson, sendError, readBody } from '../http.js';
import {
  pollsStore,
  emitPollOpenedNotifications,
  refreshExpiredPolls,
  isPollVisibleToUser,
  computePollAnswerability,
  comparePollsOrder,
  toPollSummary,
  toPollView,
  computePollElectorateCount,
  computeServerPollResults,
  validateAndBuildServerPollDraft,
  validateIncomingBallotAnswers,
  type InternalPoll,
} from '../state.js';

export async function handleGovernanceRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, urlObj, pathname, method, user, isBoard } = ctx;

    if (pathname === '/api/v1/governance/polls' && method === 'GET') {
      const statusFilter = urlObj.searchParams.get('status');
      const limit = Math.min(Math.max(Number(urlObj.searchParams.get('limit') || '50'), 1), 100);
      const offset = Math.max(Number(urlObj.searchParams.get('offset') || '0'), 0);

      if (statusFilter && !['DRAFT', 'OPEN', 'CLOSED', 'CANCELLED'].includes(statusFilter)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid poll status filter.');
      }

      refreshExpiredPolls();
      const visible = pollsStore.filter((p) => {
        if (!isPollVisibleToUser(p, user)) return false;
        if (statusFilter && p.status !== statusFilter) return false;
        return true;
      });

      visible.sort(comparePollsOrder);
      const paged = visible.slice(offset, offset + limit).map((p) => toPollSummary(p, user));
      return sendJson(res, 200, paged);
    }

    if (pathname === '/api/v1/governance/polls' && method === 'POST') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members can create polls.');
      }
      const body = await readBody(req);
      const parsed = validateAndBuildServerPollDraft(body);
      if (!parsed.draft) {
        return sendError(
          res,
          parsed.errorStatus || 422,
          parsed.errorCode || 'VALIDATION_ERROR',
          parsed.errorMessage || 'Invalid poll draft.',
          parsed.errorExtra || {}
        );
      }
      const nowIso = new Date().toISOString();
      const created: InternalPoll = {
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        ...parsed.draft,
        status: 'DRAFT',
        opened_at: null,
        closed_at: null,
        cancelled_at: null,
        created_at: nowIso,
        ballots: [],
      };
      pollsStore.unshift(created);
      return sendJson(res, 201, toPollView(created, user));
    }

    const pollActionMatch = pathname.match(
      /^\/api\/v1\/governance\/polls\/([^/]+)\/(open|close|cancel)$/
    );
    if (pollActionMatch && method === 'POST') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members can manage polls.');
      }
      const [, pollId, action] = pollActionMatch;
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const maxFutureMs = nowMs + 366 * 86400 * 1000;

      if (action === 'open') {
        if (found.status !== 'DRAFT') {
          return sendError(res, 409, 'POLL_NOT_DRAFT', 'Only a draft poll can be opened.');
        }
        const closesMs = new Date(found.closes_at).getTime();
        if (Number.isNaN(closesMs) || closesMs <= nowMs || closesMs > maxFutureMs) {
          return sendError(
            res,
            422,
            'INVALID_DEADLINE',
            'The closing time must be in the future (at most one year ahead).'
          );
        }
        if (computePollElectorateCount(found) < 1) {
          return sendError(
            res,
            422,
            'POLL_HAS_NO_ELECTORATE',
            'Nobody in the target scope can answer this poll.'
          );
        }
        found.status = 'OPEN';
        found.opened_at = nowIso;
        emitPollOpenedNotifications(found, user, nowIso);
        return sendJson(res, 200, toPollView(found, user));
      }

      if (action === 'close') {
        if (found.status !== 'OPEN') {
          return sendError(res, 409, 'POLL_NOT_OPEN', 'Only an open poll can be closed.');
        }
        found.status = 'CLOSED';
        found.closed_at = nowIso;
        return sendJson(res, 200, toPollView(found, user));
      }

      if (action === 'cancel') {
        if (found.status !== 'OPEN') {
          return sendError(res, 409, 'POLL_NOT_OPEN', 'Only an open poll can be cancelled.');
        }
        found.status = 'CANCELLED';
        found.cancelled_at = nowIso;
        return sendJson(res, 200, toPollView(found, user));
      }
    }

    const pollDetailMatch = pathname.match(/^\/api\/v1\/governance\/polls\/([^/]+)$/);
    if (pollDetailMatch && method === 'GET') {
      const pollId = pollDetailMatch[1];
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found || !isPollVisibleToUser(found, user)) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      return sendJson(res, 200, toPollView(found, user));
    }

    if (pollDetailMatch && method === 'PUT') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members can edit poll drafts.');
      }
      const pollId = pollDetailMatch[1];
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      if (found.status !== 'DRAFT') {
        return sendError(res, 409, 'POLL_NOT_DRAFT', 'Only a draft poll can be edited.');
      }
      const body = await readBody(req);
      const parsed = validateAndBuildServerPollDraft(body);
      if (!parsed.draft) {
        return sendError(
          res,
          parsed.errorStatus || 422,
          parsed.errorCode || 'VALIDATION_ERROR',
          parsed.errorMessage || 'Invalid poll draft.',
          parsed.errorExtra || {}
        );
      }
      Object.assign(found, parsed.draft);
      return sendJson(res, 200, toPollView(found, user));
    }

    if (pollDetailMatch && method === 'DELETE') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members can delete poll drafts.');
      }
      const pollId = pollDetailMatch[1];
      refreshExpiredPolls();
      const idx = pollsStore.findIndex((p) => p.id === pollId);
      if (idx === -1) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      if (pollsStore[idx].status !== 'DRAFT') {
        return sendError(res, 409, 'POLL_NOT_DRAFT', 'Only a draft poll can be deleted.');
      }
      pollsStore.splice(idx, 1);
      res.statusCode = 204;
      res.end();
      return true;
    }

    if (pollDetailMatch && method === 'PATCH') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members can extend poll deadlines.');
      }
      const pollId = pollDetailMatch[1];
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      if (found.status !== 'OPEN') {
        return sendError(res, 409, 'POLL_NOT_OPEN', 'Only an open poll deadline can be extended.');
      }
      const body = await readBody(req);
      const nextClosesAt = typeof body?.closes_at === 'string' ? body.closes_at.trim() : '';
      const nextMs = new Date(nextClosesAt).getTime();
      const currentMs = new Date(found.closes_at).getTime();
      const maxFutureMs = Date.now() + 366 * 86400 * 1000;
      if (!nextClosesAt || Number.isNaN(nextMs) || nextMs <= currentMs || nextMs > maxFutureMs) {
        return sendError(
          res,
          422,
          'INVALID_DEADLINE',
          'The new deadline must be later than the current deadline (and at most one year from now).'
        );
      }
      found.closes_at = nextClosesAt;
      return sendJson(res, 200, toPollView(found, user));
    }

    const pollBallotMatch = pathname.match(/^\/api\/v1\/governance\/polls\/([^/]+)\/ballot$/);
    if (pollBallotMatch && method === 'PUT') {
      const pollId = pollBallotMatch[1];
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found || !isPollVisibleToUser(found, user)) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      if (found.status !== 'OPEN' || new Date(found.closes_at).getTime() <= Date.now()) {
        if (found.status === 'OPEN') {
          found.status = 'CLOSED';
          found.closed_at = found.closes_at;
        }
        return sendError(res, 409, 'POLL_NOT_OPEN', 'This poll has closed.');
      }

      const { canAnswer, answerableApartmentIds } = computePollAnswerability(found, user);
      if (!canAnswer) {
        return sendError(res, 403, 'NOT_ELIGIBLE', 'You cannot answer this poll.');
      }

      const body = await readBody(req);
      let targetApartmentId: string | null = null;

      if (found.unit === 'PERSON') {
        if (body.apartment_id !== undefined && body.apartment_id !== null) {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            'apartment_id must not be sent for a PERSON poll.'
          );
        }
      } else {
        if (body.apartment_id !== undefined && body.apartment_id !== null) {
          if (!answerableApartmentIds.includes(String(body.apartment_id))) {
            return sendError(res, 403, 'NOT_ELIGIBLE', 'You cannot answer for this apartment.');
          }
          targetApartmentId = String(body.apartment_id);
        } else if (answerableApartmentIds.length === 1) {
          targetApartmentId = answerableApartmentIds[0];
        } else {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            'Select which apartment is answering.'
          );
        }
      }

      const rawAnswers = Array.isArray(body.answers) ? body.answers : null;
      if (!rawAnswers) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'answers must be an array.');
      }

      const validationResult = validateIncomingBallotAnswers(found.questions, rawAnswers);
      if (!validationResult.valid) {
        return sendError(res, 422, 'INVALID_ANSWER', 'Invalid answer.', {
          question_id: validationResult.questionId,
          reason: validationResult.reason,
        });
      }

      const nowIso = new Date().toISOString();
      const existingIdx = found.ballots.findIndex((b) =>
        found.unit === 'APARTMENT'
          ? b.apartment_id === targetApartmentId
          : b.user_id === user.user_id
      );

      if (existingIdx >= 0) {
        found.ballots[existingIdx] = {
          ...found.ballots[existingIdx],
          updated_at: nowIso,
          answers: validationResult.normalizedAnswers,
        };
      } else {
        found.ballots.push({
          apartment_id: found.unit === 'APARTMENT' ? targetApartmentId : null,
          user_id: found.unit === 'PERSON' ? user.user_id : null,
          submitted_at: nowIso,
          updated_at: nowIso,
          answers: validationResult.normalizedAnswers,
        });
      }

      return sendJson(res, 200, toPollView(found, user));
    }

    const pollResultsMatch = pathname.match(/^\/api\/v1\/governance\/polls\/([^/]+)\/results$/);
    if (pollResultsMatch && method === 'GET') {
      const pollId = pollResultsMatch[1];
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found || !isPollVisibleToUser(found, user)) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      const resultsAvailable =
        found.status === 'CLOSED' || (found.status === 'OPEN' && isBoard);
      if (!resultsAvailable) {
        return sendError(
          res,
          409,
          'RESULTS_NOT_AVAILABLE',
          'Results are not available for this poll.',
          { status: found.status }
        );
      }
      return sendJson(res, 200, computeServerPollResults(found, isBoard));
    }


  return false;
}
