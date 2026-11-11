<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { listPosts, getPost, deletePost } from '@/api/endpoints/communication.js'
import { formatDateTime } from '@/utils/dates.js'
import PostList from './components/PostList.vue'
import PostComposer from './components/PostComposer.vue'
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
const { canDeleteForumTopic } = useRole()

const posts = ref([])
const loading = ref(false)
const error = ref(null)
const activeFilter = ref('ALL')
const searchQuery = ref('')
const composerOpen = ref(false)

const selectedPostDetail = ref(null)
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
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return posts.value
  return posts.value.filter(
    (p) =>
      String(p.title || '').toLowerCase().includes(q) ||
      String(p.body || '').toLowerCase().includes(q),
  )
})

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

async function loadPosts() {
  if (!session.actingUserId) return
  const seq = ++loadPostsSeq
  loading.value = true
  error.value = null
  try {
    const params = { limit: 30 }
    if (activeFilter.value === 'OFFICIAL_NOTICE') {
      params.post_type = 'OFFICIAL_NOTICE'
    } else if (activeFilter.value !== 'ALL') {
      params.category = activeFilter.value
    }

    const data = await listPosts(params)
    if (seq !== loadPostsSeq) return
    posts.value = Array.isArray(data)
      ? data.filter((p) => p.post_type !== 'BOARD_TOPIC' && p.post_type !== 'APARTMENT_THREAD')
      : []
    if (posts.value.length > 0) {
      const stillExists =
        selectedPostDetail.value && posts.value.some((p) => p.id === selectedPostDetail.value.id)
      const targetId = stillExists ? selectedPostDetail.value.id : posts.value[0].id
      await selectPost({ id: targetId })
    } else {
      selectedPostDetail.value = null
    }
  } catch (err) {
    if (seq !== loadPostsSeq) return
    error.value = err
  } finally {
    if (seq === loadPostsSeq) {
      loading.value = false
    }
  }
}

async function selectPost(post) {
  if (!post?.id) return
  const seq = ++selectPostSeq
  try {
    const detail = await getPost(post.id)
    if (seq !== selectPostSeq) return
    selectedPostDetail.value = detail
  } catch {
    if (seq !== selectPostSeq) return
    selectedPostDetail.value = post
  }
}

function openPostDetail(post) {
  router.push({ name: 'forum-detail', params: { postId: post.id } })
}

async function handleDeletePost(post) {
  if (!post?.id) return
  try {
    await deletePost(post.id)
    if (selectedPostDetail.value?.id === post.id) {
      selectedPostDetail.value = null
    }
    await loadPosts()
  } catch (err) {
    error.value = err
  }
}

async function handleCommentAdded() {
  if (selectedPostDetail.value?.id) {
    await selectPost({ id: selectedPostDetail.value.id })
    const idx = posts.value.findIndex((p) => p.id === selectedPostDetail.value.id)
    if (idx !== -1 && selectedPostDetail.value.comments) {
      posts.value[idx].comments_count = selectedPostDetail.value.comments.length
    }
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
  loadPosts()
})

watch(
  () => [session.actingUserId, session.sessionRevision],
  () => {
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
  if (route.query.compose === '1') {
    composerOpen.value = true
  }
  loadPosts()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
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
        class="px-3.5 py-1.5 rounded-xl text-xs font-semibold transition-all inline-flex items-center gap-1.5"
        :class="
          activeFilter === f.key
            ? 'bg-primary text-on-primary shadow-2xs'
            : 'bg-surface-container-lowest border border-surface-container-high text-on-surface-variant hover:text-on-surface'
        "
        @click="activeFilter = f.key"
      >
        <span v-if="f.icon" class="material-symbols-outlined text-[15px]">{{ f.icon }}</span>
        <span>{{ f.label }}</span>
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
                  {{ notice.body }}
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
            @select="selectPost"
            @open-detail="openPostDetail"
            @delete-post="handleDeletePost"
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

                <PostOriginBadge
                  :origin="selectedPostDetail.origin"
                  :post-type="selectedPostDetail.post_type"
                />

                <span class="inline-flex items-center gap-1 text-xs text-on-surface-variant">
                  <span class="material-symbols-outlined text-[14px]">apartment</span>
                  <span>{{ getTargetScopeLabel(selectedPostDetail) }}</span>
                </span>
              </div>

              <div class="flex items-center gap-2">
                <button
                  v-if="canDeleteForumTopic && selectedPostDetail.post_type === 'FORUM_TOPIC'"
                  type="button"
                  class="px-2.5 py-1 rounded-lg border border-error/30 text-xs font-semibold text-error hover:bg-error-container/30 inline-flex items-center gap-1 transition-colors"
                  @click="handleDeletePost(selectedPostDetail)"
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
                  <span class="text-xs font-mono text-on-surface-variant">
                    {{ formatDateTime(selectedPostDetail.created_at, session.lang) }}
                  </span>
                </div>
              </div>

              <p class="text-sm sm:text-base text-on-surface whitespace-pre-line leading-relaxed">
                {{ selectedPostDetail.body }}
              </p>

              <!-- Comments & Inline Composer -->
              <div class="pt-4 border-t border-surface-container-high space-y-4">
                <h3 class="text-xs font-bold uppercase tracking-wider text-on-surface-variant flex items-center gap-1.5">
                  <span class="material-symbols-outlined text-[16px]">chat</span>
                  <span>{{ session.t('forum.commentsHeading') }} ({{ selectedPostDetail.comments?.length ?? 0 }})</span>
                </h3>

                <CommentList :comments="selectedPostDetail.comments || []" />

                <CommentComposer
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
  </div>
</template>
