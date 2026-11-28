import {
  UNHANDLED,
  activeOfflineDocumentUploads,
  OFFLINE_DEMO_USERS,
  OFFLINE_MEMBERSHIPS_BY_USER,
  makeOfflineError,
  checkAndEmitOfflineStorageAlert,
  offlineStore,
} from './state.js'
import {
  addDocumentInStore,
  canUserAccessDocumentsModule,
  checkDocumentUploadPreflight,
  deleteDocumentInStore,
  editDocumentInStore,
  getDocumentFileFromStore,
  getDocumentFromStore,
  getUploadOptionsForUser,
  queryDocumentsStore,
} from '../../utils/documents.js'
import {
  computeStorageUsage,
} from '../../utils/storage.js'

export async function handleOfflineDocuments(ctx) {
  const { urlObj, pathname, method, body, raw, user, contentType, headers, signal } = ctx

  if (pathname === '/documents' || pathname.startsWith('/documents/')) {
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const resolveOfflineDocBadge = (uid) => {
      const u = OFFLINE_DEMO_USERS.find((item) => item.user_id === uid)
      if (u?.building_role === 'CHAIRMAN') {
        return { display_label: 'Board Chairman', role_badge: 'BOARD' }
      }
      if (u?.building_role === 'ACCOUNTANT') {
        return { display_label: 'Accountant', role_badge: 'ACCOUNTANT' }
      }
      return { display_label: 'Board Member', role_badge: 'BOARD' }
    }
    const simulatedDocUploadsDisabled =
      urlObj.searchParams.get('simulate_uploads_disabled') === '1' ||
      headers?.['X-Simulate-Uploads-Disabled'] === '1' ||
      headers?.['x-simulate-uploads-disabled'] === '1'

    if (pathname === '/documents/upload-options' && method === 'GET') {
      if (!canUserAccessDocumentsModule(user, userMems)) {
        throw makeOfflineError(403, 'FORBIDDEN', 'Only active members with shared access and staff can access documents.')
      }
      return getUploadOptionsForUser(user, { uploadsDisabled: simulatedDocUploadsDisabled })
    }

    if (pathname === '/documents' && method === 'GET') {
      const result = queryDocumentsStore(
        offlineStore.offlineDocuments,
        user,
        userMems,
        {
          category: urlObj.searchParams.get('category') || '',
          limit: urlObj.searchParams.get('limit') ?? undefined,
          offset: urlObj.searchParams.get('offset') ?? undefined,
        },
        { resolveBadgeFn: resolveOfflineDocBadge },
      )
      if (!result.ok) {
        throw makeOfflineError(result.status, result.errorCode, result.message)
      }
      return result.items
    }

    if (pathname === '/documents' && method === 'POST') {
      const simAnswer = String(
        urlObj.searchParams.get('simulate_upload_answer') ||
          headers?.['X-Simulate-Upload-Answer'] ||
          headers?.['x-simulate-upload-answer'] ||
          '',
      ).toUpperCase()
      const effectiveContentType =
        contentType ||
        (body && typeof body.type === 'string' && body.type) ||
        headers?.['Content-Type'] ||
        headers?.['content-type'] ||
        ''
      const idempotencyKey =
        headers?.['Idempotency-Key'] || headers?.['idempotency-key'] || ''
      const rawLengthHeader = headers?.['Content-Length'] ?? headers?.['content-length']
      let declaredLength = null
      if (rawLengthHeader !== undefined && rawLengthHeader !== '') {
        declaredLength = Number(rawLengthHeader)
      } else if (body != null && typeof body.size === 'number') {
        declaredLength = body.size
      } else if (body != null && typeof body.byteLength === 'number') {
        declaredLength = body.byteLength
      }

      const preflight = checkDocumentUploadPreflight({
        store: offlineStore.offlineDocuments,
        user,
        userMemberships: userMems,
        query: {
          title: urlObj.searchParams.get('title'),
          category: urlObj.searchParams.get('category'),
          audience: urlObj.searchParams.get('audience'),
          document_date: urlObj.searchParams.get('document_date'),
        },
        contentType: effectiveContentType,
        contentLength: declaredLength,
        idempotencyKey,
        idempotencyStore: offlineStore.offlineDocumentIdempotency,
        uploadsDisabled: simulatedDocUploadsDisabled,
        quotaExceededReason:
          simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
        lowDisk: simAnswer === 'LOW_DISK',
        resolveBadgeFn: resolveOfflineDocBadge,
      })
      if (!preflight.ok) {
        throw makeOfflineError(
          preflight.status,
          preflight.errorCode,
          preflight.message,
          preflight.extra || {},
        )
      }
      if (preflight.replay) {
        if (simAnswer === 'UPLOAD_REMOVED') {
          throw makeOfflineError(409, 'UPLOAD_REMOVED', 'This document was removed meanwhile.')
        }
        return preflight.document
      }
      if (simAnswer === 'UPLOAD_REMOVED') {
        throw makeOfflineError(409, 'UPLOAD_REMOVED', 'This document was removed meanwhile.')
      }

      const uid = user?.user_id || 'anon'
      const activeCount = activeOfflineDocumentUploads.get(uid) || 0
      if (activeCount >= 2 || simAnswer === 'BUSY') {
        throw makeOfflineError(429, 'RATE_LIMITED', 'Server is busy.', {
          reason: 'BUSY',
          retry_after_seconds: simAnswer === 'BUSY' ? 15 : 5,
        })
      }

      activeOfflineDocumentUploads.set(uid, activeCount + 1)
      try {
        if (simAnswer === 'UPLOAD_TIMEOUT') {
          throw makeOfflineError(408, 'UPLOAD_TIMEOUT', 'Upload body timed out.')
        }
        let bytes
        if (body && typeof body.arrayBuffer === 'function') {
          bytes = new Uint8Array(await body.arrayBuffer())
        } else if (body instanceof Uint8Array) {
          bytes = body
        } else if (body instanceof ArrayBuffer) {
          bytes = new Uint8Array(body)
        } else {
          bytes = new Uint8Array(0)
        }
        if (signal?.aborted) {
          throw makeOfflineError(0, 'UPLOAD_ABORTED', 'Upload aborted')
        }
        const outcome = addDocumentInStore({
          store: offlineStore.offlineDocuments,
          user,
          userMemberships: userMems,
          bytes,
          query: {
            title: urlObj.searchParams.get('title'),
            category: urlObj.searchParams.get('category'),
            audience: urlObj.searchParams.get('audience'),
            document_date: urlObj.searchParams.get('document_date'),
          },
          contentType: effectiveContentType,
          contentLength: declaredLength,
          idempotencyKey,
          idempotencyStore: offlineStore.offlineDocumentIdempotency,
          uploadsDisabled: simulatedDocUploadsDisabled,
          quotaExceededReason:
            simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
          lowDisk: simAnswer === 'LOW_DISK',
          resolveBadgeFn: resolveOfflineDocBadge,
        })
        if (!outcome.ok) {
          throw makeOfflineError(
            outcome.status,
            outcome.errorCode,
            outcome.message,
            outcome.extra || {},
          )
        }
        checkAndEmitOfflineStorageAlert()
        return outcome.document
      } finally {
        const remaining = (activeOfflineDocumentUploads.get(uid) || 1) - 1
        if (remaining <= 0) {
          activeOfflineDocumentUploads.delete(uid)
        } else {
          activeOfflineDocumentUploads.set(uid, remaining)
        }
      }
    }

    const offlineDocFileMatch = pathname.match(/^\/documents\/([^/]+)\/file$/)
    if (offlineDocFileMatch && method === 'GET') {
      const docId = decodeURIComponent(offlineDocFileMatch[1])
      const outcome = getDocumentFileFromStore(offlineStore.offlineDocuments, docId, user, userMems)
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      const pdfBlob = new Blob([outcome.bytes], { type: 'application/pdf' })
      if (raw) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'Content-Type': outcome.contentType,
            'Content-Disposition': outcome.contentDisposition,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
          }),
          blob: async () => pdfBlob,
        }
      }
      return pdfBlob
    }

    const offlineDocItemMatch = pathname.match(/^\/documents\/([^/]+)$/)
    if (offlineDocItemMatch && method === 'GET') {
      const docId = decodeURIComponent(offlineDocItemMatch[1])
      const outcome = getDocumentFromStore(offlineStore.offlineDocuments, docId, user, userMems, {
        resolveBadgeFn: resolveOfflineDocBadge,
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return outcome.document
    }

    if (offlineDocItemMatch && method === 'PATCH') {
      const docId = decodeURIComponent(offlineDocItemMatch[1])
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const outcome = editDocumentInStore({
        store: offlineStore.offlineDocuments,
        documentId: docId,
        user,
        userMemberships: userMems,
        body: reqBody,
        resolveBadgeFn: resolveOfflineDocBadge,
      })
      if (!outcome.ok) {
        throw makeOfflineError(
          outcome.status,
          outcome.errorCode,
          outcome.message,
          outcome.extra || {},
        )
      }
      return outcome.document
    }

    if (offlineDocItemMatch && method === 'DELETE') {
      const docId = decodeURIComponent(offlineDocItemMatch[1])
      const outcome = deleteDocumentInStore({
        store: offlineStore.offlineDocuments,
        documentId: docId,
        user,
        userMemberships: userMems,
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return null
    }
  }

  // =========================================================================
  // Storage Usage (/files/usage) - #024 (E11/F4)
  // =========================================================================
  if (pathname === '/files/usage' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only the chairman and board members can view storage usage.')
    }
    const currentUsage = computeStorageUsage({
      issuesStore: offlineStore.offlineIssues,
      documentsStore: offlineStore.offlineDocuments,
      extraPendingDeletionBytes: offlineStore.offlineExtraPendingDeletionBytes,
    })
    return currentUsage
  }

  // =========================================================================
  // Maintenance Calendar (/maintenance) - #015 (E10/M1)
  // =========================================================================

  return UNHANDLED
}
