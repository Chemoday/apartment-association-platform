import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPostEditPayload,
  canAuthorForumTopicTarget,
  canCommentOnPost,
  canDeleteForumTopicForRole,
  canEditComment,
  canEditPost,
  canModerateForumForRole,
  canViewerSeeHiddenContent,
  canViewerSeePost,
  COMMENT_BODY_MAX_LENGTH,
  EDIT_WINDOW_MS,
  formatHiddenByBoardBanner,
  getAllowedForumTopicTargets,
  getEditWindowDeadlineMs,
  getEligibleAuthorMemberships,
  getNextEditExpiryDelayMs,
  getSafeBodyText,
  HIDE_REASON_MAX_LENGTH,
  isBoardRole,
  isCommentHideableOnPost,
  isCommentHidden,
  isCommentRedacted,
  isPostHideable,
  isPostHidden,
  isWithinEditWindow,
  matchesPostSearch,
  mergeUpdatedPostIntoDetail,
  mergeUpdatedPostIntoList,
  POST_BODY_MAX_LENGTH,
  POST_TITLE_MAX_LENGTH,
  projectCommentForViewer,
  replaceCommentInDetail,
  resolveAuthorApartmentForTarget,
  validateCommentEdit,
  validateHideReason,
  validatePostEdit,
} from './communication.js'

test('board role and forum topic delete checks match #026 rules', () => {
  assert.equal(isBoardRole('CHAIRMAN'), true)
  assert.equal(isBoardRole('BOARD'), true)
  assert.equal(isBoardRole('ACCOUNTANT'), false)
  assert.equal(isBoardRole('USER'), false)
  assert.equal(isBoardRole(null), false)

  assert.equal(canDeleteForumTopicForRole('CHAIRMAN'), true)
  assert.equal(canDeleteForumTopicForRole('BOARD'), true)
  assert.equal(canDeleteForumTopicForRole('ACCOUNTANT'), false)
  assert.equal(canDeleteForumTopicForRole('USER'), false)
})

test('null-safe comment and post helpers never throw when comment.body is null', () => {
  const redactedComment = {
    id: 'c1',
    body: null,
    hidden_at: '2026-10-21T12:10:00Z',
    hidden_reason: null,
  }
  assert.equal(isCommentHidden(redactedComment), true)
  assert.equal(isCommentRedacted(redactedComment), true)
  assert.equal(getSafeBodyText(redactedComment), '')

  const visibleHiddenComment = {
    id: 'c2',
    body: 'Offensive comment text',
    hidden_at: '2026-10-21T12:10:00Z',
    hidden_reason: 'Breaks house rules',
  }
  assert.equal(isCommentHidden(visibleHiddenComment), true)
  assert.equal(isCommentRedacted(visibleHiddenComment), false)
  assert.equal(getSafeBodyText(visibleHiddenComment), 'Offensive comment text')

  const normalComment = {
    id: 'c3',
    body: 'Hello neighbors',
    hidden_at: null,
    hidden_reason: null,
  }
  assert.equal(isCommentHidden(normalComment), false)
  assert.equal(isCommentRedacted(normalComment), false)

  const postWithNullBodyAndRedactedComment = {
    title: 'Bicycle racks',
    body: null,
    comments: [redactedComment, normalComment],
  }
  assert.equal(matchesPostSearch(postWithNullBodyAndRedactedComment, ''), true)
  assert.equal(matchesPostSearch(postWithNullBodyAndRedactedComment, 'bicycle'), true)
  assert.equal(matchesPostSearch(postWithNullBodyAndRedactedComment, 'neighbors'), true)
  assert.equal(matchesPostSearch(postWithNullBodyAndRedactedComment, 'missing'), false)
})

test('hidden post visibility, commenting, and comment projection respect author & board boundaries', () => {
  const authorId = 'user-author'
  const otherResidentId = 'user-other'
  const boardId = 'user-board'
  const chairmanId = 'user-chairman'
  const accountantId = 'user-accountant'

  const hiddenPost = {
    id: 'p1',
    post_type: 'FORUM_TOPIC',
    author_user_id: authorId,
    comments_enabled: true,
    hidden_at: '2026-10-22T10:00:00Z',
    hidden_reason: 'Spam links are not allowed',
  }
  assert.equal(isPostHidden(hiddenPost), true)
  assert.equal(canCommentOnPost(hiddenPost), false)
  assert.equal(canCommentOnPost({ comments_enabled: true, hidden_at: null }), true)
  assert.equal(canCommentOnPost({ comments_enabled: false, hidden_at: null }), false)

  assert.equal(canViewerSeePost(hiddenPost, { viewerUserId: authorId, viewerRole: 'USER' }), true)
  assert.equal(canViewerSeePost(hiddenPost, { viewerUserId: boardId, viewerRole: 'BOARD' }), true)
  assert.equal(canViewerSeePost(hiddenPost, { viewerUserId: chairmanId, viewerRole: 'CHAIRMAN' }), true)
  assert.equal(canViewerSeePost(hiddenPost, { viewerUserId: otherResidentId, viewerRole: 'USER' }), false)
  assert.equal(canViewerSeePost(hiddenPost, { viewerUserId: accountantId, viewerRole: 'ACCOUNTANT' }), false)

  const internalComment = {
    id: 'c1',
    post_id: 'p2',
    body: 'Hidden rude text',
    author_user_id: authorId,
    created_at: '2026-10-21T11:40:00Z',
    edited_at: null,
    hidden_at: '2026-10-21T12:10:00Z',
    hidden_reason: 'Personal attacks violate house rules',
    hidden_by_user_id: boardId,
  }
  const badge = { display_label: 'Apt 02', role_badge: 'RESIDENT' }

  const forOtherResident = projectCommentForViewer(internalComment, {
    viewerUserId: otherResidentId,
    viewerRole: 'USER',
    authorBadge: badge,
  })
  assert.equal(forOtherResident.body, null)
  assert.equal(forOtherResident.hidden_at, '2026-10-21T12:10:00Z')
  assert.equal(forOtherResident.hidden_reason, null)
  assert.equal('hidden_by_user_id' in forOtherResident, false)

  const forAccountant = projectCommentForViewer(internalComment, {
    viewerUserId: accountantId,
    viewerRole: 'ACCOUNTANT',
    authorBadge: badge,
  })
  assert.equal(forAccountant.body, null)
  assert.equal(forAccountant.hidden_reason, null)

  const forAuthor = projectCommentForViewer(internalComment, {
    viewerUserId: authorId,
    viewerRole: 'USER',
    authorBadge: badge,
  })
  assert.equal(forAuthor.body, 'Hidden rude text')
  assert.equal(forAuthor.hidden_reason, 'Personal attacks violate house rules')
  assert.equal(forAuthor.is_mine, true)

  const forBoard = projectCommentForViewer(internalComment, {
    viewerUserId: boardId,
    viewerRole: 'BOARD',
    authorBadge: badge,
  })
  assert.equal(forBoard.body, 'Hidden rude text')
  assert.equal(forBoard.hidden_reason, 'Personal attacks violate house rules')
  assert.equal(forBoard.is_mine, false)
  assert.equal(canViewerSeeHiddenContent(internalComment, boardId, 'BOARD'), true)
})

test('formatHiddenByBoardBanner handles missing or blank hidden_reason gracefully', () => {
  const t = (key: string, params?: Record<string, any>) =>
    key === 'forum.hiddenByBoardWithReason'
      ? `Hidden by the board: ${params?.reason}`
      : 'Hidden by the board'

  assert.equal(formatHiddenByBoardBanner({ hidden_at: null }, t), '')
  assert.equal(
    formatHiddenByBoardBanner({ hidden_at: '2026-10-21T12:10:00Z', hidden_reason: null }, t),
    'Hidden by the board',
  )
  assert.equal(
    formatHiddenByBoardBanner({ hidden_at: '2026-10-21T12:10:00Z', hidden_reason: '   ' }, t),
    'Hidden by the board',
  )
  assert.equal(
    formatHiddenByBoardBanner({ hidden_at: '2026-10-21T12:10:00Z', hidden_reason: ' Off-topic ' }, t),
    'Hidden by the board: Off-topic',
  )
})

test('canViewerSeePost enforces APARTMENT_THREAD history rules and ENTRANCE/APARTMENT_LIST scopes', () => {
  const userId = 'u-resident'
  const otherId = 'u-other'
  const memberships = [{ apartment_id: 'apt-14', entrance: 2, since: '2026-10-10T00:00:00Z' }]

  // Old APARTMENT_THREAD before membership.since: hidden unless authored as member or commented as member
  const oldThreadNoWrite = {
    id: 't1',
    post_type: 'APARTMENT_THREAD',
    author_user_id: otherId,
    author_apartment_id: null,
    target_apartment_ids: ['apt-14'],
    created_at: '2026-10-01T00:00:00Z',
    comments: [
      // Board comment without author_apartment_id (or undefined) must NOT grant historical access
      { author_user_id: userId, author_apartment_id: undefined },
      { author_user_id: userId, author_apartment_id: null },
    ],
  }
  assert.equal(
    canViewerSeePost(oldThreadNoWrite, { viewerUserId: userId, viewerRole: 'USER', memberships }),
    false,
  )

  // Same user authored post BEFORE membership.since with author_apartment_id undefined -> false
  const preLeaseBoardAuthoredSameUser = {
    ...oldThreadNoWrite,
    author_user_id: userId,
    author_apartment_id: undefined,
  }
  assert.equal(
    canViewerSeePost(preLeaseBoardAuthoredSameUser, {
      viewerUserId: userId,
      viewerRole: 'USER',
      memberships,
    }),
    false,
  )

  // Commented as apartment member -> grants access even if thread predated membership.since
  const oldThreadWithMemberComment = {
    ...oldThreadNoWrite,
    comments: [{ author_user_id: userId, author_apartment_id: 'apt-14' }],
  }
  assert.equal(
    canViewerSeePost(oldThreadWithMemberComment, {
      viewerUserId: userId,
      viewerRole: 'USER',
      memberships,
    }),
    true,
  )

  // ENTRANCE and APARTMENT_LIST scope filtering for residents vs board
  const entrancePost = {
    id: 'p-ent-1',
    post_type: 'OFFICIAL_NOTICE',
    target_scope: 'ENTRANCE',
    target_entrance: 1,
  }
  assert.equal(
    canViewerSeePost(entrancePost, { viewerUserId: userId, viewerRole: 'USER', memberships }),
    false,
  )
  assert.equal(
    canViewerSeePost(
      { ...entrancePost, target_entrance: 2 },
      { viewerUserId: userId, viewerRole: 'USER', memberships },
    ),
    true,
  )
  assert.equal(
    canViewerSeePost(entrancePost, { viewerUserId: 'u-board', viewerRole: 'BOARD', memberships: [] }),
    true,
  )

  const aptListPost = {
    id: 'p-apt-list',
    post_type: 'EMERGENCY',
    target_scope: 'APARTMENT_LIST',
    target_apartment_ids: ['apt-99'],
  }
  assert.equal(
    canViewerSeePost(aptListPost, { viewerUserId: userId, viewerRole: 'USER', memberships }),
    false,
  )
  assert.equal(
    canViewerSeePost(
      { ...aptListPost, target_apartment_ids: ['apt-14'] },
      { viewerUserId: userId, viewerRole: 'USER', memberships },
    ),
    true,
  )
})

test('#028 moderation permissions, type gates, reason validation, and immutable state merges', () => {
  assert.equal(canModerateForumForRole('CHAIRMAN'), true)
  assert.equal(canModerateForumForRole('BOARD'), true)
  assert.equal(canModerateForumForRole('ACCOUNTANT'), false)
  assert.equal(canModerateForumForRole('USER'), false)
  assert.equal(canModerateForumForRole(null), false)

  assert.equal(isPostHideable({ post_type: 'FORUM_TOPIC' }), true)
  assert.equal(isPostHideable({ post_type: 'OFFICIAL_NOTICE' }), false)
  assert.equal(isPostHideable({ post_type: 'EMERGENCY' }), false)
  assert.equal(isPostHideable({ post_type: 'BOARD_TOPIC' }), false)
  assert.equal(isPostHideable({ post_type: 'APARTMENT_THREAD' }), false)
  assert.equal(isPostHideable(null), false)

  assert.equal(isCommentHideableOnPost('FORUM_TOPIC'), true)
  assert.equal(isCommentHideableOnPost({ post_type: 'OFFICIAL_NOTICE' }), true)
  assert.equal(isCommentHideableOnPost('EMERGENCY'), true)
  assert.equal(isCommentHideableOnPost('BOARD_TOPIC'), false)
  assert.equal(isCommentHideableOnPost('APARTMENT_THREAD'), false)
  assert.equal(isCommentHideableOnPost(null), false)

  assert.deepEqual(validateHideReason('   '), { valid: false, reason: '', error: 'REASON_REQUIRED' })
  assert.deepEqual(validateHideReason(null), { valid: false, reason: '', error: 'REASON_REQUIRED' })
  assert.deepEqual(validateHideReason('bad\x00char'), {
    valid: false,
    reason: 'bad\x00char',
    error: 'INVALID_CHARS',
  })
  assert.deepEqual(validateHideReason('x'.repeat(HIDE_REASON_MAX_LENGTH + 1)), {
    valid: false,
    reason: 'x'.repeat(HIDE_REASON_MAX_LENGTH + 1),
    error: 'REASON_TOO_LONG',
  })
  assert.deepEqual(validateHideReason('  Breaks house rule 4\nDetails  '), {
    valid: true,
    reason: 'Breaks house rule 4\nDetails',
    error: null,
  })

  const posts = [
    { id: 'p1', title: 'Topic 1', hidden_at: null, hidden_reason: null },
    { id: 'p2', title: 'Topic 2', hidden_at: null, hidden_reason: null },
  ]
  const updatedList = mergeUpdatedPostIntoList(posts, {
    id: 'p2',
    hidden_at: '2026-11-13T10:00:00Z',
    hidden_reason: 'Off-topic',
  })
  assert.equal(updatedList[1].hidden_at, '2026-11-13T10:00:00Z')
  assert.equal(posts[1].hidden_at, null)

  const detail = {
    id: 'p2',
    title: 'Topic 2',
    hidden_at: null,
    comments: [
      { id: 'c1', body: 'One', hidden_at: null },
      { id: 'c2', body: 'Two', hidden_at: null },
    ],
  }
  const updatedDetail = mergeUpdatedPostIntoDetail(detail, {
    id: 'p2',
    hidden_at: '2026-11-13T10:00:00Z',
    hidden_reason: 'Off-topic',
  })
  assert.equal(updatedDetail.hidden_at, '2026-11-13T10:00:00Z')
  assert.equal(updatedDetail.comments.length, 2)

  const updatedCommentsDetail = replaceCommentInDetail(updatedDetail, {
    id: 'c2',
    hidden_at: '2026-11-13T10:05:00Z',
    hidden_reason: 'Spam',
  })
  assert.equal(updatedCommentsDetail.comments[1].hidden_at, '2026-11-13T10:05:00Z')
  assert.equal(updatedCommentsDetail.comments[0].hidden_at, null)

  // Additional validateHideReason edge cases: HT/CR/LF are permitted, other control chars and DEL (\x7f) are rejected
  for (const allowedCtrl of ['tab\there', 'cr\rhere']) {
    assert.deepEqual(validateHideReason(allowedCtrl), {
      valid: true,
      reason: allowedCtrl,
      error: null,
    })
  }
  for (const badCtrl of ['del\x7fhere', 'bell\x07here', 'us\x1fhere']) {
    assert.deepEqual(validateHideReason(badCtrl), {
      valid: false,
      reason: badCtrl,
      error: 'INVALID_CHARS',
    })
  }
  assert.deepEqual(validateHideReason(123 as any), {
    valid: false,
    reason: '',
    error: 'REASON_REQUIRED',
  })
  assert.deepEqual(validateHideReason({} as any), {
    valid: false,
    reason: '',
    error: 'REASON_REQUIRED',
  })
  const exact500 = 'z'.repeat(HIDE_REASON_MAX_LENGTH)
  assert.deepEqual(validateHideReason(`  ${exact500}  `), {
    valid: true,
    reason: exact500,
    error: null,
  })
})

test('#028 communication endpoint wrappers send { reason } JSON payloads and encode IDs', async () => {
  const { hidePost, unhidePost, hideComment, unhideComment } = await import(
    '../api/endpoints/communication.js'
  )
  const { disableOfflineDemo } = await import('../api/offlineDemoData.js')
  disableOfflineDemo()

  const originalFetch = globalThis.fetch
  const recorded: Array<{ url: string; method: string; headers: any; body: string | undefined }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    recorded.push({
      url: String(url),
      method: init?.method || 'GET',
      headers: init?.headers || {},
      body: init?.body,
    })
    return new Response(JSON.stringify({ id: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await hidePost('post/1', { reason: 'Breaks house rules' })
    await unhidePost('post/1')
    await hideComment('post/1', 'comment/2', { reason: 'Personal attack' })
    await unhideComment('post/1', 'comment/2')

    assert.equal(recorded.length, 4)

    assert.equal(recorded[0].url, '/api/v1/communication/posts/post%2F1/hide')
    assert.equal(recorded[0].method, 'POST')
    assert.equal(recorded[0].headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(recorded[0].body || ''), { reason: 'Breaks house rules' })

    assert.equal(recorded[1].url, '/api/v1/communication/posts/post%2F1/unhide')
    assert.equal(recorded[1].method, 'POST')
    assert.equal(recorded[1].body, undefined)

    assert.equal(recorded[2].url, '/api/v1/communication/posts/post%2F1/comments/comment%2F2/hide')
    assert.equal(recorded[2].method, 'POST')
    assert.equal(recorded[2].headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(recorded[2].body || ''), { reason: 'Personal attack' })

    assert.equal(recorded[3].url, '/api/v1/communication/posts/post%2F1/comments/comment%2F2/unhide')
    assert.equal(recorded[3].method, 'POST')
    assert.equal(recorded[3].body, undefined)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#027 getEditWindowDeadlineMs and isWithinEditWindow enforce strict < 24h boundary', () => {
  const createdAt = '2026-11-10T10:00:00.000Z'
  const createdMs = Date.parse(createdAt)
  assert.equal(getEditWindowDeadlineMs(createdAt), createdMs + EDIT_WINDOW_MS)
  assert.equal(getEditWindowDeadlineMs(null), null)
  assert.equal(getEditWindowDeadlineMs('not-a-date'), null)

  assert.equal(isWithinEditWindow(createdAt, createdMs), true)
  assert.equal(isWithinEditWindow(createdAt, createdMs + EDIT_WINDOW_MS - 1), true)
  assert.equal(isWithinEditWindow(createdAt, createdMs + EDIT_WINDOW_MS), false)
  assert.equal(isWithinEditWindow(createdAt, createdMs + EDIT_WINDOW_MS + 60_000), false)
  assert.equal(isWithinEditWindow(undefined, createdMs), false)
})

test('#027 canEditPost and canEditComment enforce type, author, origin, hidden, and 24h rules', () => {
  const createdAt = '2026-11-10T10:00:00.000Z'
  const createdMs = Date.parse(createdAt)
  const freshNow = createdMs + 3_600_000
  const expiredNow = createdMs + EDIT_WINDOW_MS + 1000

  const baseForum = {
    id: 'p1',
    post_type: 'FORUM_TOPIC',
    is_mine: true,
    origin: null,
    hidden_at: null,
    created_at: createdAt,
  }
  assert.equal(canEditPost(baseForum, freshNow), true)
  assert.equal(canEditPost(baseForum, expiredNow), false)
  assert.equal(canEditPost(baseForum, freshNow, { serverClosed: true }), false)
  assert.equal(canEditPost({ ...baseForum, is_mine: false }, freshNow), false)
  assert.equal(canEditPost({ ...baseForum, origin: 'MAINTENANCE' }, freshNow), false)
  assert.equal(canEditPost({ ...baseForum, hidden_at: createdAt }, freshNow), false)

  // Board topics have NO 24h limit when own and origin == null and not hidden
  const boardTopic = { ...baseForum, post_type: 'BOARD_TOPIC' }
  assert.equal(canEditPost(boardTopic, freshNow), true)
  assert.equal(canEditPost(boardTopic, createdMs + 90 * EDIT_WINDOW_MS), true)
  assert.equal(canEditPost({ ...boardTopic, origin: 'MAINTENANCE' }, freshNow), false)
  assert.equal(canEditPost({ ...boardTopic, is_mine: false }, freshNow), false)

  for (const forbiddenType of ['OFFICIAL_NOTICE', 'EMERGENCY', 'APARTMENT_THREAD']) {
    assert.equal(canEditPost({ ...baseForum, post_type: forbiddenType }, freshNow), false)
  }

  // Comments: editable on FORUM_TOPIC, BOARD_TOPIC, OFFICIAL_NOTICE, EMERGENCY (NOT APARTMENT_THREAD) within 24h
  const comment = {
    id: 'c1',
    is_mine: true,
    hidden_at: null,
    created_at: createdAt,
  }
  for (const allowedParentType of ['FORUM_TOPIC', 'BOARD_TOPIC', 'OFFICIAL_NOTICE', 'EMERGENCY']) {
    const parent = { post_type: allowedParentType, origin: null, hidden_at: null }
    assert.equal(canEditComment(comment, parent, freshNow), true)
    assert.equal(canEditComment(comment, parent, expiredNow), false)
    assert.equal(canEditComment(comment, parent, freshNow, { serverClosed: true }), false)
  }
  assert.equal(
    canEditComment(comment, { post_type: 'APARTMENT_THREAD', origin: null, hidden_at: null }, freshNow),
    false,
  )
  assert.equal(
    canEditComment(comment, { post_type: 'FORUM_TOPIC', origin: 'MAINTENANCE', hidden_at: null }, freshNow),
    false,
  )
  assert.equal(
    canEditComment(comment, { post_type: 'FORUM_TOPIC', origin: null, hidden_at: createdAt }, freshNow),
    false,
  )
  assert.equal(
    canEditComment({ ...comment, hidden_at: createdAt }, { post_type: 'FORUM_TOPIC', origin: null, hidden_at: null }, freshNow),
    false,
  )
  assert.equal(
    canEditComment({ ...comment, is_mine: false }, { post_type: 'FORUM_TOPIC', origin: null, hidden_at: null }, freshNow),
    false,
  )
})

test('#027 getNextEditExpiryDelayMs selects earliest open 24h deadline', () => {
  const t0 = Date.parse('2026-11-10T10:00:00.000Z')
  const post = {
    post_type: 'FORUM_TOPIC',
    is_mine: true,
    origin: null,
    hidden_at: null,
    created_at: new Date(t0).toISOString(),
    comments: [
      { id: 'c1', is_mine: true, hidden_at: null, created_at: new Date(t0 + 2000).toISOString() },
      { id: 'c2', is_mine: false, hidden_at: null, created_at: new Date(t0 - 1000).toISOString() },
    ],
  }
  // Earliest is post (t0) -> delay from t0 + 100 is EDIT_WINDOW_MS - 100 + 50
  assert.equal(getNextEditExpiryDelayMs(post, t0 + 100), EDIT_WINDOW_MS - 100 + 50)

  // Board topic ignores topic deadline, watches own fresh comment deadline
  const boardPost = { ...post, post_type: 'BOARD_TOPIC' }
  assert.equal(getNextEditExpiryDelayMs(boardPost, t0 + 100), EDIT_WINDOW_MS + 2000 - 100 + 50)

  // After all windows expire -> null
  assert.equal(getNextEditExpiryDelayMs(post, t0 + EDIT_WINDOW_MS + 5000), null)

  // Null detail, invalid timestamps, or hidden post/comment ignored cleanly
  assert.equal(getNextEditExpiryDelayMs(null, t0), null)
  assert.equal(
    getNextEditExpiryDelayMs({ ...post, created_at: 'bad-date', comments: [] }, t0),
    null,
  )
  assert.equal(
    getNextEditExpiryDelayMs(
      { ...post, hidden_at: new Date(t0 + 500).toISOString() },
      t0 + 1000,
    ),
    null,
  )
  // Large positive delay (clock before created_at): returns positive remaining + 50 ms
  assert.equal(
    getNextEditExpiryDelayMs({ ...post, comments: [] }, t0 - 30 * EDIT_WINDOW_MS),
    31 * EDIT_WINDOW_MS + 50,
  )
})

test('#027 validatePostEdit, validateCommentEdit, and buildPostEditPayload enforce field bounds and diffs', () => {
  assert.deepEqual(validatePostEdit('   ', 'Body ok'), {
    valid: false,
    title: '',
    body: 'Body ok',
    field: 'title',
    error: 'TITLE_REQUIRED',
  })
  assert.deepEqual(validatePostEdit('a'.repeat(POST_TITLE_MAX_LENGTH), 'Body ok'), {
    valid: true,
    title: 'a'.repeat(POST_TITLE_MAX_LENGTH),
    body: 'Body ok',
    field: null,
    error: null,
  })
  assert.deepEqual(validatePostEdit('a'.repeat(POST_TITLE_MAX_LENGTH + 1), 'Body ok'), {
    valid: false,
    title: 'a'.repeat(POST_TITLE_MAX_LENGTH + 1),
    body: 'Body ok',
    field: 'title',
    error: 'TITLE_TOO_LONG',
  })
  assert.deepEqual(validatePostEdit('Bad\x07Title', 'Body ok'), {
    valid: false,
    title: 'Bad\x07Title',
    body: 'Body ok',
    field: 'title',
    error: 'TITLE_INVALID_CHARS',
  })
  assert.deepEqual(validatePostEdit('Good title', '   '), {
    valid: false,
    title: 'Good title',
    body: '',
    field: 'body',
    error: 'BODY_REQUIRED',
  })
  assert.deepEqual(validatePostEdit('Good title', 'b'.repeat(POST_BODY_MAX_LENGTH + 1)), {
    valid: false,
    title: 'Good title',
    body: 'b'.repeat(POST_BODY_MAX_LENGTH + 1),
    field: 'body',
    error: 'BODY_TOO_LONG',
  })
  assert.deepEqual(validatePostEdit('  Good title  ', '  Line 1\nLine 2\t!  '), {
    valid: true,
    title: 'Good title',
    body: 'Line 1\nLine 2\t!',
    field: null,
    error: null,
  })

  assert.deepEqual(validateCommentEdit('  \n  '), {
    valid: false,
    body: '',
    error: 'BODY_REQUIRED',
  })
  assert.deepEqual(validateCommentEdit('x'.repeat(COMMENT_BODY_MAX_LENGTH + 1)), {
    valid: false,
    body: 'x'.repeat(COMMENT_BODY_MAX_LENGTH + 1),
    error: 'BODY_TOO_LONG',
  })
  assert.deepEqual(validateCommentEdit('Ctrl\x7f'), {
    valid: false,
    body: 'Ctrl\x7f',
    error: 'INVALID_CHARS',
  })
  assert.deepEqual(validateCommentEdit('  Trimmed comment  '), {
    valid: true,
    body: 'Trimmed comment',
    error: null,
  })

  const orig = { title: 'Same title', body: 'Same body' }
  assert.deepEqual(buildPostEditPayload(orig, '  Same title  ', 'Same body'), {})
  assert.deepEqual(buildPostEditPayload(orig, 'New title', 'Same body'), { title: 'New title' })
  assert.deepEqual(buildPostEditPayload(orig, 'Same title', 'New body'), { body: 'New body' })
  assert.deepEqual(buildPostEditPayload(orig, 'New title', 'New body'), {
    title: 'New title',
    body: 'New body',
  })
})

test('#027 editPost and editComment endpoint wrappers call PATCH with encoded IDs', async () => {
  const { editPost, editComment } = await import('../api/endpoints/communication.js')
  const { disableOfflineDemo } = await import('../api/offlineDemoData.js')
  disableOfflineDemo()

  const originalFetch = globalThis.fetch
  const recorded: Array<{ url: string; method: string; headers: any; body: string | undefined }> = []
  globalThis.fetch = (async (url: any, init: any) => {
    recorded.push({
      url: String(url),
      method: init?.method || 'GET',
      headers: init?.headers || {},
      body: init?.body,
    })
    return new Response(JSON.stringify({ id: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    await editPost('post/1', { title: 'Updated title' })
    await editComment('post/1', 'comment/2', { body: 'Updated comment' })

    assert.equal(recorded.length, 2)
    assert.equal(recorded[0].url, '/api/v1/communication/posts/post%2F1')
    assert.equal(recorded[0].method, 'PATCH')
    assert.equal(recorded[0].headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(recorded[0].body || ''), { title: 'Updated title' })

    assert.equal(recorded[1].url, '/api/v1/communication/posts/post%2F1/comments/comment%2F2')
    assert.equal(recorded[1].method, 'PATCH')
    assert.equal(recorded[1].headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(recorded[1].body || ''), { body: 'Updated comment' })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#065 canViewerSeePost enforces ALL_BUILDING=apartments-only, ALL_OBJECTS, and KINDS across roles', () => {
  const allBuildingPost = { id: 'p-ab', post_type: 'OFFICIAL_NOTICE', target_scope: 'ALL_BUILDING' }
  const allObjectsPost = { id: 'p-ao', post_type: 'OFFICIAL_NOTICE', target_scope: 'ALL_OBJECTS' }
  const garageOnlyPost = {
    id: 'p-gar',
    post_type: 'OFFICIAL_NOTICE',
    target_scope: 'KINDS',
    target_kinds: ['GARAGE'],
  }
  const aptAndParkingPost = {
    id: 'p-ap',
    post_type: 'OFFICIAL_NOTICE',
    target_scope: 'KINDS',
    target_kinds: ['APARTMENT', 'PARKING'],
  }

  const parkingOnlyMems = [{ apartment_id: 'park-1', apartment_kind: 'PARKING' as const, entrance: null }]
  const garageOnlyMems = [{ apartment_id: 'gar-12', apartment_kind: 'GARAGE' as const, entrance: null }]
  const aptOnlyMems = [{ apartment_id: 'apt-1', apartment_kind: 'APARTMENT' as const, entrance: 1 }]

  // Parking-only resident: misses ALL_BUILDING & garage-only, sees ALL_OBJECTS & apt+parking
  assert.equal(canViewerSeePost(allBuildingPost, { viewerUserId: 'u-p', viewerRole: 'USER', memberships: parkingOnlyMems }), false)
  assert.equal(canViewerSeePost(allObjectsPost, { viewerUserId: 'u-p', viewerRole: 'USER', memberships: parkingOnlyMems }), true)
  assert.equal(canViewerSeePost(garageOnlyPost, { viewerUserId: 'u-p', viewerRole: 'USER', memberships: parkingOnlyMems }), false)
  assert.equal(canViewerSeePost(aptAndParkingPost, { viewerUserId: 'u-p', viewerRole: 'USER', memberships: parkingOnlyMems }), true)

  // Garage-only resident: sees ALL_OBJECTS & garage-only, misses ALL_BUILDING
  assert.equal(canViewerSeePost(allBuildingPost, { viewerUserId: 'u-g', viewerRole: 'USER', memberships: garageOnlyMems }), false)
  assert.equal(canViewerSeePost(garageOnlyPost, { viewerUserId: 'u-g', viewerRole: 'USER', memberships: garageOnlyMems }), true)

  // Apartment-only resident: sees ALL_BUILDING, ALL_OBJECTS, apt+parking; misses garage-only
  assert.equal(canViewerSeePost(allBuildingPost, { viewerUserId: 'u-a', viewerRole: 'USER', memberships: aptOnlyMems }), true)
  assert.equal(canViewerSeePost(garageOnlyPost, { viewerUserId: 'u-a', viewerRole: 'USER', memberships: aptOnlyMems }), false)

  // Accountant without memberships: sees ALL_BUILDING, ALL_OBJECTS, KINDS with APARTMENT; misses garage-only
  assert.equal(canViewerSeePost(allBuildingPost, { viewerUserId: 'u-acc', viewerRole: 'ACCOUNTANT', memberships: [] }), true)
  assert.equal(canViewerSeePost(allObjectsPost, { viewerUserId: 'u-acc', viewerRole: 'ACCOUNTANT', memberships: [] }), true)
  assert.equal(canViewerSeePost(aptAndParkingPost, { viewerUserId: 'u-acc', viewerRole: 'ACCOUNTANT', memberships: [] }), true)
  assert.equal(canViewerSeePost(garageOnlyPost, { viewerUserId: 'u-acc', viewerRole: 'ACCOUNTANT', memberships: [] }), false)

  // Board / Chairman without memberships: sees all scopes including garage-only
  assert.equal(canViewerSeePost(garageOnlyPost, { viewerUserId: 'u-b', viewerRole: 'BOARD', memberships: [] }), true)
  assert.equal(canViewerSeePost(garageOnlyPost, { viewerUserId: 'u-c', viewerRole: 'CHAIRMAN', memberships: [] }), true)
})

test('#067 forum topic target choices, 403 authorization, and target-safe author_apartment_id', () => {
  const aptMem = { apartment_id: 'apt-14', apartment_kind: 'APARTMENT', entrance: 2 }
  const parkMem = { apartment_id: 'park-1', apartment_kind: 'PARKING', entrance: null }
  const garMem = { apartment_id: 'gar-12', apartment_kind: 'GARAGE', entrance: null }

  // 1. Target choices by persona
  const boardChoices = getAllowedForumTopicTargets({
    role: 'BOARD',
    memberships: [],
    buildingKinds: ['APARTMENT', 'PARKING', 'GARAGE'],
  })
  assert.equal(boardChoices.canCreate, true)
  assert.deepEqual(boardChoices.allowedScopes, [
    'ALL_BUILDING',
    'ALL_OBJECTS',
    'KINDS',
  ])
  assert.deepEqual(boardChoices.availableKinds, ['APARTMENT', 'PARKING', 'GARAGE'])

  const aptAndParkChoices = getAllowedForumTopicTargets({
    role: 'USER',
    memberships: [aptMem, parkMem],
    buildingKinds: ['APARTMENT', 'PARKING', 'GARAGE'],
  })
  assert.equal(aptAndParkChoices.canCreate, true)
  assert.deepEqual(aptAndParkChoices.allowedScopes, ['ALL_BUILDING', 'KINDS'])
  assert.deepEqual(aptAndParkChoices.availableKinds, ['APARTMENT', 'PARKING'])
  assert.equal(aptAndParkChoices.defaultScope, 'ALL_BUILDING')

  const garageOnlyChoices = getAllowedForumTopicTargets({
    role: 'USER',
    memberships: [garMem],
    buildingKinds: ['APARTMENT', 'PARKING', 'GARAGE'],
  })
  assert.equal(garageOnlyChoices.canCreate, true)
  assert.deepEqual(garageOnlyChoices.allowedScopes, ['KINDS'])
  assert.deepEqual(garageOnlyChoices.availableKinds, ['GARAGE'])
  assert.equal(garageOnlyChoices.defaultScope, 'KINDS')
  assert.deepEqual(garageOnlyChoices.defaultKinds, ['GARAGE'])

  const accountantNoMems = getAllowedForumTopicTargets({
    role: 'ACCOUNTANT',
    memberships: [],
    buildingKinds: ['APARTMENT', 'GARAGE'],
  })
  assert.equal(accountantNoMems.canCreate, false)

  // 2. Authorization (403 before 422)
  assert.equal(
    canAuthorForumTopicTarget({ role: 'USER', memberships: [garMem], targetScope: 'ALL_BUILDING' }),
    false,
  )
  assert.equal(
    canAuthorForumTopicTarget({ role: 'USER', memberships: [garMem], targetScope: 'ALL_OBJECTS' }),
    false,
  )
  assert.equal(
    canAuthorForumTopicTarget({
      role: 'USER',
      memberships: [garMem],
      targetScope: 'KINDS',
      targetKinds: ['GARAGE'],
    }),
    true,
  )
  assert.equal(
    canAuthorForumTopicTarget({
      role: 'USER',
      memberships: [garMem],
      targetScope: 'KINDS',
      targetKinds: ['PARKING'],
    }),
    false,
  )
  assert.equal(
    canAuthorForumTopicTarget({ role: 'BOARD', memberships: [], targetScope: 'ALL_OBJECTS' }),
    true,
  )

  // 3. Privacy: author object must stay inside target (never leak Apt 14 under a garage/parking/entrance-1 post)
  const katiMems = [aptMem, parkMem]
  assert.deepEqual(
    getEligibleAuthorMemberships(katiMems, { target_scope: 'KINDS', target_kinds: ['PARKING'] }).map(
      (m) => m.apartment_id,
    ),
    ['park-1'],
  )
  assert.deepEqual(
    getEligibleAuthorMemberships(katiMems, { target_scope: 'ALL_BUILDING' }).map((m) => m.apartment_id),
    ['apt-14'],
  )
  assert.deepEqual(
    getEligibleAuthorMemberships(katiMems, { target_scope: 'ALL_OBJECTS' }).map((m) => m.apartment_id),
    ['apt-14', 'park-1'],
  )

  // Explicit Apt 14 on a PARKING-only post -> 422 INVALID_AUTHOR_APARTMENT
  const rejectedOnParking = resolveAuthorApartmentForTarget({
    memberships: katiMems,
    target: { target_scope: 'KINDS', target_kinds: ['PARKING'] },
    requestedApartmentId: 'apt-14',
  })
  assert.equal(rejectedOnParking.ok, false)
  if (!rejectedOnParking.ok) assert.equal(rejectedOnParking.errorCode, 'INVALID_AUTHOR_APARTMENT')

  // Omitted author_apartment_id on PARKING-only post -> auto-picks park-1 (not apt-14!)
  const autoPickedParking = resolveAuthorApartmentForTarget({
    memberships: katiMems,
    target: { target_scope: 'KINDS', target_kinds: ['PARKING'] },
  })
  assert.deepEqual(autoPickedParking, { ok: true, apartmentId: 'park-1' })

  // Explicit Apt 14 (entrance 2) on ENTRANCE 1 post -> 422 INVALID_AUTHOR_APARTMENT
  const rejectedOnEntrance1 = resolveAuthorApartmentForTarget({
    memberships: katiMems,
    target: { target_scope: 'ENTRANCE', target_entrance: 1 },
    requestedApartmentId: 'apt-14',
  })
  assert.equal(rejectedOnEntrance1.ok, false)

  // Explicit Apt 14 on APARTMENT_LIST excluding Apt 14 -> 422 INVALID_AUTHOR_APARTMENT
  const rejectedOnList = resolveAuthorApartmentForTarget({
    memberships: katiMems,
    target: { target_scope: 'APARTMENT_LIST', target_apartment_ids: ['apt-99'] },
    requestedApartmentId: 'apt-14',
  })
  assert.equal(rejectedOnList.ok, false)

  // Board without object inside target with omitted author_apartment_id -> null (board badge)
  const boardNoObjectInTarget = resolveAuthorApartmentForTarget({
    memberships: [aptMem],
    target: { target_scope: 'KINDS', target_kinds: ['GARAGE'] },
  })
  assert.deepEqual(boardNoObjectInTarget, { ok: true, apartmentId: null })
})






