import {
  UNHANDLED,
  OFFLINE_APARTMENT_CARDS,
  OFFLINE_DEMO_USERS,
  OFFLINE_MEMBERSHIPS_BY_USER,
  OFFLINE_POSTS,
  getOfflineUserNotifications,
  makeOfflineError,
  dispatchMaintenanceAndNoticeNotifications,
} from './state.js'
import {
  COMMENT_BODY_MAX_LENGTH,
  POST_BODY_MAX_LENGTH,
  POST_TITLE_MAX_LENGTH,
  canAuthorForumTopicTarget,
  canViewerSeePost,
  getEditWindowDeadlineMs,
  hasDisallowedControlChars,
  isCommentHideableOnPost,
  isPostHideable,
  isWithinEditWindow,
  projectCommentForViewer,
  resolveAuthorApartmentForTarget,
  validateCommentEdit,
  validateHideReason,
} from '../../utils/communication.js'

const VALID_POST_TARGET_SCOPES = [
  'ALL_BUILDING',
  'ALL_OBJECTS',
  'KINDS',
  'ENTRANCE',
  'APARTMENT_LIST',
]

function getOfflineAvailableObjectKinds() {
  const kinds = new Set()
  for (const card of OFFLINE_APARTMENT_CARDS) {
    kinds.add(card.apartment_kind || 'APARTMENT')
  }
  return Array.from(kinds)
}

export async function handleOfflineCommunication(ctx) {
  const { urlObj, pathname, method, body, raw, user } = ctx

  // 9. GET /communication/emergencies/active
  if (pathname === '/communication/emergencies/active' && method === 'GET') {
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    return OFFLINE_POSTS.filter(
      (p) =>
        p.post_type === 'EMERGENCY' &&
        p.is_active &&
        canViewerSeePost(p, {
          viewerUserId: user.user_id,
          viewerRole: user.building_role,
          memberships: userMems,
        }),
    ).map((p) => ({
      id: p.id,
      post_type: p.post_type,
      category: p.category,
      title: p.title,
      body: p.body,
      author_badge: { ...p.author_badge },
      is_mine: p.author_user_id === user.user_id,
      target_scope: p.target_scope,
      target_entrance: p.target_entrance,
      target_apartment_ids: p.target_apartment_ids,
      target_kinds: p.target_kinds ?? null,
      is_active: p.is_active,
      comments_enabled: p.comments_enabled,
      comments_count: p.comments.length,
      created_at: p.created_at,
      last_activity_at:
        p.comments.length > 0 ? p.comments[p.comments.length - 1].created_at : p.created_at,
      acknowledged_at: p.acknowledged_at,
      origin: p.origin || null,
      edited_at: p.edited_at || null,
      hidden_at: p.hidden_at || null,
      hidden_reason: p.hidden_at ? p.hidden_reason || null : null,
    }))
  }

  // 10. GET & POST /communication/posts
  if (pathname === '/communication/posts' && method === 'GET') {
    const postType = urlObj.searchParams.get('post_type')
    const apartmentId = urlObj.searchParams.get('apartment_id')
    const category = urlObj.searchParams.get('category')
    const limit = Number(urlObj.searchParams.get('limit') || '20')
    const offset = Number(urlObj.searchParams.get('offset') || '0')
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const visibilityCtx = {
      viewerUserId: user.user_id,
      viewerRole: user.building_role,
      memberships: userMems,
    }

    if (apartmentId && postType !== 'APARTMENT_THREAD') {
      throw makeOfflineError(
        422,
        'VALIDATION_ERROR',
        'apartment_id filter is only valid with post_type=APARTMENT_THREAD.',
      )
    }

    let filtered = OFFLINE_POSTS.filter(
      (p) =>
        p.post_type !== 'EMERGENCY' &&
        p.post_type !== 'APARTMENT_THREAD' &&
        p.post_type !== 'BOARD_TOPIC' &&
        canViewerSeePost(p, visibilityCtx),
    )

    if (postType === 'APARTMENT_THREAD') {
      filtered = OFFLINE_POSTS.filter((p) => {
        if (p.post_type !== 'APARTMENT_THREAD') return false
        if (apartmentId && !p.target_apartment_ids?.includes(apartmentId)) return false
        return canViewerSeePost(p, visibilityCtx)
      })
      filtered.sort((a, b) => {
        const aLast =
          a.comments.length > 0 ? a.comments[a.comments.length - 1].created_at : a.created_at
        const bLast =
          b.comments.length > 0 ? b.comments[b.comments.length - 1].created_at : b.created_at
        return new Date(bLast).getTime() - new Date(aLast).getTime() || b.id.localeCompare(a.id)
      })
    } else if (postType === 'BOARD_TOPIC') {
      if (!isBoardUser) {
        throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
      }
      filtered = OFFLINE_POSTS.filter(
        (p) => p.post_type === 'BOARD_TOPIC' && canViewerSeePost(p, visibilityCtx),
      )
      filtered.sort((a, b) => {
        const aLast =
          a.comments.length > 0 ? a.comments[a.comments.length - 1].created_at : a.created_at
        const bLast =
          b.comments.length > 0 ? b.comments[b.comments.length - 1].created_at : b.created_at
        return new Date(bLast).getTime() - new Date(aLast).getTime() || b.id.localeCompare(a.id)
      })
    } else if (postType) {
      filtered = OFFLINE_POSTS.filter(
        (p) => p.post_type === postType && canViewerSeePost(p, visibilityCtx),
      )
      filtered.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
          b.id.localeCompare(a.id),
      )
    } else {
      filtered.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
          b.id.localeCompare(a.id),
      )
    }
    if (category) {
      filtered = filtered.filter((p) => p.category === category)
    }

    return filtered.slice(offset, offset + limit).map((p) => ({
      id: p.id,
      post_type: p.post_type,
      category: p.category,
      title: p.title,
      body: p.body,
      author_badge: { ...p.author_badge },
      is_mine: p.author_user_id === user.user_id,
      target_scope: p.target_scope,
      target_entrance: p.target_entrance,
      target_apartment_ids: p.target_apartment_ids,
      target_kinds: p.target_kinds ?? null,
      is_active: p.is_active,
      comments_enabled: p.comments_enabled,
      comments_count: p.comments.length,
      created_at: p.created_at,
      last_activity_at:
        p.comments.length > 0 ? p.comments[p.comments.length - 1].created_at : p.created_at,
      origin: p.origin || null,
      edited_at: p.edited_at || null,
      hidden_at: p.hidden_at || null,
      hidden_reason: p.hidden_at ? p.hidden_reason || null : null,
    }))
  }

  if (pathname === '/communication/posts' && method === 'POST') {
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const postType = reqBody.post_type || 'FORUM_TOPIC'
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    const hasControlChars = (str) => {
      for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i)
        if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
          return true
        }
      }
      return false
    }
    const cleanTitle = typeof reqBody.title === 'string' ? reqBody.title.trim() : ''
    const cleanBody = typeof reqBody.body === 'string' ? reqBody.body.trim() : ''
    if (!cleanTitle || !cleanBody || hasControlChars(cleanTitle) || hasControlChars(cleanBody)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Title and body must be non-empty plain text.')
    }
    if ((postType === 'OFFICIAL_NOTICE' || postType === 'EMERGENCY') && !isBoardUser) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only Board members can publish notices or emergencies.',
      )
    }
    if (postType === 'APARTMENT_THREAD') {
      if (reqBody.author_apartment_id !== undefined && reqBody.author_apartment_id !== null) {
        throw makeOfflineError(
          422,
          'INVALID_AUTHOR_APARTMENT',
          'author_apartment_id is not allowed on APARTMENT_THREAD.',
        )
      }
      if (reqBody.target_kinds != null) {
        throw makeOfflineError(
          422,
          'INVALID_TARGET',
          'target_kinds is not allowed on APARTMENT_THREAD.',
        )
      }
      const targetAptId = reqBody.target_apartment_ids?.[0]
      if (targetAptId === '018f0000-0000-7000-8000-000000000305') {
        throw makeOfflineError(
          422,
          'APARTMENT_HAS_NO_RESIDENTS',
          'This apartment has no registered residents yet.',
        )
      }
    }
    if (postType === 'BOARD_TOPIC') {
      if (!isBoardUser) {
        throw makeOfflineError(403, 'FORBIDDEN', 'Only Board members can publish board topics.')
      }
      if (reqBody.author_apartment_id !== undefined && reqBody.author_apartment_id !== null) {
        throw makeOfflineError(
          422,
          'INVALID_AUTHOR_APARTMENT',
          'author_apartment_id is not allowed on BOARD_TOPIC.',
        )
      }
      if (
        (reqBody.target_scope && reqBody.target_scope !== 'ALL_BUILDING') ||
        reqBody.target_entrance ||
        reqBody.target_apartment_ids ||
        reqBody.target_kinds
      ) {
        throw makeOfflineError(422, 'INVALID_TARGET', 'BOARD_TOPIC does not accept target fields.')
      }
    }

    const resolvedTargetScope =
      typeof reqBody.target_scope === 'string' && reqBody.target_scope
        ? reqBody.target_scope
        : 'ALL_BUILDING'
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []

    if (postType === 'FORUM_TOPIC') {
      const rawTargetKinds = Array.isArray(reqBody.target_kinds)
        ? reqBody.target_kinds.map((k) => String(k).toUpperCase())
        : null
      if (
        !canAuthorForumTopicTarget({
          role: user.building_role,
          memberships: userMems,
          targetScope: resolvedTargetScope,
          targetKinds: rawTargetKinds,
        })
      ) {
        throw makeOfflineError(
          403,
          'FORBIDDEN',
          'You are not allowed to publish a forum topic to this target.',
        )
      }
    }

    if (!VALID_POST_TARGET_SCOPES.includes(resolvedTargetScope)) {
      throw makeOfflineError(422, 'INVALID_TARGET', 'Invalid target_scope.')
    }

    let targetEntrance =
      typeof reqBody.target_entrance === 'number' ? reqBody.target_entrance : null
    let targetApartmentIds = Array.isArray(reqBody.target_apartment_ids)
      ? reqBody.target_apartment_ids.map(String)
      : null
    let targetKinds = null

    if (postType !== 'BOARD_TOPIC' && postType !== 'APARTMENT_THREAD') {
      const hasEntranceInput =
        reqBody.target_entrance !== undefined && reqBody.target_entrance !== null
      const hasApartmentListInput =
        Array.isArray(reqBody.target_apartment_ids) && reqBody.target_apartment_ids.length > 0
      const hasKindsInput = Array.isArray(reqBody.target_kinds) && reqBody.target_kinds.length > 0

      if (resolvedTargetScope === 'ALL_BUILDING' || resolvedTargetScope === 'ALL_OBJECTS') {
        if (hasEntranceInput || hasApartmentListInput || hasKindsInput) {
          throw makeOfflineError(
            422,
            'INVALID_TARGET',
            `target_entrance, target_apartment_ids, and target_kinds must be null for ${resolvedTargetScope}.`,
          )
        }
        targetEntrance = null
        targetApartmentIds = null
        targetKinds = null
      } else if (resolvedTargetScope === 'KINDS') {
        if (hasEntranceInput || hasApartmentListInput || !hasKindsInput) {
          throw makeOfflineError(
            422,
            'INVALID_TARGET',
            'Non-empty target_kinds is required for KINDS scope.',
          )
        }
        const availableKinds = getOfflineAvailableObjectKinds()
        const dedupedKinds = Array.from(
          new Set(reqBody.target_kinds.map((k) => String(k).toUpperCase())),
        )
        const unknownKinds = dedupedKinds.filter((k) => !availableKinds.includes(k))
        if (unknownKinds.length > 0) {
          throw makeOfflineError(422, 'INVALID_TARGET', 'Unknown object kind in target_kinds.', {
            unknown_kinds: unknownKinds,
          })
        }
        targetEntrance = null
        targetApartmentIds = null
        targetKinds = dedupedKinds
      } else if (resolvedTargetScope === 'ENTRANCE') {
        if (
          postType === 'FORUM_TOPIC' ||
          typeof targetEntrance !== 'number' ||
          !Number.isInteger(targetEntrance) ||
          hasApartmentListInput ||
          hasKindsInput
        ) {
          throw makeOfflineError(
            422,
            'INVALID_TARGET',
            postType === 'FORUM_TOPIC'
              ? 'Forum topics only support ALL_BUILDING, ALL_OBJECTS, or KINDS.'
              : 'Valid target_entrance is required for ENTRANCE scope.',
          )
        }
        targetApartmentIds = null
        targetKinds = null
      } else if (resolvedTargetScope === 'APARTMENT_LIST') {
        if (
          postType === 'FORUM_TOPIC' ||
          hasEntranceInput ||
          hasKindsInput ||
          !hasApartmentListInput
        ) {
          throw makeOfflineError(
            422,
            'INVALID_TARGET',
            postType === 'FORUM_TOPIC'
              ? 'Forum topics only support ALL_BUILDING, ALL_OBJECTS, or KINDS.'
              : 'Non-empty target_apartment_ids is required for APARTMENT_LIST scope.',
          )
        }
        targetEntrance = null
        targetKinds = null
      }
    }

    let resolvedAuthorAptId = null
    if (postType === 'BOARD_TOPIC') {
      resolvedAuthorAptId = null
    } else if (postType === 'APARTMENT_THREAD') {
      resolvedAuthorAptId = isBoardUser ? null : targetApartmentIds?.[0] || null
    } else if (
      (postType === 'OFFICIAL_NOTICE' || postType === 'EMERGENCY') &&
      !reqBody.author_apartment_id
    ) {
      resolvedAuthorAptId = null
    } else {
      const authorResolution = resolveAuthorApartmentForTarget({
        memberships: userMems,
        target: {
          target_scope: resolvedTargetScope,
          target_entrance: targetEntrance,
          target_apartment_ids: targetApartmentIds,
          target_kinds: targetKinds,
        },
        requestedApartmentId: reqBody.author_apartment_id,
      })
      if (!authorResolution.ok) {
        throw makeOfflineError(
          authorResolution.status,
          authorResolution.errorCode,
          authorResolution.message,
        )
      }
      resolvedAuthorAptId = authorResolution.apartmentId
    }

    const nowIso = new Date().toISOString()
    const boardFullNames = {
      '018f0000-0000-7000-8000-000000000101': 'Oleg Sidorov',
      '018f0000-0000-7000-8000-000000000105': 'Peeter Saar',
    }
    const matchedAuthorMem = resolvedAuthorAptId
      ? userMems.find((m) => m.apartment_id === resolvedAuthorAptId) || null
      : null
    const authorBadge =
      postType === 'BOARD_TOPIC'
        ? {
            display_label: boardFullNames[user.user_id] || user.full_name,
            role_badge: 'BOARD',
          }
        : postType === 'APARTMENT_THREAD' && isBoardUser
          ? {
              display_label: user.building_role === 'CHAIRMAN' ? 'Chairman' : 'Board',
              role_badge: 'BOARD',
            }
          : matchedAuthorMem?.preview_badge || {
              display_label:
                user.building_role === 'CHAIRMAN'
                  ? 'Chairman'
                  : user.building_role === 'BOARD'
                    ? 'Board'
                    : user.label,
              role_badge: isBoardUser
                ? 'BOARD'
                : user.building_role === 'ACCOUNTANT'
                  ? 'ACCOUNTANT'
                  : 'OWNER',
            }
    const created = {
      id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      post_type: postType,
      category: reqBody.category || 'GENERAL',
      title: cleanTitle,
      body: cleanBody,
      author_user_id: user.user_id,
      author_apartment_id: resolvedAuthorAptId,
      author_badge: authorBadge,
      target_scope: resolvedTargetScope,
      target_entrance: targetEntrance,
      target_apartment_ids: targetApartmentIds,
      target_kinds: targetKinds,
      is_active: true,
      comments_enabled: reqBody.comments_enabled !== false,
      created_at: nowIso,
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
      origin: null,
      comments: [],
    }
    OFFLINE_POSTS.unshift(created)
    if (created.post_type === 'OFFICIAL_NOTICE') {
      dispatchMaintenanceAndNoticeNotifications({
        event_type: 'NOTICE_PUBLISHED',
        subject_type: 'post',
        subject_id: created.id,
        target_scope: created.target_scope,
        target_entrance: created.target_entrance,
        target_apartment_ids: created.target_apartment_ids,
        target_kinds: created.target_kinds,
        author_user_id: user.user_id,
        created_at: nowIso,
      })
    }
    if (created.post_type === 'EMERGENCY') {
      for (const demoUser of OFFLINE_DEMO_USERS) {
        if (demoUser.user_id !== user.user_id) {
          const demoMems = OFFLINE_MEMBERSHIPS_BY_USER[demoUser.user_id] || []
          if (
            !canViewerSeePost(created, {
              viewerUserId: demoUser.user_id,
              viewerRole: demoUser.building_role,
              memberships: demoMems,
            })
          ) {
            continue
          }
          const list = getOfflineUserNotifications(demoUser.user_id)
          list.unshift({
            id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
            user_id: demoUser.user_id,
            event_type: 'EMERGENCY_PUBLISHED',
            subject_type: 'post',
            subject_id: created.id,
            params: {
              category: created.category,
              target_scope: created.target_scope,
              target_entrance: created.target_entrance,
              target_kinds: created.target_scope === 'KINDS' ? (created.target_kinds ?? []) : [],
            },
            created_at: nowIso,
            read_at: null,
          })
        }
      }
    }
    return {
      id: created.id,
      post_type: created.post_type,
      category: created.category,
      title: created.title,
      body: created.body,
      author_badge: { ...created.author_badge },
      is_mine: true,
      target_scope: created.target_scope,
      target_entrance: created.target_entrance,
      target_apartment_ids: created.target_apartment_ids,
      target_kinds: created.target_kinds ?? null,
      is_active: created.is_active,
      comments_enabled: created.comments_enabled,
      comments_count: 0,
      created_at: nowIso,
      last_activity_at: nowIso,
      origin: null,
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
    }
  }

  // 11. GET /communication/posts/:id & POST /communication/posts/:id/comments
  const postDetailMatch = pathname.match(/^\/communication\/posts\/([^/]+)$/)
  if (postDetailMatch && method === 'GET') {
    const post = OFFLINE_POSTS.find((p) => p.id === postDetailMatch[1])
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (
      !post ||
      !canViewerSeePost(post, {
        viewerUserId: user.user_id,
        viewerRole: user.building_role,
        memberships: userMems,
      })
    ) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    const rawLimit = Number(urlObj.searchParams.get('comments_limit') || '200')
    const commentsLimit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 200
    const rawOffset = Number(urlObj.searchParams.get('comments_offset') || '0')
    const commentsOffset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0
    const pagedComments = post.comments.slice(commentsOffset, commentsOffset + commentsLimit)
    return {
      id: post.id,
      post_type: post.post_type,
      category: post.category,
      title: post.title,
      body: post.body,
      author_badge: { ...post.author_badge },
      is_mine: post.author_user_id === user.user_id,
      target_scope: post.target_scope,
      target_entrance: post.target_entrance,
      target_apartment_ids: post.target_apartment_ids,
      target_kinds: post.target_kinds ?? null,
      is_active: post.is_active,
      comments_enabled: post.comments_enabled,
      comments_count: post.comments.length,
      created_at: post.created_at,
      last_activity_at:
        post.comments.length > 0
          ? post.comments[post.comments.length - 1].created_at
          : post.created_at,
      origin: post.origin || null,
      edited_at: post.edited_at || null,
      hidden_at: post.hidden_at || null,
      hidden_reason: post.hidden_at ? post.hidden_reason || null : null,
      comments: pagedComments.map((c) =>
        projectCommentForViewer(c, {
          postId: post.id,
          viewerUserId: user.user_id,
          viewerRole: user.building_role,
          authorBadge: { ...c.author_badge },
        }),
      ),
    }
  }

  if (postDetailMatch && method === 'DELETE') {
    const idx = OFFLINE_POSTS.findIndex((p) => p.id === postDetailMatch[1])
    if (idx === -1) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    const targetPost = OFFLINE_POSTS[idx]
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    if (!isBoardUser) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only Board members can delete topics.')
    }
    if (targetPost.post_type !== 'FORUM_TOPIC' && targetPost.post_type !== 'BOARD_TOPIC') {
      throw makeOfflineError(409, 'POST_NOT_DELETABLE', 'This post cannot be deleted.', {
        post_type: targetPost.post_type,
      })
    }
    OFFLINE_POSTS.splice(idx, 1)
    return null
  }

  const commentPostMatch = pathname.match(/^\/communication\/posts\/([^/]+)\/comments$/)
  if (commentPostMatch && method === 'POST') {
    const post = OFFLINE_POSTS.find((p) => p.id === commentPostMatch[1])
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (
      !post ||
      !canViewerSeePost(post, {
        viewerUserId: user.user_id,
        viewerRole: user.building_role,
        memberships: userMems,
      })
    ) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    if (post.hidden_at) {
      throw makeOfflineError(409, 'POST_HIDDEN', 'Cannot comment on a hidden post.')
    }
    if (!post.comments_enabled) {
      throw makeOfflineError(409, 'COMMENTS_DISABLED', 'Comments are disabled on this post.')
    }
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const hasControlChars = (str) => {
      for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i)
        if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
          return true
        }
      }
      return false
    }
    const cleanCommentBody = typeof reqBody.body === 'string' ? reqBody.body.trim() : ''
    if (!cleanCommentBody || hasControlChars(cleanCommentBody)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Comment body must be non-empty plain text.')
    }
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    let resolvedCommentAptId = null
    if (post.post_type === 'APARTMENT_THREAD' || post.post_type === 'BOARD_TOPIC') {
      if (reqBody.author_apartment_id !== undefined && reqBody.author_apartment_id !== null) {
        throw makeOfflineError(
          422,
          'INVALID_AUTHOR_APARTMENT',
          'author_apartment_id is not allowed on this thread.',
        )
      }
      resolvedCommentAptId =
        post.post_type === 'APARTMENT_THREAD'
          ? isBoardUser
            ? null
            : post.target_apartment_ids?.[0] || null
          : null
    } else {
      const authorResolution = resolveAuthorApartmentForTarget({
        memberships: userMems,
        target: post,
        requestedApartmentId: reqBody.author_apartment_id,
      })
      if (!authorResolution.ok) {
        throw makeOfflineError(
          authorResolution.status,
          authorResolution.errorCode,
          authorResolution.message,
        )
      }
      resolvedCommentAptId = authorResolution.apartmentId
    }
    const boardFullNames = {
      '018f0000-0000-7000-8000-000000000101': 'Oleg Sidorov',
      '018f0000-0000-7000-8000-000000000105': 'Peeter Saar',
    }
    const matchedCommentMem = resolvedCommentAptId
      ? userMems.find((m) => m.apartment_id === resolvedCommentAptId) || null
      : null
    const authorBadge =
      post.post_type === 'BOARD_TOPIC'
        ? {
            display_label: boardFullNames[user.user_id] || user.full_name,
            role_badge: 'BOARD',
          }
        : post.post_type === 'APARTMENT_THREAD' && isBoardUser
          ? {
              display_label: user.building_role === 'CHAIRMAN' ? 'Chairman' : 'Board',
              role_badge: 'BOARD',
            }
          : matchedCommentMem?.preview_badge || {
              display_label:
                user.building_role === 'CHAIRMAN'
                  ? 'Chairman'
                  : user.building_role === 'BOARD'
                    ? 'Board'
                    : user.label,
              role_badge: isBoardUser
                ? 'BOARD'
                : user.building_role === 'ACCOUNTANT'
                  ? 'ACCOUNTANT'
                  : 'OWNER',
            }
    const newComment = {
      id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      post_id: post.id,
      body: cleanCommentBody,
      author_user_id: user.user_id,
      author_apartment_id: resolvedCommentAptId,
      author_badge: authorBadge,
      created_at: new Date().toISOString(),
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
    }
    post.comments.push(newComment)
    return projectCommentForViewer(newComment, {
      postId: post.id,
      viewerUserId: user.user_id,
      viewerRole: user.building_role,
      authorBadge: { ...authorBadge },
    })
  }

  // 11b. POST /communication/posts/:id/hide & /unhide (#028)
  const safeDecodePathParam = (raw) => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return null
    }
  }
  const postHideMatch = pathname.match(/^\/communication\/posts\/([^/]+)\/(hide|unhide)$/)
  if (postHideMatch && method === 'POST') {
    const postId = safeDecodePathParam(postHideMatch[1])
    const action = postHideMatch[2]
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    if (!isBoardUser) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only Board members can moderate forum topics.')
    }
    const post = postId ? OFFLINE_POSTS.find((p) => p.id === postId) : null
    if (!post) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    if (!isPostHideable(post)) {
      throw makeOfflineError(409, 'POST_NOT_HIDEABLE', 'This post cannot be hidden.', {
        post_type: post.post_type,
      })
    }
    if (action === 'hide') {
      let reqBody = {}
      if (typeof body === 'string') {
        try {
          reqBody = JSON.parse(body || '{}')
        } catch {
          throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid request payload.')
        }
      } else if (body && typeof body === 'object') {
        reqBody = body
      }
      const check = validateHideReason(reqBody?.reason)
      if (!check.valid) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          'Hide reason must be 1 to 500 plain-text characters.',
        )
      }
      if (!post.hidden_at) {
        post.hidden_at = new Date().toISOString()
        post.hidden_reason = check.reason
        post.hidden_by_user_id = user.user_id
      }
    } else {
      post.hidden_at = null
      post.hidden_reason = null
      post.hidden_by_user_id = null
    }
    return {
      id: post.id,
      post_type: post.post_type,
      category: post.category,
      title: post.title,
      body: post.body,
      author_badge: { ...post.author_badge },
      is_mine: post.author_user_id === user.user_id,
      target_scope: post.target_scope,
      target_entrance: post.target_entrance,
      target_apartment_ids: post.target_apartment_ids,
      target_kinds: post.target_kinds ?? null,
      is_active: post.is_active,
      comments_enabled: post.comments_enabled,
      comments_count: post.comments.length,
      created_at: post.created_at,
      last_activity_at:
        post.comments.length > 0
          ? post.comments[post.comments.length - 1].created_at
          : post.created_at,
      origin: post.origin || null,
      edited_at: post.edited_at || null,
      hidden_at: post.hidden_at || null,
      hidden_reason: post.hidden_at ? post.hidden_reason || null : null,
    }
  }

  // 11c. POST /communication/posts/:id/comments/:commentId/hide & /unhide (#028)
  const commentHideMatch = pathname.match(
    /^\/communication\/posts\/([^/]+)\/comments\/([^/]+)\/(hide|unhide)$/,
  )
  if (commentHideMatch && method === 'POST') {
    const postId = safeDecodePathParam(commentHideMatch[1])
    const commentId = safeDecodePathParam(commentHideMatch[2])
    const action = commentHideMatch[3]
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    if (!isBoardUser) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only Board members can moderate comments.')
    }
    const post = postId ? OFFLINE_POSTS.find((p) => p.id === postId) : null
    if (!post) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    if (!isCommentHideableOnPost(post)) {
      throw makeOfflineError(
        409,
        'COMMENT_NOT_HIDEABLE',
        'Comments on this post cannot be hidden.',
        { post_type: post.post_type },
      )
    }
    const comment = commentId ? post.comments.find((c) => c.id === commentId) : null
    if (!comment) {
      throw makeOfflineError(404, 'COMMENT_NOT_FOUND', 'Comment not found.')
    }
    if (action === 'hide') {
      let reqBody = {}
      if (typeof body === 'string') {
        try {
          reqBody = JSON.parse(body || '{}')
        } catch {
          throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid request payload.')
        }
      } else if (body && typeof body === 'object') {
        reqBody = body
      }
      const check = validateHideReason(reqBody?.reason)
      if (!check.valid) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          'Hide reason must be 1 to 500 plain-text characters.',
        )
      }
      if (!comment.hidden_at) {
        comment.hidden_at = new Date().toISOString()
        comment.hidden_reason = check.reason
        comment.hidden_by_user_id = user.user_id
      }
    } else {
      comment.hidden_at = null
      comment.hidden_reason = null
      comment.hidden_by_user_id = null
    }
    return projectCommentForViewer(comment, {
      postId: post.id,
      viewerUserId: user.user_id,
      viewerRole: user.building_role,
      authorBadge: { ...comment.author_badge },
    })
  }

  // 11d. PATCH /communication/posts/:id & /communication/posts/:id/comments/:commentId (#027)
  const postEditMatch = pathname.match(/^\/communication\/posts\/([^/]+)$/)
  if (postEditMatch && method === 'PATCH') {
    const postId = safeDecodePathParam(postEditMatch[1])
    const post = postId ? OFFLINE_POSTS.find((p) => p.id === postId) : null
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (
      !post ||
      !canViewerSeePost(post, {
        viewerUserId: user.user_id,
        viewerRole: user.building_role,
        memberships: userMems,
      })
    ) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    if (post.author_user_id !== user.user_id) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only the author can edit this post.')
    }
    if (
      (post.post_type !== 'FORUM_TOPIC' && post.post_type !== 'BOARD_TOPIC') ||
      post.origin != null ||
      post.hidden_at
    ) {
      throw makeOfflineError(409, 'POST_NOT_EDITABLE', 'This post cannot be edited.', {
        post_type: post.post_type,
      })
    }
    if (post.post_type === 'FORUM_TOPIC') {
      const now = Date.now()
      if (!isWithinEditWindow(post.created_at, now)) {
        const deadlineMs = getEditWindowDeadlineMs(post.created_at)
        throw makeOfflineError(409, 'EDIT_WINDOW_CLOSED', 'The 24-hour edit window has closed.', {
          editable_until:
            deadlineMs !== null ? new Date(deadlineMs).toISOString() : post.created_at,
        })
      }
    }
    let reqBody = null
    if (typeof body === 'string') {
      try {
        reqBody = JSON.parse(body || 'null')
      } catch {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid request payload.')
      }
    } else if (body && typeof body === 'object' && !Array.isArray(body)) {
      reqBody = body
    }
    if (!reqBody || typeof reqBody !== 'object' || Array.isArray(reqBody)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Request body must be a JSON object.')
    }
    const keys = Object.keys(reqBody)
    if (keys.length === 0 || keys.some((k) => k !== 'title' && k !== 'body')) {
      throw makeOfflineError(
        422,
        'VALIDATION_ERROR',
        'Provide title and/or body without unknown fields.',
      )
    }
    let nextTitle = post.title
    let nextBody = post.body
    if ('title' in reqBody) {
      if (typeof reqBody.title !== 'string') {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Title must be a string.')
      }
      const trimmedTitle = reqBody.title.trim()
      if (
        !trimmedTitle ||
        trimmedTitle.length > POST_TITLE_MAX_LENGTH ||
        hasDisallowedControlChars(trimmedTitle)
      ) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          `Title must be 1 to ${POST_TITLE_MAX_LENGTH} plain-text characters.`,
        )
      }
      nextTitle = trimmedTitle
    }
    if ('body' in reqBody) {
      if (typeof reqBody.body !== 'string') {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Body must be a string.')
      }
      const trimmedBody = reqBody.body.trim()
      if (
        !trimmedBody ||
        trimmedBody.length > POST_BODY_MAX_LENGTH ||
        hasDisallowedControlChars(trimmedBody)
      ) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          `Body must be 1 to ${POST_BODY_MAX_LENGTH} plain-text characters.`,
        )
      }
      nextBody = trimmedBody
    }
    if (nextTitle !== post.title || nextBody !== post.body) {
      post.title = nextTitle
      post.body = nextBody
      post.edited_at = new Date().toISOString()
    }
    return {
      id: post.id,
      post_type: post.post_type,
      category: post.category,
      title: post.title,
      body: post.body,
      author_badge: { ...post.author_badge },
      is_mine: post.author_user_id === user.user_id,
      target_scope: post.target_scope,
      target_entrance: post.target_entrance,
      target_apartment_ids: post.target_apartment_ids,
      target_kinds: post.target_kinds ?? null,
      is_active: post.is_active,
      comments_enabled: post.comments_enabled,
      comments_count: post.comments.length,
      created_at: post.created_at,
      last_activity_at:
        post.comments.length > 0
          ? post.comments[post.comments.length - 1].created_at
          : post.created_at,
      origin: post.origin || null,
      edited_at: post.edited_at || null,
      hidden_at: post.hidden_at || null,
      hidden_reason: post.hidden_at ? post.hidden_reason || null : null,
    }
  }

  const commentEditMatch = pathname.match(
    /^\/communication\/posts\/([^/]+)\/comments\/([^/]+)$/,
  )
  if (commentEditMatch && method === 'PATCH') {
    const postId = safeDecodePathParam(commentEditMatch[1])
    const commentId = safeDecodePathParam(commentEditMatch[2])
    const post = postId ? OFFLINE_POSTS.find((p) => p.id === postId) : null
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (
      !post ||
      !canViewerSeePost(post, {
        viewerUserId: user.user_id,
        viewerRole: user.building_role,
        memberships: userMems,
      })
    ) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    const comment = commentId ? post.comments.find((c) => c.id === commentId) : null
    if (!comment) {
      throw makeOfflineError(404, 'COMMENT_NOT_FOUND', 'Comment not found.')
    }
    if (comment.author_user_id !== user.user_id) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only the author can edit this comment.')
    }
    const editablePostType =
      post.post_type === 'FORUM_TOPIC' ||
      post.post_type === 'BOARD_TOPIC' ||
      post.post_type === 'OFFICIAL_NOTICE' ||
      post.post_type === 'EMERGENCY'
    if (!editablePostType || post.origin != null || post.hidden_at || comment.hidden_at) {
      throw makeOfflineError(409, 'COMMENT_NOT_EDITABLE', 'This comment cannot be edited.')
    }
    const now = Date.now()
    if (!isWithinEditWindow(comment.created_at, now)) {
      const deadlineMs = getEditWindowDeadlineMs(comment.created_at)
      throw makeOfflineError(409, 'EDIT_WINDOW_CLOSED', 'The 24-hour edit window has closed.', {
        editable_until:
          deadlineMs !== null ? new Date(deadlineMs).toISOString() : comment.created_at,
      })
    }
    let reqBody = null
    if (typeof body === 'string') {
      try {
        reqBody = JSON.parse(body || 'null')
      } catch {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid request payload.')
      }
    } else if (body && typeof body === 'object' && !Array.isArray(body)) {
      reqBody = body
    }
    if (!reqBody || typeof reqBody !== 'object' || Array.isArray(reqBody)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Request body must be a JSON object.')
    }
    const keys = Object.keys(reqBody)
    if (keys.length !== 1 || keys[0] !== 'body' || typeof reqBody.body !== 'string') {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Comment body is required without unknown fields.')
    }
    const check = validateCommentEdit(reqBody.body)
    if (!check.valid) {
      throw makeOfflineError(
        422,
        'VALIDATION_ERROR',
        `Comment body must be 1 to ${COMMENT_BODY_MAX_LENGTH} plain-text characters.`,
      )
    }
    if (check.body !== comment.body) {
      comment.body = check.body
      comment.edited_at = new Date().toISOString()
    }
    return projectCommentForViewer(comment, {
      postId: post.id,
      viewerUserId: user.user_id,
      viewerRole: user.building_role,
      authorBadge: { ...comment.author_badge },
    })
  }


  const ackMatch = pathname.match(/^\/communication\/emergencies\/([^/]+)\/acknowledge$/)
  if (ackMatch && method === 'POST') {
    return {
      post_id: ackMatch[1],
      acknowledged_at: new Date().toISOString(),
    }
  }

  const resolveMatch = pathname.match(/^\/communication\/emergencies\/([^/]+)\/resolve$/)
  if (resolveMatch && method === 'POST') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only Board members can resolve emergencies.')
    }
    const post = OFFLINE_POSTS.find((p) => p.id === resolveMatch[1])
    if (!post) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Emergency alert not found.')
    }
    post.is_active = false
    for (const demoUser of OFFLINE_DEMO_USERS) {
      if (demoUser.user_id !== user.user_id) {
        const demoMems = OFFLINE_MEMBERSHIPS_BY_USER[demoUser.user_id] || []
        if (
          !canViewerSeePost(post, {
            viewerUserId: demoUser.user_id,
            viewerRole: demoUser.building_role,
            memberships: demoMems,
          })
        ) {
          continue
        }
        const list = getOfflineUserNotifications(demoUser.user_id)
        list.unshift({
          id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
          user_id: demoUser.user_id,
          event_type: 'EMERGENCY_RESOLVED',
          subject_type: 'post',
          subject_id: post.id,
          params: {
            category: post.category,
            target_scope: post.target_scope,
            target_entrance: post.target_entrance,
            target_kinds: post.target_scope === 'KINDS' ? (post.target_kinds ?? []) : [],
          },
          created_at: new Date().toISOString(),
          read_at: null,
        })
      }
    }
    return {
      post_id: post.id,
      is_active: false,
    }
  }


  return UNHANDLED
}
