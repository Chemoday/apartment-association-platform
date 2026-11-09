<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { createApartmentThread, listApartmentThreads } from '@/api/endpoints/communication.js'
import { listApartments } from '@/api/endpoints/property.js'
import { formatDateTime, formatRelativeTime } from '@/utils/dates.js'
import { localizeError } from '@/locales/index.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const threads = ref([])
const loading = ref(false)
const loadError = ref(null)
const apartmentsMap = ref({})

const isBoardOrChairman = computed(() =>
  ['CHAIRMAN', 'BOARD'].includes(session.me?.building_role || ''),
)
const userMemberships = computed(() => session.memberships || [])
const canAccessMessages = computed(
  () => isBoardOrChairman.value || userMemberships.value.length > 0,
)

// Compose form state ("Write to the board")
const showComposer = ref(false)
const selectedApartmentId = ref('')
const draftTitle = ref('')
const draftBody = ref('')
const submitting = ref(false)
const submitError = ref('')

const trimmedTitle = computed(() => draftTitle.value.trim())
const trimmedBody = computed(() => draftBody.value.trim())
const canSubmitThread = computed(
  () =>
    Boolean(effectiveApartmentId.value) &&
    trimmedTitle.value.length >= 1 &&
    trimmedTitle.value.length <= 255 &&
    trimmedBody.value.length >= 1 &&
    trimmedBody.value.length <= 10000 &&
    !submitting.value,
)

const effectiveApartmentId = computed(() => {
  if (userMemberships.value.length === 1) {
    return userMemberships.value[0].apartment_id
  }
  return selectedApartmentId.value || userMemberships.value[0]?.apartment_id || ''
})

function resolveThreadApartmentLabel(thread) {
  const targetId = thread?.target_apartment_ids?.[0]
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
  const badgeLabel = String(thread?.author_badge?.display_label || '')
  const match = badgeLabel.match(/Apt\.?\s*([0-9A-Za-z-]+)/i)
  if (match?.[1]) {
    return session.t('common.aptShort', { number: match[1] })
  }
  return session.t('messages.apartmentThreadBadge')
}

let fetchInboxSeq = 0

async function fetchInbox() {
  if (!canAccessMessages.value) {
    fetchInboxSeq += 1
    threads.value = []
    loading.value = false
    return
  }
  const seq = ++fetchInboxSeq
  loading.value = true
  loadError.value = null
  try {
    const promises = [listApartmentThreads()]
    if (isBoardOrChairman.value) {
      promises.push(listApartments().catch(() => null))
    }
    const [threadsRes, aptsRes] = await Promise.all(promises)
    if (seq !== fetchInboxSeq) return
    threads.value = Array.isArray(threadsRes) ? threadsRes : []

    const nextMap = {}
    for (const m of userMemberships.value) {
      if (m.apartment_id && m.apartment_number) {
        nextMap[m.apartment_id] = m.apartment_number
      }
    }
    if (aptsRes?.apartments && Array.isArray(aptsRes.apartments)) {
      for (const a of aptsRes.apartments) {
        nextMap[a.apartment_id] = a.apartment_number
      }
    }
    apartmentsMap.value = nextMap
  } catch (err) {
    if (seq !== fetchInboxSeq) return
    loadError.value = err
  } finally {
    if (seq === fetchInboxSeq) {
      loading.value = false
    }
  }
}

function openComposeForm() {
  if (userMemberships.value.length > 0 && !selectedApartmentId.value) {
    selectedApartmentId.value =
      session.activeMembership?.apartment_id || userMemberships.value[0].apartment_id
  }
  submitError.value = ''
  showComposer.value = true
}

async function handleCreateThread() {
  if (!canSubmitThread.value) return
  submitting.value = true
  submitError.value = ''
  try {
    const created = await createApartmentThread({
      apartmentId: effectiveApartmentId.value,
      title: trimmedTitle.value,
      body: trimmedBody.value,
    })
    draftTitle.value = ''
    draftBody.value = ''
    showComposer.value = false
    if (created?.id) {
      router.push({ name: 'message-thread', params: { postId: created.id } })
    } else {
      await fetchInbox()
    }
  } catch (err) {
    submitError.value = localizeError(err.errorCode, err.payload, session.lang)
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  if (route.query.write === '1') {
    showComposer.value = true
  }
  if (userMemberships.value.length > 0) {
    selectedApartmentId.value =
      session.activeMembership?.apartment_id || userMemberships.value[0].apartment_id
  }
  fetchInbox()
})

watch(
  () => route.query.write,
  (val) => {
    if (val === '1') {
      showComposer.value = true
    }
  },
)

watch(
  () => [session.actingUserId, session.me?.building_role, session.sessionRevision, userMemberships.value.length],
  () => {
    if (userMemberships.value.length > 0) {
      selectedApartmentId.value =
        session.activeMembership?.apartment_id || userMemberships.value[0].apartment_id
    }
    fetchInbox()
  },
)
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-space-md sm:py-space-lg space-y-space-lg">
    <!-- Header -->
    <header class="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-surface-container pb-space-md">
      <div>
        <div class="inline-flex items-center gap-1.5 text-xs font-label-md uppercase tracking-wider text-primary font-semibold mb-1">
          <span class="material-symbols-outlined text-[16px]">mail</span>
          <span>{{ session.t('messages.eyebrow') }}</span>
        </div>
        <h1 class="font-headline-lg text-headline-lg font-bold text-on-surface">
          {{ session.t('messages.title') }}
        </h1>
        <p class="font-body-md text-body-md text-on-surface-variant mt-1 max-w-2xl">
          {{ session.t('messages.subtitle') }}
        </p>
      </div>

      <!-- Action Button: Write to the board (if user has an apartment) or go to Apartments (if board without apartment) -->
      <div v-if="canAccessMessages" class="flex items-center gap-2 shrink-0">
        <button
          v-if="userMemberships.length > 0"
          type="button"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors cursor-pointer"
          @click="showComposer ? (showComposer = false) : openComposeForm()"
        >
          <span class="material-symbols-outlined text-[17px]">
            {{ showComposer ? 'close' : 'edit_square' }}
          </span>
          <span>
            {{ showComposer ? session.t('common.cancel') : session.t('messages.writeToBoardBtn') }}
          </span>
        </button>

        <RouterLink
          v-if="isBoardOrChairman"
          to="/apartments"
          class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors"
        >
          <span class="material-symbols-outlined text-[17px]">apartment</span>
          <span>{{ session.t('messages.writeFromApartmentCardHint') }}</span>
        </RouterLink>
      </div>
    </header>

    <!-- No Access Fallback (e.g. Accountant without an apartment) -->
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
      <!-- "Write to the board" Composer Form (for residents with 1 or more apartments) -->
      <section
        v-if="showComposer && userMemberships.length > 0"
        class="bg-surface-container-lowest border border-primary/30 rounded-2xl p-space-md sm:p-space-lg shadow-sm space-y-4"
      >
        <div class="flex items-center justify-between">
          <div>
            <h2 class="font-title-md text-title-md font-bold text-on-surface">
              {{ session.t('messages.composeTitle') }}
            </h2>
            <p class="text-xs text-on-surface-variant mt-0.5">
              {{ session.t('messages.composeSubtitle') }}
            </p>
          </div>
          <!-- Single apartment indicator when user has only 1 apartment -->
          <span
            v-if="userMemberships.length === 1"
            class="px-2.5 py-1 rounded-lg bg-surface-container text-on-surface text-xs font-mono font-semibold"
          >
            {{ session.t('common.aptShort', { number: userMemberships[0].apartment_number }) }}
          </span>
        </div>

        <form class="space-y-4" @submit.prevent="handleCreateThread">
          <!-- Apartment selector only when resident has several apartments -->
          <div v-if="userMemberships.length > 1" class="space-y-1.5">
            <label class="block text-xs font-label-md font-semibold text-on-surface">
              {{ session.t('messages.selectApartmentLabel') }}
            </label>
            <select
              v-model="selectedApartmentId"
              class="w-full sm:w-64 rounded-lg bg-surface-container-low border border-surface-container-high px-3 py-2 text-xs text-on-surface focus:outline-none focus:border-primary"
            >
              <option
                v-for="m in userMemberships"
                :key="m.membership_id"
                :value="m.apartment_id"
              >
                {{ session.t('common.apartmentNumber', { number: m.apartment_number }) }} ({{ m.relation_type }})
              </option>
            </select>
          </div>

          <!-- Subject -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label class="block text-xs font-label-md font-semibold text-on-surface">
                {{ session.t('messages.subjectLabel') }}
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
              :placeholder="session.t('messages.subjectPlaceholder')"
              class="w-full rounded-lg bg-surface-container-low border border-surface-container-high px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary"
            />
          </div>

          <!-- Body -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <label class="block text-xs font-label-md font-semibold text-on-surface">
                {{ session.t('messages.bodyLabel') }}
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
              :placeholder="session.t('messages.bodyPlaceholder')"
              class="w-full rounded-lg bg-surface-container-low border border-surface-container-high px-3 py-2 text-sm text-on-surface placeholder:text-on-surface-variant focus:outline-none focus:border-primary"
            />
          </div>

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
              :disabled="!canSubmitThread"
              class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors disabled:opacity-50 cursor-pointer"
            >
              {{ submitting ? session.t('common.saving') : session.t('messages.sendBtn') }}
            </button>
          </div>
        </form>
      </section>

      <!-- Loading State -->
      <div
        v-if="loading"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-xl text-center text-on-surface-variant text-sm"
      >
        {{ session.t('messages.loading') }}
      </div>

      <!-- Error State -->
      <ErrorCard
        v-else-if="loadError"
        :error="loadError"
        @retry="fetchInbox"
      />

      <!-- Empty State -->
      <div
        v-else-if="threads.length === 0"
        class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-xl text-center space-y-2"
      >
        <div class="w-10 h-10 rounded-full bg-surface-container text-on-surface-variant flex items-center justify-center mx-auto">
          <span class="material-symbols-outlined text-[20px]">mark_email_read</span>
        </div>
        <h2 class="font-title-md text-title-md font-bold text-on-surface">
          {{ session.t('messages.emptyTitle') }}
        </h2>
        <p class="text-xs text-on-surface-variant max-w-md mx-auto">
          {{ session.t('messages.emptySubtitle') }}
        </p>
      </div>

      <!-- Inbox List (sorted as API returns it: newest last_activity_at first) -->
      <div v-else class="space-y-3">
        <RouterLink
          v-for="thread in threads"
          :key="thread.id"
          :to="{ name: 'message-thread', params: { postId: thread.id } }"
          class="group block bg-surface-container-lowest border border-surface-container hover:border-primary/50 rounded-2xl p-space-md transition-all shadow-xs hover:shadow-md"
        >
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
            <div class="flex flex-wrap items-center gap-2">
              <!-- Apartment Badge ("Apt. 14") -->
              <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md bg-primary-container text-on-primary text-xs font-mono font-bold">
                <span class="material-symbols-outlined text-[14px]">door_front</span>
                <span>{{ resolveThreadApartmentLabel(thread) }}</span>
              </span>

              <!-- Subject -->
              <h2 class="font-title-md text-title-md font-bold text-on-surface group-hover:text-primary transition-colors">
                {{ thread.title }}
              </h2>
            </div>

            <!-- Last activity timestamp -->
            <div class="flex items-center gap-2 text-xs text-on-surface-variant shrink-0">
              <span class="font-medium">
                {{ session.t('messages.lastActivityLabel') }}:
                {{ formatRelativeTime(thread.last_activity_at || thread.created_at, session.lang) }}
              </span>
              <span class="hidden md:inline font-mono text-[11px] opacity-75">
                ({{ formatDateTime(thread.last_activity_at || thread.created_at, session.lang) }})
              </span>
            </div>
          </div>

          <p class="text-xs sm:text-sm text-on-surface-variant line-clamp-2 mb-3">
            {{ thread.body }}
          </p>

          <div class="flex flex-wrap items-center justify-between gap-3 pt-2.5 border-t border-surface-container">
            <AuthorBadge
              v-if="thread.author_badge"
              :badge="thread.author_badge"
              :is-mine="thread.is_mine"
            />
            <div class="inline-flex items-center gap-1.5 text-xs text-on-surface-variant font-medium">
              <span class="material-symbols-outlined text-[16px]">chat_bubble</span>
              <span>{{ session.t('messages.repliesCount', { count: thread.comments_count || 0 }) }}</span>
            </div>
          </div>
        </RouterLink>
      </div>
    </template>
  </div>
</template>
