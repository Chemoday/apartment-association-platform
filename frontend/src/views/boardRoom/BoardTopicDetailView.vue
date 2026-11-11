<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { deletePost, getPost } from '@/api/endpoints/communication.js'
import { formatDateTime } from '@/utils/dates.js'
import { localizeError } from '@/locales/index.js'
import CommentList from '@/views/forum/components/CommentList.vue'
import CommentComposer from '@/views/forum/components/CommentComposer.vue'
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

const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)

const isNotFoundError = computed(
  () => error.value?.errorCode === 'POST_NOT_FOUND' || error.value?.status === 404,
)

let loadTopicSeq = 0

async function loadTopic() {
  const postId = String(route.params.postId || '')
  if (!postId || !isBoardOrChairman.value) {
    loadTopicSeq += 1
    post.value = null
    loading.value = false
    return
  }
  const seq = ++loadTopicSeq
  loading.value = true
  error.value = null
  confirmingDelete.value = false
  deleteError.value = ''
  try {
    const res = await getPost(postId)
    if (seq !== loadTopicSeq) return
    post.value = res
  } catch (err) {
    if (seq !== loadTopicSeq) return
    error.value = err
  } finally {
    if (seq === loadTopicSeq) {
      loading.value = false
    }
  }
}

async function handleConfirmDelete() {
  if (!post.value?.id || deleting.value) return
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

onMounted(loadTopic)

watch(
  () => [route.params.postId, session.actingUserId, session.me?.building_role, session.sessionRevision],
  () => {
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

          <div class="flex items-center gap-3">
            <span class="text-xs font-mono text-on-surface-variant">
              {{ formatDateTime(post.created_at, session.lang) }}
            </span>

            <!-- Delete button available to CHAIRMAN and every BOARD member -->
            <button
              v-if="!confirmingDelete"
              type="button"
              class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-surface-container hover:bg-error-container hover:text-on-error-container text-on-surface-variant text-xs font-semibold transition-colors cursor-pointer"
              @click="confirmingDelete = true"
            >
              <span class="material-symbols-outlined text-[15px]">delete</span>
              <span>{{ session.t('boardRoom.deleteTopicBtn') }}</span>
            </button>
          </div>
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
          {{ post.body }}
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
          {{ session.t('forum.commentsHeading') }} ({{ post.comments?.length ?? 0 }})
        </h2>

        <CommentList :comments="post.comments || []" />

        <CommentComposer
          :post-id="post.id"
          :disabled="post.comments_enabled === false"
          :omit-author-apartment="true"
          @added="loadTopic"
        />
      </section>
    </template>
  </div>
</template>
