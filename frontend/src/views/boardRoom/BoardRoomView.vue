<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { createBoardTopic, listBoardTopics } from '@/api/endpoints/communication.js'
import { formatDateTime, formatRelativeTime } from '@/utils/dates.js'
import { localizeError } from '@/locales/index.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const router = useRouter()
const session = useSessionStore()

const topics = ref([])
const loading = ref(false)
const loadError = ref(null)

const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)

// Compose new board topic form state
const showComposer = ref(false)
const draftCategory = ref('GENERAL')
const draftTitle = ref('')
const draftBody = ref('')
const draftCommentsEnabled = ref(true)
const submitting = ref(false)
const submitError = ref('')

const categories = ['GENERAL', 'MAINTENANCE', 'WATER_SHUTOFF', 'MARKETPLACE']

const trimmedTitle = computed(() => draftTitle.value.trim())
const trimmedBody = computed(() => draftBody.value.trim())
const canSubmitTopic = computed(
  () =>
    trimmedTitle.value.length >= 1 &&
    trimmedTitle.value.length <= 255 &&
    trimmedBody.value.length >= 1 &&
    trimmedBody.value.length <= 10000 &&
    !submitting.value,
)

let fetchTopicsSeq = 0

async function fetchTopics() {
  if (!isBoardOrChairman.value) {
    fetchTopicsSeq += 1
    topics.value = []
    loading.value = false
    return
  }
  const seq = ++fetchTopicsSeq
  loading.value = true
  loadError.value = null
  try {
    const res = await listBoardTopics()
    if (seq !== fetchTopicsSeq) return
    const list = Array.isArray(res) ? res : []
    topics.value = [...list].sort((a, b) => {
      const aTime = new Date(a.last_activity_at || a.created_at).getTime()
      const bTime = new Date(b.last_activity_at || b.created_at).getTime()
      return bTime - aTime
    })
  } catch (err) {
    if (seq !== fetchTopicsSeq) return
    loadError.value = err
  } finally {
    if (seq === fetchTopicsSeq) {
      loading.value = false
    }
  }
}

function openComposeForm() {
  submitError.value = ''
  showComposer.value = true
}

async function handleCreateTopic() {
  if (!canSubmitTopic.value) return
  submitting.value = true
  submitError.value = ''
  try {
    const created = await createBoardTopic({
      title: trimmedTitle.value,
      body: trimmedBody.value,
      category: draftCategory.value,
      comments_enabled: draftCommentsEnabled.value,
    })
    draftTitle.value = ''
    draftBody.value = ''
    draftCategory.value = 'GENERAL'
    draftCommentsEnabled.value = true
    showComposer.value = false
    if (created?.id) {
      router.push({ name: 'board-room-detail', params: { postId: created.id } })
    } else {
      await fetchTopics()
    }
  } catch (err) {
    submitError.value = localizeError(err.errorCode, err.payload, session.lang)
  } finally {
    submitting.value = false
  }
}

onMounted(fetchTopics)

watch(
  () => [session.actingUserId, session.me?.building_role, session.sessionRevision],
  () => {
    fetchTopics()
  },
)
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-space-md sm:py-space-lg space-y-space-lg">
    <!-- Header -->
    <header class="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-surface-container pb-space-md">
      <div>
        <div class="inline-flex items-center gap-1.5 text-xs font-label-md uppercase tracking-wider text-primary font-semibold mb-1">
          <span class="material-symbols-outlined text-[16px]">meeting_room</span>
          <span>{{ session.t('boardRoom.eyebrow') }}</span>
        </div>
        <h1 class="font-headline-lg text-headline-lg font-bold text-on-surface">
          {{ session.t('boardRoom.title') }}
        </h1>
        <p class="font-body-md text-body-md text-on-surface-variant mt-1 max-w-2xl">
          {{ session.t('boardRoom.subtitle') }}
        </p>
      </div>

      <div v-if="isBoardOrChairman" class="flex items-center gap-2 shrink-0">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors cursor-pointer"
          @click="showComposer ? (showComposer = false) : openComposeForm()"
        >
          <span class="material-symbols-outlined text-[17px]">
            {{ showComposer ? 'close' : 'post_add' }}
          </span>
          <span>
            {{ showComposer ? session.t('common.cancel') : session.t('boardRoom.newTopicBtn') }}
          </span>
        </button>
      </div>
    </header>

    <!-- No Access Fallback (for Residents and Accountants) -->
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

    <template v-else>
      <!-- Compose New Board Topic Form -->
      <section
        v-if="showComposer"
        class="bg-surface-container-lowest border border-primary/30 rounded-2xl p-space-md sm:p-space-lg shadow-sm space-y-4"
      >
        <div>
          <h2 class="font-title-md text-title-md font-bold text-on-surface">
            {{ session.t('boardRoom.composeTitle') }}
          </h2>
          <p class="text-xs text-on-surface-variant mt-0.5">
            {{ session.t('boardRoom.composeSubtitle') }}
          </p>
        </div>

        <form class="space-y-4" @submit.prevent="handleCreateTopic">
          <!-- Category -->
          <div class="space-y-1.5">
            <label class="block text-xs font-label-md font-semibold text-on-surface">
              {{ session.t('forum.composer.categoryLabel') }}
            </label>
            <div class="flex flex-wrap gap-2">
              <button
                v-for="cat in categories"
                :key="cat"
                type="button"
                class="px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer"
                :class="
                  draftCategory === cat
                    ? 'bg-primary-container text-on-primary border-primary'
                    : 'bg-surface-container-low text-on-surface-variant border-surface-container-high hover:text-on-surface'
                "
                @click="draftCategory = cat"
              >
                {{ session.t(`forum.categories.${cat}`) }}
              </button>
            </div>
          </div>

          <!-- Title -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label class="block text-xs font-label-md font-semibold text-on-surface">
                {{ session.t('boardRoom.topicTitleLabel') }}
              </label>
              <span class="font-mono text-[11px] text-on-surface-variant">
                {{ trimmedTitle.length }} / 255
              </span>
            </div>
            <input
              v-model="draftTitle"
              type="text"
              maxlength="255"
              required
              :placeholder="session.t('boardRoom.topicTitlePlaceholder')"
              class="w-full rounded-lg bg-surface-container-low border border-surface-container-high px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary"
            />
          </div>

          <!-- Body -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label class="block text-xs font-label-md font-semibold text-on-surface">
                {{ session.t('boardRoom.topicBodyLabel') }}
              </label>
              <span class="font-mono text-[11px] text-on-surface-variant">
                {{ trimmedBody.length }} / 10000
              </span>
            </div>
            <textarea
              v-model="draftBody"
              rows="4"
              maxlength="10000"
              required
              :placeholder="session.t('boardRoom.topicBodyPlaceholder')"
              class="w-full rounded-lg bg-surface-container-low border border-surface-container-high px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary"
            />
          </div>

          <!-- Allow comments -->
          <label class="inline-flex items-center gap-2 text-xs text-on-surface cursor-pointer">
            <input
              v-model="draftCommentsEnabled"
              type="checkbox"
              class="rounded border-surface-container-high text-primary focus:ring-primary"
            />
            <span>{{ session.t('boardRoom.allowCommentsLabel') }}</span>
          </label>

          <p v-if="submitError" class="text-xs text-error font-medium">
            {{ submitError }}
          </p>

          <div class="flex items-center justify-end gap-2">
            <button
              type="button"
              class="px-3.5 py-2 rounded-lg bg-surface-container text-on-surface-variant hover:text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="showComposer = false"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="submit"
              :disabled="!canSubmitTopic"
              class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors disabled:opacity-50 cursor-pointer"
            >
              {{ submitting ? session.t('common.saving') : session.t('boardRoom.publishBtn') }}
            </button>
          </div>
        </form>
      </section>

      <!-- Loading State -->
      <div
        v-if="loading"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-xl text-center text-on-surface-variant text-sm"
      >
        {{ session.t('boardRoom.loading') }}
      </div>

      <!-- Error State -->
      <ErrorCard
        v-else-if="loadError"
        :error="loadError"
        @retry="fetchTopics"
      />

      <!-- Empty State -->
      <div
        v-else-if="topics.length === 0"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-xl text-center space-y-2"
      >
        <div class="w-10 h-10 rounded-full bg-surface-container text-on-surface-variant flex items-center justify-center mx-auto">
          <span class="material-symbols-outlined text-[20px]">meeting_room</span>
        </div>
        <h2 class="font-title-md text-title-md font-bold text-on-surface">
          {{ session.t('boardRoom.emptyTitle') }}
        </h2>
        <p class="text-xs text-on-surface-variant max-w-md mx-auto">
          {{ session.t('boardRoom.emptySubtitle') }}
        </p>
      </div>

      <!-- Topics List (newest last_activity_at first) -->
      <div v-else class="space-y-3">
        <RouterLink
          v-for="topic in topics"
          :key="topic.id"
          :to="{ name: 'board-room-detail', params: { postId: topic.id } }"
          class="group block bg-surface-container-lowest border border-surface-container hover:border-primary/50 rounded-2xl p-space-md transition-all shadow-xs hover:shadow-md"
        >
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="inline-flex items-center px-2.5 py-0.5 rounded-md bg-secondary-container text-on-secondary-container text-[11px] font-label-md font-semibold uppercase tracking-wider">
                {{ session.t(`forum.categories.${topic.category || 'GENERAL'}`) }}
              </span>
              <h2 class="font-title-md text-title-md font-bold text-on-surface group-hover:text-primary transition-colors">
                {{ topic.title }}
              </h2>
            </div>

            <!-- Last activity timestamp -->
            <div class="flex items-center gap-2 text-xs text-on-surface-variant shrink-0">
              <span class="font-medium">
                {{ session.t('boardRoom.lastActivityLabel') }}:
                {{ formatRelativeTime(topic.last_activity_at || topic.created_at, session.lang) }}
              </span>
              <span class="hidden md:inline font-mono text-[11px] opacity-75">
                ({{ formatDateTime(topic.last_activity_at || topic.created_at, session.lang) }})
              </span>
            </div>
          </div>

          <p class="text-xs sm:text-sm text-on-surface-variant line-clamp-2 mb-3">
            {{ topic.body }}
          </p>

          <div class="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-surface-container">
            <AuthorBadge
              v-if="topic.author_badge"
              :badge="topic.author_badge"
              :is-mine="topic.is_mine"
            />
            <div class="inline-flex items-center gap-1.5 text-xs text-on-surface-variant font-medium">
              <span class="material-symbols-outlined text-[16px]">chat_bubble</span>
              <span>{{ session.t('boardRoom.commentsCount', { count: topic.comments_count || 0 }) }}</span>
            </div>
          </div>
        </RouterLink>
      </div>
    </template>
  </div>
</template>
