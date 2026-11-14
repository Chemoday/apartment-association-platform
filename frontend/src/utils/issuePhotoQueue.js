/**
 * Shared client-side photo queue, retry, and downscale recovery state machine (#020).
 * Used by both IssueFormModal (create flow) and IssuePhotos (detail view),
 * and directly testable without mounting Vue components.
 */

import { localizeError } from '../locales/index.js'
import { uploadIssuePhoto } from '../api/endpoints/issues.js'
import {
  DEFAULT_PHOTO_MAX_EDGE,
  FALLBACK_SMALLER_EDGE,
  scalePhotoToJpeg,
} from './photoScaling.js'

export const MAX_CONCURRENT_PHOTO_UPLOADS = 2

const NON_RETRYABLE_PHOTO_ERRORS = new Set([
  'PHOTO_SCALING_FAILED',
  'INVALID_IMAGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'UPLOADS_DISABLED',
  'ISSUE_ENDED',
  'PHOTO_LIMIT_REACHED',
  'FORBIDDEN',
  'ISSUE_NOT_FOUND',
  'FILE_TOO_LARGE',
  'IMAGE_TOO_LARGE',
  'IDEMPOTENCY_KEY_REUSED',
  'UPLOAD_REMOVED',
  'VALIDATION_ERROR',
  'LENGTH_REQUIRED',
  'UPLOAD_ABORTED',
  'REQUEST_ABORTED',
])

/**
 * Generates an RFC 4122 v4 UUID suitable for `Idempotency-Key`.
 * Falls back cleanly if `crypto.randomUUID` is unavailable.
 * @returns {string}
 */
export function generatePhotoIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Returns true if retrying this upload error (keeping Idempotency-Key on network/interrupt/timeout)
 * can meaningfully succeed.
 * @param {any} err
 * @returns {boolean}
 */
export function isPhotoErrorRetryable(err) {
  const code = err?.errorCode || ''
  if (NON_RETRYABLE_PHOTO_ERRORS.has(code)) {
    return false
  }
  return true
}

/**
 * Formats a photo upload or viewer API error for display in UI.
 * Handles 429 reason ('BUSY' vs 'DAILY_LIMIT') and 507 reason ('QUOTA' / 'DELETIONS_PENDING').
 * @param {any} err
 * @param {(key: string, params?: Record<string, any>) => string} tFn
 * @param {string} lang
 * @returns {string}
 */
export function formatPhotoErrorMessage(err, tFn, lang) {
  if (err?.errorCode === 'RATE_LIMITED') {
    const reason = String(err?.payload?.reason || '').toUpperCase()
    if (reason === 'DAILY_LIMIT') {
      return typeof tFn === 'function'
        ? tFn('issues.photos.dailyLimitRetryWait')
        : localizeError('RATE_LIMITED', { reason: 'DAILY_LIMIT' }, lang)
    }
    const rawSeconds = Number(err?.payload?.retry_after_seconds)
    const seconds =
      Number.isFinite(rawSeconds) && rawSeconds > 0 ? Math.ceil(rawSeconds) : 60
    if (reason === 'BUSY') {
      return localizeError(
        'RATE_LIMITED',
        { ...err?.payload, reason: 'BUSY', retry_after_seconds: seconds },
        lang,
      )
    }
    return typeof tFn === 'function'
      ? tFn('issues.photos.rateLimitRetryWait', { seconds })
      : localizeError('RATE_LIMITED', { ...err?.payload, retry_after_seconds: seconds }, lang)
  }
  if (err?.errorCode === 'STORAGE_QUOTA_EXCEEDED') {
    return localizeError('STORAGE_QUOTA_EXCEEDED', {}, lang)
  }
  return localizeError(err, lang)
}

/**
 * Safely calls URL.revokeObjectURL without throwing.
 * @param {string} url
 */
export function safeRevokeObjectUrl(url) {
  if (!url) return
  try {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(url)
    }
  } catch {
    /* ignore */
  }
}

/**
 * Creates an initial photo queue entry with an immediate local preview object URL
 * and a stable per-photo Idempotency-Key.
 * @param {Blob} file
 * @param {{ idPrefix?: string, keyGenerator?: () => string, initialStatus?: 'scaling' | 'queued' | 'ready' }} [opts]
 */
export function createQueuedPhotoItem(
  file,
  { idPrefix = 'photo', keyGenerator = generatePhotoIdempotencyKey, initialStatus = 'scaling' } = {},
) {
  let previewUrl = ''
  try {
    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      previewUrl = URL.createObjectURL(file)
    }
  } catch {
    previewUrl = ''
  }

  return {
    localId: `${idPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    rawFile: /** @type {Blob | null} */ (file),
    previewUrl,
    idempotencyKey: keyGenerator(),
    scaledBlob: /** @type {Blob | null} */ (null),
    status: initialStatus, // 'queued' | 'scaling' | 'ready' | 'uploading' | 'uploaded' | 'error'
    progress: 0,
    error: '',
    unrecoverable: false,
    removed: false,
    retrySmallerUsed: false,
    reusedKeyRetried: false,
  }
}

/**
 * Revokes all preview URLs held by a list of queued photo items.
 * @param {Array<{ previewUrl?: string }>} items
 */
export function revokeQueuedPhotoPreviews(items) {
  for (const item of items || []) {
    if (item?.previewUrl) {
      safeRevokeObjectUrl(item.previewUrl)
    }
  }
}

/**
 * Scales a newly picked file to JPEG (<= 1920px). Never stores or exposes the original unscaled file
 * for upload when scaling fails.
 * @param {string} localId
 * @param {Blob} file
 * @param {Object} ctx
 * @param {(localId: string, patch: Record<string, any>) => any} ctx.updateItem
 * @param {(file: Blob, opts?: any) => Promise<{ blob: Blob, width?: number, height?: number }>} [ctx.scaleFn]
 * @param {AbortSignal} [ctx.signal]
 * @param {string} ctx.lang
 * @returns {Promise<boolean>} true if scaled and ready; false if scaling failed (fail-closed)
 */
export async function scaleQueuedPhotoItem(
  localId,
  file,
  { updateItem, scaleFn = scalePhotoToJpeg, signal, lang = 'en' },
) {
  if (signal?.aborted) {
    return false
  }
  updateItem(localId, { status: 'scaling', error: '', unrecoverable: false })
  try {
    const scaled = await scaleFn(file, {
      maxEdgePx: DEFAULT_PHOTO_MAX_EDGE,
      ...(signal ? { signal } : {}),
    })
    if (signal?.aborted) {
      return false
    }
    updateItem(localId, {
      scaledBlob: scaled.blob,
      status: 'ready',
      error: '',
      unrecoverable: false,
    })
    return true
  } catch (err) {
    if (signal?.aborted || err?.message === 'PHOTO_SCALING_ABORTED') {
      return false
    }
    // Fail closed: clear scaledBlob and mark unrecoverable so original is never uploaded
    updateItem(localId, {
      scaledBlob: null,
      status: 'error',
      error: localizeError('PHOTO_SCALING_FAILED', {}, lang),
      unrecoverable: true,
    })
    return false
  }
}

/**
 * Uploads a single scaled photo queue item, handling:
 * - live XHR progress
 * - automatic single retry with a new Idempotency-Key on 409 IDEMPOTENCY_KEY_REUSED
 * - automatic single downscale to 1280px + retry on 413 FILE_TOO_LARGE / 422 IMAGE_TOO_LARGE
 * - preserving Idempotency-Key across manual retries on transient network / 400 UPLOAD_INTERRUPTED / 429 / 507 errors
 * - revoking previewUrl and releasing retained Blobs upon successful upload
 *
 * @param {string} issueId
 * @param {string} localId
 * @param {Object} ctx
 * @param {(localId: string) => any} ctx.getItem
 * @param {(localId: string, patch: Record<string, any>) => any} ctx.updateItem
 * @param {(issueId: string, blob: Blob, opts?: any) => Promise<any>} [ctx.uploadFn]
 * @param {(file: Blob, opts?: any) => Promise<{ blob: Blob }>} [ctx.scaleFn]
 * @param {() => string} [ctx.keyGenerator]
 * @param {AbortSignal} [ctx.signal]
 * @param {(key: string, params?: Record<string, any>) => string} ctx.tFn
 * @param {string} ctx.lang
 * @returns {Promise<{ ok: boolean, photo?: any, error?: any, aborted?: boolean, removed?: boolean }>}
 */
export async function uploadQueuedPhotoItem(
  issueId,
  localId,
  {
    getItem,
    updateItem,
    uploadFn = uploadIssuePhoto,
    scaleFn = scalePhotoToJpeg,
    keyGenerator = generatePhotoIdempotencyKey,
    signal,
    tFn,
    lang = 'en',
  },
) {
  if (signal?.aborted) {
    return { ok: false, aborted: true }
  }

  const item = getItem(localId)
  if (!item || !item.scaledBlob || item.unrecoverable || item.removed) {
    return { ok: false, removed: Boolean(item?.removed) }
  }

  updateItem(localId, { status: 'uploading', progress: 0, error: '' })

  try {
    const uploadedPhoto = await uploadFn(issueId, item.scaledBlob, {
      idempotencyKey: item.idempotencyKey,
      signal,
      onProgress: (loaded, total) => {
        const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
        updateItem(localId, { progress: pct })
      },
    })
    safeRevokeObjectUrl(item.previewUrl)
    updateItem(localId, {
      status: 'uploaded',
      progress: 100,
      previewUrl: '',
      rawFile: null,
      scaledBlob: null,
      error: '',
    })
    return { ok: true, photo: uploadedPhoto }
  } catch (err) {
    if (signal?.aborted || err?.errorCode === 'UPLOAD_ABORTED' || err?.errorCode === 'REQUEST_ABORTED') {
      if (getItem(localId)) {
        updateItem(localId, { status: 'ready', progress: 0, error: '' })
      }
      return { ok: false, aborted: true, error: err }
    }

    const current = getItem(localId)
    if (!current) {
      return { ok: false, error: err }
    }

    if (err?.errorCode === 'UPLOAD_REMOVED' || err?.payload?.error_code === 'UPLOAD_REMOVED') {
      updateItem(localId, {
        status: 'error',
        progress: 0,
        rawFile: null,
        scaledBlob: null,
        error: formatPhotoErrorMessage(err, tFn, lang),
        unrecoverable: true,
        removed: true,
      })
      return { ok: false, removed: true, error: err }
    }

    if (err?.errorCode === 'IDEMPOTENCY_KEY_REUSED' && !current.reusedKeyRetried) {
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error(
          '[issuePhotoQueue] Client bug: Idempotency-Key reused for a different file; retrying once with a new key.',
        )
      }
      updateItem(localId, {
        idempotencyKey: keyGenerator(),
        reusedKeyRetried: true,
      })
      return uploadQueuedPhotoItem(issueId, localId, {
        getItem,
        updateItem,
        uploadFn,
        scaleFn,
        keyGenerator,
        signal,
        tFn,
        lang,
      })
    }

    if (
      (err?.errorCode === 'FILE_TOO_LARGE' ||
        err?.errorCode === 'IMAGE_TOO_LARGE' ||
        err?.status === 413) &&
      !current.retrySmallerUsed &&
      current.rawFile
    ) {
      updateItem(localId, {
        status: 'scaling',
        error: '',
        retrySmallerUsed: true,
        idempotencyKey: keyGenerator(),
      })
      try {
        const rescaled = await scaleFn(current.rawFile, {
          maxEdgePx: FALLBACK_SMALLER_EDGE,
          quality: 0.78,
          ...(signal ? { signal } : {}),
        })
        if (signal?.aborted) {
          if (getItem(localId)) {
            updateItem(localId, { status: 'ready', progress: 0, error: '' })
          }
          return { ok: false, aborted: true }
        }
        updateItem(localId, { scaledBlob: rescaled.blob })
        return uploadQueuedPhotoItem(issueId, localId, {
          getItem,
          updateItem,
          uploadFn,
          scaleFn,
          keyGenerator,
          signal,
          tFn,
          lang,
        })
      } catch (scaleErr) {
        if (signal?.aborted || scaleErr?.message === 'PHOTO_SCALING_ABORTED') {
          if (getItem(localId)) {
            updateItem(localId, { status: 'ready', progress: 0, error: '' })
          }
          return { ok: false, aborted: true, error: scaleErr }
        }
        updateItem(localId, {
          scaledBlob: null,
          status: 'error',
          error: localizeError('PHOTO_SCALING_FAILED', {}, lang),
          unrecoverable: true,
        })
        return { ok: false, error: scaleErr }
      }
    }

    updateItem(localId, {
      status: 'error',
      error: formatPhotoErrorMessage(err, tFn, lang),
      unrecoverable: !isPhotoErrorRetryable(err),
    })
    return { ok: false, error: err }
  }
}

/**
 * Drains a mutable list of queued upload tasks with at most `concurrency` (default 2)
 * concurrent workers (#025). Stops pulling remaining tasks immediately if `signal?.aborted`,
 * `shouldContinue()` returns false, or a worker reports a whole-issue abort error.
 *
 * @template T
 * @param {T[]} pendingTasks
 * @param {Object} opts
 * @param {(task: T, signal?: AbortSignal) => Promise<{ ok?: boolean, aborted?: boolean, removed?: boolean, error?: any }>} opts.worker
 * @param {number} [opts.concurrency]
 * @param {AbortSignal} [opts.signal]
 * @param {() => boolean} [opts.shouldContinue]
 * @param {(err: any) => void} [opts.onWholeIssueAbort]
 * @returns {Promise<{ completed: number, failed: number, aborted: boolean, wholeIssueError: any }>}
 */
export async function drainPhotoUploadQueue(
  pendingTasks,
  {
    worker,
    concurrency = MAX_CONCURRENT_PHOTO_UPLOADS,
    signal,
    shouldContinue = () => true,
    onWholeIssueAbort,
  },
) {
  if (!Array.isArray(pendingTasks) || pendingTasks.length === 0) {
    return { completed: 0, failed: 0, aborted: Boolean(signal?.aborted), wholeIssueError: null }
  }

  const maxWorkers = Math.max(1, Math.min(concurrency, pendingTasks.length))
  let completed = 0
  let failed = 0
  let aborted = false
  let stopped = false
  let wholeIssueError = null

  async function runWorker() {
    while (pendingTasks.length > 0 && !stopped && !signal?.aborted && shouldContinue()) {
      const task = pendingTasks.shift()
      if (!task) break

      let res
      try {
        res = await worker(task, signal)
      } catch (thrown) {
        res = { ok: false, error: thrown }
      }

      if (res?.aborted || signal?.aborted) {
        aborted = true
        continue
      }
      if (res?.ok) {
        completed += 1
      } else {
        failed += 1
        if (shouldAbortRemainingUploadsForError(res?.error)) {
          stopped = true
          pendingTasks.length = 0
          if (!wholeIssueError) {
            wholeIssueError = res.error
            onWholeIssueAbort?.(res.error)
          }
          break
        }
      }
    }
  }

  const workers = Array.from({ length: maxWorkers }, () => runWorker())
  await Promise.all(workers)

  return {
    completed,
    failed,
    aborted: aborted || Boolean(signal?.aborted),
    wholeIssueError,
  }
}

/**
 * Returns true unless the issue form metadata explicitly indicates uploads are disabled.
 * Defaults to true when `uploads_enabled` is omitted for backward compatibility.
 * @param {any} formMeta
 * @returns {boolean}
 */
export function isUploadsEnabledInForm(formMeta) {
  return formMeta?.uploads_enabled !== false
}

/**
 * Returns true when queued photos should be uploaded immediately after issue creation.
 * Skips futile POST .../photos requests when `createdIssue.can_add_photo === false`
 * (for example when uploads are disabled in demo mode).
 * @param {any} createdIssue
 * @param {number} uploadableCount
 * @returns {boolean}
 */
export function canQueuePhotoUploadsAfterCreate(createdIssue, uploadableCount) {
  return uploadableCount > 0 && createdIssue?.can_add_photo !== false
}

/**
 * Returns true when a photo upload failure affects the whole issue rather than just one file
 * (so remaining queued uploads for that issue should stop immediately).
 * @param {any} err
 * @returns {boolean}
 */
export function shouldAbortRemainingUploadsForError(err) {
  const code = err?.errorCode || ''
  return (
    code === 'UPLOADS_DISABLED' ||
    code === 'ISSUE_ENDED' ||
    code === 'PHOTO_LIMIT_REACHED' ||
    code === 'FORBIDDEN'
  )
}

/**
 * Normalizes a terminal issue-level error code into the modal post-create abort banner state.
 * @param {any} err
 * @returns {'' | 'UPLOADS_DISABLED' | 'ISSUE_ENDED' | 'PHOTO_LIMIT_REACHED' | 'FORBIDDEN'}
 */
export function resolvePostCreateAbortReason(err) {
  const code = err?.errorCode || ''
  if (
    code === 'UPLOADS_DISABLED' ||
    code === 'ISSUE_ENDED' ||
    code === 'PHOTO_LIMIT_REACHED' ||
    code === 'FORBIDDEN'
  ) {
    return code
  }
  return ''
}

/**
 * Returns true when IssuePhotos section must stay mounted (including to display an abort/action error at 0 photos).
 * @param {{ photosCount?: number, canAddPhoto?: boolean, photosDeleteAt?: string | null, uploadQueueCount?: number, actionError?: string }} [ctx]
 * @returns {boolean}
 */
export function shouldShowIssuePhotosSection({
  photosCount = 0,
  canAddPhoto = false,
  photosDeleteAt = null,
  uploadQueueCount = 0,
  actionError = '',
} = {}) {
  return (
    photosCount > 0 ||
    Boolean(canAddPhoto) ||
    Boolean(photosDeleteAt) ||
    uploadQueueCount > 0 ||
    Boolean(actionError)
  )
}

/**
 * Resolves the accurate localized error code when `canAddPhoto` flips to false while uploads were queued.
 * Avoids blaming `ISSUE_ENDED` when the issue is still open and uploads were disabled.
 * @param {{ abortReason?: string, existingCount?: number, issueOpen?: boolean, maxPhotos?: number }} [ctx]
 * @returns {string}
 */
export function resolveCanAddPhotoFalseReason({
  abortReason = '',
  existingCount = 0,
  issueOpen = undefined,
  maxPhotos = 3,
} = {}) {
  if (abortReason) return abortReason
  if (existingCount >= maxPhotos) return 'PHOTO_LIMIT_REACHED'
  if (issueOpen === false) return 'ISSUE_ENDED'
  return 'UPLOADS_DISABLED'
}
