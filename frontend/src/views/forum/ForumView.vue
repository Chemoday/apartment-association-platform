<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import {
  listPosts,
  getPost,
  deletePost,
  editPost,
  editComment,
  hidePost,
  unhidePost,
  hideComment,
  unhideComment,
} from '@/api/endpoints/communication.js'
import { localizeError } from '@/locales/index.js'
import { formatDateTime } from '@/utils/dates.js'
import {
  canEditPost,
  formatHiddenByBoardBanner,
  getNextEditExpiryDelayMs,
  isPostHideable,
  matchesPostSearch,
  mergeUpdatedPostIntoDetail,
  mergeUpdatedPostIntoList,
  replaceCommentInDetail,
} from '@/utils/communication.js'
import PostList from './components/PostList.vue'
import PostComposer from './components/PostComposer.vue'
import HideReasonModal from './components/HideReasonModal.vue'
import PostEditModal from './components/PostEditModal.vue'
import CommentList from './components/CommentList.vue'
import CommentComposer from './components/CommentComposer.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import BaseCard from '@/components/base/BaseCard.vue'
import BaseChip from '@/components/base/BaseChip.vue'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import PostOriginBadge from '@/components/domain/PostOriginBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const { canDeleteForumTopic, canModerateForum } = useRole()

const posts = ref([])
const loading = ref(false)
const error = ref(null)
const activeFilter = ref('ALL')
const searchQuery = ref('')
const composerOpen = ref(false)

const selectedPostDetail = ref(null)
const confirmingDeletePostId = ref(null)
const deletingPostId = ref(null)
const deletePostError = ref('')
const hideModalOpen = ref(false)
const hideTarget = ref(null)
const hideModalError = ref('')
const moderationError = ref('')
const moderationErrorPostId = ref(null)
const moderatingPostId = ref(null)
const moderatingCommentId = ref(null)

// #027 Edit state
const nowMs = ref(Date.now())
const closedEditPostIds = ref(new Set())
const closedEditCommentIds = ref(new Set())
const editModalOpen = ref(false)
const savingPostEdit = ref(false)
const editModalError = ref('')
const editingCommentId = ref(null)
const savingEditCommentId = ref(null)
const editCommentError = ref('')
const commentEditBannerError = ref('')

const isMutating = computed(() =>
  Boolean(
    deletingPostId.value ||
      moderatingPostId.value ||
      moderatingCommentId.value ||
      savingPostEdit.value ||
      savingEditCommentId.value,
  ),
)
const canEditSelectedPost = computed(() =>
  canEditPost(selectedPostDetail.value, nowMs.value, {
    serverClosed: Boolean(
      selectedPostDetail.value?.id && closedEditPostIds.value.has(selectedPostDetail.value.id),
    ),
  }),
)
const activeModerationError = computed(() =>
  moderationError.value &&
  (!moderationErrorPostId.value || moderationErrorPostId.value === selectedPostDetail.value?.id)
    ? moderationError.value
    : '',
)
const savingPrivacy = ref(false)
const privacyMenuOpen = ref(false)
const privacyMenuRef = ref(null)
const noticesCollapsed = ref(false)

const NOTICES_COLLAPSED_STORAGE_KEY = 'aap_forum_notices_collapsed'

const filters = computed(() => [
  { key: 'ALL', label: session.t('forum.filterAll'), icon: null },
  { key: 'OFFICIAL_NOTICE', label: session.t('forum.filterOfficial'), icon: 'campaign' },
  { key: 'GENERAL', label: session.t('forum.filterGeneral'), icon: null },
  { key: 'MAINTENANCE', label: session.t('forum.filterMaintenance'), icon: null },
  { key: 'MARKETPLACE', label: session.t('forum.filterMarketplace'), icon: null },
])

const privacyModes = computed(() => [
  {
    value: 'FULL_NAME',
    label: session.t('forum.privacyFullName'),
    desc: 'Kati Kask • OWNER',
  },
  {
    value: 'INITIALS',
    label: session.t('forum.privacyInitials'),
    desc: 'K. K. (Apt 14) • OWNER',
  },
  {
    value: 'APARTMENT_ONLY',
    label: session.t('forum.privacyApartmentOnly'),
    desc: 'Apt 14 • OWNER',
  },
])

const currentPrivacyBadgeLabel = computed(() => {
  const mem = session.activeMembership
  if (!mem) return ''
  if (mem.preview_badge?.display_label) {
    return mem.preview_badge.display_label
  }
  const found = privacyModes.value.find((m) => m.value === mem.privacy_display_mode)
  return found ? found.label : session.t('forum.privacyFullName')
})

const filteredPosts = computed(() => {
  const q = searchQuery.value.trim()
  if (!q) return posts.value
  return posts.value.filter((p) => matchesPostSearch(p, q))
})

const selectedPostHiddenBanner = computed(() =>
  formatHiddenByBoardBanner(selectedPostDetail.value, (key, params) => session.t(key, params)),
)

const pinnedNotices = computed(() =>
  filteredPosts.value.filter((p) => p.post_type === 'OFFICIAL_NOTICE'),
)

const leftFeedPosts = computed(() => {
  if (activeFilter.value === 'OFFICIAL_NOTICE') {
    return filteredPosts.value
  }
  const topics = filteredPosts.value.filter((p) => p.post_type !== 'OFFICIAL_NOTICE')
  return topics.length > 0 ? topics : filteredPosts.value
})

function toggleNoticesCollapsed() {
  noticesCollapsed.value = !noticesCollapsed.value
  try {
    localStorage.setItem(NOTICES_COLLAPSED_STORAGE_KEY, noticesCollapsed.value ? '1' : '0')
  } catch {
    // Ignore storage restriction
  }
}

function getCategoryLabel(post) {
  if (!post) return ''
  if (post.post_type === 'OFFICIAL_NOTICE') {
    return session.t('forum.officialNoticeBadge')
  }
  switch (post.category) {
    case 'MAINTENANCE':
      return session.t('forum.filterMaintenance')
    case 'WATER_SHUTOFF':
      return session.t('forum.waterShutoffCategory')
    case 'MARKETPLACE':
      return session.t('forum.filterMarketplace')
    default:
      return session.t('forum.filterGeneral')
  }
}

function getCategoryTone(post) {
  if (!post) return 'neutral'
  if (post.post_type === 'OFFICIAL_NOTICE') return 'primary'
  if (post.category === 'MAINTENANCE' || post.category === 'WATER_SHUTOFF') return 'warning'
  return 'neutral'
}

function getTargetScopeLabel(post) {
  if (!post) return ''
  if (post.target_scope === 'ENTRANCE' && post.target_entrance) {
    return session.t('forum.targetEntrance', { number: post.target_entrance })
  }
  if (post.target_scope === 'APARTMENT_LIST') {
    return session.t('forum.targetApartments')
  }
  return session.t('forum.targetAllBuilding')
}

let loadPostsSeq = 0
let selectPostSeq = 0
let editSeq = 0
let editExpiryTimer = null

function scheduleEditExpiryTimer() {
  if (editExpiryTimer) {
    clearTimeout(editExpiryTimer)
    editExpiryTimer = null
  }
  const delayMs = getNextEditExpiryDelayMs(selectedPostDetail.value, nowMs.value)
  if (delayMs !== null) {
    editExpiryTimer = setTimeout(() => {
      nowMs.value = Date.now()
      scheduleEditExpiryTimer()
    }, Math.min(delayMs, 2147483647))
  }
}

function refreshNowClock() {
  nowMs.value = Date.now()
  scheduleEditExpiryTimer()
}

function isSameSessionSnapshot(userId, role, rev, expectedPostId = undefined) {
  if (
    expectedPostId !== undefined &&
    selectedPostDetail.value?.id !== expectedPostId
  ) {
    return false
  }
  return (
    session.actingUserId === userId &&
    session.me?.building_role === role &&
    session.sessionRevision === rev
  )
}

function evictMissingPost(postId) {
  posts.value = posts.value.filter((p) => p.id !== postId)
  if (selectedPostDetail.value?.id === postId) {
    editSeq += 1
    selectedPostDetail.value = null
    editModalOpen.value = false
    savingPostEdit.value = false
    editModalError.value = ''
    editingCommentId.value = null
    savingEditCommentId.value = null
    editCommentError.value = ''
    commentEditBannerError.value = ''
    scheduleEditExpiryTimer()
  }
  if (confirmingDeletePostId.value === postId) {
    confirmingDeletePostId.value = null
    deletePostError.value = ''
  }
}

async function loadPosts() {
  if (!session.actingUserId) return
  const seq = ++loadPostsSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  loading.value = true
  error.value = null
  confirmingDeletePostId.value = null
  deletePostError.value = ''
  try {
    const params = { limit: 30 }
    if (activeFilter.value === 'OFFICIAL_NOTICE') {
      params.post_type = 'OFFICIAL_NOTICE'
    } else if (activeFilter.value !== 'ALL') {
      params.category = activeFilter.value
    }

    const data = await listPosts(params)
    if (seq !== loadPostsSeq || !isSameSessionSnapshot(targetUserId, targetRole, targetRev)) return
    posts.value = Array.isArray(data)
      ? data.filter((p) => p.post_type !== 'BOARD_TOPIC' && p.post_type !== 'APARTMENT_THREAD')
      : []
    if (posts.value.length > 0) {
      const targetPost =
        (selectedPostDetail.value &&
          posts.value.find((p) => p.id === selectedPostDetail.value.id)) ||
        posts.value[0]
      await selectPost(targetPost)
    } else {
      selectPostSeq += 1
      editSeq += 1
      selectedPostDetail.value = null
      editModalOpen.value = false
      savingPostEdit.value = false
      editModalError.value = ''
      editingCommentId.value = null
      savingEditCommentId.value = null
      editCommentError.value = ''
      commentEditBannerError.value = ''
      scheduleEditExpiryTimer()
    }
  } catch (err) {
    if (seq !== loadPostsSeq || !isSameSessionSnapshot(targetUserId, targetRole, targetRev)) return
    error.value = err
  } finally {
    if (seq === loadPostsSeq) {
      loading.value = false
    }
  }
}

async function selectPost(post, { silent = false } = {}) {
  if (!post?.id) return
  const seq = ++selectPostSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  const switchingPost = selectedPostDetail.value?.id !== post.id
  if (!silent) {
    moderationError.value = ''
    moderationErrorPostId.value = null
    commentEditBannerError.value = ''
  }
  if (switchingPost) {
    editSeq += 1
    savingPostEdit.value = false
    savingEditCommentId.value = null
    editingCommentId.value = null
    editCommentError.value = ''
    editModalOpen.value = false
    editModalError.value = ''
  }
  if (confirmingDeletePostId.value !== post.id) {
    confirmingDeletePostId.value = null
    deletePostError.value = ''
  }
  try {
    const detail = await getPost(post.id)
    if (seq !== selectPostSeq || !isSameSessionSnapshot(targetUserId, targetRole, targetRev)) return
    selectedPostDetail.value = detail
    refreshNowClock()
  } catch (err) {
    if (seq !== selectPostSeq || !isSameSessionSnapshot(targetUserId, targetRole, targetRev)) return
    if (err?.status === 404) {
      evictMissingPost(post.id)
    } else if (!silent) {
      selectedPostDetail.value = typeof post.title === 'string' ? post : null
      refreshNowClock()
    }
  }
}

function openPostDetail(post) {
  router.push({ name: 'forum-detail', params: { postId: post.id } })
}

async function requestDeletePost(post) {
  if (!post?.id || isMutating.value) return
  if (selectedPostDetail.value?.id !== post.id) {
    await selectPost(post)
    if (selectedPostDetail.value?.id !== post.id) return
  }
  confirmingDeletePostId.value = post.id
  deletePostError.value = ''
}

function cancelDeletePost() {
  if (deletingPostId.value) return
  confirmingDeletePostId.value = null
  deletePostError.value = ''
}

async function handleConfirmDeletePost(post) {
  if (!post?.id || isMutating.value) return
  deletingPostId.value = post.id
  deletePostError.value = ''
  try {
    await deletePost(post.id)
    confirmingDeletePostId.value = null
    if (selectedPostDetail.value?.id === post.id) {
      selectedPostDetail.value = null
    }
    await loadPosts()
  } catch (err) {
    if (err?.status === 404) {
      evictMissingPost(post.id)
      await loadPosts()
    } else {
      deletePostError.value = localizeError(err?.errorCode, err?.payload, session.lang)
    }
  } finally {
    deletingPostId.value = null
  }
}

function openEditPostModal() {
  if (!canEditSelectedPost.value || isMutating.value) return
  confirmingDeletePostId.value = null
  deletePostError.value = ''
  moderationError.value = ''
  moderationErrorPostId.value = null
  editModalError.value = ''
  editModalOpen.value = true
}

function closeEditPostModal() {
  if (savingPostEdit.value) return
  editModalOpen.value = false
  editModalError.value = ''
}

async function handleConfirmPostEdit(payload) {
  const targetPostId = selectedPostDetail.value?.id
  if (!targetPostId || isMutating.value) return
  const seq = ++editSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  savingPostEdit.value = true
  editModalError.value = ''
  moderationError.value = ''
  moderationErrorPostId.value = null
  try {
    const updated = await editPost(targetPostId, payload)
    if (
      seq !== editSeq ||
      !isSameSessionSnapshot(targetUserId, targetRole, targetRev, targetPostId)
    ) {
      return
    }
    posts.value = mergeUpdatedPostIntoList(posts.value, updated)
    if (selectedPostDetail.value?.id === updated.id) {
      selectedPostDetail.value = mergeUpdatedPostIntoDetail(selectedPostDetail.value, updated)
    }
    editModalOpen.value = false
  } catch (err) {
    if (
      seq !== editSeq ||
      !isSameSessionSnapshot(targetUserId, targetRole, targetRev, targetPostId)
    ) {
      return
    }
    if (err?.errorCode === 'EDIT_WINDOW_CLOSED') {
      const next = new Set(closedEditPostIds.value)
      next.add(targetPostId)
      closedEditPostIds.value = next
      editModalOpen.value = false
      moderationErrorPostId.value = targetPostId
      moderationError.value = localizeError(err.errorCode, err.payload, session.lang)
    } else if (err?.errorCode === 'POST_NOT_EDITABLE') {
      editModalOpen.value = false
      moderationErrorPostId.value = targetPostId
      moderationError.value = localizeError(err.errorCode, err.payload, session.lang)
      await selectPost({ id: targetPostId }, { silent: true })
    } else if (err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND') {
      evictMissingPost(targetPostId)
      editModalOpen.value = false
    } else {
      editModalError.value = localizeError(err?.errorCode, err?.payload, session.lang)
    }
  } finally {
    if (seq === editSeq) {
      savingPostEdit.value = false
    }
  }
}

function handleStartEditComment(comment) {
  if (!comment?.id || isMutating.value) return
  editingCommentId.value = comment.id
  editCommentError.value = ''
  commentEditBannerError.value = ''
}

function handleCancelEditComment() {
  if (savingEditCommentId.value) return
  editingCommentId.value = null
  editCommentError.value = ''
}

async function handleSaveEditComment({ comment, body }) {
  const targetPostId = selectedPostDetail.value?.id
  if (!targetPostId || !comment?.id || isMutating.value) return
  const seq = ++editSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  savingEditCommentId.value = comment.id
  editCommentError.value = ''
  commentEditBannerError.value = ''
  try {
    const updatedComment = await editComment(targetPostId, comment.id, { body })
    if (
      seq !== editSeq ||
      !isSameSessionSnapshot(targetUserId, targetRole, targetRev, targetPostId)
    ) {
      return
    }
    if (selectedPostDetail.value?.id === targetPostId) {
      selectedPostDetail.value = replaceCommentInDetail(selectedPostDetail.value, updatedComment)
    }
    editingCommentId.value = null
  } catch (err) {
    if (
      seq !== editSeq ||
      !isSameSessionSnapshot(targetUserId, targetRole, targetRev, targetPostId)
    ) {
      return
    }
    if (err?.errorCode === 'EDIT_WINDOW_CLOSED') {
      const next = new Set(closedEditCommentIds.value)
      next.add(comment.id)
      closedEditCommentIds.value = next
      editingCommentId.value = null
      commentEditBannerError.value = localizeError(err.errorCode, err.payload, session.lang)
    } else if (
      err?.errorCode === 'COMMENT_NOT_EDITABLE' ||
      (err?.status === 404 && err?.errorCode === 'COMMENT_NOT_FOUND')
    ) {
      editingCommentId.value = null
      editCommentError.value = ''
      commentEditBannerError.value = localizeError(err.errorCode, err.payload, session.lang)
      await selectPost({ id: targetPostId }, { silent: true })
    } else if (err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND') {
      evictMissingPost(targetPostId)
    } else {
      editCommentError.value = localizeError(err?.errorCode, err?.payload, session.lang)
    }
  } finally {
    if (seq === editSeq) {
      savingEditCommentId.value = null
    }
  }
}

let moderationSeq = 0

function openHidePostModal(post) {
  if (!post?.id || isMutating.value) return
  confirmingDeletePostId.value = null
  deletePostError.value = ''
  hideTarget.value = { type: 'post', postId: post.id }
  hideModalError.value = ''
  moderationError.value = ''
  moderationErrorPostId.value = null
  hideModalOpen.value = true
}

function openHideCommentModal(comment) {
  const postId = selectedPostDetail.value?.id
  if (!postId || !comment?.id || isMutating.value) return
  confirmingDeletePostId.value = null
  deletePostError.value = ''
  hideTarget.value = { type: 'comment', postId, commentId: comment.id }
  hideModalError.value = ''
  moderationError.value = ''
  moderationErrorPostId.value = null
  hideModalOpen.value = true
}

function closeHideModal() {
  if (isMutating.value) return
  hideModalOpen.value = false
  hideTarget.value = null
  hideModalError.value = ''
}

async function handleConfirmHide(reason) {
  const target = hideTarget.value
  if (!target || isMutating.value) return
  const seq = ++moderationSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  hideModalError.value = ''
  moderationError.value = ''
  moderationErrorPostId.value = null

  if (target.type === 'post') {
    moderatingPostId.value = target.postId
    try {
      const updated = await hidePost(target.postId, { reason })
      if (seq !== moderationSeq || !isSameSessionSnapshot(targetUserId, targetRole, targetRev)) {
        return
      }
      posts.value = mergeUpdatedPostIntoList(posts.value, updated)
      if (selectedPostDetail.value?.id === updated.id) {
        selectedPostDetail.value = mergeUpdatedPostIntoDetail(selectedPostDetail.value, updated)
        refreshNowClock()
      }
      hideModalOpen.value = false
      hideTarget.value = null
    } catch (err) {
      if (seq === moderationSeq && isSameSessionSnapshot(targetUserId, targetRole, targetRev)) {
        if (err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND') {
          evictMissingPost(target.postId)
          hideModalOpen.value = false
          hideTarget.value = null
        } else {
          hideModalError.value = localizeError(err?.errorCode, err?.payload, session.lang)
        }
      }
    } finally {
      if (seq === moderationSeq) {
        moderatingPostId.value = null
      }
    }
    return
  }

  moderatingCommentId.value = target.commentId
  try {
    const updatedComment = await hideComment(target.postId, target.commentId, { reason })
    if (seq !== moderationSeq || !isSameSessionSnapshot(targetUserId, targetRole, targetRev)) {
      return
    }
    if (selectedPostDetail.value?.id === target.postId) {
      selectedPostDetail.value = replaceCommentInDetail(selectedPostDetail.value, updatedComment)
      refreshNowClock()
    }
    hideModalOpen.value = false
    hideTarget.value = null
  } catch (err) {
    if (seq === moderationSeq && isSameSessionSnapshot(targetUserId, targetRole, targetRev)) {
      if (err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND') {
        evictMissingPost(target.postId)
        hideModalOpen.value = false
        hideTarget.value = null
      } else {
        hideModalError.value = localizeError(err?.errorCode, err?.payload, session.lang)
      }
    }
  } finally {
    if (seq === moderationSeq) {
      moderatingCommentId.value = null
    }
  }
}

async function handleUnhidePost(post) {
  if (!post?.id || isMutating.value) return
  const seq = ++moderationSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  confirmingDeletePostId.value = null
  deletePostError.value = ''
  moderatingPostId.value = post.id
  moderationError.value = ''
  moderationErrorPostId.value = null
  try {
    const updated = await unhidePost(post.id)
    if (seq !== moderationSeq || !isSameSessionSnapshot(targetUserId, targetRole, targetRev)) {
      return
    }
    posts.value = mergeUpdatedPostIntoList(posts.value, updated)
    if (selectedPostDetail.value?.id === updated.id) {
      selectedPostDetail.value = mergeUpdatedPostIntoDetail(selectedPostDetail.value, updated)
      refreshNowClock()
    }
  } catch (err) {
    if (seq === moderationSeq && isSameSessionSnapshot(targetUserId, targetRole, targetRev)) {
      if (err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND') {
        evictMissingPost(post.id)
      } else {
        moderationErrorPostId.value = post.id
        moderationError.value = localizeError(err?.errorCode, err?.payload, session.lang)
      }
    }
  } finally {
    if (seq === moderationSeq) {
      moderatingPostId.value = null
    }
  }
}

async function handleUnhideComment(comment) {
  const postId = selectedPostDetail.value?.id
  if (!postId || !comment?.id || isMutating.value) return
  const seq = ++moderationSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  confirmingDeletePostId.value = null
  deletePostError.value = ''
  moderatingCommentId.value = comment.id
  moderationError.value = ''
  moderationErrorPostId.value = null
  try {
    const updatedComment = await unhideComment(postId, comment.id)
    if (seq !== moderationSeq || !isSameSessionSnapshot(targetUserId, targetRole, targetRev)) {
      return
    }
    if (selectedPostDetail.value?.id === postId) {
      selectedPostDetail.value = replaceCommentInDetail(selectedPostDetail.value, updatedComment)
      refreshNowClock()
    }
  } catch (err) {
    if (seq === moderationSeq && isSameSessionSnapshot(targetUserId, targetRole, targetRev)) {
      if (err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND') {
        evictMissingPost(postId)
      } else {
        moderationErrorPostId.value = postId
        moderationError.value = localizeError(err?.errorCode, err?.payload, session.lang)
      }
    }
  } finally {
    if (seq === moderationSeq) {
      moderatingCommentId.value = null
    }
  }
}

async function handleCommentAdded() {
  const postId = selectedPostDetail.value?.id
  if (!postId) return
  await selectPost({ id: postId }, { silent: true })
  const detail = selectedPostDetail.value
  if (!detail || detail.id !== postId) return
  const idx = posts.value.findIndex((p) => p.id === postId)
  if (idx !== -1) {
    posts.value[idx].comments_count = detail.comments_count ?? detail.comments?.length ?? 0
  }
}

async function handlePrivacyChange(mode) {
  const membership = session.activeMembership
  if (!membership || savingPrivacy.value || mode === membership.privacy_display_mode) {
    privacyMenuOpen.value = false
    return
  }
  savingPrivacy.value = true
  try {
    await session.changePrivacyMode(membership.membership_id, mode)
    privacyMenuOpen.value = false
    await loadPosts()
  } finally {
    savingPrivacy.value = false
  }
}

function handleDocumentClick(e) {
  if (privacyMenuOpen.value && privacyMenuRef.value && !privacyMenuRef.value.contains(e.target)) {
    privacyMenuOpen.value = false
  }
}

watch(activeFilter, () => {
  moderationSeq += 1
  editSeq += 1
  moderationError.value = ''
  moderationErrorPostId.value = null
  moderatingPostId.value = null
  moderatingCommentId.value = null
  editModalOpen.value = false
  savingPostEdit.value = false
  editModalError.value = ''
  editingCommentId.value = null
  savingEditCommentId.value = null
  editCommentError.value = ''
  commentEditBannerError.value = ''
  loadPosts()
})

watch(
  () => [session.actingUserId, session.me?.building_role, session.sessionRevision],
  () => {
    loadPostsSeq += 1
    selectPostSeq += 1
    moderationSeq += 1
    editSeq += 1
    if (editExpiryTimer) {
      clearTimeout(editExpiryTimer)
      editExpiryTimer = null
    }
    posts.value = []
    selectedPostDetail.value = null
    confirmingDeletePostId.value = null
    deletePostError.value = ''
    deletingPostId.value = null
    hideModalOpen.value = false
    hideTarget.value = null
    hideModalError.value = ''
    moderationError.value = ''
    moderationErrorPostId.value = null
    moderatingPostId.value = null
    moderatingCommentId.value = null
    editModalOpen.value = false
    savingPostEdit.value = false
    editModalError.value = ''
    editingCommentId.value = null
    savingEditCommentId.value = null
    editCommentError.value = ''
    commentEditBannerError.value = ''
    closedEditPostIds.value = new Set()
    closedEditCommentIds.value = new Set()
    loadPosts()
  },
)

onMounted(() => {
  try {
    noticesCollapsed.value = localStorage.getItem(NOTICES_COLLAPSED_STORAGE_KEY) === '1'
  } catch {
    noticesCollapsed.value = false
  }
  document.addEventListener('click', handleDocumentClick)
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', refreshNowClock)
  }
  if (route.query.compose === '1') {
    composerOpen.value = true
  }
  loadPosts()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
  if (editExpiryTimer) clearTimeout(editExpiryTimer)
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', refreshNowClock)
  }
})

watch(
  () => route.query.compose,
  (val) => {
    if (val === '1') {
      composerOpen.value = true
    }
  },
)
</script>

<template>
  <div class="w-full max-w-[1360px] mx-auto px-gutter py-space-lg space-y-5">
    <!-- Top Unified Header & Action Bar -->
    <div class="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-surface-container-lowest border border-surface-container-high rounded-2xl p-4 sm:p-5 shadow-2xs">
      <div>
        <span class="text-[11px] font-bold uppercase tracking-widest text-primary block mb-0.5">
          KÜ Sõpruse 12 • Tallinn
        </span>
        <h1 class="text-xl sm:text-2xl font-bold text-on-surface tracking-tight">
          {{ session.t('forum.title') }}
        </h1>
        <p class="text-xs sm:text-sm text-on-surface-variant mt-0.5">
          {{ session.t('forum.subtitle') }}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2.5">
        <!-- Search Input -->
        <div class="relative flex-1 sm:flex-initial">
          <span class="material-symbols-outlined text-[16px] text-on-surface-variant absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
            search
          </span>
          <input
            v-model="searchQuery"
            type="search"
            :placeholder="session.t('forum.searchPlaceholder')"
            class="w-full sm:w-56 pl-8 pr-3 py-1.5 rounded-xl bg-surface-container-low/60 border border-outline-variant/40 text-xs text-on-surface placeholder-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

        <!-- Compact Privacy Signature Popover Chip (for Residents with an Apartment Membership) -->
        <div v-if="session.activeMembership" ref="privacyMenuRef" class="relative">
          <button
            type="button"
            class="px-3 py-1.5 rounded-xl border border-outline-variant/50 bg-surface-container-low/60 hover:bg-surface-container-low text-xs font-medium inline-flex items-center gap-1.5 transition-colors"
            :title="session.t('forum.privacyWidgetTitle')"
            @click="privacyMenuOpen = !privacyMenuOpen"
          >
            <span class="material-symbols-outlined text-[16px] text-primary">badge</span>
            <span class="text-on-surface-variant hidden sm:inline">{{ session.t('forum.signingAsLabel') }}</span>
            <span class="font-semibold text-on-surface">{{ currentPrivacyBadgeLabel }}</span>
            <span class="material-symbols-outlined text-[15px] text-on-surface-variant">
              {{ privacyMenuOpen ? 'expand_less' : 'expand_more' }}
            </span>
          </button>

          <!-- Dropdown Popover -->
          <div
            v-if="privacyMenuOpen"
            class="absolute right-0 mt-2 w-72 bg-surface-container-lowest border border-surface-container-high rounded-2xl shadow-lg p-3.5 z-30 space-y-2.5"
          >
            <div>
              <h3 class="text-xs font-bold text-on-surface">
                {{ session.t('forum.privacyWidgetTitle') }}
              </h3>
              <p class="text-[11px] text-on-surface-variant mt-0.5 leading-snug">
                {{ session.t('forum.privacyWidgetDesc') }}
              </p>
            </div>

            <div class="space-y-1.5">
              <button
                v-for="mode in privacyModes"
                :key="mode.value"
                type="button"
                class="w-full text-left p-2 rounded-xl border transition-colors flex items-center justify-between gap-2"
                :class="
                  session.activeMembership.privacy_display_mode === mode.value
                    ? 'bg-primary/10 border-primary text-on-surface'
                    : 'bg-surface-container-low/40 border-surface-container-high text-on-surface-variant hover:bg-surface-container-low'
                "
                :disabled="savingPrivacy"
                @click="handlePrivacyChange(mode.value)"
              >
                <div>
                  <div class="text-xs font-semibold text-on-surface">{{ mode.label }}</div>
                  <div class="text-[11px] text-on-surface-variant font-mono">{{ mode.desc }}</div>
                </div>
                <span
                  class="material-symbols-outlined text-[18px]"
                  :class="
                    session.activeMembership.privacy_display_mode === mode.value
                      ? 'text-primary'
                      : 'text-outline-variant'
                  "
                >
                  {{
                    session.activeMembership.privacy_display_mode === mode.value
                      ? 'check_circle'
                      : 'radio_button_unchecked'
                  }}
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- New Post Button -->
        <BaseButton variant="primary" size="sm" @click="composerOpen = true">
          <span class="material-symbols-outlined text-[17px]">edit_square</span>
          <span>{{ session.t('forum.newDiscussionBtn') }}</span>
        </BaseButton>
      </div>
    </div>

    <!-- Category Filter Bar -->
    <div class="flex flex-wrap items-center gap-2">
      <button
        v-for="f in filters"
        :key="f.key"
        type="button"
        class="px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all inline-flex items-center gap-1.5 cursor-pointer"
        :class="
          activeFilter === f.key
            ? 'bg-primary text-on-primary shadow-2xs'
            : f.key === 'OFFICIAL_NOTICE' && pinnedNotices.length > 0
              ? 'bg-primary/10 border border-primary/30 text-primary hover:bg-primary/15'
              : 'bg-surface-container-lowest border border-surface-container-high text-on-surface-variant hover:text-on-surface'
        "
        @click="activeFilter = f.key"
      >
        <span v-if="f.icon" class="material-symbols-outlined text-[15px]">{{ f.icon }}</span>
        <span>{{ f.label }}</span>
        <span
          v-if="f.key === 'OFFICIAL_NOTICE' && pinnedNotices.length > 0"
          class="px-1.5 py-0.2 rounded-full text-[10px] font-bold"
          :class="activeFilter === f.key ? 'bg-white/20 text-white' : 'bg-primary text-on-primary'"
        >
          {{ pinnedNotices.length }}
        </span>
      </button>
    </div>

    <ErrorCard v-if="error" :error="error" @retry="loadPosts" />

    <template v-else>
      <!-- Collapsible Official Board Notices Block (Shown when notices exist and filter is not a specific non-notice category) -->
      <section
        v-if="pinnedNotices.length > 0 && activeFilter !== 'OFFICIAL_NOTICE'"
        aria-label="Official Board Notices"
      >
        <!-- Collapsed Single Horizontal Bar Button -->
        <button
          v-if="noticesCollapsed"
          type="button"
          class="w-full px-4 py-2.5 rounded-xl bg-primary/8 hover:bg-primary/12 border border-primary/25 transition-colors flex items-center justify-between gap-3 text-left cursor-pointer"
          @click="toggleNoticesCollapsed"
        >
          <div class="flex items-center gap-2 min-w-0">
            <span class="material-symbols-outlined text-[18px] text-primary">campaign</span>
            <span class="text-xs font-bold text-on-surface">
              {{ session.t('forum.pinnedNoticesHeading') }}
            </span>
            <span class="px-2 py-0.5 rounded-full bg-primary text-on-primary text-[11px] font-mono font-bold">
              {{ pinnedNotices.length }}
            </span>
            <span class="text-xs text-on-surface-variant truncate hidden md:inline">
              — {{ pinnedNotices[0]?.title }}
            </span>
          </div>
          <span class="inline-flex items-center gap-1 text-xs font-semibold text-primary shrink-0">
            <span>{{ session.t('forum.expandNoticesBtn') }}</span>
            <span class="material-symbols-outlined text-[16px]">expand_more</span>
          </span>
        </button>

        <!-- Expanded Official Notices Grid -->
        <div
          v-else
          class="rounded-2xl bg-primary/5 border border-primary/20 p-4 space-y-3"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="material-symbols-outlined text-[18px] text-primary">campaign</span>
              <h2 class="text-xs font-bold uppercase tracking-wider text-on-surface">
                {{ session.t('forum.pinnedNoticesHeading') }} ({{ pinnedNotices.length }})
              </h2>
            </div>

            <button
              type="button"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg hover:bg-primary/10 text-xs font-semibold text-primary transition-colors cursor-pointer"
              @click="toggleNoticesCollapsed"
            >
              <span>{{ session.t('forum.collapseNoticesBtn') }}</span>
              <span class="material-symbols-outlined text-[16px]">expand_less</span>
            </button>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <article
              v-for="notice in pinnedNotices"
              :key="notice.id"
              class="p-3.5 rounded-xl border transition-all cursor-pointer flex flex-col justify-between gap-2.5"
              :class="
                selectedPostDetail?.id === notice.id
                  ? 'bg-surface-container-lowest border-primary ring-2 ring-primary/20 shadow-xs'
                  : 'bg-surface-container-lowest/90 border-surface-container-high hover:border-primary/50'
              "
              @click="selectPost(notice)"
            >
              <div>
                <div class="flex items-center justify-between gap-2 mb-1.5">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <BaseChip tone="primary">
                      <span class="material-symbols-outlined text-[13px] mr-0.5">campaign</span>
                      <span>{{ session.t('forum.officialNoticeBadge') }}</span>
                    </BaseChip>
                    <PostOriginBadge
                      :origin="notice.origin"
                      :post-type="notice.post_type"
                    />
                  </div>
                  <div class="flex items-center gap-1">
                    <span class="text-[11px] font-mono text-on-surface-variant">
                      {{ formatDateTime(notice.created_at, session.lang) }}
                    </span>
                    <span
                      v-if="notice.edited_at"
                      class="text-[11px] text-on-surface-variant italic underline decoration-dotted cursor-help"
                      :title="
                        session.t('forum.editedAtTooltip', {
                          time: formatDateTime(notice.edited_at, session.lang),
                        })
                      "
                    >
                      {{ session.t('forum.editedLabel') }}
                    </span>
                    <button
                      type="button"
                      class="p-1 rounded text-on-surface-variant hover:text-primary hover:bg-primary/10 transition-colors"
                      :title="session.t('forum.fullThreadBtn')"
                      @click.stop="openPostDetail(notice)"
                    >
                      <span class="material-symbols-outlined text-[15px]">open_in_new</span>
                    </button>
                  </div>
                </div>

                <h3 class="text-sm font-bold text-on-surface line-clamp-1 mb-1">
                  {{ notice.title }}
                </h3>
                <p class="text-xs text-on-surface-variant line-clamp-2 whitespace-pre-line">
                  {{ notice.body ?? '' }}
                </p>
              </div>

              <div class="flex items-center justify-between gap-2 pt-2 border-t border-surface-container-high text-xs">
                <AuthorBadge
                  v-if="notice.author_badge"
                  :badge="notice.author_badge"
                  :is-mine="notice.is_mine"
                />
                <span class="inline-flex items-center gap-1 font-mono text-on-surface-variant">
                  <span class="material-symbols-outlined text-[14px]">chat_bubble</span>
                  <span>{{ notice.comments_count ?? 0 }}</span>
                </span>
              </div>
            </article>
          </div>
        </div>
      </section>

      <!-- 12-Col Split-View Reader: 5 Cols Compact Feed / 7 Cols Generous Reader Pane -->
      <div class="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <!-- Left Scannable Feed (5 cols) -->
        <div class="lg:col-span-5 space-y-2.5">
          <div
            v-if="activeFilter !== 'OFFICIAL_NOTICE' && pinnedNotices.length > 0"
            class="text-xs font-bold uppercase tracking-wider text-on-surface-variant px-1"
          >
            {{ session.t('forum.residentDiscussionsHeading') }} ({{ leftFeedPosts.length }})
          </div>

          <PostList
            :posts="leftFeedPosts"
            :selected-post-id="selectedPostDetail?.id"
            :loading="loading"
            :moderating-post-id="moderatingPostId"
            :moderation-disabled="isMutating"
            @select="selectPost"
            @open-detail="openPostDetail"
            @delete-post="requestDeletePost"
            @hide-post="openHidePostModal"
            @unhide-post="handleUnhidePost"
          />
        </div>

        <!-- Right Generous Thread Reader & Discussion Pane (7 cols) -->
        <aside class="lg:col-span-7 lg:sticky lg:top-20">
          <BaseCard v-if="selectedPostDetail" padding="none" class="overflow-hidden">
            <!-- Reader Top Meta & Action Bar -->
            <div class="px-5 py-3.5 border-b border-surface-container-high bg-surface-container-low/40 flex flex-wrap items-center justify-between gap-2">
              <div class="flex flex-wrap items-center gap-2">
                <BaseChip :tone="getCategoryTone(selectedPostDetail)">
                  <span
                    v-if="selectedPostDetail.post_type === 'OFFICIAL_NOTICE'"
                    class="material-symbols-outlined text-[13px] mr-0.5"
                  >
                    campaign
                  </span>
                  <span>{{ getCategoryLabel(selectedPostDetail) }}</span>
                </BaseChip>

                <BaseChip v-if="selectedPostDetail.hidden_at" tone="warning">
                  <span class="material-symbols-outlined text-[13px] mr-0.5" aria-hidden="true">visibility_off</span>
                  <span>{{ session.t('forum.hiddenTopicBadge') }}</span>
                </BaseChip>

                <PostOriginBadge
                  :origin="selectedPostDetail.origin"
                  :post-type="selectedPostDetail.post_type"
                />

                <span class="inline-flex items-center gap-1 text-xs text-on-surface-variant">
                  <span class="material-symbols-outlined text-[14px]">apartment</span>
                  <span>{{ getTargetScopeLabel(selectedPostDetail) }}</span>
                </span>
              </div>

              <div class="flex flex-wrap items-center gap-2">
                <button
                  v-if="canEditSelectedPost"
                  type="button"
                  :disabled="isMutating"
                  class="px-2.5 py-1 rounded-lg border border-primary/40 text-xs font-semibold text-primary hover:bg-primary/10 inline-flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
                  @click="openEditPostModal"
                >
                  <span class="material-symbols-outlined text-[14px]" aria-hidden="true">edit</span>
                  <span>{{ session.t('forum.editBtn') }}</span>
                </button>

                <button
                  v-if="canModerateForum && isPostHideable(selectedPostDetail)"
                  type="button"
                  :disabled="isMutating"
                  class="px-2.5 py-1 rounded-lg border border-warning/40 text-xs font-semibold text-on-surface hover:bg-warning-container/25 inline-flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
                  @click="
                    selectedPostDetail.hidden_at
                      ? handleUnhidePost(selectedPostDetail)
                      : openHidePostModal(selectedPostDetail)
                  "
                >
                  <span class="material-symbols-outlined text-[14px] text-warning" aria-hidden="true">
                    {{ selectedPostDetail.hidden_at ? 'visibility' : 'visibility_off' }}
                  </span>
                  <span>
                    {{
                      selectedPostDetail.hidden_at
                        ? session.t('forum.unhideBtn')
                        : session.t('forum.hideBtn')
                    }}
                  </span>
                </button>

                <button
                  v-if="
                    canDeleteForumTopic &&
                    selectedPostDetail.post_type === 'FORUM_TOPIC' &&
                    confirmingDeletePostId !== selectedPostDetail.id
                  "
                  type="button"
                  :disabled="isMutating"
                  class="px-2.5 py-1 rounded-lg border border-error/30 text-xs font-semibold text-error hover:bg-error-container/30 inline-flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-50"
                  @click="requestDeletePost(selectedPostDetail)"
                >
                  <span class="material-symbols-outlined text-[14px]">delete</span>
                  <span>{{ session.t('common.delete') }}</span>
                </button>

                <button
                  type="button"
                  class="px-2.5 py-1 rounded-lg border border-outline-variant/50 bg-surface-container-lowest hover:border-primary text-xs font-semibold text-primary inline-flex items-center gap-1 transition-colors"
                  @click="openPostDetail(selectedPostDetail)"
                >
                  <span>{{ session.t('forum.expandBtn') }}</span>
                  <span class="material-symbols-outlined text-[14px]">open_in_new</span>
                </button>
              </div>
            </div>

            <!-- Reader Content & Comments -->
            <div class="p-5 sm:p-6 space-y-5">
              <div
                v-if="activeModerationError"
                role="alert"
                class="rounded-xl border border-error/40 bg-error-container/20 px-4 py-2.5 flex items-center justify-between gap-3 text-xs text-error font-medium"
              >
                <span>{{ activeModerationError }}</span>
                <button
                  type="button"
                  class="p-1 rounded hover:bg-error/10 cursor-pointer"
                  :aria-label="session.t('common.close')"
                  @click="moderationError = ''; moderationErrorPostId = null"
                >
                  <span class="material-symbols-outlined text-[15px]">close</span>
                </button>
              </div>

              <div
                v-if="confirmingDeletePostId === selectedPostDetail.id"
                class="rounded-xl bg-error-container/20 border border-error/40 p-space-md flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                role="alert"
              >
                <div class="space-y-0.5">
                  <p class="text-xs font-bold text-on-surface">
                    {{ session.t('forum.deleteConfirmTitle') }}
                  </p>
                  <p class="text-xs text-on-surface-variant">
                    {{ session.t('forum.deleteConfirmBody') }}
                  </p>
                  <p v-if="deletePostError" class="text-xs text-error font-medium pt-1">
                    {{ deletePostError }}
                  </p>
                </div>
                <div class="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    :disabled="isMutating"
                    class="px-3 py-1.5 rounded-lg bg-surface-container text-on-surface text-xs font-semibold hover:bg-surface-container-high transition-colors cursor-pointer disabled:opacity-50"
                    @click="cancelDeletePost"
                  >
                    {{ session.t('common.cancel') }}
                  </button>
                  <button
                    type="button"
                    :disabled="isMutating"
                    class="px-3 py-1.5 rounded-lg bg-error text-on-error text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
                    @click="handleConfirmDeletePost(selectedPostDetail)"
                  >
                    {{
                      deletingPostId === selectedPostDetail.id
                        ? session.t('common.saving')
                        : session.t('forum.deleteConfirmBtn')
                    }}
                  </button>
                </div>
              </div>

              <div
                v-if="selectedPostDetail.hidden_at"
                role="status"
                class="rounded-xl border border-warning/40 bg-warning-container/25 px-4 py-3 flex items-start gap-3"
              >
                <span class="material-symbols-outlined text-[20px] text-warning shrink-0 mt-0.5" aria-hidden="true">
                  visibility_off
                </span>
                <div class="space-y-0.5 text-xs">
                  <p class="font-bold text-on-surface">{{ selectedPostHiddenBanner }}</p>
                  <p class="text-on-surface-variant">{{ session.t('forum.hiddenTopicNotice') }}</p>
                </div>
              </div>

              <div>
                <h2 class="text-lg sm:text-xl font-bold text-on-surface leading-snug mb-3">
                  {{ selectedPostDetail.title }}
                </h2>

                <div class="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-surface-container-high">
                  <AuthorBadge
                    v-if="selectedPostDetail.author_badge"
                    :badge="selectedPostDetail.author_badge"
                    :is-mine="selectedPostDetail.is_mine"
                  />
                  <div class="flex items-center gap-1.5">
                    <span class="text-xs font-mono text-on-surface-variant">
                      {{ formatDateTime(selectedPostDetail.created_at, session.lang) }}
                    </span>
                    <span
                      v-if="selectedPostDetail.edited_at"
                      class="text-xs text-on-surface-variant italic underline decoration-dotted cursor-help"
                      :title="
                        session.t('forum.editedAtTooltip', {
                          time: formatDateTime(selectedPostDetail.edited_at, session.lang),
                        })
                      "
                    >
                      {{ session.t('forum.editedLabel') }}
                    </span>
                  </div>
                </div>
              </div>

              <p
                class="text-sm sm:text-base whitespace-pre-line leading-relaxed"
                :class="selectedPostDetail.hidden_at ? 'text-on-surface-variant' : 'text-on-surface'"
              >
                {{ selectedPostDetail.body ?? '' }}
              </p>

              <!-- Comments & Inline Composer -->
              <div class="pt-4 border-t border-surface-container-high space-y-4">
                <h3 class="text-xs font-bold uppercase tracking-wider text-on-surface-variant flex items-center gap-1.5">
                  <span class="material-symbols-outlined text-[16px]">chat</span>
                  <span>{{ session.t('forum.commentsHeading') }} ({{ selectedPostDetail.comments_count ?? selectedPostDetail.comments?.length ?? 0 }})</span>
                </h3>

                <div
                  v-if="commentEditBannerError"
                  role="alert"
                  class="rounded-xl border border-error/40 bg-error-container/20 px-4 py-2.5 flex items-center justify-between gap-3 text-xs text-error font-medium"
                >
                  <span>{{ commentEditBannerError }}</span>
                  <button
                    type="button"
                    class="p-1 rounded hover:bg-error/10 cursor-pointer"
                    :aria-label="session.t('common.close')"
                    @click="commentEditBannerError = ''"
                  >
                    <span class="material-symbols-outlined text-[15px]">close</span>
                  </button>
                </div>

                <CommentList
                  :comments="selectedPostDetail.comments || []"
                  :post-type="selectedPostDetail.post_type"
                  :post-origin="selectedPostDetail.origin"
                  :post-hidden="Boolean(selectedPostDetail.hidden_at)"
                  :now-ms="nowMs"
                  :moderating-comment-id="moderatingCommentId"
                  :moderation-disabled="isMutating"
                  :editing-comment-id="editingCommentId"
                  :saving-edit-comment-id="savingEditCommentId"
                  :edit-comment-error="editCommentError"
                  :closed-edit-comment-ids="closedEditCommentIds"
                  @hide-comment="openHideCommentModal"
                  @unhide-comment="handleUnhideComment"
                  @start-edit-comment="handleStartEditComment"
                  @cancel-edit-comment="handleCancelEditComment"
                  @save-edit-comment="handleSaveEditComment"
                  @clear-comment-edit-error="editCommentError = ''"
                />

                <CommentComposer
                  v-if="!selectedPostDetail.hidden_at"
                  :key="selectedPostDetail.id"
                  :post-id="selectedPostDetail.id"
                  :disabled="selectedPostDetail.comments_enabled === false"
                  @added="handleCommentAdded"
                />
              </div>
            </div>
          </BaseCard>

          <!-- Empty Selection Fallback -->
          <BaseCard v-else class="text-center py-12 text-xs text-on-surface-variant">
            {{ session.t('forum.selectTopicPrompt') }}
          </BaseCard>
        </aside>
      </div>
    </template>

    <PostComposer
      :open="composerOpen"
      @close="composerOpen = false"
      @created="loadPosts"
    />

    <HideReasonModal
      :open="hideModalOpen"
      :target-type="hideTarget?.type || 'post'"
      :saving="isMutating"
      :error-msg="hideModalError"
      @close="closeHideModal"
      @submit="handleConfirmHide"
      @clear-error="hideModalError = ''"
    />

    <PostEditModal
      :open="editModalOpen"
      :post="selectedPostDetail"
      :saving="savingPostEdit"
      :error-msg="editModalError"
      @clear-error="editModalError = ''"
      @close="closeEditPostModal"
      @submit="handleConfirmPostEdit"
    />
  </div>
</template>
