import type { AuthorBadgeDTO, CommentView, ObjectKind, PostEditRequest, TargetScope } from '@/api/schema.js'
import { OBJECT_KINDS, isObjectInTarget, normalizeObjectKind, type TargetScopeLike } from './objectName.js'

/**
 * Pure domain helpers for forum posts, notices, board topics, apartment threads,
 * and hidden/edited state projection (#026).
 */

/**
 * Whether the building role belongs to the board (Chairman or Board member).
 */
export function isBoardRole(role?: string | null): boolean {
  return role === 'CHAIRMAN' || role === 'BOARD'
}

/**
 * Whether the role can delete a FORUM_TOPIC (#026: CHAIRMAN and BOARD).
 */
export function canDeleteForumTopicForRole(role?: string | null): boolean {
  return isBoardRole(role)
}

export function isPostHidden(post?: { hidden_at?: string | null } | null): boolean {
  return Boolean(post?.hidden_at)
}

export function isCommentHidden(comment?: { hidden_at?: string | null } | null): boolean {
  return Boolean(comment?.hidden_at)
}

/**
 * True when a comment was hidden by the board and its body has been redacted for this viewer.
 */
export function isCommentRedacted(
  comment?: { hidden_at?: string | null; body?: string | null } | null,
): boolean {
  return Boolean(comment?.hidden_at && (comment?.body === null || comment?.body === undefined))
}

export function hasHiddenReason(
  item?: { hidden_reason?: string | null } | null,
): item is { hidden_reason: string } {
  return typeof item?.hidden_reason === 'string' && item.hidden_reason.trim().length > 0
}

/**
 * Safely extract text from a post/comment body that may be null.
 */
export function getSafeBodyText(item?: { body?: string | null } | null): string {
  return typeof item?.body === 'string' ? item.body : ''
}

/**
 * Null-safe search matching across post title and body (and optional comments).
 */
export function matchesPostSearch(
  post?: {
    title?: string | null
    body?: string | null
    comments?: Array<{ body?: string | null }>
  } | null,
  query?: string | null,
): boolean {
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
 */
export function canCommentOnPost(
  post?: { comments_enabled?: boolean; hidden_at?: string | null } | null,
): boolean {
  if (!post) return false
  if (isPostHidden(post)) return false
  return post.comments_enabled !== false
}

/**
 * Whether the viewer is allowed to see hidden content (author or board/chairman).
 */
export function canViewerSeeHiddenContent(
  item?: { author_user_id?: string | null } | null,
  viewerUserId?: string | null,
  viewerRole?: string | null,
): boolean {
  if (isBoardRole(viewerRole)) return true
  return Boolean(viewerUserId) && item?.author_user_id === viewerUserId
}

export interface CommentLike {
  id?: string
  post_id?: string
  body?: string | null
  author_user_id?: string | null
  author_apartment_id?: string | null
  is_mine?: boolean
  created_at?: string
  edited_at?: string | null
  hidden_at?: string | null
  hidden_reason?: string | null
}

export interface PostLike {
  id?: string
  post_type?: string | null
  origin?: string | null
  author_user_id?: string | null
  author_apartment_id?: string | null
  is_mine?: boolean
  created_at?: string
  edited_at?: string | null
  hidden_at?: string | null
  hidden_reason?: string | null
  target_scope?: string | null
  target_entrance?: number | null
  target_apartment_ids?: string[] | null
  target_kinds?: string[] | null
  comments?: CommentLike[] | null
}

/**
 * Full post visibility check matching backend GET /communication/posts and GET /posts/:id rules.
 */
export function canViewerSeePost(
  post: PostLike | null | undefined,
  {
    viewerUserId,
    viewerRole,
    memberships,
  }: {
    viewerUserId?: string | null
    viewerRole?: string | null
    memberships?: Array<{
      apartment_id: string
      apartment_kind?: string
      since?: string
      entrance?: number | null
    }>
  } = {},
): boolean {
  if (!post) return false
  if (post.hidden_at && !canViewerSeeHiddenContent(post, viewerUserId, viewerRole)) {
    return false
  }
  if (post.post_type === 'BOARD_TOPIC') {
    return isBoardRole(viewerRole)
  }
  if (post.post_type === 'APARTMENT_THREAD') {
    if (isBoardRole(viewerRole)) return true
    const mems = Array.isArray(memberships) ? memberships : []
    const hasWrittenAsMember =
      Array.isArray(post.comments) &&
      post.comments.some(
        (c) => c.author_user_id === viewerUserId && c.author_apartment_id != null,
      )
    return mems.some(
      (m) =>
        post.target_apartment_ids?.includes(m.apartment_id) &&
        (new Date(m.since || 0).getTime() <= new Date(post.created_at || 0).getTime() ||
          (post.author_user_id === viewerUserId && post.author_apartment_id != null) ||
          hasWrittenAsMember),
    )
  }
  if (isBoardRole(viewerRole)) return true

  const scope = post.target_scope || 'ALL_BUILDING'
  const hasMembershipsArg = Array.isArray(memberships)
  const mems = hasMembershipsArg ? memberships : []

  if (viewerRole === 'ACCOUNTANT') {
    if (
      scope === 'ALL_BUILDING' ||
      scope === 'ALL_OBJECTS' ||
      (scope === 'KINDS' && Array.isArray(post.target_kinds) && post.target_kinds.includes('APARTMENT'))
    ) {
      return true
    }
    return mems.some((m) => isObjectInTarget(post, m))
  }

  if (!hasMembershipsArg) {
    if (scope === 'ALL_BUILDING' || scope === 'ALL_OBJECTS') return true
    return false
  }

  return mems.some((m) => isObjectInTarget(post, m))
}

export interface AuthorMembershipLike {
  apartment_id: string
  apartment_number?: string
  apartment_kind?: ObjectKind | string | null
  entrance?: number | null
  preview_badge?: AuthorBadgeDTO | { display_label: string; role_badge: string } | null
}

/**
 * Determine which target scopes and object kinds the caller can choose when starting
 * a `FORUM_TOPIC` (#067, docs/API.md §4):
 * - Board/Chairman: any scope (`ALL_BUILDING`, `ALL_OBJECTS`, `KINDS`, `ENTRANCE`, `APARTMENT_LIST`)
 *   and all non-zero kinds present in the building.
 * - Anyone else: `ALL_BUILDING` only if they hold an `APARTMENT`, plus `KINDS` restricted
 *   to the kinds they hold. `ALL_OBJECTS`, `ENTRANCE`, and `APARTMENT_LIST` are board-only.
 */
export function getAllowedForumTopicTargets({
  role,
  memberships = [],
  buildingKinds = ['APARTMENT'],
}: {
  role?: string | null
  memberships?: ReadonlyArray<AuthorMembershipLike> | null
  buildingKinds?: ReadonlyArray<ObjectKind> | null
}): {
  canCreate: boolean
  allowedScopes: TargetScope[]
  availableKinds: ObjectKind[]
  defaultScope: TargetScope
  defaultKinds: ObjectKind[] | null
} {
  const normalizedBuildingKinds = OBJECT_KINDS.filter((k) =>
    Array.isArray(buildingKinds) && buildingKinds.length > 0 ? buildingKinds.includes(k) : k === 'APARTMENT',
  )

  if (isBoardRole(role)) {
    return {
      canCreate: true,
      allowedScopes: ['ALL_BUILDING', 'ALL_OBJECTS', 'KINDS'],
      availableKinds: normalizedBuildingKinds.length > 0 ? normalizedBuildingKinds : ['APARTMENT'],
      defaultScope: 'ALL_BUILDING',
      defaultKinds: null,
    }
  }

  const heldSet = new Set<ObjectKind>()
  for (const m of Array.isArray(memberships) ? memberships : []) {
    if (m?.apartment_id) {
      heldSet.add(normalizeObjectKind(m.apartment_kind))
    }
  }
  const heldKinds = OBJECT_KINDS.filter((k) => heldSet.has(k))
  if (heldKinds.length === 0) {
    return {
      canCreate: false,
      allowedScopes: [],
      availableKinds: [],
      defaultScope: 'ALL_BUILDING',
      defaultKinds: null,
    }
  }

  const hasApartment = heldKinds.includes('APARTMENT')
  if (hasApartment) {
    return {
      canCreate: true,
      allowedScopes: ['ALL_BUILDING', 'KINDS'],
      availableKinds: heldKinds,
      defaultScope: 'ALL_BUILDING',
      defaultKinds: null,
    }
  }

  return {
    canCreate: true,
    allowedScopes: ['KINDS'],
    availableKinds: heldKinds,
    defaultScope: 'KINDS',
    defaultKinds: [heldKinds[0]],
  }
}

/**
 * Authorization check for `POST /communication/posts` with `post_type === 'FORUM_TOPIC'` (#067).
 * Must run BEFORE target validation (`422`) so unauthorized callers receive `403 FORBIDDEN`.
 */
export function canAuthorForumTopicTarget({
  role,
  memberships = [],
  targetScope,
  targetKinds,
}: {
  role?: string | null
  memberships?: ReadonlyArray<AuthorMembershipLike> | null
  targetScope: string
  targetKinds?: ReadonlyArray<string> | null
}): boolean {
  if (isBoardRole(role)) return true

  const heldSet = new Set<ObjectKind>()
  for (const m of Array.isArray(memberships) ? memberships : []) {
    if (m?.apartment_id) {
      heldSet.add(normalizeObjectKind(m.apartment_kind))
    }
  }
  if (heldSet.size === 0) return false

  if (targetScope === 'ALL_BUILDING') {
    return heldSet.has('APARTMENT')
  }
  if (targetScope === 'KINDS') {
    if (!Array.isArray(targetKinds) || targetKinds.length === 0) {
      // Caller holds at least one object; let target validation return 422 INVALID_TARGET
      return true
    }
    return targetKinds.every((k) => heldSet.has(String(k).toUpperCase() as ObjectKind))
  }
  // ALL_OBJECTS, ENTRANCE, APARTMENT_LIST (or anything else) on FORUM_TOPIC are board-only
  return false
}

/**
 * Filter caller's memberships to ONLY objects inside `target` (#067 privacy rule).
 * Never offers an out-of-target object (e.g. Apt 14 under a garage-only notice).
 */
export function getEligibleAuthorMemberships<T extends AuthorMembershipLike>(
  memberships: ReadonlyArray<T> | null | undefined,
  target: TargetScopeLike | null | undefined,
): T[] {
  if (!Array.isArray(memberships) || memberships.length === 0) return []
  return memberships.filter((m) => Boolean(m?.apartment_id) && isObjectInTarget(target, m))
}

/**
 * Resolve & validate `author_apartment_id` against a post's target (#067).
 * - Explicit ID outside caller's eligible memberships inside the target -> 422 INVALID_AUTHOR_APARTMENT.
 * - Omitted/null -> first eligible membership inside the target, or null (board/accountant without object in target).
 */
export function resolveAuthorApartmentForTarget({
  memberships = [],
  target,
  requestedApartmentId,
}: {
  memberships?: ReadonlyArray<AuthorMembershipLike> | null
  target: TargetScopeLike | null | undefined
  requestedApartmentId?: unknown
}):
  | { ok: true; apartmentId: string | null }
  | { ok: false; status: 422; errorCode: 'INVALID_AUTHOR_APARTMENT'; message: string } {
  const eligible = getEligibleAuthorMemberships(memberships, target)
  if (requestedApartmentId !== undefined && requestedApartmentId !== null && requestedApartmentId !== '') {
    const reqId = typeof requestedApartmentId === 'string' ? requestedApartmentId : ''
    const match = reqId ? eligible.find((m) => m.apartment_id === reqId) : null
    if (!match) {
      return {
        ok: false,
        status: 422,
        errorCode: 'INVALID_AUTHOR_APARTMENT',
        message: 'Selected object is not eligible to sign inside this post target.',
      }
    }
    return { ok: true, apartmentId: match.apartment_id }
  }
  return { ok: true, apartmentId: eligible[0]?.apartment_id ?? null }
}

/**
 * Project an internal stored comment into a CommentView, masking body & hidden_reason
 * to null when hidden and the viewer is neither the author nor the board.
 */
export function projectCommentForViewer(
  comment: CommentLike,
  {
    postId,
    viewerUserId,
    viewerRole,
    authorBadge,
  }: {
    postId?: string
    viewerUserId?: string | null
    viewerRole?: string | null
    authorBadge: AuthorBadgeDTO | { display_label: string; role_badge: string }
  },
): CommentView {
  const hidden = Boolean(comment?.hidden_at)
  const canSeeHidden = !hidden || canViewerSeeHiddenContent(comment, viewerUserId, viewerRole)
  return {
    id: comment.id ?? '',
    post_id: postId ?? comment.post_id ?? '',
    body: canSeeHidden ? (comment.body ?? '') : null,
    author_badge: authorBadge as AuthorBadgeDTO,
    is_mine: comment.author_user_id === viewerUserId,
    created_at: comment.created_at ?? '',
    edited_at: comment.edited_at || null,
    hidden_at: comment.hidden_at || null,
    hidden_reason: hidden && canSeeHidden ? comment.hidden_reason || null : null,
  }
}

/**
 * Format localized "Hidden by the board: <reason>" or fallback "Hidden by the board".
 */
export function formatHiddenByBoardBanner(
  item: { hidden_at?: string | null; hidden_reason?: string | null } | null | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (!item?.hidden_at) return ''
  if (hasHiddenReason(item)) {
    return t('forum.hiddenByBoardWithReason', { reason: item.hidden_reason.trim() })
  }
  return t('forum.hiddenByBoard')
}

export const HIDE_REASON_MAX_LENGTH = 500

/**
 * Reject ASCII control chars except HT (\t), LF (\n), CR (\r).
 */
export function hasDisallowedControlChars(value: unknown): boolean {
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
 */
export function canModerateForumForRole(role?: string | null): boolean {
  return isBoardRole(role)
}

/**
 * Only FORUM_TOPIC posts can be hidden or unhidden by the board (#028).
 */
export function isPostHideable(post?: { post_type?: string | null } | null): boolean {
  return post?.post_type === 'FORUM_TOPIC'
}

/**
 * Comments on FORUM_TOPIC, OFFICIAL_NOTICE, and EMERGENCY can be hidden or unhidden;
 * APARTMENT_THREAD and BOARD_TOPIC comments are never hideable (#028).
 */
export function isCommentHideableOnPost(
  postOrType?: { post_type?: string | null } | string | null,
): boolean {
  const postType = typeof postOrType === 'string' ? postOrType : postOrType?.post_type
  return (
    postType === 'FORUM_TOPIC' || postType === 'OFFICIAL_NOTICE' || postType === 'EMERGENCY'
  )
}

/**
 * Validate a hide moderation reason per backend contract (trimmed, 1..500 chars, plain text).
 */
export function validateHideReason(rawReason?: string | null): {
  valid: boolean
  reason: string
  error: 'REASON_REQUIRED' | 'REASON_TOO_LONG' | 'INVALID_CHARS' | null
} {
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
 */
export function mergeUpdatedPostIntoList<T extends { id?: string } = PostLike>(
  posts: T[],
  updatedPost: PostLike | null | undefined,
): T[] {
  if (!Array.isArray(posts) || !updatedPost?.id) return posts
  let changed = false
  const next = posts.map((p) => {
    if (p?.id !== updatedPost.id) return p
    changed = true
    return { ...p, ...updatedPost } as T
  })
  return changed ? next : posts
}

/**
 * Merge a returned PostView (which omits comments[]) into an open PostDetail without dropping comments.
 */
export function mergeUpdatedPostIntoDetail<T extends PostLike>(
  detail: T,
  updatedPost: PostLike,
): T & PostLike
export function mergeUpdatedPostIntoDetail<T extends PostLike>(
  detail: T | null | undefined,
  updatedPost: PostLike | null | undefined,
): (T & PostLike) | PostLike | null | undefined
export function mergeUpdatedPostIntoDetail<T extends PostLike>(
  detail: T | null | undefined,
  updatedPost: PostLike | null | undefined,
): (T & PostLike) | PostLike | null | undefined {
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
 */
export function replaceCommentInDetail<T extends PostLike>(
  detail: T,
  updatedComment: Partial<CommentLike>,
): T
export function replaceCommentInDetail<T extends PostLike>(
  detail: T | null | undefined,
  updatedComment: Partial<CommentLike> | null | undefined,
): T | null | undefined
export function replaceCommentInDetail<T extends PostLike>(
  detail: T | null | undefined,
  updatedComment: Partial<CommentLike> | null | undefined,
): T | null | undefined {
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
 */
export function getEditWindowDeadlineMs(createdAt?: string | null): number | null {
  if (typeof createdAt !== 'string' || !createdAt.trim()) return null
  const createdMs = Date.parse(createdAt)
  if (!Number.isFinite(createdMs)) return null
  return createdMs + EDIT_WINDOW_MS
}

/**
 * True strictly before created_at + 24 hours (#027).
 */
export function isWithinEditWindow(createdAt?: string | null, nowMs: number = Date.now()): boolean {
  const deadlineMs = getEditWindowDeadlineMs(createdAt)
  if (deadlineMs === null) return false
  return nowMs < deadlineMs
}

/**
 * Whether the caller can edit a post (#027).
 */
export function canEditPost(
  post: PostLike | null | undefined,
  nowMs: number = Date.now(),
  { serverClosed = false }: { serverClosed?: boolean } = {},
): boolean {
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
 * Whether the caller can edit a comment (#027).
 */
export function canEditComment(
  comment: CommentLike | null | undefined,
  post: PostLike | null | undefined,
  nowMs: number = Date.now(),
  { serverClosed = false }: { serverClosed?: boolean } = {},
): boolean {
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
 */
export function getNextEditExpiryDelayMs(
  post: PostLike | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!post) return null
  const candidates: number[] = []
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
 */
export function validatePostEdit(
  rawTitle?: string | null,
  rawBody?: string | null,
): {
  valid: boolean
  title: string
  body: string
  field: 'title' | 'body' | null
  error:
    | 'TITLE_REQUIRED'
    | 'TITLE_INVALID_CHARS'
    | 'TITLE_TOO_LONG'
    | 'BODY_REQUIRED'
    | 'BODY_INVALID_CHARS'
    | 'BODY_TOO_LONG'
    | null
} {
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
 */
export function buildPostEditPayload(
  originalPost: { title?: string | null; body?: string | null } | null | undefined,
  nextTitle: string,
  nextBody: string,
): PostEditRequest {
  const cleanTitle = typeof nextTitle === 'string' ? nextTitle.trim() : ''
  const cleanBody = typeof nextBody === 'string' ? nextBody.trim() : ''
  const origTitle = typeof originalPost?.title === 'string' ? originalPost.title.trim() : ''
  const origBody = typeof originalPost?.body === 'string' ? originalPost.body.trim() : ''
  const payload: PostEditRequest = {}
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
 */
export function validateCommentEdit(rawBody?: string | null): {
  valid: boolean
  body: string
  error: 'BODY_REQUIRED' | 'INVALID_CHARS' | 'BODY_TOO_LONG' | null
} {
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
