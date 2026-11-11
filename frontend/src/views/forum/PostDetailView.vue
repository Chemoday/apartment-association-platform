<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { getPost, deletePost } from '@/api/endpoints/communication.js'
import { formatDateTime } from '@/utils/dates.js'
import CommentList from './components/CommentList.vue'
import CommentComposer from './components/CommentComposer.vue'
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
const { canDeleteForumTopic } = useRole()

const post = ref(null)
const loading = ref(false)
const error = ref(null)
const linkCopied = ref(false)
let copyTimer = null

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

async function loadPost() {
  const postId = route.params.postId
  if (!postId) return
  loading.value = true
  error.value = null
  try {
    post.value = await getPost(postId)
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

async function handleDelete() {
  if (!post.value?.id) return
  try {
    await deletePost(post.value.id)
    router.push({ name: 'forum' })
  } catch (err) {
    error.value = err
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
})

watch(
  () => [route.params.postId, session.actingUserId, session.sessionRevision],
  () => {
    loadPost()
  },
)

onMounted(() => {
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

      <div v-if="post" class="flex items-center gap-2">
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
          v-if="canDeleteForumTopic && post.post_type === 'FORUM_TOPIC'"
          type="button"
          class="px-3 py-1.5 rounded-xl border border-error/30 bg-surface-container-lowest hover:bg-error-container/30 text-xs font-semibold text-error inline-flex items-center gap-1.5 transition-colors cursor-pointer"
          @click="handleDelete"
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

          <PostOriginBadge
            :origin="post.origin"
            :post-type="post.post_type"
          />

          <span class="inline-flex items-center gap-1 text-xs text-on-surface-variant">
            <span class="material-symbols-outlined text-[14px]">apartment</span>
            <span>{{ targetScopeLabel }}</span>
          </span>
        </div>

        <span class="text-xs font-mono text-on-surface-variant">
          {{ formatDateTime(post.created_at, session.lang) }}
        </span>
      </div>

      <!-- Post Article Body -->
      <div class="p-5 sm:p-7 space-y-6">
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

        <p class="text-sm sm:text-base text-on-surface leading-relaxed whitespace-pre-line">
          {{ post.body }}
        </p>

        <!-- Discussion & Reply Section -->
        <div class="pt-6 border-t border-surface-container-high space-y-5">
          <div class="flex items-center justify-between">
            <h2 class="text-xs font-bold uppercase tracking-wider text-on-surface-variant flex items-center gap-1.5">
              <span class="material-symbols-outlined text-[16px]">chat</span>
              <span>{{ session.t('forum.commentsHeading') }} ({{ post.comments?.length ?? 0 }})</span>
            </h2>
          </div>

          <CommentList :comments="post.comments || []" />

          <CommentComposer
            :post-id="post.id"
            :disabled="post.comments_enabled === false"
            @added="loadPost"
          />
        </div>
      </div>
    </BaseCard>
  </div>
</template>
