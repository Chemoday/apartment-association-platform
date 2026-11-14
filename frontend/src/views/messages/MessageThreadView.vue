<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { getPost } from '@/api/endpoints/communication.js'
import { listApartments } from '@/api/endpoints/property.js'
import { formatDateTime } from '@/utils/dates.js'
import CommentList from '@/views/forum/components/CommentList.vue'
import CommentComposer from '@/views/forum/components/CommentComposer.vue'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const session = useSessionStore()

const post = ref(null)
const loading = ref(false)
const error = ref(null)
const apartmentsMap = ref({})

const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)
const userMemberships = computed(() => session.memberships || [])
const canAccessMessages = computed(
  () => isBoardOrChairman.value || userMemberships.value.length > 0,
)

const isNotFoundError = computed(
  () => error.value?.errorCode === 'POST_NOT_FOUND' || error.value?.status === 404,
)

const apartmentLabel = computed(() => {
  const targetId = post.value?.target_apartment_ids?.[0]
  if (targetId) {
    const fromMem = userMemberships.value.find((m) => m.apartment_id === targetId)
    if (fromMem?.apartment_number) {
      return session.t('common.aptShort', { number: fromMem.apartment_number })
    }
    const fromMap = apartmentsMap.value[targetId]
    if (fromMap) {
      return session.t('common.aptShort', { number: fromMap })
    }
  }
  const badgeLabel = String(post.value?.author_badge?.display_label || '')
  const match = badgeLabel.match(/Apt\.?\s*([0-9A-Za-z-]+)/i)
  if (match?.[1]) {
    return session.t('common.aptShort', { number: match[1] })
  }
  return session.t('messages.apartmentThreadBadge')
})

let loadThreadSeq = 0

async function loadThread() {
  const postId = String(route.params.postId || '')
  if (!postId || !canAccessMessages.value) {
    loadThreadSeq += 1
    post.value = null
    loading.value = false
    return
  }
  const seq = ++loadThreadSeq
  loading.value = true
  error.value = null
  try {
    const promises = [getPost(postId)]
    if (isBoardOrChairman.value && Object.keys(apartmentsMap.value).length === 0) {
      promises.push(listApartments().catch(() => null))
    }
    const [postRes, aptsRes] = await Promise.all(promises)
    if (seq !== loadThreadSeq) return
    post.value = postRes

    if (aptsRes?.apartments && Array.isArray(aptsRes.apartments)) {
      const nextMap = { ...apartmentsMap.value }
      for (const a of aptsRes.apartments) {
        nextMap[a.apartment_id] = a.apartment_number
      }
      apartmentsMap.value = nextMap
    }
  } catch (err) {
    if (seq !== loadThreadSeq) return
    error.value = err
  } finally {
    if (seq === loadThreadSeq) {
      loading.value = false
    }
  }
}

onMounted(loadThread)

watch(
  () => [route.params.postId, session.actingUserId, session.me?.building_role, session.sessionRevision],
  () => {
    loadThread()
  },
)
</script>

<template>
  <div class="w-full max-w-4xl mx-auto px-3 sm:px-gutter py-space-md sm:py-space-lg space-y-space-md">
    <!-- Top Back Link -->
    <div class="flex items-center justify-between gap-2">
      <RouterLink
        to="/messages"
        class="inline-flex items-center gap-1.5 text-xs font-label-md font-semibold text-on-surface-variant hover:text-primary transition-colors"
      >
        <span class="material-symbols-outlined text-[16px]">arrow_back</span>
        <span>{{ session.t('messages.backToInbox') }}</span>
      </RouterLink>

      <RouterLink
        v-if="isBoardOrChairman && post?.target_apartment_ids?.[0]"
        :to="{ name: 'apartment-card', params: { apartmentId: post.target_apartment_ids[0] } }"
        class="inline-flex items-center gap-1 text-xs font-label-md font-semibold text-primary hover:underline"
      >
        <span class="material-symbols-outlined text-[15px]">apartment</span>
        <span>{{ session.t('apartments.openCard') }}</span>
      </RouterLink>
    </div>

    <!-- No Access Fallback -->
    <div
      v-if="!canAccessMessages"
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
    </div>

    <!-- Loading -->
    <div
      v-else-if="loading"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-xl text-center text-on-surface-variant text-sm"
    >
      {{ session.t('messages.loadingThread') }}
    </div>

    <!-- 404 POST_NOT_FOUND Friendly Notice -->
    <div
      v-else-if="isNotFoundError"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-lg text-center max-w-lg mx-auto space-y-4"
      role="alert"
    >
      <div class="w-12 h-12 rounded-full bg-surface-container text-on-surface-variant flex items-center justify-center mx-auto">
        <span class="material-symbols-outlined text-[24px]">mail_lock</span>
      </div>
      <h2 class="font-title-lg text-title-lg font-bold text-on-surface">
        {{ session.t('messages.notFoundTitle') }}
      </h2>
      <p class="font-body-md text-body-md text-on-surface-variant">
        {{ session.t('messages.notFoundBody') }}
      </p>
      <div>
        <RouterLink
          to="/messages"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors"
        >
          <span class="material-symbols-outlined text-[16px]">arrow_back</span>
          <span>{{ session.t('messages.backToInbox') }}</span>
        </RouterLink>
      </div>
    </div>

    <!-- Other Error -->
    <ErrorCard
      v-else-if="error"
      :error="error"
      @retry="loadThread"
    />

    <!-- Thread Detail (No delete or edit buttons; comment form always shown) -->
    <template v-else-if="post">
      <article class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-md sm:p-space-lg shadow-xs space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-primary-container text-on-primary text-xs font-mono font-bold">
              <span class="material-symbols-outlined text-[14px]">door_front</span>
              <span>{{ apartmentLabel }}</span>
            </span>
            <span class="text-xs font-label-md uppercase tracking-wider text-on-surface-variant">
              {{ session.t('messages.privateThreadLabel') }}
            </span>
          </div>

          <div class="text-xs font-mono text-on-surface-variant">
            {{ formatDateTime(post.created_at, session.lang) }}
          </div>
        </div>

        <h1 class="font-headline-md text-xl sm:text-2xl font-bold text-on-surface">
          {{ post.title }}
        </h1>

        <p class="text-sm sm:text-base text-on-surface leading-relaxed whitespace-pre-line">
          {{ post.body ?? '' }}
        </p>

        <div class="pt-4 border-t border-surface-container flex flex-wrap items-center justify-between gap-2">
          <AuthorBadge
            v-if="post.author_badge"
            :badge="post.author_badge"
            :is-mine="post.is_mine"
          />
          <span
            v-if="post.last_activity_at"
            class="text-xs text-on-surface-variant"
          >
            {{ session.t('messages.lastActivityLabel') }}:
            {{ formatDateTime(post.last_activity_at, session.lang) }}
          </span>
        </div>
      </article>

      <!-- Replies & Always-Enabled Comment Form (without author_apartment_id) -->
      <section class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-md sm:p-space-lg space-y-5">
        <h2 class="text-xs font-label-lg font-bold uppercase tracking-wider text-on-surface-variant">
          {{ session.t('messages.repliesHeading') }} ({{ post.comments_count ?? post.comments?.length ?? 0 }})
        </h2>

        <CommentList :comments="post.comments || []" />

        <CommentComposer
          :post-id="post.id"
          :disabled="false"
          :omit-author-apartment="true"
          @added="loadThread"
        />
      </section>
    </template>
  </div>
</template>
