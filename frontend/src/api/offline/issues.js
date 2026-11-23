import {
  UNHANDLED,
  activeOfflinePhotoUploads,
  OFFLINE_DEMO_USERS,
  OFFLINE_MEMBERSHIPS_BY_USER,
  makeOfflineError,
  checkAndEmitOfflineStorageAlert,
  emitOfflineIssueNotificationBatch,
  offlineStore,
} from './state.js'
import {
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
} from '../../utils/issues.js'

export async function handleOfflineIssues(ctx) {
  const { urlObj, pathname, method, body, raw, user, contentType, headers, signal } = ctx

  if (pathname === '/issues' || pathname.startsWith('/issues/')) {
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (!canUserAccessIssues(user, userMems)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only residents with an apartment and board members can access the issue tracker.',
      )
    }

    let simulatedUploadsDisabled = false
    try {
      simulatedUploadsDisabled =
        urlObj.searchParams.get('simulate_uploads_disabled') === '1' ||
        headers?.['X-Simulate-Uploads-Disabled'] === '1' ||
        headers?.['x-simulate-uploads-disabled'] === '1' ||
        (typeof window !== 'undefined' &&
          new URLSearchParams(window.location.search).get('simulate_uploads_disabled') === '1') ||
        (typeof localStorage !== 'undefined' &&
          localStorage.getItem('simulate_uploads_disabled') === '1')
    } catch {
      /* ignore */
    }

    if (pathname === '/issues/form' && method === 'GET') {
      const urgentEnabled = Boolean(
        readSettingFromStore(offlineStore.offlineSettings, 'issues.urgent_enabled', false),
      )
      const apartmentIds = userMems
        .slice()
        .sort((a, b) => a.apartment_number.localeCompare(b.apartment_number))
        .map((m) => m.apartment_id)
      return {
        urgent_enabled: urgentEnabled,
        uploads_enabled: !simulatedUploadsDisabled,
        apartment_ids: apartmentIds,
        entrances: [1, 2],
      }
    }

    if (pathname === '/issues' && method === 'GET') {
      const result = queryIssuesStore(
        offlineStore.offlineIssues,
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
        { uploadsDisabled: simulatedUploadsDisabled },
      )
      if (!result.ok) {
        throw makeOfflineError(result.status, result.errorCode, result.message)
      }
      return result.items
    }

    if (pathname === '/issues' && method === 'POST') {
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const requestedAptId =
        reqBody?.apartment_id != null && reqBody?.apartment_id !== ''
          ? String(reqBody.apartment_id)
          : userMems[0]?.apartment_id
      const matchedMem =
        userMems.find((m) => m.apartment_id === requestedAptId) || userMems[0]
      const reporterBadge = matchedMem?.preview_badge || {
        display_label: user.label || 'Resident',
        role_badge:
          user.building_role === 'CHAIRMAN' || user.building_role === 'BOARD'
            ? 'BOARD'
            : 'OWNER',
      }

      const outcome = createIssueInStore({
        issuesStore: offlineStore.offlineIssues,
        settingsStore: offlineStore.offlineSettings,
        user,
        userMemberships: userMems,
        reporterBadge,
        body: reqBody,
        buildingEntrances: [1, 2],
      })
      if (!outcome.ok) {
        throw makeOfflineError(
          outcome.status,
          outcome.errorCode,
          outcome.message,
          outcome.extra || {},
        )
      }
      if (outcome.rawIssue) {
        const notifBatch = buildIssueReportedNotification(
          outcome.rawIssue,
          OFFLINE_DEMO_USERS,
          user,
        )
        emitOfflineIssueNotificationBatch(notifBatch)
      }
      return toIssueView(outcome.rawIssue, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    const offlineIssueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/)
    if (offlineIssueStatusMatch && method === 'POST') {
      const issueId = offlineIssueStatusMatch[1]
      const found = offlineStore.offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const outcome = changeIssueStatusInStore({
        issuesStore: offlineStore.offlineIssues,
        issue: found,
        user,
        body: reqBody,
      })
      if (!outcome.ok) {
        throw makeOfflineError(
          outcome.status,
          outcome.errorCode,
          outcome.message,
          outcome.extra || {},
        )
      }
      for (const notifBatch of outcome.notifications || []) {
        emitOfflineIssueNotificationBatch(notifBatch)
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    const offlineIssueUrgentClearMatch = pathname.match(/^\/issues\/([^/]+)\/urgent\/clear$/)
    if (offlineIssueUrgentClearMatch && method === 'POST') {
      const issueId = offlineIssueUrgentClearMatch[1]
      const found = offlineStore.offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const outcome = clearIssueUrgentInStore({
        issue: found,
        user,
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    const offlineIssueWithdrawMatch = pathname.match(/^\/issues\/([^/]+)\/withdraw$/)
    if (offlineIssueWithdrawMatch && method === 'POST') {
      const issueId = offlineIssueWithdrawMatch[1]
      const found = offlineStore.offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const outcome = withdrawIssueInStore({ issue: found, user })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    const offlineIssueFollowMatch = pathname.match(/^\/issues\/([^/]+)\/follow$/)
    if (offlineIssueFollowMatch && (method === 'PUT' || method === 'DELETE')) {
      const issueId = offlineIssueFollowMatch[1]
      const found = offlineStore.offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const outcome = updateIssueFollowInStore({
        issue: found,
        user,
        follow: method === 'PUT',
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    // POST /issues/:issueId/photos
    const offlineIssuePhotosMatch = pathname.match(/^\/issues\/([^/]+)\/photos$/)
    if (offlineIssuePhotosMatch && method === 'POST') {
      const issueId = offlineIssuePhotosMatch[1]
      const found = offlineStore.offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }

      const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user?.building_role)
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

      const preflight = checkIssuePhotoUploadPreflight({
        issue: found,
        user,
        contentType: effectiveContentType,
        contentLength: declaredLength,
        idempotencyKey,
        idempotencyStore: offlineStore.offlineIssuePhotoIdempotency,
        dailyUploadsStore: offlineStore.offlineIssuePhotoDailyUploads,
        uploadsDisabled: simulatedUploadsDisabled,
        quotaExceededReason:
          simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
        lowDisk: simAnswer === 'LOW_DISK',
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
        return preflight.photo
      }

      if (simAnswer === 'DAILY_LIMIT' && !isBoardUser) {
        throw makeOfflineError(
          429,
          'RATE_LIMITED',
          'You have stored the photos allowed for today.',
          { reason: 'DAILY_LIMIT', retry_after_seconds: 3600 },
        )
      }

      const uid = user?.user_id || 'anon'
      const activeCount = activeOfflinePhotoUploads.get(uid) || 0
      if (activeCount >= 2 || simAnswer === 'BUSY') {
        throw makeOfflineError(429, 'RATE_LIMITED', 'Server is busy.', {
          reason: 'BUSY',
          retry_after_seconds: simAnswer === 'BUSY' ? 15 : 5,
        })
      }

      activeOfflinePhotoUploads.set(uid, activeCount + 1)
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
        const outcome = addIssuePhotoInStore({
          issue: found,
          user,
          bytes,
          contentType: effectiveContentType,
          contentLength: declaredLength,
          idempotencyKey,
          idempotencyStore: offlineStore.offlineIssuePhotoIdempotency,
          dailyUploadsStore: offlineStore.offlineIssuePhotoDailyUploads,
          uploadsDisabled: simulatedUploadsDisabled,
          quotaExceededReason:
            simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
          lowDisk: simAnswer === 'LOW_DISK',
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
        return outcome.photo
      } finally {
        const remaining = (activeOfflinePhotoUploads.get(uid) || 1) - 1
        if (remaining <= 0) {
          activeOfflinePhotoUploads.delete(uid)
        } else {
          activeOfflinePhotoUploads.set(uid, remaining)
        }
      }
    }

    // GET / DELETE /issues/:issueId/photos/:photoId
    const offlineIssuePhotoItemMatch = pathname.match(/^\/issues\/([^/]+)\/photos\/([^/]+)$/)
    if (offlineIssuePhotoItemMatch && method === 'GET') {
      const issueId = offlineIssuePhotoItemMatch[1]
      const photoId = offlineIssuePhotoItemMatch[2]
      const found = offlineStore.offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const variant = urlObj.searchParams.get('variant') || 'display'
      const outcome = getIssuePhotoFromStore({ issue: found, photoId, variant })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      const resBlob = new Blob([outcome.bytes], { type: outcome.mime || 'image/webp' })
      if (raw) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': outcome.mime || 'image/webp' }),
          blob: async () => resBlob,
        }
      }
      return resBlob
    }

    if (offlineIssuePhotoItemMatch && method === 'DELETE') {
      const issueId = offlineIssuePhotoItemMatch[1]
      const photoId = offlineIssuePhotoItemMatch[2]
      const found = offlineStore.offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const outcome = deleteIssuePhotoInStore({
        issue: found,
        user,
        photoId,
        idempotencyStore: offlineStore.offlineIssuePhotoIdempotency,
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return null
    }

    const offlineIssueDetailMatch = pathname.match(/^\/issues\/([^/]+)$/)
    if (offlineIssueDetailMatch && method === 'GET') {
      const issueId = offlineIssueDetailMatch[1]
      const found = offlineStore.offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    if (offlineIssueDetailMatch && method === 'PATCH') {
      const issueId = offlineIssueDetailMatch[1]
      const found = offlineStore.offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const outcome = editIssueInStore({
        issue: found,
        user,
        body: reqBody,
        buildingEntrances: [1, 2],
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }
  }

  // =========================================================================
  // Association Documents (/documents) - #022 & #023 (E11/F3)
  // =========================================================================

  return UNHANDLED
}
