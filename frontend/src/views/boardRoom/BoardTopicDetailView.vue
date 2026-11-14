<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { deletePost, editComment, editPost, getPost } from '@/api/endpoints/communication.js'
import { formatDateTime } from '@/utils/dates.js'
import { localizeError } from '@/locales/index.js'
import {
  canEditPost,
  getNextEditExpiryDelayMs,
  mergeUpdatedPostIntoDetail,
  replaceCommentInDetail,
} from '@/utils/communication.js'
import CommentList from '@/views/forum/components/CommentList.vue'
import CommentComposer from '@/views/forum/components/CommentComposer.vue'
import PostEditModal from '@/views/forum/components/PostEditModal.vue'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import PostOriginBadge from '@/components/domain/PostOriginBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const post = ref(null)
const loading = ref(false)
const error = ref(null)

// Delete confirmation state (available to CHAIRMAN and every BOARD member)
const confirmingDelete = ref(false)
const deleting = ref(false)
const deleteError = ref('')

// #027 Edit state
const nowMs = ref(Date.now())
const closedEditPostIds = ref(new Set())
const closedEditCommentIds = ref(new Set())
const editModalOpen = ref(false)
const savingPostEdit = ref(false)
const editModalError = ref('')
const postEditBannerError = ref('')
const editingCommentId = ref(null)
const savingEditCommentId = ref(null)
const editCommentError = ref('')
const commentEditBannerError = ref('')

const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)

const isNotFoundError = computed(
  () => error.value?.errorCode === 'POST_NOT_FOUND' || error.value?.status === 404,
)

const isMutating = computed(() =>
  Boolean(deleting.value || savingPostEdit.value || savingEditCommentId.value),
)

const canEditThisPost = computed(() =>
  canEditPost(post.value, nowMs.value, {
    serverClosed: Boolean(post.value?.id && closedEditPostIds.value.has(post.value.id)),
  }),
)

let loadTopicSeq = 0
let editSeq = 0
let editExpiryTimer = null

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

async function loadTopic({ silent = false } = {}) {
  const postId = String(route.params.postId || '')
  if (!postId || !isBoardOrChairman.value) {
    loadTopicSeq += 1
    post.value = null
    loading.value = false
    if (editExpiryTimer) {
      clearTimeout(editExpiryTimer)
      editExpiryTimer = null
    }
    return
  }
  const seq = ++loadTopicSeq
  const targetUserId = session.actingUserId
  const targetRole = session.me?.building_role
  const targetRev = session.sessionRevision
  if (!silent) {
    loading.value = true
    confirmingDelete.value = false
    deleteError.value = ''
    postEditBannerError.value = ''
    editingCommentId.value = null
    editCommentError.value = ''
    commentEditBannerError.value = ''
  }
  error.value = null
  try {
    const res = await getPost(postId)
    if (seq !== loadTopicSeq || !isSameSessionSnapshot(postId, targetUserId, targetRole, targetRev)) return
    post.value = res
    refreshNowClock()
  } catch (err) {
    if (seq !== loadTopicSeq || !isSameSessionSnapshot(postId, targetUserId, targetRole, targetRev)) return
    post.value = null
    error.value = err
  } finally {
    if (seq === loadTopicSeq) {
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
    router.push({ name: 'board-room' })
  } catch (err) {
    deleteError.value = localizeError(err.errorCode, err.payload, session.lang)
    deleting.value = false
  }
}

function openEditPostModal() {
  if (!canEditThisPost.value || isMutating.value) return
  confirmingDelete.value = false
  deleteError.value = ''
  postEditBannerError.value = ''
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
  postEditBannerError.value = ''
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
      postEditBannerError.value = localizeError(err.errorCode, err.payload, session.lang)
    } else if (err?.errorCode === 'POST_NOT_EDITABLE') {
      editModalOpen.value = false
      postEditBannerError.value = localizeError(err.errorCode, err.payload, session.lang)
      await loadTopic({ silent: true })
    } else if (err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND') {
      editModalOpen.value = false
      await loadTopic({ silent: true })
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
      await loadTopic({ silent: true })
    } else if (err?.status === 404 && err?.errorCode === 'POST_NOT_FOUND') {
      editingCommentId.value = null
      await loadTopic({ silent: true })
    } else {
      editCommentError.value = localizeError(err?.errorCode, err?.payload, session.lang)
    }
  } finally {
    if (seq === editSeq) {
      savingEditCommentId.value = null
    }
  }
}

onBeforeUnmount(() => {
  if (editExpiryTimer) clearTimeout(editExpiryTimer)
  if (typeof window !== 'undefined') {
    window.removeEventListener('focus', refreshNowClock)
  }
})

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', refreshNowClock)
  }
  loadTopic()
})

watch(
  () => [route.params.postId, session.actingUserId, session.me?.building_role, session.sessionRevision],
  () => {
    editSeq += 1
    if (editExpiryTimer) {
      clearTimeout(editExpiryTimer)
      editExpiryTimer = null
    }
    editModalOpen.value = false
    savingPostEdit.value = false
    editModalError.value = ''
    postEditBannerError.value = ''
    editingCommentId.value = null
    savingEditCommentId.value = null
    editCommentError.value = ''
    commentEditBannerError.value = ''
    closedEditPostIds.value = new Set()
    closedEditCommentIds.value = new Set()
    loadTopic()
  },
)
</script>

<template>
  <div class="w-full max-w-4xl mx-auto px-3 sm:px-gutter py-space-md sm:py-space-lg space-y-space-md">
    <!-- Top Back Link -->
    <div class="flex items-center justify-between gap-2">
      <RouterLink
        to="/board-room"
        class="inline-flex items-center gap-1.5 text-xs font-label-md font-semibold text-on-surface-variant hover:text-primary transition-colors"
      >
        <span class="material-symbols-outlined text-[16px]">arrow_back</span>
        <span>{{ session.t('boardRoom.backToBoardRoom') }}</span>
      </RouterLink>
    </div>

    <!-- No Access Fallback -->
    <div
      v-if="!isBoardOrChairman"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-lg text-center max-w-lg mx-auto my-space-lg space-y-4"
      role="alert"
    >
      <div class="w-12 h-12 rounded-full bg-error-container text-on-error-container flex items-center justify-center mx-auto">
        <span class="material-symbols-outlined text-[24px]">lock</span>
      </div>
      <h2 class="font-title-lg text-title-lg font-bold text-on-surface">
        {{ session.t('common.noAccessTitle') }}
      </h2>
      <p class="font-body-md text-body-md text-on-surface-variant">
        {{ session.t('errors.FORBIDDEN') }}
      </p>
      <div>
        <RouterLink
          to="/"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors"
        >
          <span class="material-symbols-outlined text-[16px]">arrow_back</span>
          <span>{{ session.t('nav.dashboard') }}</span>
        </RouterLink>
      </div>
    </div>

    <!-- Loading -->
    <div
      v-else-if="loading"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-xl text-center text-on-surface-variant text-sm"
    >
      {{ session.t('boardRoom.loadingTopic') }}
    </div>

    <!-- 404 POST_NOT_FOUND Friendly Notice -->
    <div
      v-else-if="isNotFoundError"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-lg text-center max-w-lg mx-auto space-y-4"
      role="alert"
    >
      <div class="w-12 h-12 rounded-full bg-surface-container text-on-surface-variant flex items-center justify-center mx-auto">
        <span class="material-symbols-outlined text-[24px]">meeting_room</span>
      </div>
      <h2 class="font-title-lg text-title-lg font-bold text-on-surface">
        {{ session.t('boardRoom.notFoundTitle') }}
      </h2>
      <p class="font-body-md text-body-md text-on-surface-variant">
        {{ session.t('boardRoom.notFoundBody') }}
      </p>
      <div>
        <RouterLink
          to="/board-room"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors"
        >
          <span class="material-symbols-outlined text-[16px]">arrow_back</span>
          <span>{{ session.t('boardRoom.backToBoardRoom') }}</span>
        </RouterLink>
      </div>
    </div>

    <!-- Other Error -->
    <ErrorCard
      v-else-if="error"
      :error="error"
      @retry="loadTopic"
    />

    <!-- Topic Detail -->
    <template v-else-if="post">
      <article class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-md sm:p-space-lg shadow-xs space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center px-2.5 py-0.5 rounded-md bg-secondary-container text-on-secondary-container text-xs font-label-md font-semibold uppercase tracking-wider">
              {{ session.t(`forum.categories.${post.category || 'GENERAL'}`) }}
            </span>
            <span class="text-xs font-label-md uppercase tracking-wider text-on-surface-variant">
              {{ session.t('boardRoom.eyebrow') }}
            </span>
          </div>

          <div class="flex flex-wrap items-center gap-2">
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

            <!-- Edit button for author when origin == null (no time limit for BOARD_TOPIC) -->
            <button
              v-if="canEditThisPost"
              type="button"
              :disabled="isMutating"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-primary/40 text-primary hover:bg-primary/10 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
              @click="openEditPostModal"
            >
              <span class="material-symbols-outlined text-[15px]" aria-hidden="true">edit</span>
              <span>{{ session.t('forum.editBtn') }}</span>
            </button>

            <!-- Delete button available to CHAIRMAN and every BOARD member -->
            <button
              v-if="!confirmingDelete"
              type="button"
              :disabled="isMutating"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-container hover:bg-error-container hover:text-on-error-container text-on-surface-variant text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
              @click="confirmingDelete = true"
            >
              <span class="material-symbols-outlined text-[15px]">delete</span>
              <span>{{ session.t('boardRoom.deleteTopicBtn') }}</span>
            </button>
          </div>
        </div>

        <div
          v-if="postEditBannerError"
          role="alert"
          class="rounded-xl border border-error/40 bg-error-container/20 px-4 py-2.5 flex items-center justify-between gap-3 text-xs text-error font-medium"
        >
          <span>{{ postEditBannerError }}</span>
          <button
            type="button"
            class="p-1 rounded hover:bg-error/10 cursor-pointer"
            :aria-label="session.t('common.close')"
            @click="postEditBannerError = ''"
          >
            <span class="material-symbols-outlined text-[15px]">close</span>
          </button>
        </div>

        <!-- Inline Delete Confirmation -->
        <div
          v-if="confirmingDelete"
          class="rounded-xl bg-error-container/20 border border-error/40 p-space-md flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          role="alert"
        >
          <div class="space-y-0.5">
            <p class="text-xs font-bold text-on-surface">
              {{ session.t('boardRoom.deleteConfirmTitle') }}
            </p>
            <p class="text-xs text-on-surface-variant">
              {{ session.t('boardRoom.deleteConfirmBody') }}
            </p>
            <p v-if="deleteError" class="text-xs text-error font-medium pt-1">
              {{ deleteError }}
            </p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <button
              type="button"
              :disabled="deleting"
              class="px-3 py-1.5 rounded-lg bg-surface-container text-on-surface text-xs font-semibold hover:bg-surface-container-high transition-colors cursor-pointer"
              @click="confirmingDelete = false"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="deleting"
              class="px-3 py-1.5 rounded-lg bg-error text-on-error text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="handleConfirmDelete"
            >
              {{ deleting ? session.t('common.saving') : session.t('boardRoom.deleteConfirmBtn') }}
            </button>
          </div>
        </div>

        <h1 class="font-headline-md text-xl sm:text-2xl font-bold text-on-surface">
          {{ post.title }}
        </h1>

        <p class="text-sm sm:text-base text-on-surface leading-relaxed whitespace-pre-line">
          {{ post.body ?? '' }}
        </p>

        <div class="pt-4 border-t border-surface-container flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <AuthorBadge
              v-if="post.author_badge"
              :badge="post.author_badge"
              :is-mine="post.is_mine"
            />
            <PostOriginBadge
              :origin="post.origin"
              post-type="BOARD_TOPIC"
            />
          </div>
          <span
            v-if="post.last_activity_at"
            class="text-xs text-on-surface-variant"
          >
            {{ session.t('boardRoom.lastActivityLabel') }}:
            {{ formatDateTime(post.last_activity_at, session.lang) }}
          </span>
        </div>
      </article>

      <!-- Comments & Composer (without author_apartment_id) -->
      <section class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-md sm:p-space-lg space-y-5">
        <h2 class="text-xs font-label-lg font-bold uppercase tracking-wider text-on-surface-variant">
          {{ session.t('forum.commentsHeading') }} ({{ post.comments_count ?? post.comments?.length ?? 0 }})
        </h2>

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
          :moderation-disabled="isMutating"
          :editing-comment-id="editingCommentId"
          :saving-edit-comment-id="savingEditCommentId"
          :edit-comment-error="editCommentError"
          :closed-edit-comment-ids="closedEditCommentIds"
          @start-edit-comment="handleStartEditComment"
          @cancel-edit-comment="handleCancelEditComment"
          @save-edit-comment="handleSaveEditComment"
          @clear-comment-edit-error="editCommentError = ''"
        />

        <CommentComposer
          :post-id="post.id"
          :disabled="post.comments_enabled === false"
          :omit-author-apartment="true"
          @added="loadTopic({ silent: true })"
        />
      </section>
    </template>

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
