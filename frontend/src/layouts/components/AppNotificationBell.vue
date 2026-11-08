<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { bellEnabled, setUnread, unread } from '@/composables/useUnreadCount.js'
import { getFeed, markAllRead, markRead } from '@/api/endpoints/notifications.js'
import { buildNotificationDescriptor, formatNotificationText } from '@/utils/notificationText.js'
import { formatDateTime, formatRelativeTime } from '@/utils/dates.js'

const router = useRouter()
const route = useRoute()
const session = useSessionStore()

const isOpen = ref(false)
const items = ref([])
const loading = ref(false)
const markingAll = ref(false)
const rootRef = ref(null)

const badgeLabel = computed(() => {
  if (unread.value <= 0) return ''
  return unread.value > 99 ? '99+' : String(unread.value)
})

async function loadLatest() {
  if (!bellEnabled.value || session.authMode === 'none') return
  loading.value = true
  try {
    const res = await getFeed({ unreadOnly: false, limit: 10, offset: 0 })
    items.value = Array.isArray(res) ? res : []
  } catch (err) {
    if (err?.status === 404) {
      bellEnabled.value = false
      isOpen.value = false
    }
  } finally {
    loading.value = false
  }
}

function toggleBell() {
  isOpen.value = !isOpen.value
  if (isOpen.value) {
    loadLatest()
  }
}

function closeBell() {
  isOpen.value = false
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
  } catch (err) {
    if (err?.status === 404) {
      items.value = items.value.filter((i) => i.id !== item.id)
      return
    }
  }
  closeBell()
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
    items.value = items.value.map((i) => ({
      ...i,
      read_at: i.read_at || nowIso,
    }))
    setUnread(0)
  } finally {
    markingAll.value = false
  }
}

function goToAllNotifications() {
  closeBell()
  router.push({ name: 'notifications' })
}

function goToSettings() {
  closeBell()
  router.push({ name: 'settings-notifications' })
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

function handleDocumentClick(e) {
  if (isOpen.value && rootRef.value && !rootRef.value.contains(e.target)) {
    isOpen.value = false
  }
}

watch(
  () => unread.value,
  () => {
    if (isOpen.value) {
      loadLatest()
    }
  },
)

watch(
  () => route.fullPath,
  () => {
    isOpen.value = false
  },
)

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
})
</script>

<template>
  <div v-if="bellEnabled && session.authMode !== 'none'" ref="rootRef" class="relative shrink-0">
    <button
      type="button"
      :aria-label="session.t('notifications.bellLabel')"
      :aria-expanded="isOpen"
      class="relative inline-flex items-center justify-center w-9 h-9 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface transition-colors cursor-pointer"
      @click="toggleBell"
    >
      <span class="material-symbols-outlined text-[20px]" aria-hidden="true">notifications</span>
      <span
        v-if="unread > 0"
        class="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-error text-on-error font-mono tabular-nums text-[10px] font-bold flex items-center justify-center shadow-xs"
      >
        {{ badgeLabel }}
      </span>
    </button>

    <!-- Desktop Dropdown & Mobile Full-Screen Sheet -->
    <div
      v-if="isOpen"
      class="fixed inset-0 z-50 sm:absolute sm:inset-auto sm:right-0 sm:mt-2 sm:w-[380px] bg-surface-container-lowest sm:rounded-xl shadow-xl sm:border sm:border-surface-container flex flex-col max-h-screen sm:max-h-[520px]"
    >
      <!-- Header -->
      <div class="px-4 py-3 border-b border-surface-container flex items-center justify-between gap-2 shrink-0">
        <div class="flex items-center gap-2">
          <h3 class="font-headline-sm text-sm font-bold text-on-surface">
            {{ session.t('notifications.title') }}
          </h3>
          <span
            v-if="unread > 0"
            class="font-mono tabular-nums text-xs text-on-surface-variant"
          >
            · {{ unread }}
          </span>
        </div>

        <div class="flex items-center gap-2">
          <button
            v-if="unread > 0"
            type="button"
            :disabled="markingAll"
            class="text-xs font-semibold text-primary hover:underline disabled:opacity-50 whitespace-nowrap cursor-pointer"
            @click="handleMarkAllRead"
          >
            {{ session.t('notifications.markAllRead') }}
          </button>
          <button
            type="button"
            :aria-label="session.t('notificationSettings.title')"
            class="p-1 rounded-md text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low transition-colors cursor-pointer"
            @click="goToSettings"
          >
            <span class="material-symbols-outlined text-[18px]" aria-hidden="true">settings</span>
          </button>
          <button
            type="button"
            class="sm:hidden p-1 rounded-md text-on-surface-variant hover:text-on-surface cursor-pointer"
            aria-label="Close"
            @click="closeBell"
          >
            <span class="material-symbols-outlined text-[20px]" aria-hidden="true">close</span>
          </button>
        </div>
      </div>

      <!-- Feed List -->
      <div class="flex-1 overflow-y-auto divide-y divide-surface-container">
        <div v-if="loading && !items.length" class="p-6 text-center text-xs text-on-surface-variant">
          {{ session.t('notifications.loading') }}
        </div>

        <div
          v-else-if="!items.length"
          class="p-8 flex flex-col items-center justify-center text-center gap-2"
        >
          <span class="material-symbols-outlined text-[32px] text-on-surface-variant/50" aria-hidden="true">
            notifications_none
          </span>
          <p class="text-xs font-medium text-on-surface-variant max-w-[240px]">
            {{ session.t('notifications.emptyShort') }}
          </p>
        </div>

        <button
          v-for="item in items"
          v-else
          :key="item.id"
          type="button"
          class="w-full px-4 py-3 text-left flex items-start gap-3 hover:bg-surface-container-low transition-colors cursor-pointer"
          :class="!item.read_at ? 'bg-primary-fixed/10' : ''"
          @click="handleSelectItem(item)"
        >
          <div
            class="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
            :class="getItemUi(item).iconBg"
          >
            <span class="material-symbols-outlined text-[17px]" aria-hidden="true">
              {{ getItemUi(item).icon }}
            </span>
          </div>

          <div class="flex-1 min-w-0">
            <p
              class="text-xs leading-snug text-on-surface break-words"
              :class="!item.read_at ? 'font-semibold' : 'font-normal text-on-surface-variant'"
            >
              {{ getItemUi(item).text }}
            </p>
            <span
              class="block mt-1 text-[11px] text-on-surface-variant font-mono tabular-nums"
              :title="getItemUi(item).fullTime"
            >
              {{ getItemUi(item).relativeTime }}
            </span>
          </div>

          <span
            v-if="!item.read_at"
            class="w-2 h-2 rounded-full bg-primary shrink-0 mt-2"
            aria-hidden="true"
          />
        </button>
      </div>

      <!-- Footer -->
      <div class="px-4 py-2.5 border-t border-surface-container bg-surface-container-low/50 flex items-center justify-between shrink-0">
        <button
          type="button"
          class="w-full text-center text-xs font-semibold text-primary hover:underline py-1 cursor-pointer"
          @click="goToAllNotifications"
        >
          {{ session.t('notifications.seeAll') }}
        </button>
      </div>
    </div>
  </div>
</template>
