import { apiRequest, apiUpload } from '../client.js'

/**
 * GET /api/v1/documents/upload-options
 * Returns { can_upload, audiences, categories, max_bytes } for the acting user.
 * @param {{ signal?: AbortSignal }} [options]
 */
export function getDocumentUploadOptions({ signal = undefined } = {}) {
  return apiRequest('/documents/upload-options', {
    ...(signal ? { signal } : {}),
  })
}

/**
 * GET /api/v1/documents?category=...&limit=...&offset=...
 * @param {{ category?: string, limit?: number, offset?: number }} [query]
 * @param {{ signal?: AbortSignal }} [options]
 */
export function listDocuments(
  { category = '', limit = 50, offset = 0 } = {},
  { signal = undefined } = {},
) {
  const qs = new URLSearchParams()
  if (category) qs.set('category', String(category))
  if (limit !== undefined && limit !== null) qs.set('limit', String(limit))
  if (offset !== undefined && offset !== null) qs.set('offset', String(offset))
  const suffix = qs.toString()
  return apiRequest(suffix ? `/documents?${suffix}` : '/documents', {
    ...(signal ? { signal } : {}),
  })
}

function requireDocumentId(documentId) {
  const id = String(documentId ?? '').trim()
  if (!id) {
    throw new Error('documentId is required')
  }
  return id
}

/**
 * GET /api/v1/documents/{document_id}
 * @param {string} documentId
 * @param {{ signal?: AbortSignal }} [options]
 */
export function getDocument(documentId, { signal = undefined } = {}) {
  const id = requireDocumentId(documentId)
  return apiRequest(`/documents/${encodeURIComponent(id)}`, {
    ...(signal ? { signal } : {}),
  })
}

/**
 * GET /api/v1/documents/{document_id}/file
 * Returns the raw Response (or mock response object with blob() + headers)
 * so callers can save it as a download without rendering inline.
 * @param {string} documentId
 * @param {{ signal?: AbortSignal }} [options]
 */
export function downloadDocumentFile(documentId, { signal = undefined } = {}) {
  const id = requireDocumentId(documentId)
  return apiRequest(`/documents/${encodeURIComponent(id)}/file`, {
    raw: true,
    ...(signal ? { signal } : {}),
  })
}

/**
 * POST /api/v1/documents?title=...&category=...&audience=...&document_date=...
 * Uploads raw PDF bytes as the request body (Content-Type: application/pdf).
 * @param {Blob} pdfBlob
 * @param {{ title?: string, category?: string, audience?: string, document_date?: string | null }} [meta]
 * @param {{ idempotencyKey?: string, onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal }} [options]
 */
export function uploadDocument(
  pdfBlob,
  { title = '', category = '', audience = '', document_date = null } = {},
  { idempotencyKey = '', onProgress = undefined, signal = undefined } = {},
) {
  const qs = new URLSearchParams()
  qs.set('title', String(title ?? '').trim())
  qs.set('category', String(category ?? ''))
  qs.set('audience', String(audience ?? ''))
  if (document_date !== undefined && document_date !== null && String(document_date).trim() !== '') {
    qs.set('document_date', String(document_date).trim())
  }
  const headers = {}
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey
  }
  return apiUpload(`/documents?${qs.toString()}`, {
    method: 'POST',
    body: pdfBlob,
    contentType: 'application/pdf',
    headers,
    onProgress,
    signal,
  })
}

/**
 * PATCH /api/v1/documents/{document_id}
 * Sends only the changed fields so concurrent edits by board members do not overwrite each other.
 */
export function editDocument(documentId, patchPayload, { signal } = {}) {
  const id = requireDocumentId(documentId)
  return apiRequest(`/documents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patchPayload,
    ...(signal ? { signal } : {}),
  })
}

/**
 * DELETE /api/v1/documents/{document_id}
 */
export function deleteDocument(documentId, { signal } = {}) {
  const id = requireDocumentId(documentId)
  return apiRequest(`/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  })
}
