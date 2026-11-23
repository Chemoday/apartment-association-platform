import { apiRequest, apiUpload } from '../client.js'
import type { DocumentEdit, DocumentView, UploadOptions } from '../schema.js'

/**
 * GET /api/v1/documents/upload-options
 * Returns { can_upload, audiences, categories, max_bytes } for the acting user.
 */
export function getDocumentUploadOptions(
  { signal = undefined }: { signal?: AbortSignal } = {},
): Promise<UploadOptions> {
  return apiRequest<UploadOptions>('/documents/upload-options', {
    ...(signal ? { signal } : {}),
  })
}

/**
 * GET /api/v1/documents?category=...&limit=...&offset=...
 */
export function listDocuments(
  {
    category = '',
    limit = 50,
    offset = 0,
  }: { category?: string | null; limit?: number; offset?: number } = {},
  { signal = undefined }: { signal?: AbortSignal } = {},
): Promise<DocumentView[]> {
  const qs = new URLSearchParams()
  if (category) qs.set('category', String(category))
  if (limit !== undefined && limit !== null) qs.set('limit', String(limit))
  if (offset !== undefined && offset !== null) qs.set('offset', String(offset))
  const suffix = qs.toString()
  return apiRequest<DocumentView[]>(suffix ? `/documents?${suffix}` : '/documents', {
    ...(signal ? { signal } : {}),
  })
}

function requireDocumentId(documentId: string): string {
  const id = String(documentId ?? '').trim()
  if (!id) {
    throw new Error('documentId is required')
  }
  return id
}

/**
 * GET /api/v1/documents/{document_id}
 */
export function getDocument(
  documentId: string,
  { signal = undefined }: { signal?: AbortSignal } = {},
): Promise<DocumentView> {
  const id = requireDocumentId(documentId)
  return apiRequest<DocumentView>(`/documents/${encodeURIComponent(id)}`, {
    ...(signal ? { signal } : {}),
  })
}

/**
 * GET /api/v1/documents/{document_id}/file
 * Returns the raw Response (or mock response object with blob() + headers)
 * so callers can save it as a download without rendering inline.
 */
export function downloadDocumentFile(
  documentId: string,
  { signal = undefined }: { signal?: AbortSignal } = {},
): Promise<Response> {
  const id = requireDocumentId(documentId)
  return apiRequest<Response>(`/documents/${encodeURIComponent(id)}/file`, {
    raw: true,
    ...(signal ? { signal } : {}),
  })
}

/**
 * POST /api/v1/documents?title=...&category=...&audience=...&document_date=...
 * Uploads raw PDF bytes as the request body (Content-Type: application/pdf).
 */
export function uploadDocument(
  pdfBlob: Blob,
  {
    title = '',
    category = '',
    audience = '',
    document_date = null,
  }: {
    title?: string
    category?: string
    audience?: string
    document_date?: string | null
  } = {},
  {
    idempotencyKey = '',
    onProgress = undefined,
    signal = undefined,
  }: {
    idempotencyKey?: string
    onProgress?: (loaded: number, total: number) => void
    signal?: AbortSignal
  } = {},
): Promise<DocumentView> {
  const qs = new URLSearchParams()
  qs.set('title', String(title ?? '').trim())
  qs.set('category', String(category ?? ''))
  qs.set('audience', String(audience ?? ''))
  if (
    document_date !== undefined &&
    document_date !== null &&
    String(document_date).trim() !== ''
  ) {
    qs.set('document_date', String(document_date).trim())
  }
  const headers: Record<string, string> = {}
  if (idempotencyKey) {
    headers['Idempotency-Key'] = idempotencyKey
  }
  return apiUpload<DocumentView>(`/documents?${qs.toString()}`, {
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
export function editDocument(
  documentId: string,
  patchPayload: DocumentEdit,
  { signal }: { signal?: AbortSignal } = {},
): Promise<DocumentView> {
  const id = requireDocumentId(documentId)
  return apiRequest<DocumentView>(`/documents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patchPayload,
    ...(signal ? { signal } : {}),
  })
}

/**
 * DELETE /api/v1/documents/{document_id}
 */
export function deleteDocument(
  documentId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<null> {
  const id = requireDocumentId(documentId)
  return apiRequest<null>(`/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...(signal ? { signal } : {}),
  })
}
