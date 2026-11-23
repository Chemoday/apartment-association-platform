import type { SeedUser } from '../state.js';
import { type RouteContext, sendJson, sendError, readBody, readRawBody } from '../http.js';
import {
  DEMO_USERS,
  membershipsByUser,
  issuePhotoIdempotencyStore,
  issuePhotoDailyUploadsStore,
  activePhotoUploadsByUser,
  checkAndEmitServerStorageAlert,
  emitServerIssueNotificationBatch,
  resolveAuthorBadge,
  serverStore,
} from '../state.js';
import {
  MAX_ISSUE_PHOTO_BYTES,
  addIssuePhotoInStore,
  buildIssueReportedNotification,
  canUserAccessIssues,
  changeIssueStatusInStore,
  checkIssuePhotoUploadPreflight,
  clearIssueUrgentInStore,
  createIssueInStore,
  deleteIssuePhotoInStore,
  editIssueInStore,
  getIssuePhotoFromStore,
  isIssueVisibleToUser,
  queryIssuesStore,
  readSettingFromStore,
  toIssueView,
  updateIssueFollowInStore,
  withdrawIssueInStore,
} from '../../utils/issues.js';

export async function handleIssuesRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, urlObj, pathname, method, user } = ctx;

    if (pathname === '/api/v1/issues' || pathname.startsWith('/api/v1/issues/')) {
      const userMems = membershipsByUser[user.user_id] || [];
      if (!canUserAccessIssues(user, userMems)) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Only residents with an apartment and board members can access the issue tracker.'
        );
      }

      let refererUploadsDisabled = false;
      if (typeof req.headers.referer === 'string' && req.headers.referer) {
        try {
          refererUploadsDisabled =
            new URL(req.headers.referer).searchParams.get('simulate_uploads_disabled') === '1';
        } catch {
          refererUploadsDisabled = false;
        }
      }
      const uploadsDisabled =
        urlObj.searchParams.get('simulate_uploads_disabled') === '1' ||
        req.headers['x-simulate-uploads-disabled'] === '1' ||
        refererUploadsDisabled;

      if (pathname === '/api/v1/issues/form' && method === 'GET') {
        const urgentEnabled = Boolean(
          readSettingFromStore(serverStore.associationSettingsStore, 'issues.urgent_enabled', false)
        );
        const apartmentIds = userMems
          .slice()
          .sort((a, b) => a.apartment_number.localeCompare(b.apartment_number))
          .map((m) => m.apartment_id);
        return sendJson(res, 200, {
          urgent_enabled: urgentEnabled,
          uploads_enabled: !uploadsDisabled,
          apartment_ids: apartmentIds,
          entrances: [1, 2],
        });
      }

      if (pathname === '/api/v1/issues' && method === 'GET') {
        const result = queryIssuesStore(
          serverStore.issuesStore,
          user,
          {
            status: urlObj.searchParams.get('status'),
            category: urlObj.searchParams.get('category'),
            entrance: urlObj.searchParams.get('entrance'),
            include_old: urlObj.searchParams.get('include_old'),
            limit: urlObj.searchParams.get('limit'),
            offset: urlObj.searchParams.get('offset'),
          },
          Date.now(),
          { uploadsDisabled }
        );
        if (!result.ok) {
          return sendError(
            res,
            result.status || 422,
            result.errorCode || 'VALIDATION_ERROR',
            result.message || 'Invalid query.'
          );
        }
        return sendJson(res, 200, result.items);
      }

      if (pathname === '/api/v1/issues' && method === 'POST') {
        const body = await readBody(req);
        const requestedAptId =
          body?.apartment_id != null && body?.apartment_id !== ''
            ? String(body.apartment_id)
            : userMems[0]?.apartment_id;
        const matchedMem =
          userMems.find((m) => m.apartment_id === requestedAptId) || userMems[0];
        const reporterBadge =
          matchedMem?.preview_badge || resolveAuthorBadge(user.user_id);

        const outcome = createIssueInStore({
          issuesStore: serverStore.issuesStore,
          settingsStore: serverStore.associationSettingsStore,
          user,
          userMemberships: userMems,
          reporterBadge,
          body,
          buildingEntrances: [1, 2],
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Validation error.',
            outcome.extra || {}
          );
        }
        if (outcome.rawIssue) {
          const notifBatch = buildIssueReportedNotification(outcome.rawIssue, DEMO_USERS, user);
          emitServerIssueNotificationBatch(notifBatch);
        }
        return sendJson(
          res,
          201,
          toIssueView(outcome.rawIssue, user, { uploadsDisabled })
        );
      }

      const issueStatusMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/status$/);
      if (issueStatusMatch && method === 'POST') {
        const issueId = issueStatusMatch[1];
        const found = serverStore.issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const body = await readBody(req);
        const outcome = changeIssueStatusInStore({
          issuesStore: serverStore.issuesStore,
          issue: found,
          user,
          body,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Cannot change issue status.',
            outcome.extra || {}
          );
        }
        for (const notifBatch of outcome.notifications || []) {
          emitServerIssueNotificationBatch(notifBatch);
        }
        return sendJson(res, 200, toIssueView(found, user, { uploadsDisabled }));
      }

      const issueUrgentClearMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/urgent\/clear$/);
      if (issueUrgentClearMatch && method === 'POST') {
        const issueId = issueUrgentClearMatch[1];
        const found = serverStore.issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const outcome = clearIssueUrgentInStore({
          issue: found,
          user,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 409,
            outcome.errorCode || 'ISSUE_ENDED',
            outcome.message || 'Cannot clear urgent flag.'
          );
        }
        return sendJson(res, 200, toIssueView(found, user, { uploadsDisabled }));
      }

      const issueWithdrawMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/withdraw$/);
      if (issueWithdrawMatch && method === 'POST') {
        const issueId = issueWithdrawMatch[1];
        const found = serverStore.issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const outcome = withdrawIssueInStore({ issue: found, user });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 409,
            outcome.errorCode || 'ISSUE_NOT_EDITABLE',
            outcome.message || 'Cannot withdraw issue.'
          );
        }
        return sendJson(res, 200, toIssueView(found, user, { uploadsDisabled }));
      }

      const issueFollowMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/follow$/);
      if (issueFollowMatch && (method === 'PUT' || method === 'DELETE')) {
        const issueId = issueFollowMatch[1];
        const found = serverStore.issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const outcome = updateIssueFollowInStore({
          issue: found,
          user,
          follow: method === 'PUT',
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 409,
            outcome.errorCode || 'ISSUE_ENDED',
            outcome.message || 'Cannot update follow state.'
          );
        }
        return sendJson(res, 200, toIssueView(found, user, { uploadsDisabled }));
      }

      // POST /api/v1/issues/:issueId/photos
      const issuePhotosMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/photos$/);
      if (issuePhotosMatch && method === 'POST') {
        const issueId = issuePhotosMatch[1];
        const found = serverStore.issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }

        const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user?.building_role);
        const simAnswer = String(
          urlObj.searchParams.get('simulate_upload_answer') ||
            req.headers['x-simulate-upload-answer'] ||
            ''
        ).toUpperCase();

        const idempotencyKeyHeader =
          (req.headers['idempotency-key'] as string | undefined) || '';
        const rawLengthHeader = req.headers['content-length'];
        const parsedLength =
          rawLengthHeader !== undefined && rawLengthHeader !== ''
            ? Number(rawLengthHeader)
            : null;
        const contentTypeHeader =
          (req.headers['content-type'] as string | undefined) || '';

        const preflight = checkIssuePhotoUploadPreflight({
          issue: found,
          user,
          contentType: contentTypeHeader,
          contentLength: parsedLength,
          idempotencyKey: idempotencyKeyHeader,
          idempotencyStore: issuePhotoIdempotencyStore,
          dailyUploadsStore: issuePhotoDailyUploadsStore,
          uploadsDisabled,
          quotaExceededReason:
            simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
          lowDisk: simAnswer === 'LOW_DISK',
        });
        if (!preflight.ok) {
          return sendError(
            res,
            preflight.status || 422,
            preflight.errorCode || 'VALIDATION_ERROR',
            preflight.message || 'Cannot upload photo.',
            preflight.extra || {}
          );
        }
        if (preflight.replay) {
          return sendJson(res, preflight.status || 200, preflight.photo);
        }

        if (simAnswer === 'DAILY_LIMIT' && !isBoardUser) {
          return sendError(
            res,
            429,
            'RATE_LIMITED',
            'You have stored the photos allowed for today.',
            {
              reason: 'DAILY_LIMIT',
              retry_after_seconds: 3600,
            }
          );
        }

        const uid = user?.user_id || 'anon';
        const activeCount = activePhotoUploadsByUser.get(uid) || 0;
        if (activeCount >= 2 || simAnswer === 'BUSY') {
          return sendError(res, 429, 'RATE_LIMITED', 'Server is busy.', {
            reason: 'BUSY',
            retry_after_seconds: simAnswer === 'BUSY' ? 15 : 5,
          });
        }

        activePhotoUploadsByUser.set(uid, activeCount + 1);
        try {
          if (simAnswer === 'UPLOAD_TIMEOUT') {
            return sendError(res, 408, 'UPLOAD_TIMEOUT', 'Upload body timed out.');
          }

          const { interrupted, tooLarge, buffer } = await readRawBody(
            req,
            MAX_ISSUE_PHOTO_BYTES,
            parsedLength,
          );
          if (interrupted) {
            return sendError(res, 400, 'UPLOAD_INTERRUPTED', 'Upload interrupted; please retry.');
          }
          if (tooLarge) {
            return sendError(res, 413, 'FILE_TOO_LARGE', 'Photo exceeds the 4 MB limit.', {
              max_bytes: MAX_ISSUE_PHOTO_BYTES,
            });
          }
          const outcome = addIssuePhotoInStore({
            issue: found,
            user,
            bytes: buffer,
            contentType: contentTypeHeader,
            contentLength: parsedLength as number,
            idempotencyKey: idempotencyKeyHeader,
            idempotencyStore: issuePhotoIdempotencyStore,
            dailyUploadsStore: issuePhotoDailyUploadsStore,
            uploadsDisabled,
            quotaExceededReason:
              simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
            lowDisk: simAnswer === 'LOW_DISK',
          });
          if (!outcome.ok) {
            return sendError(
              res,
              outcome.status || 422,
              outcome.errorCode || 'VALIDATION_ERROR',
              outcome.message || 'Cannot upload photo.',
              outcome.extra || {}
            );
          }
          checkAndEmitServerStorageAlert();
          return sendJson(res, outcome.status || 201, outcome.photo);
        } finally {
          const remaining = (activePhotoUploadsByUser.get(uid) || 1) - 1;
          if (remaining <= 0) {
            activePhotoUploadsByUser.delete(uid);
          } else {
            activePhotoUploadsByUser.set(uid, remaining);
          }
        }
      }

      // GET / DELETE /api/v1/issues/:issueId/photos/:photoId
      const issuePhotoItemMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/photos\/([^/]+)$/);
      if (issuePhotoItemMatch && method === 'GET') {
        const issueId = issuePhotoItemMatch[1];
        const photoId = issuePhotoItemMatch[2];
        const found = serverStore.issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const variant = urlObj.searchParams.get('variant') || 'display';
        const outcome = getIssuePhotoFromStore({ issue: found, photoId, variant });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 404,
            outcome.errorCode || 'PHOTO_NOT_FOUND',
            outcome.message || 'Photo not found.'
          );
        }
        const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`;
        res.statusCode = 200;
        res.setHeader('Content-Type', outcome.mime || 'image/webp');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
        res.setHeader('X-Trace-Id', traceId);
        { res.end(Buffer.from(outcome.bytes)); return true; }
      }

      if (issuePhotoItemMatch && method === 'DELETE') {
        const issueId = issuePhotoItemMatch[1];
        const photoId = issuePhotoItemMatch[2];
        const found = serverStore.issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const outcome = deleteIssuePhotoInStore({
          issue: found,
          user,
          photoId,
          idempotencyStore: issuePhotoIdempotencyStore,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 404,
            outcome.errorCode || 'PHOTO_NOT_FOUND',
            outcome.message || 'Photo not found.'
          );
        }
        const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`;
        res.statusCode = 204;
        res.setHeader('X-Trace-Id', traceId);
        { res.end(); return true; }
      }

      const issueDetailMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)$/);
      if (issueDetailMatch && method === 'GET') {
        const issueId = issueDetailMatch[1];
        const found = serverStore.issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        return sendJson(res, 200, toIssueView(found, user, { uploadsDisabled }));
      }

      if (issueDetailMatch && method === 'PATCH') {
        const issueId = issueDetailMatch[1];
        const found = serverStore.issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const body = await readBody(req);
        const outcome = editIssueInStore({
          issue: found,
          user,
          body,
          buildingEntrances: [1, 2],
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Cannot edit issue.'
          );
        }
        return sendJson(res, 200, toIssueView(found, user, { uploadsDisabled }));
      }
    }

    // =========================================================================
    // Association Documents (/api/v1/documents) - #022 & #023 (E11/F3)
    // =========================================================================

  return false;
}
