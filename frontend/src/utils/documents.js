import { i18n } from '../locales/index.js'

export const MAX_DOCUMENT_BYTES = 20_000_000
export const MAX_DOCUMENT_TITLE_LENGTH = 200
export const MIN_DOCUMENT_DATE = '1900-01-01'

export const DOCUMENT_CATEGORIES = [
  'ARTICLES',
  'GENERAL_MEETING_MINUTES',
  'BOARD_MINUTES',
  'CONTRACT',
  'INVOICE',
  'FINANCIAL_REPORT',
  'INSURANCE',
  'HOUSE_RULES',
  'OTHER',
]

export const DOCUMENT_AUDIENCES = ['EVERYONE', 'BOARD_AND_ACCOUNTANT', 'BOARD']

const DOCUMENT_CATEGORY_SET = new Set(DOCUMENT_CATEGORIES)
const DOCUMENT_AUDIENCE_SET = new Set(DOCUMENT_AUDIENCES)
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Maps unknown backend document category strings safely to 'OTHER' (#022).
 */
export function resolveDocumentCategoryKey(category) {
  const key = String(category || '').trim()
  return DOCUMENT_CATEGORY_SET.has(key) ? key : 'OTHER'
}

/**
 * Returns whether the user role is staff (chairman, board, accountant)
 * and therefore allowed to see audience chips & uploaded_by privacy badges.
 */
export function isStaffRole(role) {
  return role === 'CHAIRMAN' || role === 'BOARD' || role === 'ACCOUNTANT'
}

/**
 * Generates an RFC-4122 UUID v4 (or bounded fallback) suitable for Idempotency-Key headers.
 */
export function generateDocumentIdempotencyKey() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  const part = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return `${part()}-${part().slice(0, 4)}-4${part().slice(1, 4)}-8${part().slice(1, 4)}-${part()}${part().slice(0, 4)}`
}

/**
 * Prefills document title from picked file name without folder path or trailing ".pdf" (#023).
 */
export function prefillDocumentTitleFromFilename(fileName) {
  if (typeof fileName !== 'string' || !fileName) return ''
  const base = fileName.split(/[\\/]/).pop() || ''
  const withoutPdf = base.replace(/\.pdf$/i, '')
  return withoutPdf
    .replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DOCUMENT_TITLE_LENGTH)
}

/**
 * Validates that title is one line of visible text, 1..200 chars (#023 / API section 13).
 */
export function isSingleLineVisibleTitle(title) {
  if (typeof title !== 'string') return false
  if (/[\r\n\t\x00-\x1f\x7f]/.test(title)) return false
  const trimmed = title.trim()
  if (trimmed.length < 1 || trimmed.length > MAX_DOCUMENT_TITLE_LENGTH) return false
  const visibleOnly = trimmed.replace(
    /[\s\u200B-\u200D\uFEFF\u00AD\u034F\u061C\u180E\u2060-\u206F]/g,
    '',
  )
  return visibleOnly.length > 0
}

/**
 * Formats today in Europe/Tallinn and returns ISO date string 5 years ahead (clamping Feb 29).
 */
export function getMaxDocumentDate(nowMs = Date.now()) {
  let todayIso = ''
  try {
    todayIso = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Tallinn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(nowMs))
  } catch {
    todayIso = new Date(nowMs).toISOString().slice(0, 10)
  }
  const [yStr, mStr, dStr] = todayIso.split('-')
  const targetYear = Number(yStr) + 5
  const month = Number(mStr)
  let day = Number(dStr)
  const lastDayOfMonth = new Date(Date.UTC(targetYear, month, 0)).getUTCDate()
  if (day > lastDayOfMonth) day = lastDayOfMonth
  return `${String(targetYear).padStart(4, '0')}-${mStr}-${String(day).padStart(2, '0')}`
}

/**
 * Validates optional YYYY-MM-DD document_date between 1900-01-01 and +5 years from today.
 */
export function isValidDocumentDate(dateStr, nowMs = Date.now()) {
  if (dateStr === null || dateStr === undefined || String(dateStr).trim() === '') {
    return true
  }
  const normalized = String(dateStr).trim()
  if (!ISO_DATE_RE.test(normalized)) return false
  const [yStr, mStr, dStr] = normalized.split('-')
  const y = Number(yStr)
  const m = Number(mStr)
  const d = Number(dStr)
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return false
  }
  return normalized >= MIN_DOCUMENT_DATE && normalized <= getMaxDocumentDate(nowMs)
}

/**
 * Checks raw bytes begin with %PDF- (0x25 0x50 0x44 0x46 0x2D).
 */
export function hasPdfMagicHeader(bytes) {
  const arr =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : null
  if (!arr || arr.byteLength < 5) return false
  return (
    arr[0] === 0x25 &&
    arr[1] === 0x50 &&
    arr[2] === 0x44 &&
    arr[3] === 0x46 &&
    arr[4] === 0x2d
  )
}

/**
 * Inspects a Blob/File locally before uploading: checks non-empty, <= maxBytes, and %PDF- signature.
 */
export async function inspectPdfBlob(blob, maxBytes = MAX_DOCUMENT_BYTES) {
  if (!blob || typeof blob.size !== 'number' || blob.size <= 0) {
    return { ok: false, errorCode: 'UNSUPPORTED_MEDIA_TYPE' }
  }
  if (blob.size > maxBytes) {
    return { ok: false, errorCode: 'FILE_TOO_LARGE' }
  }
  if (typeof blob.slice === 'function') {
    const headBuf = await blob.slice(0, 5).arrayBuffer()
    if (!hasPdfMagicHeader(headBuf)) {
      return { ok: false, errorCode: 'UNSUPPORTED_MEDIA_TYPE' }
    }
  }
  return { ok: true, size: blob.size }
}

/**
 * Sanitizes a fallback download filename and ensures exactly one trailing ".pdf" extension.
 */
export function sanitizeDownloadFilename(title) {
  const stripped = String(title || '')
    .split(/[\\/]/)
    .pop()
    .replace(/[\r\n\t\x00-\x1f\x7f<>:"|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const base = stripped || 'document'
  if (/\.pdf$/i.test(base)) {
    return `${base.slice(0, -4) || 'document'}.pdf`
  }
  return `${base}.pdf`
}

/**
 * Extracts download file name from Content-Disposition (RFC 5987 filename* or filename=),
 * falling back to sanitized document title with a single ".pdf".
 */
export function parseContentDispositionFilename(headerValue, fallbackTitle = 'document') {
  if (typeof headerValue === 'string' && headerValue.trim()) {
    const extMatch = headerValue.match(/filename\*\s*=\s*(?:utf-8)?'[a-zA-Z0-9-]*'([^;]+)/i)
    if (extMatch && extMatch[1]) {
      try {
        const decoded = decodeURIComponent(extMatch[1].trim().replace(/^["']|["']$/g, ''))
        if (decoded.trim()) {
          return sanitizeDownloadFilename(decoded)
        }
      } catch {
        /* fallback below */
      }
    }
    const quotedMatch = headerValue.match(/filename\s*=\s*"([^"]+)"/i)
    if (quotedMatch && quotedMatch[1]) {
      return sanitizeDownloadFilename(quotedMatch[1])
    }
    const plainMatch = headerValue.match(/filename\s*=\s*([^;\s]+)/i)
    if (plainMatch && plainMatch[1]) {
      return sanitizeDownloadFilename(plainMatch[1].replace(/^["']|["']$/g, ''))
    }
  }
  return sanitizeDownloadFilename(fallbackTitle)
}

/**
 * Formats byte size into human-readable units (B / KB / MB).
 */
export function formatDocumentSize(bytes, lang = 'en') {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  }
  const locale = lang === 'et' ? 'et-EE' : lang === 'ru' ? 'ru-RU' : 'en-US'
  try {
    return `${new Intl.NumberFormat(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(n / (1024 * 1024))} MB`
  } catch {
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }
}

/**
 * Validates document create / edit drafts client-side.
 * @param {Record<string, any>} [draft]
 * @param {{
 *   requireFile?: boolean,
 *   file?: any,
 *   fileIsPdf?: boolean,
 *   maxBytes?: number,
 *   allowedAudiences?: string[],
 *   allowedCategories?: string[],
 *   nowMs?: number,
 * }} [options]
 */
export function validateDocumentDraft(
  draft = {},
  {
    requireFile = false,
    file = null,
    fileIsPdf = true,
    maxBytes = MAX_DOCUMENT_BYTES,
    allowedAudiences = DOCUMENT_AUDIENCES,
    allowedCategories = DOCUMENT_CATEGORIES,
    nowMs = Date.now(),
  } = {},
) {
  const fieldErrors = {}
  const title = typeof draft.title === 'string' ? draft.title.trim() : ''
  const category = String(draft.category || '')
  const audience = String(draft.audience || '')
  const rawDate =
    draft.document_date === null || draft.document_date === undefined
      ? ''
      : String(draft.document_date).trim()

  if (requireFile) {
    if (!file || typeof file.size !== 'number' || file.size <= 0) {
      fieldErrors.file = 'FILE_REQUIRED'
    } else if (file.size > maxBytes) {
      fieldErrors.file = 'FILE_TOO_LARGE'
    } else if (!fileIsPdf) {
      fieldErrors.file = 'UNSUPPORTED_MEDIA_TYPE'
    }
  }

  if (!isSingleLineVisibleTitle(draft.title || '')) {
    if (!title) {
      fieldErrors.title = 'TITLE_REQUIRED'
    } else if (title.length > MAX_DOCUMENT_TITLE_LENGTH) {
      fieldErrors.title = 'TITLE_TOO_LONG'
    } else {
      fieldErrors.title = 'TITLE_INVALID'
    }
  }

  if (!allowedCategories.includes(category)) {
    fieldErrors.category = 'CATEGORY_REQUIRED'
  }

  if (!allowedAudiences.includes(audience)) {
    fieldErrors.audience = 'AUDIENCE_INVALID'
  }

  if (!isValidDocumentDate(rawDate, nowMs)) {
    fieldErrors.document_date = 'DATE_INVALID'
  }

  return {
    valid: Object.keys(fieldErrors).length === 0,
    fieldErrors,
    payload: {
      title,
      category,
      audience,
      document_date: rawDate || null,
    },
  }
}

/**
 * Computes minimal PATCH payload containing ONLY fields actually changed vs originalDoc (#023).
 */
export function buildDocumentEditPatch(originalDoc, draft) {
  const patch = {}
  if (!originalDoc || !draft) return { patch, hasChanges: false }

  const nextTitle = typeof draft.title === 'string' ? draft.title.trim() : ''
  if (nextTitle !== String(originalDoc.title || '')) {
    patch.title = nextTitle
  }

  const nextCategory = String(draft.category || '')
  if (nextCategory && nextCategory !== String(originalDoc.category || '')) {
    patch.category = nextCategory
  }

  const nextAudience = String(draft.audience || '')
  if (nextAudience && nextAudience !== String(originalDoc.audience || '')) {
    patch.audience = nextAudience
  }

  const origDate = originalDoc.document_date ? String(originalDoc.document_date).trim() : null
  const nextDate =
    draft.document_date && String(draft.document_date).trim() !== ''
      ? String(draft.document_date).trim()
      : null
  if (nextDate !== origDate) {
    patch.document_date = nextDate
  }

  return {
    patch,
    hasChanges: Object.keys(patch).length > 0,
  }
}

/**
 * Whether a failed document upload error can be retried with the same Idempotency-Key (#023).
 */
export function isDocumentUploadErrorRetryable(err) {
  const code = err?.errorCode || err?.payload?.error_code || ''
  const status = Number(err?.status || 0)
  if (
    code === 'UPLOAD_REMOVED' ||
    code === 'IDEMPOTENCY_KEY_REUSED' ||
    code === 'FORBIDDEN' ||
    code === 'UPLOADS_DISABLED' ||
    code === 'DOCUMENT_NOT_FOUND' ||
    code === 'UNSUPPORTED_MEDIA_TYPE' ||
    code === 'FILE_TOO_LARGE' ||
    code === 'LENGTH_REQUIRED' ||
    code === 'VALIDATION_ERROR' ||
    status === 411 ||
    status === 413 ||
    status === 415 ||
    status === 403 ||
    status === 404 ||
    status === 422
  ) {
    return false
  }
  return true
}

/**
 * Extracts 422 field-level validation errors keyed by field name (`title`, `document_date`, `category`, `audience`).
 */
export function extractDocumentFieldErrors(err, tFn = null, lang = 'en') {
  const result = {}
  const items = err?.payload?.errors || err?.payload?.detail
  if (!Array.isArray(items)) return result
  const t =
    typeof tFn === 'function'
      ? tFn
      : (k, p = {}) => String(i18n.global.t(k, p, { locale: lang || 'en' }))

  for (const item of items) {
    const loc = Array.isArray(item?.loc) ? item.loc.map(String) : []
    const target = loc.find((part) =>
      ['title', 'document_date', 'category', 'audience'].includes(part),
    )
    if (!target || result[target]) continue
    if (target === 'title') {
      result.title = t('documents.validation.TITLE_INVALID')
    } else if (target === 'document_date') {
      result.document_date = t('documents.validation.DATE_INVALID')
    } else if (target === 'category') {
      result.category = t('documents.validation.CATEGORY_REQUIRED')
    } else if (target === 'audience') {
      result.audience = t('documents.validation.AUDIENCE_INVALID')
    }
  }
  return result
}

/**
 * Formats document upload/edit/delete/download errors using dedicated documents.errors.* messages
 * (FRONTEND_GUIDE section 18, never reusing photo error texts).
 */
export function formatDocumentErrorMessage(err, tFn = null, lang = 'en') {
  const tr = (key, params = {}) => {
    if (typeof tFn === 'function') {
      return tFn(key, params)
    }
    return String(i18n.global.t(key, params, { locale: lang || 'en' }))
  }
  const code = err?.errorCode || err?.payload?.error_code || ''
  const status = Number(err?.status || 0)
  const traceId = err?.traceId || err?.payload?.trace_id || ''

  if (code === 'FILE_TOO_LARGE' || status === 413) {
    const maxBytes = Number(err?.payload?.max_bytes || MAX_DOCUMENT_BYTES)
    const maxMb = Math.max(1, Math.round(maxBytes / 1_000_000))
    return tr('documents.errors.FILE_TOO_LARGE', { max_mb: maxMb })
  }
  if (code === 'UNSUPPORTED_MEDIA_TYPE' || status === 415) {
    return tr('documents.errors.UNSUPPORTED_MEDIA_TYPE')
  }
  if (
    code === 'UPLOAD_INTERRUPTED' ||
    code === 'UPLOAD_TIMEOUT' ||
    code === 'BACKEND_UNAVAILABLE' ||
    status === 408 ||
    status === 400
  ) {
    return tr('documents.errors.UPLOAD_INTERRUPTED')
  }
  if (code === 'UPLOAD_REMOVED') {
    return tr('documents.errors.UPLOAD_REMOVED')
  }
  if (code === 'IDEMPOTENCY_KEY_REUSED') {
    return tr('documents.errors.IDEMPOTENCY_KEY_REUSED')
  }
  if (code === 'UPLOADS_DISABLED') {
    return tr('documents.errors.UPLOADS_DISABLED')
  }
  if (code === 'FORBIDDEN' || status === 403) {
    return tr('documents.errors.FORBIDDEN')
  }
  if (code === 'DOCUMENT_NOT_FOUND' || status === 404) {
    return tr('documents.errors.DOCUMENT_NOT_FOUND')
  }
  if (code === 'STORAGE_QUOTA_EXCEEDED' || code === 'STORAGE_LOW_DISK' || status === 507) {
    return tr('documents.errors.STORAGE_FULL')
  }
  if (code === 'RATE_LIMITED' || status === 429) {
    const wait = Number(err?.payload?.retry_after_seconds)
    if (Number.isFinite(wait) && wait > 0) {
      return tr('documents.errors.RATE_LIMITED_WAIT', { seconds: Math.ceil(wait) })
    }
    return tr('documents.errors.RATE_LIMITED')
  }
  if (code === 'VALIDATION_ERROR' || status === 422) {
    return tr('documents.errors.VALIDATION_ERROR')
  }
  const baseUnknown = tr('documents.errors.UNKNOWN')
  if (traceId && (status >= 500 || code === 'INTERNAL_SERVER_ERROR' || !code)) {
    const resolvedLang = lang || i18n.global.locale.value || 'en'
    const prefix =
      resolvedLang === 'et' ? 'Veakood:' : resolvedLang === 'ru' ? 'Код ошибки:' : 'Error code:'
    return `${baseUnknown} (${prefix} ${traceId})`
  }
  return baseUnknown
}

// ---------------------------------------------------------------------------
// Shared document store & validation logic for dev middleware & offline demo
// ---------------------------------------------------------------------------

/**
 * Generates minimal valid %PDF-1.4 bytes for seeded mock documents so binary downloads succeed cleanly.
 */
export function buildMinimalPdfBytes(label = 'Association Document') {
  const safeLabel = String(label || 'Document')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/[()\\]/g, '')
    .slice(0, 60)
  const stream = `BT /F1 12 Tf 72 720 Td (${safeLabel}) Tj ET`
  const pdf = [
    '%PDF-1.4',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj`,
    'xref',
    '0 5',
    '0000000000 65535 f ',
    'trailer << /Size 5 /Root 1 0 R >>',
    'startxref',
    '0',
    '%%EOF\n',
  ].join('\n')
  return new TextEncoder().encode(pdf)
}

/**
 * Resolves whether a user can access the documents module (API section 13).
 */
export function canUserAccessDocumentsModule(user, userMemberships = []) {
  if (!user) return false
  if (isStaffRole(user.building_role)) return true
  return Array.isArray(userMemberships) && userMemberships.length > 0
}

/**
 * Resolves whether a specific document is visible to the acting user.
 */
export function isDocumentVisibleToUser(doc, user, userMemberships = []) {
  if (!doc || doc.deleted || doc.expired) return false
  if (!canUserAccessDocumentsModule(user, userMemberships)) return false
  const role = user.building_role
  if (doc.audience === 'EVERYONE') return true
  if (doc.audience === 'BOARD_AND_ACCOUNTANT') {
    return role === 'CHAIRMAN' || role === 'BOARD' || role === 'ACCOUNTANT'
  }
  if (doc.audience === 'BOARD') {
    return role === 'CHAIRMAN' || role === 'BOARD'
  }
  return false
}

/**
 * Formats an internal document record as DocumentView respecting privacy rules (#022).
 */
export function toDocumentView(doc, user, { resolveBadgeFn } = {}) {
  const role = user?.building_role || 'USER'
  const isStaff = isStaffRole(role)
  const canEdit = role === 'CHAIRMAN' || role === 'BOARD'
  const canDelete = role === 'CHAIRMAN'
  let uploadedBy = null
  if (isStaff && doc.uploader_user_id) {
    const rawBadge =
      typeof resolveBadgeFn === 'function' ? resolveBadgeFn(doc.uploader_user_id) : null
    if (rawBadge) {
      // Strip any accidental apartment context per API section 13 ("without an apartment context")
      uploadedBy = {
        display_label: rawBadge.display_label,
        role_badge: rawBadge.role_badge,
      }
    } else if (doc.uploader_badge) {
      uploadedBy = { ...doc.uploader_badge }
    }
  }
  return {
    id: doc.id,
    title: doc.title,
    category: doc.category,
    audience: doc.audience,
    document_date: doc.document_date || null,
    size_bytes: Number(doc.size_bytes || 0),
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    mine: doc.uploader_user_id === user?.user_id,
    can_edit: canEdit,
    can_delete: canDelete,
    uploaded_by: uploadedBy,
  }
}

/**
 * Returns GET /api/v1/documents/upload-options payload for the acting user.
 */
export function getUploadOptionsForUser(user, { uploadsDisabled = false } = {}) {
  const role = user?.building_role || 'USER'
  let audiences = []
  if (role === 'CHAIRMAN' || role === 'BOARD') {
    audiences = ['EVERYONE', 'BOARD_AND_ACCOUNTANT', 'BOARD']
  } else if (role === 'ACCOUNTANT') {
    audiences = ['BOARD_AND_ACCOUNTANT']
  }
  return {
    can_upload: !uploadsDisabled && audiences.length > 0,
    audiences,
    categories: [...DOCUMENT_CATEGORIES],
    max_bytes: MAX_DOCUMENT_BYTES,
  }
}

/**
 * Creates deterministic seeded documents covering EVERYONE, BOARD_AND_ACCOUNTANT, and BOARD.
 */
export function createDefaultDocumentsSeed(nowMs = Date.UTC(2026, 10, 12, 10, 0, 0)) {
  const chairmanId = '018f0000-0000-7000-8000-000000000101'
  const boardId = '018f0000-0000-7000-8000-000000000105'
  const accountantId = '018f0000-0000-7000-8000-000000000103'
  const iso = (daysAgo) => new Date(nowMs - daysAgo * 86_400_000).toISOString()

  const specs = [
    {
      id: '018f0000-0000-7000-8000-000000004001',
      title: 'Articles of Association (Current)',
      category: 'ARTICLES',
      audience: 'EVERYONE',
      document_date: '2024-03-14',
      size_bytes: 420_180,
      daysAgo: 40,
      uploader_user_id: chairmanId,
      uploader_badge: { display_label: 'Board Chairman', role_badge: 'BOARD' },
    },
    {
      id: '018f0000-0000-7000-8000-000000004002',
      title: 'General Meeting Minutes 2026',
      category: 'GENERAL_MEETING_MINUTES',
      audience: 'EVERYONE',
      document_date: '2026-05-20',
      size_bytes: 482_133,
      daysAgo: 18,
      uploader_user_id: chairmanId,
      uploader_badge: { display_label: 'Board Chairman', role_badge: 'BOARD' },
    },
    {
      id: '018f0000-0000-7000-8000-000000004003',
      title: 'House Rules & Courtyard Parking Guidelines',
      category: 'HOUSE_RULES',
      audience: 'EVERYONE',
      document_date: '2025-09-01',
      size_bytes: 310_400,
      daysAgo: 25,
      uploader_user_id: boardId,
      uploader_badge: { display_label: 'Board Member', role_badge: 'BOARD' },
    },
    {
      id: '018f0000-0000-7000-8000-000000004004',
      title: 'Annual Financial Report 2025',
      category: 'FINANCIAL_REPORT',
      audience: 'BOARD_AND_ACCOUNTANT',
      document_date: '2026-01-18',
      size_bytes: 892_040,
      daysAgo: 10,
      uploader_user_id: accountantId,
      uploader_badge: { display_label: 'Accountant', role_badge: 'ACCOUNTANT' },
    },
    {
      id: '018f0000-0000-7000-8000-000000004005',
      title: 'Lift Maintenance Invoice #INV-2026-104',
      category: 'INVOICE',
      audience: 'BOARD_AND_ACCOUNTANT',
      document_date: '2026-10-30',
      size_bytes: 215_900,
      daysAgo: 4,
      uploader_user_id: accountantId,
      uploader_badge: { display_label: 'Accountant', role_badge: 'ACCOUNTANT' },
    },
    {
      id: '018f0000-0000-7000-8000-000000004006',
      title: 'Board Minutes — Roof Tender Review',
      category: 'BOARD_MINUTES',
      audience: 'BOARD',
      document_date: '2026-11-05',
      size_bytes: 194_560,
      daysAgo: 1,
      uploader_user_id: boardId,
      uploader_badge: { display_label: 'Board Member', role_badge: 'BOARD' },
    },
  ]

  return specs.map((item) => ({
    id: item.id,
    title: item.title,
    category: item.category,
    audience: item.audience,
    document_date: item.document_date,
    size_bytes: item.size_bytes,
    created_at: iso(item.daysAgo),
    updated_at: iso(item.daysAgo),
    uploader_user_id: item.uploader_user_id,
    uploader_badge: item.uploader_badge,
    bytes: buildMinimalPdfBytes(item.title),
    deleted: false,
    expired: false,
  }))
}

/**
 * Executes GET /api/v1/documents?category=&limit=&offset=.
 * @param {any[]} store
 * @param {any} user
 * @param {any[]} [userMemberships]
 * @param {{ category?: string, limit?: number | string, offset?: number | string }} [params]
 * @param {{ resolveBadgeFn?: ((uid: string) => any) | null }} [options]
 * @returns {any}
 */
export function queryDocumentsStore(
  store,
  user,
  userMemberships = [],
  { category = '', limit = 50, offset = 0 } = {},
  { resolveBadgeFn = null } = {},
) {
  if (!canUserAccessDocumentsModule(user, userMemberships)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only active members and association staff can access documents.',
    }
  }
  const parsedLimit = limit === undefined || limit === null || limit === '' ? 50 : Number(limit)
  const parsedOffset = offset === undefined || offset === null || offset === '' ? 0 : Number(offset)
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'limit must be between 1 and 100.',
    }
  }
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'offset must be non-negative.',
    }
  }
  const catFilter = category ? String(category).trim() : ''
  const visible = (store || [])
    .filter((doc) => isDocumentVisibleToUser(doc, user, userMemberships))
    .filter((doc) => (!catFilter ? true : doc.category === catFilter))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))

  const sliced = visible
    .slice(parsedOffset, parsedOffset + parsedLimit)
    .map((doc) => toDocumentView(doc, user, { resolveBadgeFn }))

  return { ok: true, items: sliced, totalVisible: visible.length }
}

/**
 * Resolves GET /api/v1/documents/{document_id}.
 * @param {any[]} store
 * @param {string} documentId
 * @param {any} user
 * @param {any[]} [userMemberships]
 * @param {{ resolveBadgeFn?: ((uid: string) => any) | null }} [options]
 * @returns {any}
 */
export function getDocumentFromStore(store, documentId, user, userMemberships = [], { resolveBadgeFn = null } = {}) {
  if (!canUserAccessDocumentsModule(user, userMemberships)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only active members and association staff can access documents.',
    }
  }
  const doc = (store || []).find((d) => d.id === documentId)
  if (!doc || !isDocumentVisibleToUser(doc, user, userMemberships)) {
    return {
      ok: false,
      status: 404,
      errorCode: 'DOCUMENT_NOT_FOUND',
      message: 'This document is not available.',
    }
  }
  return { ok: true, document: toDocumentView(doc, user, { resolveBadgeFn }) }
}

/**
 * Resolves GET /api/v1/documents/{document_id}/file.
 * @param {any[]} store
 * @param {string} documentId
 * @param {any} user
 * @param {any[]} [userMemberships]
 * @returns {any}
 */
export function getDocumentFileFromStore(store, documentId, user, userMemberships = []) {
  if (!canUserAccessDocumentsModule(user, userMemberships)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only active members and association staff can access documents.',
    }
  }
  const doc = (store || []).find((d) => d.id === documentId)
  if (!doc || !isDocumentVisibleToUser(doc, user, userMemberships) || !doc.bytes) {
    return {
      ok: false,
      status: 404,
      errorCode: 'DOCUMENT_NOT_FOUND',
      message: 'This document is not available.',
    }
  }
  const downloadFilename = sanitizeDownloadFilename(doc.title)
  const asciiCandidate = downloadFilename
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\;]/g, '')
    .trim()
  const asciiFilename =
    asciiCandidate && asciiCandidate !== '.pdf' ? asciiCandidate : 'document.pdf'
  const encodedFilename = encodeURIComponent(downloadFilename)
  return {
    ok: true,
    bytes: doc.bytes,
    filename: downloadFilename,
    contentType: 'application/pdf',
    contentDisposition: `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
  }
}

/**
 * Runs pre-body upload checks for POST /api/v1/documents in strict API.md sections 12 & 13 order.
 * @param {{
 *   store: any[],
 *   user: any,
 *   userMemberships?: any[],
 *   query?: Record<string, any>,
 *   contentType?: string,
 *   contentLength?: number | null,
 *   idempotencyKey?: string,
 *   idempotencyStore?: Map<string, any> | null,
 *   nowMs?: number,
 *   uploadsDisabled?: boolean,
 *   quotaExceededReason?: string,
 *   lowDisk?: boolean,
 *   storageStats?: any,
 *   byteLengthFallback?: number,
 *   resolveBadgeFn?: ((uid: string) => any) | null,
 * }} params
 * @returns {any}
 */
export function checkDocumentUploadPreflight({
  store,
  user,
  userMemberships = [],
  query = {},
  contentType = 'application/pdf',
  contentLength = undefined,
  idempotencyKey = '',
  idempotencyStore = null,
  nowMs = Date.now(),
  uploadsDisabled = false,
  quotaExceededReason = '',
  lowDisk = false,
  storageStats = null,
  byteLengthFallback = undefined,
  resolveBadgeFn = null,
}) {
  if (!canUserAccessDocumentsModule(user, userMemberships)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only staff members can upload documents.',
    }
  }

  const role = user?.building_role || 'USER'
  const isChairmanOrBoard = role === 'CHAIRMAN' || role === 'BOARD'
  const isAccountant = role === 'ACCOUNTANT'
  if (!isChairmanOrBoard && !isAccountant) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Residents cannot upload documents.',
    }
  }

  const titleRaw = query.title == null ? '' : String(query.title)
  const category = String(query.category || '')
  const audience = String(query.audience || '')
  const documentDateRaw =
    query.document_date == null || String(query.document_date).trim() === ''
      ? null
      : String(query.document_date).trim()

  if (isAccountant && audience && audience !== 'BOARD_AND_ACCOUNTANT') {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Accountant can only upload documents into Board and accountant.',
    }
  }

  const rawKey = idempotencyKey == null ? '' : String(idempotencyKey)
  if (rawKey.length > 0 && !IDEMPOTENCY_KEY_RE.test(rawKey)) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Malformed Idempotency-Key header.',
    }
  }

  const validationErrors = []
  if (!isSingleLineVisibleTitle(titleRaw)) {
    validationErrors.push({
      loc: ['query', 'title'],
      message: 'Title must be 1..200 visible characters on one line.',
      type: 'value_error',
    })
  }
  if (!category || category.length > 64) {
    validationErrors.push({
      loc: ['query', 'category'],
      message: 'Category is required.',
      type: 'value_error',
    })
  }
  if (!DOCUMENT_AUDIENCE_SET.has(audience)) {
    validationErrors.push({
      loc: ['query', 'audience'],
      message: 'Invalid audience.',
      type: 'value_error',
    })
  }
  if (documentDateRaw !== null && !isValidDocumentDate(documentDateRaw, nowMs)) {
    validationErrors.push({
      loc: ['query', 'document_date'],
      message: 'Invalid document date.',
      type: 'value_error',
    })
  }
  if (validationErrors.length > 0) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Please check document fields.',
      extra: { errors: validationErrors },
    }
  }

  const resolvedLength =
    contentLength === undefined
      ? Number(byteLengthFallback ?? NaN)
      : contentLength === null
        ? NaN
        : Number(contentLength)

  const normalizedMime = String(contentType || '')
    .split(';')[0]
    .trim()
    .toLowerCase()

  const scopedKey = rawKey ? `${user?.user_id || 'anon'}:${rawKey}` : ''
  if (scopedKey && idempotencyStore instanceof Map && idempotencyStore.has(scopedKey)) {
    const entry = idempotencyStore.get(scopedKey)
    if (
      entry.contentLength !== undefined &&
      Number.isFinite(resolvedLength) &&
      resolvedLength !== entry.contentLength
    ) {
      return {
        ok: false,
        status: 409,
        errorCode: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used for another file.',
      }
    }
    const existing = (store || []).find((d) => d.id === entry.documentId)
    if (existing && isDocumentVisibleToUser(existing, user, userMemberships)) {
      return {
        ok: true,
        status: 200,
        replay: true,
        idempotencyDigest: entry.contentDigest || '',
        document: toDocumentView(existing, user, { resolveBadgeFn }),
      }
    }
    // API section 13: document was deleted, expired, or moved out of caller's sight -> IDEMPOTENCY_KEY_REUSED
    return {
      ok: false,
      status: 409,
      errorCode: 'IDEMPOTENCY_KEY_REUSED',
      message: 'This upload key is no longer available.',
    }
  }

  if (normalizedMime !== 'application/pdf') {
    return {
      ok: false,
      status: 415,
      errorCode: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Only PDF files are accepted.',
    }
  }

  if (!Number.isFinite(resolvedLength) || resolvedLength < 0) {
    return {
      ok: false,
      status: 411,
      errorCode: 'LENGTH_REQUIRED',
      message: 'Content-Length header is required.',
    }
  }

  if (resolvedLength > MAX_DOCUMENT_BYTES) {
    return {
      ok: false,
      status: 413,
      errorCode: 'FILE_TOO_LARGE',
      message: 'PDF exceeds the 20 MB limit.',
      extra: { max_bytes: MAX_DOCUMENT_BYTES },
    }
  }

  if (uploadsDisabled) {
    return {
      ok: false,
      status: 403,
      errorCode: 'UPLOADS_DISABLED',
      message: 'Uploads are switched off in this demo.',
    }
  }

  if (lowDisk) {
    return {
      ok: false,
      status: 507,
      errorCode: 'STORAGE_LOW_DISK',
      message: 'Server disk is nearly full.',
    }
  }

  if (quotaExceededReason === 'DELETIONS_PENDING') {
    return {
      ok: false,
      status: 507,
      errorCode: 'STORAGE_QUOTA_EXCEEDED',
      message: 'Deleted files waiting to be erased.',
      extra: { reason: 'DELETIONS_PENDING' },
    }
  }
  if (quotaExceededReason === 'QUOTA') {
    return {
      ok: false,
      status: 507,
      errorCode: 'STORAGE_QUOTA_EXCEEDED',
      message: 'Document storage quota exceeded.',
      extra: { reason: 'QUOTA', category: 'documents' },
    }
  }
  if (storageStats) {
    const docsUsed = Number(storageStats.documentsUsedBytes || 0)
    const docsLimit = Number(storageStats.documentsLimitBytes || Infinity)
    const filesUsed = Number(storageStats.filesUsedBytes || 0)
    const filesLimit = Number(storageStats.filesLimitBytes || Infinity)
    const pendingDel = Number(storageStats.pendingDeletionBytes || 0)
    const totalQuota = Number(storageStats.quotaBytes || Infinity)
    if (pendingDel + resolvedLength > totalQuota) {
      return {
        ok: false,
        status: 507,
        errorCode: 'STORAGE_QUOTA_EXCEEDED',
        message: 'Deleted files waiting to be erased.',
        extra: { reason: 'DELETIONS_PENDING' },
      }
    }
    if (docsUsed + resolvedLength > docsLimit || filesUsed + resolvedLength > filesLimit) {
      return {
        ok: false,
        status: 507,
        errorCode: 'STORAGE_QUOTA_EXCEEDED',
        message: 'Document storage quota exceeded.',
        extra: { reason: 'QUOTA', category: 'documents' },
      }
    }
  }

  return {
    ok: true,
    preflightOnly: true,
    resolvedLength,
    scopedKey,
    normalizedQuery: {
      title: titleRaw.trim(),
      category,
      audience,
      document_date: documentDateRaw,
    },
  }
}

function computePdfDigest(byteArr) {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b1
  for (let i = 0; i < byteArr.byteLength; i += 1) {
    const b = byteArr[i]
    h1 ^= b
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= (b + (i & 0xff)) & 0xff
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return `${byteArr.byteLength}:${h1.toString(16)}:${h2.toString(16)}`
}

/**
 * Applies POST /api/v1/documents (#023).
 * @param {{
 *   store: any[],
 *   user: any,
 *   userMemberships?: any[],
 *   bytes: any,
 *   query?: Record<string, any>,
 *   contentType?: string,
 *   contentLength?: number | null,
 *   idempotencyKey?: string,
 *   idempotencyStore?: Map<string, any> | null,
 *   nowMs?: number,
 *   uploadsDisabled?: boolean,
 *   quotaExceededReason?: string,
 *   lowDisk?: boolean,
 *   storageStats?: any,
 *   resolveBadgeFn?: ((uid: string) => any) | null,
 * }} params
 * @returns {any}
 */
export function addDocumentInStore({
  store,
  user,
  userMemberships = [],
  bytes,
  query = {},
  contentType = 'application/pdf',
  contentLength = undefined,
  idempotencyKey = '',
  idempotencyStore = null,
  nowMs = Date.now(),
  uploadsDisabled = false,
  quotaExceededReason = '',
  lowDisk = false,
  storageStats = null,
  resolveBadgeFn = null,
}) {
  const byteArr =
    bytes instanceof Uint8Array
      ? bytes
      : bytes instanceof ArrayBuffer
        ? new Uint8Array(bytes)
        : ArrayBuffer.isView(bytes)
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(0)

  const preflight = checkDocumentUploadPreflight({
    store,
    user,
    userMemberships,
    query,
    contentType,
    contentLength,
    idempotencyKey,
    idempotencyStore,
    nowMs,
    uploadsDisabled,
    quotaExceededReason,
    lowDisk,
    storageStats,
    byteLengthFallback: byteArr.byteLength,
    resolveBadgeFn,
  })
  if (!preflight.ok) return preflight
  if (preflight.replay) {
    if (
      byteArr.byteLength > 0 &&
      preflight.idempotencyDigest &&
      computePdfDigest(byteArr) !== preflight.idempotencyDigest
    ) {
      return {
        ok: false,
        status: 409,
        errorCode: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used for another file.',
      }
    }
    return preflight
  }

  const { resolvedLength, scopedKey, normalizedQuery } = preflight
  if (byteArr.byteLength > MAX_DOCUMENT_BYTES || byteArr.byteLength > resolvedLength) {
    return {
      ok: false,
      status: 413,
      errorCode: 'FILE_TOO_LARGE',
      message: 'PDF exceeds the 20 MB limit.',
      extra: { max_bytes: MAX_DOCUMENT_BYTES },
    }
  }
  if (byteArr.byteLength < resolvedLength) {
    return {
      ok: false,
      status: 400,
      errorCode: 'UPLOAD_INTERRUPTED',
      message: 'Upload interrupted; please retry.',
    }
  }

  if (!hasPdfMagicHeader(byteArr)) {
    return {
      ok: false,
      status: 415,
      errorCode: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Only PDF files are accepted.',
    }
  }

  const docId =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `018f0000-0000-7000-9400-${Math.floor(100000000000 + Math.random() * 899999999999)}`
  const nowIso = new Date(nowMs).toISOString()
  const rawBadge = typeof resolveBadgeFn === 'function' ? resolveBadgeFn(user?.user_id) : null
  const docRecord = {
    id: docId,
    title: normalizedQuery.title,
    category: normalizedQuery.category,
    audience: normalizedQuery.audience,
    document_date: normalizedQuery.document_date,
    size_bytes: byteArr.byteLength,
    created_at: nowIso,
    updated_at: nowIso,
    uploader_user_id: user.user_id,
    uploader_badge: rawBadge
      ? { display_label: rawBadge.display_label, role_badge: rawBadge.role_badge }
      : {
          display_label: user?.building_role === 'ACCOUNTANT' ? 'Accountant' : 'Board',
          role_badge: user?.building_role === 'ACCOUNTANT' ? 'ACCOUNTANT' : 'BOARD',
        },
    bytes: byteArr,
    deleted: false,
    expired: false,
  }

  store.unshift(docRecord)
  if (scopedKey && idempotencyStore instanceof Map) {
    idempotencyStore.set(scopedKey, {
      documentId: docId,
      contentLength: resolvedLength,
      contentDigest: computePdfDigest(byteArr),
    })
  }

  return {
    ok: true,
    status: 201,
    document: toDocumentView(docRecord, user, { resolveBadgeFn }),
    rawDocument: docRecord,
  }
}

/**
 * Applies PATCH /api/v1/documents/{document_id} (CHAIRMAN and BOARD only).
 * @param {{
 *   store: any[],
 *   documentId: string,
 *   user: any,
 *   userMemberships?: any[],
 *   body?: Record<string, any>,
 *   nowMs?: number,
 *   resolveBadgeFn?: ((uid: string) => any) | null,
 * }} params
 * @returns {any}
 */
export function editDocumentInStore({
  store,
  documentId,
  user,
  userMemberships = [],
  body = {},
  nowMs = Date.now(),
  resolveBadgeFn = null,
}) {
  if (!canUserAccessDocumentsModule(user, userMemberships)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Access denied.',
    }
  }
  const role = user?.building_role || 'USER'
  if (role !== 'CHAIRMAN' && role !== 'BOARD') {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only the chairman and board members can edit documents.',
    }
  }

  const doc = (store || []).find((d) => d.id === documentId)
  if (!doc || !isDocumentVisibleToUser(doc, user, userMemberships)) {
    return {
      ok: false,
      status: 404,
      errorCode: 'DOCUMENT_NOT_FOUND',
      message: 'This document is not available.',
    }
  }

  const validationErrors = []
  let nextTitle = doc.title
  if (Object.prototype.hasOwnProperty.call(body, 'title')) {
    const rawTitle = body.title == null ? '' : String(body.title)
    if (!isSingleLineVisibleTitle(rawTitle)) {
      validationErrors.push({
        loc: ['body', 'title'],
        message: 'Title must be 1..200 visible characters on one line.',
        type: 'value_error',
      })
    } else {
      nextTitle = rawTitle.trim()
    }
  }

  let nextCategory = doc.category
  if (Object.prototype.hasOwnProperty.call(body, 'category')) {
    const cat = String(body.category || '').trim()
    if (!cat || cat.length > 64) {
      validationErrors.push({
        loc: ['body', 'category'],
        message: 'Invalid category.',
        type: 'value_error',
      })
    } else {
      nextCategory = cat
    }
  }

  let nextAudience = doc.audience
  if (Object.prototype.hasOwnProperty.call(body, 'audience')) {
    const aud = String(body.audience || '')
    if (!DOCUMENT_AUDIENCE_SET.has(aud)) {
      validationErrors.push({
        loc: ['body', 'audience'],
        message: 'Invalid audience.',
        type: 'value_error',
      })
    } else {
      nextAudience = aud
    }
  }

  let nextDate = doc.document_date
  if (Object.prototype.hasOwnProperty.call(body, 'document_date')) {
    if (body.document_date === null || String(body.document_date).trim() === '') {
      nextDate = null
    } else {
      const candidate = String(body.document_date).trim()
      if (!isValidDocumentDate(candidate, nowMs)) {
        validationErrors.push({
          loc: ['body', 'document_date'],
          message: 'Invalid document date.',
          type: 'value_error',
        })
      } else {
        nextDate = candidate
      }
    }
  }

  if (validationErrors.length > 0) {
    return {
      ok: false,
      status: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Please check document fields.',
      extra: { errors: validationErrors },
    }
  }

  const changed =
    nextTitle !== doc.title ||
    nextCategory !== doc.category ||
    nextAudience !== doc.audience ||
    nextDate !== doc.document_date

  doc.title = nextTitle
  doc.category = nextCategory
  doc.audience = nextAudience
  doc.document_date = nextDate
  if (changed) {
    doc.updated_at = new Date(nowMs).toISOString()
  }

  return {
    ok: true,
    document: toDocumentView(doc, user, { resolveBadgeFn }),
  }
}

/**
 * Applies DELETE /api/v1/documents/{document_id} (CHAIRMAN only).
 * @param {{
 *   store: any[],
 *   documentId: string,
 *   user: any,
 *   userMemberships?: any[],
 * }} params
 * @returns {any}
 */
export function deleteDocumentInStore({ store, documentId, user, userMemberships = [] }) {
  if (!canUserAccessDocumentsModule(user, userMemberships)) {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Access denied.',
    }
  }
  if (user?.building_role !== 'CHAIRMAN') {
    return {
      ok: false,
      status: 403,
      errorCode: 'FORBIDDEN',
      message: 'Only the chairman can delete documents.',
    }
  }
  const idx = (store || []).findIndex((d) => d.id === documentId)
  if (idx === -1 || !isDocumentVisibleToUser(store[idx], user, userMemberships)) {
    return {
      ok: false,
      status: 404,
      errorCode: 'DOCUMENT_NOT_FOUND',
      message: 'This document is not available.',
    }
  }
  const target = store[idx]
  target.deleted = true
  return {
    ok: true,
    freedBytes: Number(target.size_bytes || 0),
    deletedDocument: target,
  }
}
