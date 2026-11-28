import type { SeedUser } from '../state.js';
import type { AuthorBadgeDTO } from '../../api/schema.js';
import { type RouteContext, sendJson, sendError, readBody, readRawBody } from '../http.js';
import {
  DEMO_USERS,
  membershipsByUser,
  documentIdempotencyStore,
  activeDocumentUploadsByUser,
  checkAndEmitServerStorageAlert,
  serverStore,
} from '../state.js';
import {
  MAX_DOCUMENT_BYTES,
  addDocumentInStore,
  canUserAccessDocumentsModule,
  checkDocumentUploadPreflight,
  deleteDocumentInStore,
  editDocumentInStore,
  getDocumentFileFromStore,
  getDocumentFromStore,
  getUploadOptionsForUser,
  queryDocumentsStore,
} from '../../utils/documents.js';
import {
  computeStorageUsage,
} from '../../utils/storage.js';

export async function handleDocumentsRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, urlObj, pathname, method, user } = ctx;

    if (pathname === '/api/v1/documents' || pathname.startsWith('/api/v1/documents/')) {
      const userMems = membershipsByUser[user.user_id] || [];
      const resolveDocBadge = (uid: string): AuthorBadgeDTO => {
        const u = DEMO_USERS.find((item) => item.user_id === uid);
        if (u?.building_role === 'CHAIRMAN') {
          return { display_label: 'Board Chairman', role_badge: 'BOARD' };
        }
        if (u?.building_role === 'ACCOUNTANT') {
          return { display_label: 'Accountant', role_badge: 'ACCOUNTANT' };
        }
        return { display_label: 'Board Member', role_badge: 'BOARD' };
      };

      let refererDocUploadsDisabled = false;
      if (typeof req.headers.referer === 'string' && req.headers.referer) {
        try {
          refererDocUploadsDisabled =
            new URL(req.headers.referer).searchParams.get('simulate_uploads_disabled') === '1';
        } catch {
          /* ignore */
        }
      }
      const docUploadsDisabled =
        urlObj.searchParams.get('simulate_uploads_disabled') === '1' ||
        req.headers['x-simulate-uploads-disabled'] === '1' ||
        refererDocUploadsDisabled;

      if (pathname === '/api/v1/documents/upload-options' && method === 'GET') {
        if (!canUserAccessDocumentsModule(user, userMems)) {
          return sendError(res, 403, 'FORBIDDEN', 'Only active members with shared access and staff can access documents.');
        }
        return sendJson(res, 200, getUploadOptionsForUser(user, { uploadsDisabled: docUploadsDisabled }));
      }

      if (pathname === '/api/v1/documents' && method === 'GET') {
        const result = queryDocumentsStore(
          serverStore.documentsStore,
          user,
          userMems,
          {
            category: urlObj.searchParams.get('category') || '',
            limit: urlObj.searchParams.get('limit') ?? undefined,
            offset: urlObj.searchParams.get('offset') ?? undefined,
          },
          { resolveBadgeFn: resolveDocBadge }
        );
        if (!result.ok) {
          return sendError(
            res,
            result.status || 403,
            result.errorCode || 'FORBIDDEN',
            result.message || 'Cannot list documents.'
          );
        }
        return sendJson(res, 200, result.items);
      }

      if (pathname === '/api/v1/documents' && method === 'POST') {
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

        const preflight = checkDocumentUploadPreflight({
          store: serverStore.documentsStore,
          user,
          userMemberships: userMems,
          query: {
            title: urlObj.searchParams.get('title'),
            category: urlObj.searchParams.get('category'),
            audience: urlObj.searchParams.get('audience'),
            document_date: urlObj.searchParams.get('document_date'),
          },
          contentType: contentTypeHeader,
          contentLength: parsedLength,
          idempotencyKey: idempotencyKeyHeader,
          idempotencyStore: documentIdempotencyStore,
          uploadsDisabled: docUploadsDisabled,
          quotaExceededReason:
            simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
          lowDisk: simAnswer === 'LOW_DISK',
          resolveBadgeFn: resolveDocBadge,
        });
        if (!preflight.ok) {
          return sendError(
            res,
            preflight.status || 422,
            preflight.errorCode || 'VALIDATION_ERROR',
            preflight.message || 'Cannot upload document.',
            preflight.extra || {}
          );
        }
        if (preflight.replay) {
          if (simAnswer === 'UPLOAD_REMOVED') {
            return sendError(res, 409, 'UPLOAD_REMOVED', 'This document was removed meanwhile.');
          }
          return sendJson(res, preflight.status || 200, preflight.document);
        }

        if (simAnswer === 'UPLOAD_REMOVED') {
          return sendError(res, 409, 'UPLOAD_REMOVED', 'This document was removed meanwhile.');
        }

        const uid = user?.user_id || 'anon';
        const activeCount = activeDocumentUploadsByUser.get(uid) || 0;
        if (activeCount >= 2 || simAnswer === 'BUSY') {
          return sendError(res, 429, 'RATE_LIMITED', 'Server is busy.', {
            reason: 'BUSY',
            retry_after_seconds: simAnswer === 'BUSY' ? 15 : 5,
          });
        }

        activeDocumentUploadsByUser.set(uid, activeCount + 1);
        try {
          if (simAnswer === 'UPLOAD_TIMEOUT') {
            return sendError(res, 408, 'UPLOAD_TIMEOUT', 'Upload body timed out.');
          }
          const { interrupted, tooLarge, buffer } = await readRawBody(
            req,
            MAX_DOCUMENT_BYTES,
            parsedLength,
          );
          if (interrupted) {
            return sendError(res, 400, 'UPLOAD_INTERRUPTED', 'The upload broke off; try again.');
          }
          if (tooLarge) {
            return sendError(res, 413, 'FILE_TOO_LARGE', 'The file is larger than 20 MB.', {
              max_bytes: MAX_DOCUMENT_BYTES,
            });
          }
          const outcome = addDocumentInStore({
            store: serverStore.documentsStore,
            user,
            userMemberships: userMems,
            bytes: buffer,
            query: {
              title: urlObj.searchParams.get('title'),
              category: urlObj.searchParams.get('category'),
              audience: urlObj.searchParams.get('audience'),
              document_date: urlObj.searchParams.get('document_date'),
            },
            contentType: contentTypeHeader,
            contentLength: parsedLength as number,
            idempotencyKey: idempotencyKeyHeader,
            idempotencyStore: documentIdempotencyStore,
            uploadsDisabled: docUploadsDisabled,
            quotaExceededReason:
              simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
            lowDisk: simAnswer === 'LOW_DISK',
            resolveBadgeFn: resolveDocBadge,
          });
          if (!outcome.ok) {
            return sendError(
              res,
              outcome.status || 422,
              outcome.errorCode || 'VALIDATION_ERROR',
              outcome.message || 'Cannot upload document.',
              outcome.extra || {}
            );
          }
          checkAndEmitServerStorageAlert();
          return sendJson(res, outcome.status || 201, outcome.document);
        } finally {
          const remaining = (activeDocumentUploadsByUser.get(uid) || 1) - 1;
          if (remaining <= 0) {
            activeDocumentUploadsByUser.delete(uid);
          } else {
            activeDocumentUploadsByUser.set(uid, remaining);
          }
        }
      }

      const docFileMatch = pathname.match(/^\/api\/v1\/documents\/([^/]+)\/file$/);
      if (docFileMatch && method === 'GET') {
        const docId = decodeURIComponent(docFileMatch[1]);
        const outcome = getDocumentFileFromStore(serverStore.documentsStore, docId, user, userMems);
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 404,
            outcome.errorCode || 'DOCUMENT_NOT_FOUND',
            outcome.message || 'This document is not available.'
          );
        }
        const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`;
        res.statusCode = 200;
        res.setHeader('Content-Type', outcome.contentType);
        res.setHeader('Content-Disposition', outcome.contentDisposition);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('X-Trace-Id', traceId);
        { res.end(Buffer.from(outcome.bytes)); return true; }
      }

      const docItemMatch = pathname.match(/^\/api\/v1\/documents\/([^/]+)$/);
      if (docItemMatch && method === 'GET') {
        const docId = decodeURIComponent(docItemMatch[1]);
        const outcome = getDocumentFromStore(serverStore.documentsStore, docId, user, userMems, {
          resolveBadgeFn: resolveDocBadge,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 404,
            outcome.errorCode || 'DOCUMENT_NOT_FOUND',
            outcome.message || 'This document is not available.'
          );
        }
        return sendJson(res, 200, outcome.document);
      }

      if (docItemMatch && method === 'PATCH') {
        const docId = decodeURIComponent(docItemMatch[1]);
        const body = await readBody(req);
        const outcome = editDocumentInStore({
          store: serverStore.documentsStore,
          documentId: docId,
          user,
          userMemberships: userMems,
          body,
          resolveBadgeFn: resolveDocBadge,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Cannot edit document.',
            outcome.extra || {}
          );
        }
        return sendJson(res, 200, outcome.document);
      }

      if (docItemMatch && method === 'DELETE') {
        const docId = decodeURIComponent(docItemMatch[1]);
        const outcome = deleteDocumentInStore({
          store: serverStore.documentsStore,
          documentId: docId,
          user,
          userMemberships: userMems,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 404,
            outcome.errorCode || 'DOCUMENT_NOT_FOUND',
            outcome.message || 'This document is not available.'
          );
        }
        const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`;
        res.statusCode = 204;
        res.setHeader('X-Trace-Id', traceId);
        { res.end(); return true; }
      }
    }

    // =========================================================================
    // Storage Usage (/api/v1/files/usage) - #024 (E11/F4)
    // =========================================================================
    if (pathname === '/api/v1/files/usage' && method === 'GET') {
      if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
        return sendError(res, 403, 'FORBIDDEN', 'Only the chairman and board members can view storage usage.');
      }
      const currentUsage = computeStorageUsage({
        issuesStore: serverStore.issuesStore,
        documentsStore: serverStore.documentsStore,
        extraPendingDeletionBytes: serverStore.serverExtraPendingDeletionBytes,
      });
      return sendJson(res, 200, currentUsage);
    }

    // =========================================================================
    // Maintenance Calendar (/api/v1/maintenance) - #015 (E10/M1)
    // =========================================================================

  return false;
}
