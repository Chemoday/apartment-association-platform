import { apiRequest } from '../client.js'

/**
 * Fetch active emergency alerts targeting the caller.
 * @returns {Promise<import('../schema').EmergencyView[]>}
 */
export function getActiveEmergencies() {
  return apiRequest('/communication/emergencies/active')
}

/**
 * Acknowledge an active emergency alert.
 * @param {string} postId
 * @returns {Promise<import('../schema').AcknowledgeResponse>}
 */
export function acknowledgeEmergency(postId) {
  return apiRequest(`/communication/emergencies/${encodeURIComponent(postId)}/acknowledge`, {
    method: 'POST',
  })
}

/**
 * Resolve an active emergency alert (Board / Chairman only).
 * @param {string} postId
 * @returns {Promise<import('../schema').ResolveResponse>}
 */
export function resolveEmergency(postId) {
  return apiRequest(`/communication/emergencies/${encodeURIComponent(postId)}/resolve`, {
    method: 'POST',
  })
}

/**
 * List posts with optional filters and paging.
 * @param {{ post_type?: string | null, apartment_id?: string | null, category?: string | null, limit?: number, offset?: number }} [params]
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import('../schema').PostView[]>}
 */
export function listPosts(params = {}, { signal } = {}) {
  const search = new URLSearchParams()
  if (params.post_type) search.set('post_type', params.post_type)
  if (params.apartment_id) search.set('apartment_id', params.apartment_id)
  if (params.category) search.set('category', params.category)
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const qs = search.toString()
  return apiRequest(`/communication/posts${qs ? `?${qs}` : ''}`, signal ? { signal } : {})
}

/**
 * List private threads between the board and apartments (post_type=APARTMENT_THREAD).
 * @param {{ apartment_id?: string | null, limit?: number, offset?: number }} [params]
 * @returns {Promise<import('../schema').PostView[]>}
 */
export function listApartmentThreads(params = {}) {
  return listPosts({
    ...params,
    post_type: 'APARTMENT_THREAD',
  })
}

/**
 * Start a new private thread between the board and a single apartment.
 * Never sends author_apartment_id.
 * @param {{ apartmentId: string, title: string, body: string, category?: import('../schema').PostCategory }} params
 * @returns {Promise<import('../schema').PostView>}
 */
export function createApartmentThread({ apartmentId, title, body, category = 'GENERAL' }) {
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
 * @param {{ category?: string | null, limit?: number, offset?: number }} [params]
 * @returns {Promise<import('../schema').PostView[]>}
 */
export function listBoardTopics(params = {}) {
  return listPosts({
    ...params,
    post_type: 'BOARD_TOPIC',
  })
}

/**
 * Create a new board micro-forum topic (post_type=BOARD_TOPIC).
 * Never sends target fields or author_apartment_id.
 * @param {{ title: string, body: string, category?: import('../schema').PostCategory, comments_enabled?: boolean }} params
 * @returns {Promise<import('../schema').PostView>}
 */
export function createBoardTopic({
  title,
  body,
  category = 'GENERAL',
  comments_enabled = true,
}) {
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
 * @param {import('../schema').PostCreateRequest} payload
 * @returns {Promise<import('../schema').PostView>}
 */
export function createPost(payload) {
  return apiRequest('/communication/posts', {
    method: 'POST',
    body: payload,
  })
}

/**
 * Get post detail with paged comments.
 * @param {string} postId
 * @param {{ comments_limit?: number, comments_offset?: number }} [params]
 * @returns {Promise<import('../schema').PostDetail>}
 */
export function getPost(postId, params = {}) {
  const search = new URLSearchParams()
  if (params.comments_limit !== undefined) search.set('comments_limit', String(params.comments_limit))
  if (params.comments_offset !== undefined) search.set('comments_offset', String(params.comments_offset))
  const qs = search.toString()
  return apiRequest(`/communication/posts/${encodeURIComponent(postId)}${qs ? `?${qs}` : ''}`)
}

/**
 * Delete a forum or board topic (Chairman or Board).
 * @param {string} postId
 * @returns {Promise<null>}
 */
export function deletePost(postId) {
  return apiRequest(`/communication/posts/${encodeURIComponent(postId)}`, {
    method: 'DELETE',
  })
}

/**
 * Add a comment to a post.
 * @param {string} postId
 * @param {import('../schema').CommentCreateRequest} payload
 * @returns {Promise<import('../schema').CommentView>}
 */
export function addComment(postId, payload) {
  return apiRequest(`/communication/posts/${encodeURIComponent(postId)}/comments`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * Hide a forum topic with a reason (Chairman or Board, #028).
 * @param {string} postId
 * @param {import('../schema').HideRequest} payload
 * @returns {Promise<import('../schema').PostView>}
 */
export function hidePost(postId, payload) {
  return apiRequest(`/communication/posts/${encodeURIComponent(postId)}/hide`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * Show a hidden forum topic again (Chairman or Board, #028).
 * @param {string} postId
 * @returns {Promise<import('../schema').PostView>}
 */
export function unhidePost(postId) {
  return apiRequest(`/communication/posts/${encodeURIComponent(postId)}/unhide`, {
    method: 'POST',
  })
}

/**
 * Hide a single comment with a reason (Chairman or Board, #028).
 * @param {string} postId
 * @param {string} commentId
 * @param {import('../schema').HideRequest} payload
 * @returns {Promise<import('../schema').CommentView>}
 */
export function hideComment(postId, commentId, payload) {
  return apiRequest(
    `/communication/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/hide`,
    {
      method: 'POST',
      body: payload,
    },
  )
}

/**
 * Show a hidden comment again (Chairman or Board, #028).
 * @param {string} postId
 * @param {string} commentId
 * @returns {Promise<import('../schema').CommentView>}
 */
export function unhideComment(postId, commentId) {
  return apiRequest(
    `/communication/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}/unhide`,
    {
      method: 'POST',
    },
  )
}

/**
 * Edit own forum or board topic (#027).
 * @param {string} postId
 * @param {import('../schema').PostEditRequest} payload
 * @returns {Promise<import('../schema').PostView>}
 */
export function editPost(postId, payload) {
  return apiRequest(`/communication/posts/${encodeURIComponent(postId)}`, {
    method: 'PATCH',
    body: payload,
  })
}

/**
 * Edit own comment (#027).
 * @param {string} postId
 * @param {string} commentId
 * @param {import('../schema').CommentEditRequest} payload
 * @returns {Promise<import('../schema').CommentView>}
 */
export function editComment(postId, commentId, payload) {
  return apiRequest(
    `/communication/posts/${encodeURIComponent(postId)}/comments/${encodeURIComponent(commentId)}`,
    {
      method: 'PATCH',
      body: payload,
    },
  )
}


