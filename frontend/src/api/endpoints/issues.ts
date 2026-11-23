import { apiRequest, apiUpload } from '../client.js'
import type {
  IssueCategory,
  IssueEdit,
  IssueForm,
  IssuePhoto,
  IssueReport,
  IssueStatus,
  IssueSummary,
  IssueView,
  PhotoVariant,
  StatusChange,
} from '../schema.js'

/**
 * GET /api/v1/issues/form
 * Returns form options for reporting an issue:
 * { urgent_enabled, apartment_ids, entrances }
 */
export function getIssueForm(options: { signal?: AbortSignal } = {}): Promise<IssueForm> {
  return apiRequest<IssueForm>('/issues/form', {
    method: 'GET',
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

export interface ListIssuesParams {
  status?: 'OPEN' | 'ENDED' | IssueStatus | string | null
  category?: IssueCategory | string | null
  entrance?: number | string | null
  include_old?: boolean
  limit?: number
  offset?: number
  signal?: AbortSignal
}

/**
 * GET /api/v1/issues
 * Lists open issues and issues that ended within the last 30 days (or older when include_old=true for board).
 */
export function listIssues(params: ListIssuesParams = {}): Promise<IssueSummary[]> {
  const search = new URLSearchParams()
  if (params.status) search.set('status', String(params.status))
  if (params.category) search.set('category', String(params.category))
  if (params.entrance !== undefined && params.entrance !== null && params.entrance !== '') {
    search.set('entrance', String(params.entrance))
  }
  if (params.include_old) {
    search.set('include_old', 'true')
  }
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const qs = search.toString()
  return apiRequest<IssueSummary[]>(`/issues${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    ...(params.signal ? { signal: params.signal } : {}),
  })
}

/**
 * GET /api/v1/issues/{issue_id}
 * Returns full details of a single issue including description and timeline.
 */
export function getIssue(
  issueId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<IssueView> {
  return apiRequest<IssueView>(`/issues/${encodeURIComponent(issueId)}`, { method: 'GET', signal })
}

/**
 * POST /api/v1/issues
 * Reports a common-area issue.
 */
export function createIssue(
  payload: IssueReport,
  { signal }: { signal?: AbortSignal } = {},
): Promise<IssueView> {
  return apiRequest<IssueView>('/issues', {
    method: 'POST',
    body: payload,
    signal,
  })
}

/**
 * PATCH /api/v1/issues/{issue_id}
 * Edits a reported issue while its status is still REPORTED.
 */
export function editIssue(issueId: string, payload: IssueEdit): Promise<IssueView> {
  return apiRequest<IssueView>(`/issues/${encodeURIComponent(issueId)}`, {
    method: 'PATCH',
    body: payload,
  })
}

/**
 * POST /api/v1/issues/{issue_id}/withdraw
 * Withdraws a reported issue while its status is still REPORTED.
 */
export function withdrawIssue(issueId: string): Promise<IssueView> {
  return apiRequest<IssueView>(`/issues/${encodeURIComponent(issueId)}/withdraw`, {
    method: 'POST',
  })
}

/**
 * PUT /api/v1/issues/{issue_id}/follow
 * Follows an open issue ("+1 / I see it too"). Idempotent.
 */
export function followIssue(issueId: string): Promise<IssueView> {
  return apiRequest<IssueView>(`/issues/${encodeURIComponent(issueId)}/follow`, {
    method: 'PUT',
  })
}

/**
 * DELETE /api/v1/issues/{issue_id}/follow
 * Stops following an open issue. Idempotent.
 */
export function unfollowIssue(issueId: string): Promise<IssueView> {
  return apiRequest<IssueView>(`/issues/${encodeURIComponent(issueId)}/follow`, {
    method: 'DELETE',
  })
}

/**
 * POST /api/v1/issues/{issue_id}/status
 * Board & Chairman workflow: moves an issue on, marks duplicate, declines, or reopens within 30 days.
 */
export function changeIssueStatus(issueId: string, payload: StatusChange): Promise<IssueView> {
  return apiRequest<IssueView>(`/issues/${encodeURIComponent(issueId)}/status`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * POST /api/v1/issues/{issue_id}/urgent/clear
 * Board & Chairman workflow: clears a false urgent flag on an open issue.
 */
export function clearIssueUrgent(issueId: string): Promise<IssueView> {
  return apiRequest<IssueView>(`/issues/${encodeURIComponent(issueId)}/urgent/clear`, {
    method: 'POST',
  })
}

/**
 * POST /api/v1/issues/{issue_id}/photos
 * Uploads a single client-scaled JPEG photo with upload progress and idempotency key.
 */
export function uploadIssuePhoto(
  issueId: string,
  jpegBlob: Blob,
  {
    idempotencyKey,
    onProgress,
    signal,
  }: {
    idempotencyKey?: string
    onProgress?: (loaded: number, total: number) => void
    signal?: AbortSignal
  } = {},
): Promise<IssuePhoto> {
  return apiUpload<IssuePhoto>(`/issues/${encodeURIComponent(issueId)}/photos`, {
    method: 'POST',
    body: jpegBlob,
    contentType: 'image/jpeg',
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
    onProgress,
    signal,
  })
}

/**
 * GET /api/v1/issues/{issue_id}/photos/{photo_id}?variant=display|thumb
 * Fetches an authenticated image variant as a Blob.
 */
export async function fetchIssuePhotoBlob(
  issueId: string,
  photoId: string,
  variant: PhotoVariant = 'display',
  { signal }: { signal?: AbortSignal } = {},
): Promise<Blob> {
  const qs = variant ? `?variant=${encodeURIComponent(variant)}` : ''
  const response = await apiRequest<Response>(
    `/issues/${encodeURIComponent(issueId)}/photos/${encodeURIComponent(photoId)}${qs}`,
    {
      method: 'GET',
      raw: true,
      signal,
    },
  )
  return response.blob()
}

/**
 * DELETE /api/v1/issues/{issue_id}/photos/{photo_id}
 * Deletes a photo (uploader while issue is open; chairman/board anytime). Returns 204.
 */
export function deleteIssuePhoto(issueId: string, photoId: string): Promise<null> {
  return apiRequest<null>(
    `/issues/${encodeURIComponent(issueId)}/photos/${encodeURIComponent(photoId)}`,
    {
      method: 'DELETE',
    },
  )
}
