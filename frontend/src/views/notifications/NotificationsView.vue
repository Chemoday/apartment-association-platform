<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { setUnread, unread } from '@/composables/useUnreadCount.js'
import { getFeed, markAllRead, markRead } from '@/api/endpoints/notifications.js'
import { buildNotificationDescriptor, formatNotificationText } from '@/utils/notificationText.js'
import { formatDateTime, formatRelativeTime } from '@/utils/dates.js'
import BaseSkeleton from '@/components/base/BaseSkeleton.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const PAGE_SIZE = 50

const router = useRouter()
const session = useSessionStore()

const activeTab = ref('all') // 'all' | 'unread'
const items = ref([])
const loading = ref(false)
const loadingMore = ref(false)
const hasMore = ref(false)
const loadError = ref(null)
const markingAll = ref(false)

const unreadTabLabel = computed(() => {
  if (unread.value > 0) {
    return `${session.t('notifications.tabs.unread')} (${unread.value})`
  }
  return session.t('notifications.tabs.unread')
})

let fetchPageSeq = 0

async function fetchPage(reset = true) {
  const seq = ++fetchPageSeq
  if (reset) {
    loading.value = true
    items.value = []
  } else {
    loadingMore.value = true
  }
  loadError.value = null
  const offset = reset ? 0 : items.value.length

  try {
    const res = await getFeed({
      unreadOnly: activeTab.value === 'unread',
      limit: PAGE_SIZE,
      offset,
    })
    if (seq !== fetchPageSeq) return
    const batch = Array.isArray(res) ? res : []
    if (reset) {
      items.value = batch
    } else {
      items.value = [...items.value, ...batch]
    }
    hasMore.value = batch.length === PAGE_SIZE
  } catch (err) {
    if (seq !== fetchPageSeq) return
    loadError.value = err
  } finally {
    if (seq === fetchPageSeq) {
      loading.value = false
      loadingMore.value = false
    }
  }
}

function switchTab(tab) {
  if (activeTab.value === tab) return
  activeTab.value = tab
  fetchPage(true)
}

async function handleSelectItem(item) {
  const desc = buildNotificationDescriptor(item, session.lang)
  const wasUnread = !item.read_at
  try {
    const res = await markRead(item.id)
    item.read_at = res?.read_at || new Date().toISOString()
    if (wasUnread) {
      setUnread(unread.value - 1)
    }
    if (activeTab.value === 'unread') {
      items.value = items.value.filter((i) => i.id !== item.id)
    }
  } catch (err) {
    if (err?.status === 404 || err?.errorCode === 'NOTIFICATION_NOT_FOUND') {
      items.value = items.value.filter((i) => i.id !== item.id)
      return
    }
  }
  if (desc.route) {
    router.push(desc.route)
  }
}

async function handleMarkAllRead() {
  if (markingAll.value || unread.value === 0) return
  markingAll.value = true
  try {
    await markAllRead()
    const nowIso = new Date().toISOString()
    if (activeTab.value === 'unread') {
      items.value = []
    } else {
      items.value = items.value.map((i) => ({
        ...i,
        read_at: i.read_at || nowIso,
      }))
    }
    setUnread(0)
  } finally {
    markingAll.value = false
  }
}

function getItemUi(item) {
  const desc = buildNotificationDescriptor(item, session.lang)
  const text = formatNotificationText(item, session.t, session.lang)
  let iconBg = 'bg-surface-container text-on-surface-variant'
  if (desc.variant === 'emergency') {
    iconBg = 'bg-error-container text-error'
  } else if (desc.variant === 'resolved') {
    iconBg = 'bg-secondary-container text-secondary'
  } else if (desc.variant === 'deadline') {
    iconBg = 'bg-primary-fixed/40 text-primary'
  } else if (desc.variant === 'review') {
    iconBg = 'bg-surface-container-high text-on-surface'
  }
  return {
    icon: desc.icon,
    iconBg,
    text,
    relativeTime: formatRelativeTime(item.created_at, session.lang),
    fullTime: formatDateTime(item.created_at, session.lang),
  }
}

onMounted(() => {
  fetchPage(true)
})

watch(
  () => session.sessionRevision,
  () => {
    fetchPage(true)
  },
)
</script>

<template>
  <div class="w-full max-w-[960px] mx-auto px-gutter py-space-lg space-y-6">
    <!-- Top Header -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div class="space-y-1">
        <span class="font-label-md text-xs uppercase tracking-wider text-secondary font-semibold">
          {{ session.t('notifications.kicker') }}
        </span>
        <h1 class="font-headline-xl text-2xl sm:text-3xl font-bold text-on-surface tracking-tight">
          {{ session.t('notifications.title') }}
        </h1>
      </div>

      <div class="flex flex-wrap items-center gap-3">
        <button
          v-if="unread > 0"
          type="button"
          :disabled="markingAll"
          class="px-3.5 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors disabled:opacity-50 whitespace-nowrap cursor-pointer"
          @click="handleMarkAllRead"
        >
          {{ session.t('notifications.markAllRead') }}
        </button>

        <RouterLink
          to="/settings/notifications"
          class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-surface-container-lowest border border-surface-container hover:bg-surface-container-low text-on-surface text-xs font-semibold transition-colors whitespace-nowrap"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">tune</span>
          <span>{{ session.t('notificationSettings.title') }}</span>
        </RouterLink>
      </div>
    </div>

    <!-- Filter Tabs: All / Unread -->
    <div class="inline-flex items-center gap-1 p-1 rounded-lg bg-surface-container">
      <button
        type="button"
        class="px-4 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer"
        :class="
          activeTab === 'all'
            ? 'bg-surface-container-lowest text-on-surface shadow-xs'
            : 'text-on-surface-variant hover:text-on-surface'
        "
        @click="switchTab('all')"
      >
        {{ session.t('notifications.tabs.all') }}
      </button>

      <button
        type="button"
        class="px-4 py-1.5 rounded-md text-xs font-semibold transition-colors whitespace-nowrap font-mono tabular-nums cursor-pointer"
        :class="
          activeTab === 'unread'
            ? 'bg-surface-container-lowest text-on-surface shadow-xs'
            : 'text-on-surface-variant hover:text-on-surface'
        "
        @click="switchTab('unread')"
      >
        {{ unreadTabLabel }}
      </button>
    </div>

    <ErrorCard v-if="loadError" :error="loadError" @retry="fetchPage(true)" />

    <!-- Loading Skeleton -->
    <div v-if="loading" class="space-y-3">
      <BaseSkeleton class="h-18 w-full rounded-xl" />
      <BaseSkeleton class="h-18 w-full rounded-xl" />
      <BaseSkeleton class="h-18 w-full rounded-xl" />
    </div>

    <!-- Empty State -->
    <div
      v-else-if="!items.length"
      class="rounded-xl bg-surface-container-lowest border border-surface-container p-12 flex flex-col items-center justify-center text-center gap-3"
    >
      <div class="w-12 h-12 rounded-full bg-surface-container flex items-center justify-center text-on-surface-variant">
        <span class="material-symbols-outlined text-[24px]" aria-hidden="true">
          notifications_none
        </span>
      </div>
      <p class="text-sm font-medium text-on-surface-variant max-w-md">
        {{ session.t('notifications.emptyFull') }}
      </p>
    </div>

    <!-- Notifications List -->
    <div
      v-else
      class="rounded-xl bg-surface-container-lowest border border-surface-container divide-y divide-surface-container overflow-hidden shadow-xs"
    >
      <button
        v-for="item in items"
        :key="item.id"
        type="button"
        class="w-full px-5 py-4 text-left flex items-center justify-between gap-4 hover:bg-surface-container-low transition-colors cursor-pointer"
        :class="!item.read_at ? 'bg-primary-fixed/10' : ''"
        @click="handleSelectItem(item)"
      >
        <div class="flex items-start gap-3.5 min-w-0">
          <div
            class="w-9 h-9 rounded-full flex items-center justify-center shrink-0 mt-0.5"
            :class="getItemUi(item).iconBg"
          >
            <span class="material-symbols-outlined text-[18px]" aria-hidden="true">
              {{ getItemUi(item).icon }}
            </span>
          </div>

          <div class="space-y-1 min-w-0">
            <p
              class="text-sm leading-snug text-on-surface break-words"
              :class="!item.read_at ? 'font-semibold' : 'font-normal text-on-surface-variant'"
            >
              {{ getItemUi(item).text }}
            </p>
            <span class="block sm:hidden text-xs text-on-surface-variant font-mono tabular-nums">
              {{ getItemUi(item).relativeTime }}
            </span>
          </div>
        </div>

        <div class="flex items-center gap-3 shrink-0">
          <span
            class="hidden sm:inline text-xs text-on-surface-variant font-mono tabular-nums whitespace-nowrap"
            :title="getItemUi(item).fullTime"
          >
            {{ getItemUi(item).fullTime }}
          </span>
          <span
            v-if="!item.read_at"
            class="w-2.5 h-2.5 rounded-full bg-primary shrink-0"
            aria-hidden="true"
          />
        </div>
      </button>
    </div>

    <!-- Load More -->
    <div v-if="hasMore" class="flex justify-center pt-2">
      <button
        type="button"
        :disabled="loadingMore"
        class="px-5 py-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors disabled:opacity-50 cursor-pointer"
        @click="fetchPage(false)"
      >
        {{ session.t('notifications.loadMore') }}
      </button>
    </div>
  </div>
</template>
