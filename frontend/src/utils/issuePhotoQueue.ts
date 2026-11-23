/**
 * Shared client-side photo queue, retry, and downscale recovery state machine (#020).
 * Used by both IssueFormModal (create flow) and IssuePhotos (detail view),
 * and directly testable without mounting Vue components.
 */

import { asApiErrorLike, type ApiErrorLike } from '../api/client.js'
import type { IssuePhoto } from '../api/schema.js'
import { localizeError } from '../locales/index.js'
import { uploadIssuePhoto } from '../api/endpoints/issues.js'
import {
  DEFAULT_PHOTO_MAX_EDGE,
  FALLBACK_SMALLER_EDGE,
  scalePhotoToJpeg,
  type ScalePhotoOptions,
} from './photoScaling.js'

export const MAX_CONCURRENT_PHOTO_UPLOADS = 2

export type QueuedPhotoStatus =
  | 'queued'
  | 'scaling'
  | 'ready'
  | 'uploading'
  | 'uploaded'
  | 'error'

export interface QueuedPhotoItem {
  localId: string
  rawFile: Blob | null
  previewUrl: string
  idempotencyKey: string
  scaledBlob: Blob | null
  status: QueuedPhotoStatus | string
  progress: number
  error: string
  unrecoverable: boolean
  removed: boolean
  retrySmallerUsed: boolean
  reusedKeyRetried: boolean
}

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
 */
export function generatePhotoIdempotencyKey(): string {
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
 */
export function isPhotoErrorRetryable(err: unknown): boolean {
  const code = asApiErrorLike(err).errorCode || ''
  if (NON_RETRYABLE_PHOTO_ERRORS.has(code)) {
    return false
  }
  return true
}

/**
 * Formats a photo upload or viewer API error for display in UI.
 * Handles 429 reason ('BUSY' vs 'DAILY_LIMIT') and 507 reason ('QUOTA' / 'DELETIONS_PENDING').
 */
export function formatPhotoErrorMessage(
  err: unknown,
  tFn?: ((key: string, params?: Record<string, unknown>) => string) | null,
  lang: string = 'en',
): string {
  const errLike = asApiErrorLike(err)
  if (errLike.errorCode === 'RATE_LIMITED') {
    const reason = String(errLike.payload?.reason || '').toUpperCase()
    if (reason === 'DAILY_LIMIT') {
      return typeof tFn === 'function'
        ? tFn('issues.photos.dailyLimitRetryWait')
        : localizeError('RATE_LIMITED', { reason: 'DAILY_LIMIT' }, lang)
    }
    const rawSeconds = Number(errLike.payload?.retry_after_seconds)
    const seconds = Number.isFinite(rawSeconds) && rawSeconds > 0 ? Math.ceil(rawSeconds) : 60
    if (reason === 'BUSY') {
      return localizeError(
        'RATE_LIMITED',
        { ...errLike.payload, reason: 'BUSY', retry_after_seconds: seconds },
        lang,
      )
    }
    return typeof tFn === 'function'
      ? tFn('issues.photos.rateLimitRetryWait', { seconds })
      : localizeError('RATE_LIMITED', { ...errLike.payload, retry_after_seconds: seconds }, lang)
  }
  if (errLike.errorCode === 'STORAGE_QUOTA_EXCEEDED') {
    return localizeError('STORAGE_QUOTA_EXCEEDED', {}, lang)
  }
  return localizeError(err as string | Record<string, unknown>, lang)
}

/**
 * Safely calls URL.revokeObjectURL without throwing.
 */
export function safeRevokeObjectUrl(url?: string | null): void {
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
 */
export function createQueuedPhotoItem(
  file: Blob,
  {
    idPrefix = 'photo',
    keyGenerator = generatePhotoIdempotencyKey,
    initialStatus = 'scaling',
  }: {
    idPrefix?: string
    keyGenerator?: () => string
    initialStatus?: QueuedPhotoStatus
  } = {},
): QueuedPhotoItem {
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
    rawFile: file,
    previewUrl,
    idempotencyKey: keyGenerator(),
    scaledBlob: null,
    status: initialStatus,
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
 */
export function revokeQueuedPhotoPreviews(items?: Array<{ previewUrl?: string }> | null): void {
  for (const item of items || []) {
    if (item?.previewUrl) {
      safeRevokeObjectUrl(item.previewUrl)
    }
  }
}

export interface ScaleQueuedPhotoContext {
  updateItem: (localId: string, patch: Partial<QueuedPhotoItem>) => unknown
  scaleFn?: (
    file: Blob,
    opts?: ScalePhotoOptions,
  ) => Promise<{ blob: Blob; width?: number; height?: number }>
  signal?: AbortSignal
  lang?: string
}

/**
 * Scales a newly picked file to JPEG (<= 1920px). Never stores or exposes the original unscaled file
 * for upload when scaling fails.
 */
export async function scaleQueuedPhotoItem(
  localId: string,
  file: Blob,
  { updateItem, scaleFn = scalePhotoToJpeg, signal, lang = 'en' }: ScaleQueuedPhotoContext,
): Promise<boolean> {
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : ''
    if (signal?.aborted || msg === 'PHOTO_SCALING_ABORTED') {
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

export interface UploadPhotoFnOptions {
  idempotencyKey: string
  signal?: AbortSignal
  onProgress: (loaded: number, total: number) => void
}

export interface UploadQueuedPhotoContext {
  getItem: (localId: string) => Partial<QueuedPhotoItem> | null | undefined
  updateItem: (localId: string, patch: Partial<QueuedPhotoItem>) => unknown
  uploadFn?: (
    issueId: string,
    blob: Blob,
    opts: UploadPhotoFnOptions,
  ) => Promise<Partial<IssuePhoto>>
  scaleFn?: (file: Blob, opts: ScalePhotoOptions) => Promise<{ blob: Blob }>
  keyGenerator?: () => string
  signal?: AbortSignal
  tFn?: ((key: string, params?: Record<string, unknown>) => string) | null
  lang?: string
}

/**
 * Uploads a single scaled photo queue item.
 */
export async function uploadQueuedPhotoItem(
  issueId: string,
  localId: string,
  {
    getItem,
    updateItem,
    uploadFn = uploadIssuePhoto,
    scaleFn = scalePhotoToJpeg,
    keyGenerator = generatePhotoIdempotencyKey,
    signal,
    tFn,
    lang = 'en',
  }: UploadQueuedPhotoContext,
): Promise<{
  ok: boolean
  photo?: Partial<IssuePhoto>
  error?: unknown
  aborted?: boolean
  removed?: boolean
}> {
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
      idempotencyKey: item.idempotencyKey || '',
      signal,
      onProgress: (loaded: number, total: number) => {
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
  } catch (err: unknown) {
    const errLike = asApiErrorLike(err)
    if (
      signal?.aborted ||
      errLike.errorCode === 'UPLOAD_ABORTED' ||
      errLike.errorCode === 'REQUEST_ABORTED'
    ) {
      if (getItem(localId)) {
        updateItem(localId, { status: 'ready', progress: 0, error: '' })
      }
      return { ok: false, aborted: true, error: err }
    }

    const current = getItem(localId)
    if (!current) {
      return { ok: false, error: err }
    }

    if (errLike.errorCode === 'UPLOAD_REMOVED' || errLike.payload?.error_code === 'UPLOAD_REMOVED') {
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

    if (errLike.errorCode === 'IDEMPOTENCY_KEY_REUSED' && !current.reusedKeyRetried) {
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
      (errLike.errorCode === 'FILE_TOO_LARGE' ||
        errLike.errorCode === 'IMAGE_TOO_LARGE' ||
        errLike.status === 413) &&
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
      } catch (scaleErr: unknown) {
        const scaleMsg = scaleErr instanceof Error ? scaleErr.message : ''
        if (signal?.aborted || scaleMsg === 'PHOTO_SCALING_ABORTED') {
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

export interface DrainPhotoUploadQueueOptions<T> {
  worker: (
    task: T,
    signal?: AbortSignal,
  ) => Promise<{ ok?: boolean; aborted?: boolean; removed?: boolean; error?: unknown }>
  concurrency?: number
  signal?: AbortSignal
  shouldContinue?: () => boolean
  onWholeIssueAbort?: (err: ApiErrorLike) => void
}

/**
 * Drains a mutable list of queued upload tasks with at most `concurrency` (default 2)
 * concurrent workers (#025).
 */
export async function drainPhotoUploadQueue<T>(
  pendingTasks: T[],
  {
    worker,
    concurrency = MAX_CONCURRENT_PHOTO_UPLOADS,
    signal,
    shouldContinue = () => true,
    onWholeIssueAbort,
  }: DrainPhotoUploadQueueOptions<T>,
): Promise<{
  completed: number
  failed: number
  aborted: boolean
  wholeIssueError: ApiErrorLike | null
}> {
  if (!Array.isArray(pendingTasks) || pendingTasks.length === 0) {
    return { completed: 0, failed: 0, aborted: Boolean(signal?.aborted), wholeIssueError: null }
  }

  const maxWorkers = Math.max(1, Math.min(concurrency, pendingTasks.length))
  let completed = 0
  let failed = 0
  let aborted = false
  let stopped = false
  let wholeIssueError: ApiErrorLike | null = null

  async function runWorker(): Promise<void> {
    while (pendingTasks.length > 0 && !stopped && !signal?.aborted && shouldContinue()) {
      const task = pendingTasks.shift()
      if (!task) break

      let res: { ok?: boolean; aborted?: boolean; removed?: boolean; error?: unknown }
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
            const normalizedErr = asApiErrorLike(res.error)
            wholeIssueError = normalizedErr
            onWholeIssueAbort?.(normalizedErr)
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
 */
export function isUploadsEnabledInForm(
  formMeta?: { uploads_enabled?: boolean; [key: string]: unknown } | null,
): boolean {
  return formMeta?.uploads_enabled !== false
}

/**
 * Returns true when queued photos should be uploaded immediately after issue creation.
 */
export function canQueuePhotoUploadsAfterCreate(
  createdIssue: { can_add_photo?: boolean; [key: string]: unknown } | null | undefined,
  uploadableCount: number,
): boolean {
  return uploadableCount > 0 && createdIssue?.can_add_photo !== false
}

/**
 * Returns true when a photo upload failure affects the whole issue rather than just one file.
 */
export function shouldAbortRemainingUploadsForError(err: unknown): boolean {
  const code = asApiErrorLike(err).errorCode || ''
  return (
    code === 'UPLOADS_DISABLED' ||
    code === 'ISSUE_ENDED' ||
    code === 'PHOTO_LIMIT_REACHED' ||
    code === 'FORBIDDEN'
  )
}

export type PostCreateAbortReason =
  | ''
  | 'UPLOADS_DISABLED'
  | 'ISSUE_ENDED'
  | 'PHOTO_LIMIT_REACHED'
  | 'FORBIDDEN'

/**
 * Normalizes a terminal issue-level error code into the modal post-create abort banner state.
 */
export function resolvePostCreateAbortReason(err: unknown): PostCreateAbortReason {
  const code = asApiErrorLike(err).errorCode || ''
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
 * Returns true when IssuePhotos section must stay mounted.
 */
export function shouldShowIssuePhotosSection({
  photosCount = 0,
  canAddPhoto = false,
  photosDeleteAt = null,
  uploadQueueCount = 0,
  actionError = '',
}: {
  photosCount?: number
  canAddPhoto?: boolean
  photosDeleteAt?: string | null
  uploadQueueCount?: number
  actionError?: string
} = {}): boolean {
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
 */
export function resolveCanAddPhotoFalseReason({
  abortReason = '',
  existingCount = 0,
  issueOpen = undefined,
  maxPhotos = 3,
}: {
  abortReason?: string
  existingCount?: number
  issueOpen?: boolean
  maxPhotos?: number
} = {}): string {
  if (abortReason) return abortReason
  if (existingCount >= maxPhotos) return 'PHOTO_LIMIT_REACHED'
  if (issueOpen === false) return 'ISSUE_ENDED'
  return 'UPLOADS_DISABLED'
}
