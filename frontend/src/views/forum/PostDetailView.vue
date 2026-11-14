<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import {
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
  mergeUpdatedPostIntoDetail,
  replaceCommentInDetail,
} from '@/utils/communication.js'
import CommentList from './components/CommentList.vue'
import CommentComposer from './components/CommentComposer.vue'
import HideReasonModal from './components/HideReasonModal.vue'
import PostEditModal from './components/PostEditModal.vue'
import BaseCard from '@/components/base/BaseCard.vue'
import BaseButton from '@/components/base/BaseButton.vue'
import BaseChip from '@/components/base/BaseChip.vue'
import BaseSkeleton from '@/components/base/BaseSkeleton.vue'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import PostOriginBadge from '@/components/domain/PostOriginBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const { canDeleteForumTopic, canModerateForum } = useRole()

const post = ref(null)
const loading = ref(false)
const error = ref(null)
const confirmingDelete = ref(false)
const deleting = ref(false)
const deleteError = ref('')
const hideModalOpen = ref(false)
const hideTarget = ref(null)
const hideModalError = ref('')
const moderationError = ref('')
const moderatingPost = ref(false)
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
    deleting.value ||
      moderatingPost.value ||
      moderatingCommentId.value ||
      savingPostEdit.value ||
      savingEditCommentId.value,
  ),
)

const canEditThisPost = computed(() =>
  canEditPost(post.value, nowMs.value, {
    serverClosed: Boolean(post.value?.id && closedEditPostIds.value.has(post.value.id)),
  }),
)

const linkCopied = ref(false)
let copyTimer = null
let editExpiryTimer = null
let loadPostSeq = 0
let moderationSeq = 0
let editSeq = 0

function scheduleEditExpiryTimer() {
  if (editExpiryTimer) {
    clearTimeout(editExpiryTimer)
    editExpiryTimer = null
  }
  const delayMs = getNextEditExpiryDelayMs(post.value, nowMs.value)
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

function isSameSessionSnapshot(postId, userId, role, rev) {
  return (
    String(route.params.postId || '') === postId &&
    session.actingUserId === userId &&
    session.me?.building_role === role &&
    session.sessionRevision === rev
  )
}

const categoryLabel = computed(() => {
  if (!post.value) return ''
  if (post.value.post_type === 'OFFICIAL_NOTICE') {
    return session.t('forum.officialNoticeBadge')
  }
  switch (post.value.category) {
    case 'MAINTENANCE':
      return session.t('forum.filterMaintenance')
    case 'WATER_SHUTOFF':
      return session.t('forum.waterShutoffCategory')
    case 'MARKETPLACE':
      return session.t('forum.filterMarketplace')
    default:
      return session.t('forum.filterGeneral')
  }
})

const categoryTone = computed(() => {
  if (!post.value) return 'neutral'
  if (post.value.post_type === 'OFFICIAL_NOTICE') return 'primary'
  if (post.value.category === 'MAINTENANCE' || post.value.category === 'WATER_SHUTOFF') return 'warning'
  return 'neutral'
})

const targetScopeLabel = computed(() => {
  if (!post.value) return ''
  if (post.value.target_scope === 'ENTRANCE' && post.value.target_entrance) {
    return session.t('forum.targetEntrance', { number: post.value.target_entrance })
  }
  if (post.value.target_scope === 'APARTMENT_LIST') {
    return session.t('forum.targetApartments')
  }
  return session.t('forum.targetAllBuilding')
})

const authorInitial = computed(() => {
  const label = post.value?.author_badge?.display_label || '?'
  return label.trim().charAt(0).toUpperCase()
})

const hiddenBannerText = computed(() =>
  formatHiddenByBoardBanner(post.value, (key, params) => session.t(key, params)),
)

async function loadPost({ silent = false } = {}) {
  const postId = route.params.postId
  if (!postId) return
  const seq = ++loadPostSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  if (!silent) {
    post.value = null
    confirmingDelete.value = false
    deleteError.value = ''
    moderationError.value = ''
    commentEditBannerError.value = ''
    editingCommentId.value = null
    editCommentError.value = ''
    loading.value = true
  }
  error.value = null
  try {
    const detail = await getPost(postId)
    if (seq !== loadPostSeq || !isSameSessionSnapshot(postId, targetUserId, targetRole, targetRev)) return
    post.value = detail
    refreshNowClock()
  } catch (err) {
    if (seq !== loadPostSeq || !isSameSessionSnapshot(postId, targetUserId, targetRole, targetRev)) return
    post.value = null
    error.value = err
  } finally {
    if (seq === loadPostSeq) {
      loading.value = false
    }
  }
}

async function handleConfirmDelete() {
  if (!post.value?.id || isMutating.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    await deletePost(post.value.id)
    router.push({ name: 'forum' })
  } catch (err) {
    if (err?.status === 404) {
      router.push({ name: 'forum' })
      return
    }
    deleteError.value = localizeError(err?.errorCode, err?.payload, session.lang)
  } finally {
    deleting.value = false
  }
}

function openEditPostModal() {
  if (!canEditThisPost.value || isMutating.value) return
  confirmingDelete.value = false
  deleteError.value = ''
  moderationError.value = ''
  editModalError.value = ''
  editModalOpen.value = true
}

function closeEditPostModal() {
  if (savingPostEdit.value) return
  editModalOpen.value = false
  editModalError.value = ''
}

async function handleConfirmPostEdit(payload) {
  const targetPostId = post.value?.id
  if (!targetPostId || isMutating.value) return
  const seq = ++editSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  savingPostEdit.value = true
  editModalError.value = ''
  moderationError.value = ''
  try {
    const updated = await editPost(targetPostId, payload)
    if (
      seq !== editSeq ||
      !isSameSessionSnapshot(targetPostId, targetUserId, targetRole, targetRev)
    ) {
      return
    }
    if (post.value?.id === updated.id) {
      post.value = mergeUpdatedPostIntoDetail(post.value, updated)
    }
    editModalOpen.value = false
  } catch (err) {
    if (
      seq !== editSeq ||
      !isSameSessionSnapshot(targetPostId, targetUserId, targetRole, targetRev)
    ) {
      return
    }
    if (err?.errorCode === 'EDIT_WINDOW_CLOSED') {
      const next = new Set(closedEditPostIds.value)
      next.add(targetPostId)
      closedEditPostIds.value = next
      editModalOpen.value = false
      moderationError.value = localizeError(err.errorCode, err.payload, session.lang)
    } else if (err?.errorCode === 'POST_NOT_EDITABLE') {
      editModalOpen.value = false
      moderationError.value = localizeError(err.errorCode, err.payload, session.lang)
      await loadPost({ silent: true })
    } else if (err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND') {
      editModalOpen.value = false
      await loadPost({ silent: true })
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
  const targetPostId = post.value?.id
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
      !isSameSessionSnapshot(targetPostId, targetUserId, targetRole, targetRev)
    ) {
      return
    }
    if (post.value?.id === targetPostId) {
      post.value = replaceCommentInDetail(post.value, updatedComment)
    }
    editingCommentId.value = null
  } catch (err) {
    if (
      seq !== editSeq ||
      !isSameSessionSnapshot(targetPostId, targetUserId, targetRole, targetRev)
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
      await loadPost({ silent: true })
    } else if (err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND') {
      editingCommentId.value = null
      await loadPost({ silent: true })
    } else {
      editCommentError.value = localizeError(err?.errorCode, err?.payload, session.lang)
    }
  } finally {
    if (seq === editSeq) {
      savingEditCommentId.value = null
    }
  }
}

function openHidePostModal() {
  if (!post.value?.id || isMutating.value) return
  confirmingDelete.value = false
  deleteError.value = ''
  hideTarget.value = { type: 'post', postId: post.value.id }
  hideModalError.value = ''
  moderationError.value = ''
  hideModalOpen.value = true
}

function openHideCommentModal(comment) {
  if (!post.value?.id || !comment?.id || isMutating.value) return
  confirmingDelete.value = false
  deleteError.value = ''
  hideTarget.value = { type: 'comment', postId: post.value.id, commentId: comment.id }
  hideModalError.value = ''
  moderationError.value = ''
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

  if (target.type === 'post') {
    moderatingPost.value = true
    try {
      const updated = await hidePost(target.postId, { reason })
      if (
        seq !== moderationSeq ||
        !isSameSessionSnapshot(target.postId, targetUserId, targetRole, targetRev)
      ) {
        return
      }
      if (post.value?.id === updated.id) {
        post.value = mergeUpdatedPostIntoDetail(post.value, updated)
      }
      hideModalOpen.value = false
      hideTarget.value = null
    } catch (err) {
      if (
        seq === moderationSeq &&
        isSameSessionSnapshot(target.postId, targetUserId, targetRole, targetRev)
      ) {
        hideModalError.value = localizeError(err?.errorCode, err?.payload, session.lang)
      }
    } finally {
      if (seq === moderationSeq) {
        moderatingPost.value = false
      }
    }
    return
  }

  moderatingCommentId.value = target.commentId
  try {
    const updatedComment = await hideComment(target.postId, target.commentId, { reason })
    if (
      seq !== moderationSeq ||
      !isSameSessionSnapshot(target.postId, targetUserId, targetRole, targetRev)
    ) {
      return
    }
    if (post.value?.id === target.postId) {
      post.value = replaceCommentInDetail(post.value, updatedComment)
    }
    hideModalOpen.value = false
    hideTarget.value = null
  } catch (err) {
    if (
      seq === moderationSeq &&
      isSameSessionSnapshot(target.postId, targetUserId, targetRole, targetRev)
    ) {
      hideModalError.value = localizeError(err?.errorCode, err?.payload, session.lang)
    }
  } finally {
    if (seq === moderationSeq) {
      moderatingCommentId.value = null
    }
  }
}

async function handleUnhidePost() {
  const targetPostId = post.value?.id
  if (!targetPostId || isMutating.value) return
  const seq = ++moderationSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  confirmingDelete.value = false
  deleteError.value = ''
  moderatingPost.value = true
  moderationError.value = ''
  try {
    const updated = await unhidePost(targetPostId)
    if (
      seq !== moderationSeq ||
      !isSameSessionSnapshot(targetPostId, targetUserId, targetRole, targetRev)
    ) {
      return
    }
    if (post.value?.id === updated.id) {
      post.value = mergeUpdatedPostIntoDetail(post.value, updated)
      refreshNowClock()
    }
  } catch (err) {
    if (
      seq === moderationSeq &&
      isSameSessionSnapshot(targetPostId, targetUserId, targetRole, targetRev)
    ) {
      moderationError.value = localizeError(err?.errorCode, err?.payload, session.lang)
    }
  } finally {
    if (seq === moderationSeq) {
      moderatingPost.value = false
    }
  }
}

async function handleUnhideComment(comment) {
  const targetPostId = post.value?.id
  if (!targetPostId || !comment?.id || isMutating.value) return
  const seq = ++moderationSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  confirmingDelete.value = false
  deleteError.value = ''
  moderatingCommentId.value = comment.id
  moderationError.value = ''
  try {
    const updatedComment = await unhideComment(targetPostId, comment.id)
    if (
      seq !== moderationSeq ||
      !isSameSessionSnapshot(targetPostId, targetUserId, targetRole, targetRev)
    ) {
      return
    }
    if (post.value?.id === targetPostId) {
      post.value = replaceCommentInDetail(post.value, updatedComment)
      refreshNowClock()
    }
  } catch (err) {
    if (
      seq === moderationSeq &&
      isSameSessionSnapshot(targetPostId, targetUserId, targetRole, targetRev)
    ) {
      moderationError.value = localizeError(err?.errorCode, err?.payload, session.lang)
    }
  } finally {
    if (seq === moderationSeq) {
      moderatingCommentId.value = null
    }
  }
}

async function handleCopyLink() {
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(window.location.href)
    }
    linkCopied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => {
      linkCopied.value = false
    }, 2500)
  } catch {
    // Ignore clipboard error
  }
}

onBeforeUnmount(() => {
  if (copyTimer) clearTimeout(copyTimer)
  if (editExpiryTimer) clearTimeout(editExpiryTimer)
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', refreshNowClock)
  }
})

watch(
  () => [route.params.postId, session.actingUserId, session.me?.building_role, session.sessionRevision],
  () => {
    loadPostSeq += 1
    moderationSeq += 1
    editSeq += 1
    if (editExpiryTimer) {
      clearTimeout(editExpiryTimer)
      editExpiryTimer = null
    }
    post.value = null
    confirmingDelete.value = false
    deleteError.value = ''
    deleting.value = false
    hideModalOpen.value = false
    hideTarget.value = null
    hideModalError.value = ''
    moderationError.value = ''
    moderatingPost.value = false
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
    loadPost()
  },
)

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', refreshNowClock)
  }
  loadPost()
})
</script>

<template>
  <div class="w-full max-w-4xl mx-auto px-gutter py-space-lg space-y-5">
    <!-- Top Navigation & Utility Bar -->
    <div class="flex flex-wrap items-center justify-between gap-3">
      <BaseButton
        variant="ghost"
        size="sm"
        @click="router.push({ name: 'forum' })"
      >
        <span class="material-symbols-outlined text-[16px]">arrow_back</span>
        <span>{{ session.t('forum.backToForum') }}</span>
      </BaseButton>

      <div v-if="post" class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="px-3 py-1.5 rounded-xl border border-outline-variant/50 bg-surface-container-lowest hover:bg-surface-container-low text-xs font-semibold text-on-surface inline-flex items-center gap-1.5 transition-colors cursor-pointer"
          @click="handleCopyLink"
        >
          <span class="material-symbols-outlined text-[15px] text-primary">
            {{ linkCopied ? 'check' : 'link' }}
          </span>
          <span>
            {{ linkCopied ? session.t('forum.linkCopiedFeedback') : session.t('forum.copyLinkBtn') }}
          </span>
        </button>

        <button
          v-if="canEditThisPost"
          type="button"
          :disabled="isMutating"
          class="px-3 py-1.5 rounded-xl border border-primary/40 bg-surface-container-lowest hover:bg-primary/10 text-xs font-semibold text-primary inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
          @click="openEditPostModal"
        >
          <span class="material-symbols-outlined text-[15px]" aria-hidden="true">edit</span>
          <span>{{ session.t('forum.editBtn') }}</span>
        </button>

        <button
          v-if="canModerateForum && isPostHideable(post)"
          type="button"
          :disabled="isMutating"
          class="px-3 py-1.5 rounded-xl border border-warning/40 bg-surface-container-lowest hover:bg-warning-container/25 text-xs font-semibold text-on-surface inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
          @click="post.hidden_at ? handleUnhidePost() : openHidePostModal()"
        >
          <span class="material-symbols-outlined text-[15px] text-warning" aria-hidden="true">
            {{ post.hidden_at ? 'visibility' : 'visibility_off' }}
          </span>
          <span>{{ post.hidden_at ? session.t('forum.unhideBtn') : session.t('forum.hideBtn') }}</span>
        </button>

        <button
          v-if="canDeleteForumTopic && post.post_type === 'FORUM_TOPIC' && !confirmingDelete"
          type="button"
          :disabled="isMutating"
          class="px-3 py-1.5 rounded-xl border border-error/30 bg-surface-container-lowest hover:bg-error-container/30 text-xs font-semibold text-error inline-flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
          @click="confirmingDelete = true; deleteError = ''"
        >
          <span class="material-symbols-outlined text-[15px]">delete</span>
          <span>{{ session.t('common.delete') }}</span>
        </button>
      </div>
    </div>

    <BaseSkeleton v-if="loading" :lines="4" />

    <ErrorCard
      v-else-if="error"
      :error="error"
      @retry="loadPost"
    />

    <!-- Unified Single-Card Thread View (Header + Body + Discussion + Composer) -->
    <BaseCard v-else-if="post" padding="none" class="overflow-hidden">
      <!-- Top Metadata Strip -->
      <div class="px-5 sm:px-7 py-4 border-b border-surface-container-high bg-surface-container-low/40 flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2">
          <BaseChip :tone="categoryTone">
            <span v-if="post.post_type === 'OFFICIAL_NOTICE'" class="material-symbols-outlined text-[13px] mr-0.5">
              campaign
            </span>
            <span>{{ categoryLabel }}</span>
          </BaseChip>

          <BaseChip v-if="post.hidden_at" tone="warning">
            <span class="material-symbols-outlined text-[13px] mr-0.5" aria-hidden="true">visibility_off</span>
            <span>{{ session.t('forum.hiddenTopicBadge') }}</span>
          </BaseChip>

          <PostOriginBadge
            :origin="post.origin"
            :post-type="post.post_type"
          />

          <span class="inline-flex items-center gap-1 text-xs text-on-surface-variant">
            <span class="material-symbols-outlined text-[14px]">apartment</span>
            <span>{{ targetScopeLabel }}</span>
          </span>
        </div>

        <div class="flex items-center gap-1.5">
          <span class="text-xs font-mono text-on-surface-variant">
            {{ formatDateTime(post.created_at, session.lang) }}
          </span>
          <span
            v-if="post.edited_at"
            class="text-xs text-on-surface-variant italic underline decoration-dotted cursor-help"
            :title="
              session.t('forum.editedAtTooltip', {
                time: formatDateTime(post.edited_at, session.lang),
              })
            "
          >
            {{ session.t('forum.editedLabel') }}
          </span>
        </div>
      </div>

      <!-- Post Article Body -->
      <div class="p-5 sm:p-7 space-y-6">
        <div
          v-if="moderationError"
          role="alert"
          class="rounded-xl border border-error/40 bg-error-container/20 px-4 py-2.5 flex items-center justify-between gap-3 text-xs text-error font-medium"
        >
          <span>{{ moderationError }}</span>
          <button
            type="button"
            class="p-1 rounded hover:bg-error/10 cursor-pointer"
            :aria-label="session.t('common.close')"
            @click="moderationError = ''"
          >
            <span class="material-symbols-outlined text-[15px]">close</span>
          </button>
        </div>

        <div
          v-if="confirmingDelete"
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
            <p v-if="deleteError" class="text-xs text-error font-medium pt-1">
              {{ deleteError }}
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              :disabled="deleting"
              class="px-3 py-1.5 rounded-lg bg-surface-container text-on-surface text-xs font-semibold hover:bg-surface-container-high transition-colors cursor-pointer disabled:opacity-50"
              @click="confirmingDelete = false; deleteError = ''"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="deleting"
              class="px-3 py-1.5 rounded-lg bg-error text-on-error text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="handleConfirmDelete"
            >
              {{ deleting ? session.t('common.saving') : session.t('forum.deleteConfirmBtn') }}
            </button>
          </div>
        </div>

        <div
          v-if="post.hidden_at"
          role="status"
          class="rounded-xl border border-warning/40 bg-warning-container/25 px-4 py-3 flex items-start gap-3"
        >
          <span class="material-symbols-outlined text-[20px] text-warning shrink-0 mt-0.5" aria-hidden="true">
            visibility_off
          </span>
          <div class="space-y-0.5 text-xs">
            <p class="font-bold text-on-surface">{{ hiddenBannerText }}</p>
            <p class="text-on-surface-variant">{{ session.t('forum.hiddenTopicNotice') }}</p>
          </div>
        </div>

        <div>
          <h1 class="text-xl sm:text-2xl font-bold text-on-surface leading-snug mb-4">
            {{ post.title }}
          </h1>

          <div class="flex flex-wrap items-center justify-between gap-3 pb-5 border-b border-surface-container-high">
            <div class="flex items-center gap-2.5">
              <div class="w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center text-xs font-bold">
                {{ authorInitial }}
              </div>
              <AuthorBadge
                v-if="post.author_badge"
                :badge="post.author_badge"
                :is-mine="post.is_mine"
              />
            </div>

            <span v-if="post.last_activity_at" class="text-xs text-on-surface-variant">
              {{ session.t('forum.lastActivityLabel') }}:
              <span class="font-mono">{{ formatDateTime(post.last_activity_at, session.lang) }}</span>
            </span>
          </div>
        </div>

        <p
          class="text-sm sm:text-base leading-relaxed whitespace-pre-line"
          :class="post.hidden_at ? 'text-on-surface-variant' : 'text-on-surface'"
        >
          {{ post.body ?? '' }}
        </p>

        <!-- Discussion & Reply Section -->
        <div class="pt-6 border-t border-surface-container-high space-y-5">
          <div class="flex items-center justify-between">
            <h2 class="text-xs font-bold uppercase tracking-wider text-on-surface-variant flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[16px]">chat</span>
              <span>{{ session.t('forum.commentsHeading') }} ({{ post.comments_count ?? post.comments?.length ?? 0 }})</span>
            </h2>
          </div>

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
            :comments="post.comments || []"
            :post-type="post.post_type"
            :post-origin="post.origin"
            :post-hidden="Boolean(post.hidden_at)"
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
            v-if="!post.hidden_at"
            :key="post.id"
            :post-id="post.id"
            :disabled="post.comments_enabled === false"
            @added="loadPost({ silent: true })"
          />
        </div>
      </div>
    </BaseCard>

    <HideReasonModal
      :open="hideModalOpen"
      :target-type="hideTarget?.type || 'post'"
      :saving="isMutating"
      :error-msg="hideModalError"
      @clear-error="hideModalError = ''"
      @close="closeHideModal"
      @submit="handleConfirmHide"
    />

    <PostEditModal
      :open="editModalOpen"
      :post="post"
      :saving="savingPostEdit"
      :error-msg="editModalError"
      @clear-error="editModalError = ''"
      @close="closeEditPostModal"
      @submit="handleConfirmPostEdit"
    />
  </div>
</template>
