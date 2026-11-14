/**
 * Pure domain helpers for forum posts, notices, board topics, apartment threads,
 * and hidden/edited state projection (#026).
 */

/**
 * Whether the building role belongs to the board (Chairman or Board member).
 * @param {string | null | undefined} role
 * @returns {boolean}
 */
export function isBoardRole(role) {
  return role === 'CHAIRMAN' || role === 'BOARD'
}

/**
 * Whether the role can delete a FORUM_TOPIC (#026: CHAIRMAN and BOARD).
 * @param {string | null | undefined} role
 * @returns {boolean}
 */
export function canDeleteForumTopicForRole(role) {
  return isBoardRole(role)
}

/**
 * @param {{ hidden_at?: string | null } | null | undefined} post
 * @returns {boolean}
 */
export function isPostHidden(post) {
  return Boolean(post?.hidden_at)
}

/**
 * @param {{ hidden_at?: string | null } | null | undefined} comment
 * @returns {boolean}
 */
export function isCommentHidden(comment) {
  return Boolean(comment?.hidden_at)
}

/**
 * True when a comment was hidden by the board and its body has been redacted for this viewer.
 * @param {{ hidden_at?: string | null, body?: string | null } | null | undefined} comment
 * @returns {boolean}
 */
export function isCommentRedacted(comment) {
  return Boolean(comment?.hidden_at && (comment?.body === null || comment?.body === undefined))
}

/**
 * @param {{ hidden_reason?: string | null } | null | undefined} item
 * @returns {boolean}
 */
export function hasHiddenReason(item) {
  return typeof item?.hidden_reason === 'string' && item.hidden_reason.trim().length > 0
}

/**
 * Safely extract text from a post/comment body that may be null.
 * @param {{ body?: string | null } | null | undefined} item
 * @returns {string}
 */
export function getSafeBodyText(item) {
  return typeof item?.body === 'string' ? item.body : ''
}

/**
 * Null-safe search matching across post title and body (and optional comments).
 * @param {{ title?: string | null, body?: string | null, comments?: Array<{ body?: string | null }> } | null | undefined} post
 * @param {string | null | undefined} query
 * @returns {boolean}
 */
export function matchesPostSearch(post, query) {
  const q = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!q) return true
  if (!post) return false
  const title = typeof post.title === 'string' ? post.title.toLowerCase() : ''
  const body = getSafeBodyText(post).toLowerCase()
  if (title.includes(q) || body.includes(q)) return true
  if (Array.isArray(post.comments)) {
    return post.comments.some((c) => getSafeBodyText(c).toLowerCase().includes(q))
  }
  return false
}

/**
 * Whether new comments may currently be posted on this post in UI.
 * Hidden posts cannot receive new comments (409 POST_HIDDEN on backend).
 * @param {{ comments_enabled?: boolean, hidden_at?: string | null } | null | undefined} post
 * @returns {boolean}
 */
export function canCommentOnPost(post) {
  if (!post) return false
  if (isPostHidden(post)) return false
  return post.comments_enabled !== false
}

/**
 * Whether the viewer is allowed to see hidden content (author or board/chairman).
 * @param {{ author_user_id?: string | null } | null | undefined} item
 * @param {string | null | undefined} viewerUserId
 * @param {string | null | undefined} viewerRole
 * @returns {boolean}
 */
export function canViewerSeeHiddenContent(item, viewerUserId, viewerRole) {
  if (isBoardRole(viewerRole)) return true
  return Boolean(viewerUserId) && item?.author_user_id === viewerUserId
}

/**
 * Full post visibility check matching backend GET /communication/posts and GET /posts/:id rules.
 * @param {any} post
 * @param {{ viewerUserId?: string | null, viewerRole?: string | null, memberships?: Array<{ apartment_id: string, since: string }> }} [ctx]
 * @returns {boolean}
 */
export function canViewerSeePost(post, { viewerUserId, viewerRole, memberships = [] } = {}) {
  if (!post) return false
  if (post.hidden_at && !canViewerSeeHiddenContent(post, viewerUserId, viewerRole)) {
    return false
  }
  if (post.post_type === 'BOARD_TOPIC') {
    return isBoardRole(viewerRole)
  }
  if (post.post_type === 'APARTMENT_THREAD') {
    if (isBoardRole(viewerRole)) return true
    const hasWrittenAsMember =
      Array.isArray(post.comments) &&
      post.comments.some(
        (c) => c.author_user_id === viewerUserId && c.author_apartment_id != null,
      )
    return memberships.some(
      (m) =>
        post.target_apartment_ids?.includes(m.apartment_id) &&
        (new Date(m.since).getTime() <= new Date(post.created_at).getTime() ||
          (post.author_user_id === viewerUserId && post.author_apartment_id != null) ||
          hasWrittenAsMember),
    )
  }
  if (isBoardRole(viewerRole)) return true
  if (post.target_scope === 'ENTRANCE') {
    return memberships.some((m) => m.entrance === post.target_entrance)
  }
  if (post.target_scope === 'APARTMENT_LIST') {
    return memberships.some((m) => post.target_apartment_ids?.includes(m.apartment_id))
  }
  return true
}

/**
 * Project an internal stored comment into a CommentView, masking body & hidden_reason
 * to null when hidden and the viewer is neither the author nor the board.
 * Never leaks moderator identity.
 * @param {any} comment
 * @param {{ postId?: string, viewerUserId?: string | null, viewerRole?: string | null, authorBadge: any }} ctx
 */
export function projectCommentForViewer(
  comment,
  { postId, viewerUserId, viewerRole, authorBadge },
) {
  const hidden = Boolean(comment?.hidden_at)
  const canSeeHidden = !hidden || canViewerSeeHiddenContent(comment, viewerUserId, viewerRole)
  return {
    id: comment.id,
    post_id: postId ?? comment.post_id,
    body: canSeeHidden ? (comment.body ?? '') : null,
    author_badge: authorBadge,
    is_mine: comment.author_user_id === viewerUserId,
    created_at: comment.created_at,
    edited_at: comment.edited_at || null,
    hidden_at: comment.hidden_at || null,
    hidden_reason: hidden && canSeeHidden ? (comment.hidden_reason || null) : null,
  }
}

/**
 * Format localized "Hidden by the board: <reason>" or fallback "Hidden by the board".
 * @param {{ hidden_at?: string | null, hidden_reason?: string | null } | null | undefined} item
 * @param {(key: string, params?: Record<string, any>) => string} t
 * @returns {string}
 */
export function formatHiddenByBoardBanner(item, t) {
  if (!item?.hidden_at) return ''
  if (hasHiddenReason(item)) {
    return t('forum.hiddenByBoardWithReason', { reason: item.hidden_reason.trim() })
  }
  return t('forum.hiddenByBoard')
}

export const HIDE_REASON_MAX_LENGTH = 500

/**
 * Reject ASCII control chars except HT (\t), LF (\n), CR (\r).
 * @param {string} value
 * @returns {boolean}
 */
export function hasDisallowedControlChars(value) {
  if (typeof value !== 'string') return false
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return true
    }
  }
  return false
}

/**
 * Whether a role can moderate forum topics and comments (#028: CHAIRMAN and BOARD).
 * @param {string | null | undefined} role
 * @returns {boolean}
 */
export function canModerateForumForRole(role) {
  return isBoardRole(role)
}

/**
 * Only FORUM_TOPIC posts can be hidden or unhidden by the board (#028).
 * @param {{ post_type?: string | null } | null | undefined} post
 * @returns {boolean}
 */
export function isPostHideable(post) {
  return post?.post_type === 'FORUM_TOPIC'
}

/**
 * Comments on FORUM_TOPIC, OFFICIAL_NOTICE, and EMERGENCY can be hidden or unhidden;
 * APARTMENT_THREAD and BOARD_TOPIC comments are never hideable (#028).
 * Fails closed when postType is missing.
 * @param {{ post_type?: string | null } | string | null | undefined} postOrType
 * @returns {boolean}
 */
export function isCommentHideableOnPost(postOrType) {
  const postType = typeof postOrType === 'string' ? postOrType : postOrType?.post_type
  return (
    postType === 'FORUM_TOPIC' ||
    postType === 'OFFICIAL_NOTICE' ||
    postType === 'EMERGENCY'
  )
}

/**
 * Validate a hide moderation reason per backend contract (trimmed, 1..500 chars, plain text).
 * @param {string | null | undefined} rawReason
 * @returns {{ valid: boolean, reason: string, error: 'REASON_REQUIRED' | 'REASON_TOO_LONG' | 'INVALID_CHARS' | null }}
 */
export function validateHideReason(rawReason) {
  const reason = typeof rawReason === 'string' ? rawReason.trim() : ''
  if (!reason) {
    return { valid: false, reason: '', error: 'REASON_REQUIRED' }
  }
  if (hasDisallowedControlChars(reason)) {
    return { valid: false, reason, error: 'INVALID_CHARS' }
  }
  if (reason.length > HIDE_REASON_MAX_LENGTH) {
    return { valid: false, reason, error: 'REASON_TOO_LONG' }
  }
  return { valid: true, reason, error: null }
}

/**
 * Merge a returned PostView (e.g. from hide/unhide/edit) into an existing post list immutably.
 * @param {Array<any>} posts
 * @param {any} updatedPost
 * @returns {Array<any>}
 */
export function mergeUpdatedPostIntoList(posts, updatedPost) {
  if (!Array.isArray(posts) || !updatedPost?.id) return posts
  let changed = false
  const next = posts.map((p) => {
    if (p?.id !== updatedPost.id) return p
    changed = true
    return { ...p, ...updatedPost }
  })
  return changed ? next : posts
}

/**
 * Merge a returned PostView (which omits comments[]) into an open PostDetail without dropping comments.
 * @param {any} detail
 * @param {any} updatedPost
 * @returns {any}
 */
export function mergeUpdatedPostIntoDetail(detail, updatedPost) {
  if (!updatedPost) return detail
  if (!detail || detail.id !== updatedPost.id) return updatedPost
  return {
    ...detail,
    ...updatedPost,
    comments: Array.isArray(updatedPost.comments)
      ? updatedPost.comments
      : Array.isArray(detail.comments)
        ? detail.comments
        : [],
  }
}

/**
 * Replace a single comment inside an open PostDetail immutably (#028 / #027).
 * @param {any} detail
 * @param {any} updatedComment
 * @returns {any}
 */
export function replaceCommentInDetail(detail, updatedComment) {
  if (!detail || !Array.isArray(detail.comments) || !updatedComment?.id) return detail
  let changed = false
  const nextComments = detail.comments.map((c) => {
    if (c?.id !== updatedComment.id) return c
    changed = true
    return { ...c, ...updatedComment }
  })
  return changed ? { ...detail, comments: nextComments } : detail
}

export const POST_TITLE_MAX_LENGTH = 255
export const POST_BODY_MAX_LENGTH = 10000
export const COMMENT_BODY_MAX_LENGTH = 4000
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Compute UTC ms deadline for a 24-hour edit window from created_at.
 * @param {string | null | undefined} createdAt
 * @returns {number | null}
 */
export function getEditWindowDeadlineMs(createdAt) {
  if (typeof createdAt !== 'string' || !createdAt.trim()) return null
  const createdMs = Date.parse(createdAt)
  if (!Number.isFinite(createdMs)) return null
  return createdMs + EDIT_WINDOW_MS
}

/**
 * True strictly before created_at + 24 hours (#027).
 * @param {string | null | undefined} createdAt
 * @param {number} [nowMs]
 * @returns {boolean}
 */
export function isWithinEditWindow(createdAt, nowMs = Date.now()) {
  const deadlineMs = getEditWindowDeadlineMs(createdAt)
  if (deadlineMs === null) return false
  return nowMs < deadlineMs
}

/**
 * Whether the caller can edit a post (#027):
 * - post.is_mine === true
 * - post_type is FORUM_TOPIC or BOARD_TOPIC
 * - origin == null
 * - not hidden
 * - FORUM_TOPIC: within 24h of created_at; BOARD_TOPIC: no time limit
 * @param {any} post
 * @param {number} [nowMs]
 * @param {{ serverClosed?: boolean }} [options]
 * @returns {boolean}
 */
export function canEditPost(post, nowMs = Date.now(), { serverClosed = false } = {}) {
  if (!post || serverClosed) return false
  if (post.is_mine !== true) return false
  if (post.origin != null) return false
  if (post.hidden_at) return false
  if (post.post_type === 'BOARD_TOPIC') return true
  if (post.post_type === 'FORUM_TOPIC') {
    return isWithinEditWindow(post.created_at, nowMs)
  }
  return false
}

/**
 * Whether the caller can edit a comment (#027):
 * - comment.is_mine === true
 * - parent post is not APARTMENT_THREAD (must be FORUM_TOPIC, BOARD_TOPIC, OFFICIAL_NOTICE, or EMERGENCY)
 * - post.origin == null
 * - neither post nor comment is hidden
 * - within 24h of comment.created_at
 * @param {any} comment
 * @param {any} post
 * @param {number} [nowMs]
 * @param {{ serverClosed?: boolean }} [options]
 * @returns {boolean}
 */
export function canEditComment(comment, post, nowMs = Date.now(), { serverClosed = false } = {}) {
  if (!comment || !post || serverClosed) return false
  if (comment.is_mine !== true) return false
  const postType = post.post_type
  if (
    postType !== 'FORUM_TOPIC' &&
    postType !== 'BOARD_TOPIC' &&
    postType !== 'OFFICIAL_NOTICE' &&
    postType !== 'EMERGENCY'
  ) {
    return false
  }
  if (post.origin != null) return false
  if (post.hidden_at || comment.hidden_at) return false
  return isWithinEditWindow(comment.created_at, nowMs)
}

/**
 * Find the delay in ms until the earliest open 24h edit window on a post detail closes.
 * Returns null if no editable time-limited item is currently open.
 * @param {any} post
 * @param {number} [nowMs]
 * @returns {number | null}
 */
export function getNextEditExpiryDelayMs(post, nowMs = Date.now()) {
  if (!post) return null
  const candidates = []
  if (
    post.post_type === 'FORUM_TOPIC' &&
    post.is_mine === true &&
    post.origin == null &&
    !post.hidden_at
  ) {
    const deadline = getEditWindowDeadlineMs(post.created_at)
    if (deadline !== null && deadline > nowMs) {
      candidates.push(deadline - nowMs)
    }
  }
  if (Array.isArray(post.comments)) {
    for (const c of post.comments) {
      if (canEditComment(c, post, nowMs)) {
        const deadline = getEditWindowDeadlineMs(c.created_at)
        if (deadline !== null && deadline > nowMs) {
          candidates.push(deadline - nowMs)
        }
      }
    }
  }
  if (candidates.length === 0) return null
  return Math.min(...candidates) + 50
}

/**
 * Validate post edit draft (title 1..255, body 1..10000 after trim, plain text).
 * @param {string | null | undefined} rawTitle
 * @param {string | null | undefined} rawBody
 * @returns {{
 *   valid: boolean,
 *   title: string,
 *   body: string,
 *   field: 'title' | 'body' | null,
 *   error: 'TITLE_REQUIRED' | 'TITLE_INVALID_CHARS' | 'TITLE_TOO_LONG' | 'BODY_REQUIRED' | 'BODY_INVALID_CHARS' | 'BODY_TOO_LONG' | null
 * }}
 */
export function validatePostEdit(rawTitle, rawBody) {
  const title = typeof rawTitle === 'string' ? rawTitle.trim() : ''
  const body = typeof rawBody === 'string' ? rawBody.trim() : ''
  if (!title) {
    return { valid: false, title: '', body, field: 'title', error: 'TITLE_REQUIRED' }
  }
  if (hasDisallowedControlChars(title)) {
    return { valid: false, title, body, field: 'title', error: 'TITLE_INVALID_CHARS' }
  }
  if (title.length > POST_TITLE_MAX_LENGTH) {
    return { valid: false, title, body, field: 'title', error: 'TITLE_TOO_LONG' }
  }
  if (!body) {
    return { valid: false, title, body: '', field: 'body', error: 'BODY_REQUIRED' }
  }
  if (hasDisallowedControlChars(body)) {
    return { valid: false, title, body, field: 'body', error: 'BODY_INVALID_CHARS' }
  }
  if (body.length > POST_BODY_MAX_LENGTH) {
    return { valid: false, title, body, field: 'body', error: 'BODY_TOO_LONG' }
  }
  return { valid: true, title, body, field: null, error: null }
}

/**
 * Build PATCH payload containing ONLY changed post fields (#027).
 * Returns {} if neither title nor body changed.
 * @param {{ title?: string | null, body?: string | null } | null | undefined} originalPost
 * @param {string} nextTitle
 * @param {string} nextBody
 * @returns {{ title?: string, body?: string }}
 */
export function buildPostEditPayload(originalPost, nextTitle, nextBody) {
  const cleanTitle = typeof nextTitle === 'string' ? nextTitle.trim() : ''
  const cleanBody = typeof nextBody === 'string' ? nextBody.trim() : ''
  const origTitle = typeof originalPost?.title === 'string' ? originalPost.title.trim() : ''
  const origBody = typeof originalPost?.body === 'string' ? originalPost.body.trim() : ''
  const payload = {}
  if (cleanTitle !== origTitle) {
    payload.title = cleanTitle
  }
  if (cleanBody !== origBody) {
    payload.body = cleanBody
  }
  return payload
}

/**
 * Validate comment edit draft (body 1..4000 after trim, plain text).
 * @param {string | null | undefined} rawBody
 * @returns {{ valid: boolean, body: string, error: 'BODY_REQUIRED' | 'INVALID_CHARS' | 'BODY_TOO_LONG' | null }}
 */
export function validateCommentEdit(rawBody) {
  const body = typeof rawBody === 'string' ? rawBody.trim() : ''
  if (!body) {
    return { valid: false, body: '', error: 'BODY_REQUIRED' }
  }
  if (hasDisallowedControlChars(body)) {
    return { valid: false, body, error: 'INVALID_CHARS' }
  }
  if (body.length > COMMENT_BODY_MAX_LENGTH) {
    return { valid: false, body, error: 'BODY_TOO_LONG' }
  }
  return { valid: true, body, error: null }
}


