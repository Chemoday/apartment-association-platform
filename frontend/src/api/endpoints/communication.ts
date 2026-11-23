import { apiRequest } from '../client.js'
import type {
  AcknowledgeResponse,
  CommentCreateRequest,
  CommentEditRequest,
  CommentView,
  EmergencyView,
  HideRequest,
  PostCategory,
  PostCreateRequest,
  PostDetail,
  PostEditRequest,
  PostView,
  ResolveResponse,
} from '../schema.js'

/**
 * Fetch active emergency alerts targeting the caller.
 */
export function getActiveEmergencies(
  options: { signal?: AbortSignal } = {},
): Promise<EmergencyView[]> {
  return apiRequest<EmergencyView[]>(
    '/communication/emergencies/active',
    options.signal ? { signal: options.signal } : {},
  )
}

/**
 * Acknowledge an active emergency alert.
 */
export function acknowledgeEmergency(postId: string): Promise<AcknowledgeResponse> {
  return apiRequest<AcknowledgeResponse>(
    `/communication/emergencies/${encodeURIComponent(postId)}/acknowledge`,
    {
      method: 'POST',
    },
  )
}

/**
 * Resolve an active emergency alert (Board / Chairman only).
 */
export function resolveEmergency(postId: string): Promise<ResolveResponse> {
  return apiRequest<ResolveResponse>(
    `/communication/emergencies/${encodeURIComponent(postId)}/resolve`,
    {
      method: 'POST',
    },
  )
}

export interface ListPostsParams {
  post_type?: string | null
  apartment_id?: string | null
  category?: string | null
  limit?: number
  offset?: number
}

/**
 * List posts with optional filters and paging.
 */
export function listPosts(
  params: ListPostsParams = {},
  { signal }: { signal?: AbortSignal } = {},
): Promise<PostView[]> {
  const search = new URLSearchParams()
  if (params.post_type) search.set('post_type', params.post_type)
  if (params.apartment_id) search.set('apartment_id', params.apartment_id)
  if (params.category) search.set('category', params.category)
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const qs = search.toString()
  return apiRequest<PostView[]>(
    `/communication/posts${qs ? `?${qs}` : ''}`,
    signal ? { signal } : {},
  )
}

/**
 * List private threads between the board and apartments (post_type=APARTMENT_THREAD).
 */
export function listApartmentThreads(
  params: { apartment_id?: string | null; limit?: number; offset?: number } = {},
): Promise<PostView[]> {
  return listPosts({
    ...params,
    post_type: 'APARTMENT_THREAD',
  })
}

/**
 * Start a new private thread between the board and a single apartment.
 * Never sends author_apartment_id.
 */
export function createApartmentThread({
  apartmentId,
  title,
  body,
  category = 'GENERAL',
}: {
  apartmentId: string
  title: string
  body: string
  category?: PostCategory
}): Promise<PostView> {
  return createPost({
    post_type: 'APARTMENT_THREAD',
    category,
    title,
    body,
    target_scope: 'APARTMENT_LIST',
    target_apartment_ids: [apartmentId],
    comments_enabled: true,
  })
}

/**
 * List board micro-forum topics (post_type=BOARD_TOPIC), newest activity first.
 * Accessible only to CHAIRMAN and BOARD.
 */
export function listBoardTopics(
  params: { category?: string | null; limit?: number; offset?: number } = {},
): Promise<PostView[]> {
  return listPosts({
    ...params,
    post_type: 'BOARD_TOPIC',
  })
}

/**
 * Create a new board micro-forum topic (post_type=BOARD_TOPIC).
 * Never sends target fields or author_apartment_id.
 */
export function createBoardTopic({
  title,
  body,
  category = 'GENERAL',
  comments_enabled = true,
}: {
  title: string
  body: string
  category?: PostCategory
  comments_enabled?: boolean
}): Promise<PostView> {
  return createPost({
    post_type: 'BOARD_TOPIC',
    category,
    title,
    body,
    comments_enabled,
  })
}

/**
 * Create a new post (forum topic, official notice, emergency, apartment thread, or board topic).
 */
export function createPost(payload: PostCreateRequest): Promise<PostView> {
  return apiRequest<PostView>('/communication/posts', {
    method: 'POST',
    body: payload,
  })
}

/**
 * Get post detail with paged comments.
 */
export function getPost(
  postId: string,
  params: { comments_limit?: number; comments_offset?: number } = {},
): Promise<PostDetail> {
  const search = new URLSearchParams()
  if (params.comments_limit !== undefined) search.set('comments_limit', String(params.comments_limit))
  if (params.comments_offset !== undefined) search.set('comments_offset', String(params.comments_offset))
  const qs = search.toString()
  return apiRequest<PostDetail>(
    `/communication/posts/${encodeURIComponent(postId)}${qs ? `?${qs}` : ''}`,
  )
}

/**
 * Delete a forum or board topic (Chairman or Board).
 */
export function deletePost(postId: string): Promise<null> {
  return apiRequest<null>(`/communication/posts/${encodeURIComponent(postId)}`, {
    method: 'DELETE',
  })
}

/**
 * Add a comment to a post.
 */
export function addComment(postId: string, payload: CommentCreateRequest): Promise<CommentView> {
  return apiRequest<CommentView>(`/communication/posts/${encodeURIComponent(postId)}/comments`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * Hide a forum topic with a reason (Chairman or Board, #028).
 */
export function hidePost(postId: string, payload: HideRequest): Promise<PostView> {
  return apiRequest<PostView>(`/communication/posts/${encodeURIComponent(postId)}/hide`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * Show a hidden forum topic again (Chairman or Board, #028).
 */
export function unhidePost(postId: string): Promise<PostView> {
  return apiRequest<PostView>(`/communication/posts/${encodeURIComponent(postId)}/unhide`, {
    method: 'POST',
  })
}

/**
 * Hide a single comment with a reason (Chairman or Board, #028).
 */
export function hideComment(
  postId: string,
  commentId: string,
  payload: HideRequest,
): Promise<CommentView> {
  return apiRequest<CommentView>(
    `/communication/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/hide`,
    {
      method: 'POST',
      body: payload,
    },
  )
}

/**
 * Show a hidden comment again (Chairman or Board, #028).
 */
export function unhideComment(postId: string, commentId: string): Promise<CommentView> {
  return apiRequest<CommentView>(
    `/communication/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/unhide`,
    {
      method: 'POST',
    },
  )
}

/**
 * Edit own forum or board topic (#027).
 */
export function editPost(postId: string, payload: PostEditRequest): Promise<PostView> {
  return apiRequest<PostView>(`/communication/posts/${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    body: payload,
  })
}

/**
 * Edit own comment (#027).
 */
export function editComment(
  postId: string,
  commentId: string,
  payload: CommentEditRequest,
): Promise<CommentView> {
  return apiRequest<CommentView>(
    `/communication/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`,
    {
      method: 'PATCH',
      body: payload,
    },
  )
}
