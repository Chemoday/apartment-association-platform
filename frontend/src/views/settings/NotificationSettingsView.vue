<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import {
  getPreferences,
  updatePreferences,
  createTelegramLinkCode,
  listBindings,
  deleteBinding,
} from '@/api/endpoints/notifications.js'
import {
  NOTIFICATION_CHANNELS,
  visibleNotificationEvents,
  clonePreferences,
  findPreferenceCell,
  changedPreferences,
  canTogglePreference,
  findChannelStatus,
} from '@/utils/preferences.js'
import {
  isWebPushSupportedInBrowser,
  enableBrowserPush,
  removeThisBrowserPush,
  getStoredWebPushBindingId,
  detectBrowserDeviceLabel,
} from '@/utils/webpush.js'
import { localizeError } from '@/locales/index.js'
import { formatShortDate } from '@/utils/dates.js'
import BaseSkeleton from '@/components/base/BaseSkeleton.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'
import SettingsShellTabs from './components/SettingsShellTabs.vue'

const session = useSessionStore()
const { buildingRole } = useRole()

function formatErr(err) {
  return localizeError(err?.errorCode || 'DEFAULT', err?.payload || {}, session.lang)
}

const loading = ref(true)
const loadError = ref(null)
const saveError = ref('')
const saving = ref(false)
const saveSuccess = ref(false)

const originalPreferences = ref([])
const editedPreferences = ref([])
const serverChannels = ref([])
const bindings = ref([])

// Demo preview toggle for inspecting NOT_LINKED Telegram & WebPush cards in demo mode
const previewLinkedChannels = ref(false)

// Language selector
const selectedLocale = ref(session.notificationLocale ?? '')
const localeSaving = ref(false)
const localeSaved = ref(false)
const localeError = ref('')

// Telegram linking state (kept strictly in component memory)
const telegramLoading = ref(false)
const telegramError = ref('')
const telegramLink = ref(null) // { code, deep_link, expires_at }
const telegramSecondsLeft = ref(0)
const copiedCode = ref(false)
let telegramCountdownTimer = null
let telegramPollTimer = null

// WebPush state
const pushSupported = isWebPushSupportedInBrowser()
const pushLoading = ref(false)
const pushState = ref(null) // null | 'denied' | 'unsupported' | 'not_configured' | 'error'
const pushErrorMsg = ref('')
const storedBrowserBindingId = ref(getStoredWebPushBindingId())

// Bindings state
const deletingBindingId = ref('')

const isDemoChannelMode = computed(() => {
  return serverChannels.value.some((ch) => ch.reason === 'DEMO_MODE')
})

const effectiveChannels = computed(() => {
  if (!previewLinkedChannels.value) {
    return serverChannels.value
  }
  return serverChannels.value.map((ch) => {
    if ((ch.channel === 'telegram' || ch.channel === 'webpush') && ch.reason === 'DEMO_MODE') {
      const hasBinding = bindings.value.some((b) => b.channel === ch.channel)
      return {
        ...ch,
        available: hasBinding,
        reason: hasBinding ? null : 'NOT_LINKED',
      }
    }
    return ch
  })
})

const visibleEvents = computed(() => {
  const hasApartment = (session.memberships?.length || 0) > 0
  return visibleNotificationEvents(buildingRole.value, hasApartment)
})

const pendingChanges = computed(() => {
  return changedPreferences(originalPreferences.value, editedPreferences.value)
})

const hasUnsavedChanges = computed(() => pendingChanges.value.length > 0)

const telegramStatus = computed(() => findChannelStatus(effectiveChannels.value, 'telegram'))
const webpushStatus = computed(() => findChannelStatus(effectiveChannels.value, 'webpush'))

const showTelegramCard = computed(() => {
  const st = telegramStatus.value
  return st.reason === null || st.reason === 'NOT_LINKED'
})

const showWebPushCard = computed(() => {
  if (!pushSupported) return false
  const st = webpushStatus.value
  return st.reason === null || st.reason === 'NOT_LINKED'
})

const telegramBinding = computed(() => {
  return bindings.value.find((b) => b.channel === 'telegram') || null
})

const thisBrowserBinding = computed(() => {
  if (storedBrowserBindingId.value) {
    const match = bindings.value.find(
      (b) => b.channel === 'webpush' && b.binding_id === storedBrowserBindingId.value,
    )
    if (match) return match
  }
  return bindings.value.find((b) => b.channel === 'webpush') || null
})

watch(
  () => session.notificationLocale,
  (val) => {
    selectedLocale.value = val ?? ''
  },
)

watch(
  () => session.sessionRevision,
  () => {
    loadData()
  },
)

function normalizeBindings(raw) {
  if (Array.isArray(raw)) return raw
  if (Array.isArray(raw?.items)) return raw.items
  return []
}

async function loadData() {
  loading.value = true
  loadError.value = null
  try {
    const [prefsResp, bindingsResp] = await Promise.all([
      getPreferences(),
      listBindings().catch(() => []),
    ])
    originalPreferences.value = clonePreferences(prefsResp?.preferences || [])
    editedPreferences.value = clonePreferences(prefsResp?.preferences || [])
    serverChannels.value = prefsResp?.channels || []
    bindings.value = normalizeBindings(bindingsResp)
    storedBrowserBindingId.value = getStoredWebPushBindingId()
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

function getCell(eventType, channel) {
  return findPreferenceCell(editedPreferences.value, eventType, channel)
}

function isCellDisabled(eventType, channel) {
  const cell = getCell(eventType, channel)
  return !canTogglePreference(cell, effectiveChannels.value)
}

function toggleCell(eventType, channel) {
  const cell = getCell(eventType, channel)
  if (!cell || !canTogglePreference(cell, effectiveChannels.value)) return
  cell.enabled = !cell.enabled
  saveSuccess.value = false
  saveError.value = ''
}

function getChannelReasonNote(channel) {
  const st = findChannelStatus(effectiveChannels.value, channel)
  if (!st || st.available || !st.reason) return ''
  if (st.reason === 'DEMO_MODE') return session.t('notificationSettings.reasons.DEMO_MODE')
  if (st.reason === 'NOT_LINKED') {
    return channel === 'telegram'
      ? session.t('notificationSettings.reasons.NOT_LINKED_TELEGRAM')
      : session.t('notificationSettings.reasons.NOT_LINKED_WEBPUSH')
  }
  if (st.reason === 'NO_EMAIL_ON_FILE') {
    return session.t('notificationSettings.reasons.NO_EMAIL_ON_FILE')
  }
  if (st.reason === 'CHANNEL_NOT_ENABLED') {
    return session.t('notificationSettings.reasons.CHANNEL_NOT_ENABLED')
  }
  return ''
}

async function handleSavePreferences() {
  if (!hasUnsavedChanges.value || saving.value) return
  saving.value = true
  saveError.value = ''
  saveSuccess.value = false

  try {
    const resp = await updatePreferences(pendingChanges.value)
    originalPreferences.value = clonePreferences(resp?.preferences || editedPreferences.value)
    editedPreferences.value = clonePreferences(resp?.preferences || editedPreferences.value)
    if (resp?.channels) {
      serverChannels.value = resp.channels
    }
    saveSuccess.value = true
  } catch (err) {
    saveError.value = formatErr(err)
  } finally {
    saving.value = false
  }
}

function handleCancelPreferences() {
  editedPreferences.value = clonePreferences(originalPreferences.value)
  saveError.value = ''
  saveSuccess.value = false
}

async function handleLocaleChange() {
  localeSaving.value = true
  localeSaved.value = false
  localeError.value = ''
  const nextLocale = selectedLocale.value === '' ? null : selectedLocale.value
  try {
    await session.changeNotificationLocale(nextLocale)
    localeSaved.value = true
  } catch (err) {
    localeError.value = formatErr(err)
  } finally {
    localeSaving.value = false
  }
}

function clearTelegramTimers() {
  if (telegramCountdownTimer) {
    clearInterval(telegramCountdownTimer)
    telegramCountdownTimer = null
  }
  if (telegramPollTimer) {
    clearInterval(telegramPollTimer)
    telegramPollTimer = null
  }
}

function startTelegramCountdownAndPolling(expiresAtIso) {
  clearTelegramTimers()
  const updateRemaining = () => {
    const diffSec = Math.max(0, Math.floor((new Date(expiresAtIso).getTime() - Date.now()) / 1000))
    telegramSecondsLeft.value = diffSec
    if (diffSec <= 0) {
      clearTelegramTimers()
    }
  }
  updateRemaining()
  telegramCountdownTimer = setInterval(updateRemaining, 1000)

  telegramPollTimer = setInterval(async () => {
    try {
      const resp = await listBindings()
      bindings.value = normalizeBindings(resp)
      if (bindings.value.some((b) => b.channel === 'telegram')) {
        clearTelegramTimers()
        telegramLink.value = null
        const prefsResp = await getPreferences()
        serverChannels.value = prefsResp?.channels || []
      }
    } catch {
      // ignore background poll errors
    }
  }, 5000)
}

async function handleCreateTelegramCode() {
  telegramLoading.value = true
  telegramError.value = ''
  copiedCode.value = false
  try {
    const resp = await createTelegramLinkCode()
    telegramLink.value = resp
    startTelegramCountdownAndPolling(resp.expires_at)
  } catch (err) {
    if (previewLinkedChannels.value && err?.errorCode === 'CHANNEL_NOT_ENABLED') {
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString()
      telegramLink.value = {
        code: 'K7Q2M9XA',
        deep_link: 'https://t.me/korteriuhistu_bot?start=K7Q2M9XA',
        expires_at: expiresAt,
      }
      startTelegramCountdownAndPolling(expiresAt)
    } else {
      telegramError.value = formatErr(err)
    }
  } finally {
    telegramLoading.value = false
  }
}

async function copyStartCommand() {
  if (!telegramLink.value) return
  const text = `/start ${telegramLink.value.code}`
  try {
    await navigator.clipboard.writeText(text)
    copiedCode.value = true
    setTimeout(() => {
      copiedCode.value = false
    }, 2000)
  } catch {
    copiedCode.value = false
  }
}

function formatCountdown(sec) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

async function handleEnableBrowserPush() {
  pushLoading.value = true
  pushState.value = null
  pushErrorMsg.value = ''
  try {
    const res = await enableBrowserPush(detectBrowserDeviceLabel())
    if (res.ok) {
      storedBrowserBindingId.value = res.binding?.binding_id || getStoredWebPushBindingId()
      const [prefsResp, bindingsResp] = await Promise.all([
        getPreferences(),
        listBindings().catch(() => []),
      ])
      serverChannels.value = prefsResp?.channels || []
      bindings.value = normalizeBindings(bindingsResp)
    } else {
      pushState.value = res.reason
    }
  } catch (err) {
    if (err?.errorCode === 'CHANNEL_NOT_ENABLED') {
      pushState.value = 'not_configured'
    } else {
      pushState.value = 'error'
      pushErrorMsg.value = formatErr(err)
    }
  } finally {
    pushLoading.value = false
  }
}

async function handleDisableBrowserPush() {
  pushLoading.value = true
  pushErrorMsg.value = ''
  try {
    const binding = thisBrowserBinding.value
    if (binding && binding.binding_id === storedBrowserBindingId.value) {
      await removeThisBrowserPush()
    } else if (binding) {
      await deleteBinding(binding.binding_id)
    }
    storedBrowserBindingId.value = getStoredWebPushBindingId()
    const [prefsResp, bindingsResp] = await Promise.all([
      getPreferences(),
      listBindings().catch(() => []),
    ])
    serverChannels.value = prefsResp?.channels || []
    bindings.value = normalizeBindings(bindingsResp)
  } catch (err) {
    pushErrorMsg.value = formatErr(err)
  } finally {
    pushLoading.value = false
  }
}

async function handleUnlinkBinding(binding) {
  deletingBindingId.value = binding.binding_id
  try {
    if (binding.channel === 'webpush' && binding.binding_id === storedBrowserBindingId.value) {
      await removeThisBrowserPush()
      storedBrowserBindingId.value = getStoredWebPushBindingId()
    } else {
      await deleteBinding(binding.binding_id)
    }
    const [prefsResp, bindingsResp] = await Promise.all([
      getPreferences(),
      listBindings().catch(() => []),
    ])
    serverChannels.value = prefsResp?.channels || []
    bindings.value = normalizeBindings(bindingsResp)
  } catch (err) {
    saveError.value = formatErr(err)
  } finally {
    deletingBindingId.value = ''
  }
}

onMounted(() => {
  loadData()
})

onUnmounted(() => {
  clearTelegramTimers()
})
</script>

<template>
  <div class="w-full max-w-[960px] mx-auto px-gutter py-space-lg space-y-6">
    <!-- Page Header -->
    <div class="flex flex-col gap-4">
      <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div class="space-y-1">
          <span class="font-label-md text-xs uppercase tracking-wider text-secondary font-semibold">
            {{ session.t('notificationSettings.kicker') }}
          </span>
          <h1 class="font-headline-xl text-2xl sm:text-3xl font-bold text-on-surface tracking-tight">
            {{ session.t('notificationSettings.title') }}
          </h1>
          <p class="text-sm text-on-surface-variant">
            {{ session.t('notificationSettings.subtitle') }}
          </p>
        </div>

        <SettingsShellTabs />
      </div>

      <!-- Demo Preview Toggle for NOT_LINKED cards -->
      <div
        v-if="isDemoChannelMode"
        class="self-start flex items-center gap-2.5 px-3.5 py-2 rounded-lg border border-outline-variant/40 bg-surface-container-low text-on-surface text-xs"
      >
        <span class="material-symbols-outlined text-[18px] text-primary shrink-0" aria-hidden="true">
          visibility
        </span>
        <label class="flex items-center gap-2 cursor-pointer select-none font-medium">
          <input
            v-model="previewLinkedChannels"
            type="checkbox"
            class="rounded border-outline-variant text-primary focus:ring-primary"
          />
          <span>{{ session.t('notificationSettings.demoPreviewToggle') }}</span>
        </label>
      </div>
    </div>

    <ErrorCard v-if="loadError" :error="loadError" @retry="loadData" />

    <!-- Loading Skeleton -->
    <div v-else-if="loading" class="space-y-4">
      <BaseSkeleton class="h-64 w-full rounded-xl" />
      <BaseSkeleton class="h-24 w-full rounded-xl" />
    </div>

    <template v-else>
      <!-- Card 1: What we notify you about -->
      <section class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs overflow-hidden">
        <div class="p-5 sm:p-6 border-b border-surface-container">
          <h2 class="font-headline-md text-lg font-bold text-on-surface">
            {{ session.t('notificationSettings.matrix.title') }}
          </h2>
          <p class="text-xs text-on-surface-variant mt-1">
            {{ session.t('notificationSettings.matrix.description') }}
          </p>
        </div>

        <!-- Desktop Table -->
        <div class="hidden md:block overflow-x-auto">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="border-b border-surface-container bg-surface-container-low/60">
                <th class="py-3.5 px-6 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                  {{ session.t('notificationSettings.matrix.eventColumn') }}
                </th>
                <th
                  v-for="ch in NOTIFICATION_CHANNELS"
                  :key="ch"
                  class="py-3.5 px-4 text-center text-xs font-semibold uppercase tracking-wider text-on-surface-variant"
                >
                  <div>{{ session.t(`notificationSettings.channels.${ch}`) }}</div>
                  <div
                    v-if="getChannelReasonNote(ch)"
                    class="text-[11px] font-normal normal-case text-on-surface-variant/80 mt-0.5 max-w-[140px] mx-auto"
                  >
                    {{ getChannelReasonNote(ch) }}
                  </div>
                </th>
              </tr>
            </thead>
            <tbody class="divide-y divide-surface-container">
              <tr
                v-for="ev in visibleEvents"
                :key="ev"
                class="hover:bg-surface-container-low/40 transition-colors"
              >
                <td class="py-4 px-6">
                  <div class="font-semibold text-sm text-on-surface">
                    {{ session.t(`notificationSettings.events.${ev}.title`) }}
                  </div>
                  <div class="text-xs text-on-surface-variant mt-0.5">
                    {{ session.t(`notificationSettings.events.${ev}.description`) }}
                  </div>
                </td>
                <td
                  v-for="ch in NOTIFICATION_CHANNELS"
                  :key="ch"
                  class="py-4 px-4 text-center align-middle"
                >
                  <div class="inline-flex items-center justify-center gap-1.5">
                    <button
                      type="button"
                      role="switch"
                      :aria-checked="Boolean(getCell(ev, ch)?.enabled)"
                      :aria-label="`${session.t(`notificationSettings.events.${ev}.title`)} — ${session.t(`notificationSettings.channels.${ch}`)}`"
                      :disabled="isCellDisabled(ev, ch)"
                      :title="
                        getCell(ev, ch)?.mandatory
                          ? session.t('notificationSettings.matrix.mandatoryTooltip')
                          : getChannelReasonNote(ch) || ''
                      "
                      class="relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-primary/40"
                      :class="[
                        getCell(ev, ch)?.enabled ? 'bg-primary' : 'bg-surface-container-high',
                        isCellDisabled(ev, ch) ? 'opacity-55 cursor-not-allowed' : 'cursor-pointer',
                      ]"
                      @click="toggleCell(ev, ch)"
                    >
                      <span
                        class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-surface-container-lowest shadow-xs transition duration-200"
                        :class="getCell(ev, ch)?.enabled ? 'translate-x-5' : 'translate-x-0'"
                      />
                    </button>
                    <span
                      v-if="getCell(ev, ch)?.mandatory"
                      class="material-symbols-outlined text-[15px] text-on-surface-variant"
                      :title="session.t('notificationSettings.matrix.mandatoryTooltip')"
                      aria-hidden="true"
                    >
                      lock
                    </span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Mobile Cards (375px) -->
        <div class="md:hidden divide-y divide-surface-container">
          <div v-for="ev in visibleEvents" :key="ev" class="p-4 space-y-3">
            <div>
              <div class="font-semibold text-sm text-on-surface">
                {{ session.t(`notificationSettings.events.${ev}.title`) }}
              </div>
              <div class="text-xs text-on-surface-variant mt-0.5">
                {{ session.t(`notificationSettings.events.${ev}.description`) }}
              </div>
            </div>
            <div class="space-y-2.5 pt-1">
              <div
                v-for="ch in NOTIFICATION_CHANNELS"
                :key="ch"
                class="flex items-center justify-between gap-3 py-1"
              >
                <div>
                  <div class="text-sm text-on-surface">
                    {{ session.t(`notificationSettings.channels.${ch}`) }}
                  </div>
                  <div v-if="getChannelReasonNote(ch)" class="text-xs text-on-surface-variant">
                    {{ getChannelReasonNote(ch) }}
                  </div>
                </div>
                <div class="flex items-center gap-1.5">
                  <span
                    v-if="getCell(ev, ch)?.mandatory"
                    class="material-symbols-outlined text-[15px] text-on-surface-variant"
                    :title="session.t('notificationSettings.matrix.mandatoryTooltip')"
                    aria-hidden="true"
                  >
                    lock
                  </span>
                  <button
                    type="button"
                    role="switch"
                    :aria-checked="Boolean(getCell(ev, ch)?.enabled)"
                    :disabled="isCellDisabled(ev, ch)"
                    class="relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200"
                    :class="[
                      getCell(ev, ch)?.enabled ? 'bg-primary' : 'bg-surface-container-high',
                      isCellDisabled(ev, ch) ? 'opacity-55 cursor-not-allowed' : 'cursor-pointer',
                    ]"
                    @click="toggleCell(ev, ch)"
                  >
                    <span
                      class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-surface-container-lowest shadow-xs transition duration-200"
                      :class="getCell(ev, ch)?.enabled ? 'translate-x-5' : 'translate-x-0'"
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Matrix Footer Actions -->
        <div
          class="px-5 py-4 bg-surface-container-low/50 border-t border-surface-container flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <div class="text-xs text-on-surface-variant flex items-center gap-1.5">
            <span class="material-symbols-outlined text-[15px] shrink-0" aria-hidden="true">lock</span>
            <span>{{ session.t('notificationSettings.matrix.mandatoryTooltip') }}</span>
          </div>

          <div class="flex items-center gap-3">
            <span v-if="saveError" class="text-xs text-error font-medium">{{ saveError }}</span>
            <span v-else-if="saveSuccess" class="text-xs text-primary font-semibold">
              {{ session.t('notificationSettings.matrix.saved') }}
            </span>

            <button
              v-if="hasUnsavedChanges"
              type="button"
              class="px-3.5 py-2 text-xs font-semibold text-on-surface bg-surface-container hover:bg-surface-container-high rounded-lg transition-colors cursor-pointer"
              @click="handleCancelPreferences"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="!hasUnsavedChanges || saving"
              class="px-4 py-2 text-xs font-semibold text-on-primary bg-primary rounded-lg hover:opacity-95 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity cursor-pointer"
              @click="handleSavePreferences"
            >
              {{ saving ? session.t('common.saving') : session.t('common.saveChanges') }}
            </button>
          </div>
        </div>
      </section>

      <!-- Card 2: Language of messages -->
      <section class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs p-5 sm:p-6">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div class="space-y-1">
            <h2 class="font-headline-md text-lg font-bold text-on-surface flex items-center gap-2">
              <span class="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
                translate
              </span>
              <span>{{ session.t('notificationSettings.language.title') }}</span>
            </h2>
            <p class="text-xs text-on-surface-variant">
              {{ session.t('notificationSettings.language.description') }}
            </p>
          </div>

          <div class="flex items-center gap-3">
            <select
              v-model="selectedLocale"
              :disabled="localeSaving"
              :aria-label="session.t('notificationSettings.language.title')"
              class="rounded-lg border border-outline-variant/40 bg-surface-container-low px-3.5 py-2 text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40"
              @change="handleLocaleChange"
            >
              <option value="">{{ session.t('notificationSettings.language.buildingDefault') }}</option>
              <option value="et">{{ session.t('notificationSettings.language.et') }}</option>
              <option value="ru">{{ session.t('notificationSettings.language.ru') }}</option>
              <option value="en">{{ session.t('notificationSettings.language.en') }}</option>
            </select>
            <span v-if="localeSaved" class="text-xs text-primary font-semibold">
              {{ session.t('notificationSettings.language.saved') }}
            </span>
            <span v-else-if="localeError" class="text-xs text-error">
              {{ localeError }}
            </span>
          </div>
        </div>
      </section>

      <!-- Card 3a: Telegram -->
      <section
        v-if="showTelegramCard"
        class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs p-5 sm:p-6 space-y-4"
      >
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 class="font-headline-md text-lg font-bold text-on-surface flex items-center gap-2">
              <span class="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
                send
              </span>
              <span>{{ session.t('notificationSettings.telegram.title') }}</span>
            </h2>
            <p class="text-xs text-on-surface-variant mt-1">
              {{ session.t('notificationSettings.telegram.description') }}
            </p>
          </div>

          <div v-if="telegramBinding" class="flex items-center gap-3">
            <span
              class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-secondary-container text-on-secondary-container"
            >
              {{
                session.t('notificationSettings.telegram.linkedAs', {
                  label: telegramBinding.label || 'Telegram',
                })
              }}
            </span>
            <button
              type="button"
              :disabled="deletingBindingId === telegramBinding.binding_id"
              class="px-3 py-1.5 text-xs font-semibold text-error hover:bg-error-container/30 rounded-lg transition-colors cursor-pointer"
              @click="handleUnlinkBinding(telegramBinding)"
            >
              {{ session.t('notificationSettings.bindings.unlink') }}
            </button>
          </div>

          <button
            v-else-if="!telegramLink"
            type="button"
            :disabled="telegramLoading"
            class="px-4 py-2 text-xs font-semibold text-on-primary bg-primary hover:opacity-95 rounded-lg disabled:opacity-50 transition-opacity self-start sm:self-auto cursor-pointer"
            @click="handleCreateTelegramCode"
          >
            {{
              telegramLoading
                ? session.t('common.loading')
                : session.t('notificationSettings.telegram.linkButton')
            }}
          </button>
        </div>

        <div v-if="telegramError" class="text-xs text-error">
          {{ telegramError }}
        </div>

        <!-- Active Link Code Flow -->
        <div
          v-if="telegramLink && !telegramBinding"
          class="rounded-xl bg-surface-container-low border border-surface-container p-4 space-y-3"
        >
          <div v-if="telegramSecondsLeft > 0" class="space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <a
                :href="telegramLink.deep_link"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-on-primary bg-primary hover:opacity-95 rounded-lg transition-opacity"
              >
                <span>{{ session.t('notificationSettings.telegram.openTelegram') }}</span>
                <span class="material-symbols-outlined text-[16px]" aria-hidden="true">
                  open_in_new
                </span>
              </a>

              <span class="text-xs font-mono tabular-nums font-semibold text-on-surface-variant">
                {{
                  session.t('notificationSettings.telegram.expiresIn', {
                    time: formatCountdown(telegramSecondsLeft),
                  })
                }}
              </span>
            </div>

            <div class="text-xs text-on-surface-variant">
              {{ session.t('notificationSettings.telegram.manualHint') }}
            </div>

            <div class="flex items-center gap-2">
              <code
                class="px-3 py-1.5 rounded-lg bg-surface-container-lowest border border-outline-variant/40 font-mono text-sm text-on-surface select-all"
              >
                /start {{ telegramLink.code }}
              </code>
              <button
                type="button"
                class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-on-surface bg-surface-container hover:bg-surface-container-high rounded-lg transition-colors cursor-pointer"
                @click="copyStartCommand"
              >
                <span class="material-symbols-outlined text-[15px]" aria-hidden="true">
                  {{ copiedCode ? 'check' : 'content_copy' }}
                </span>
                <span>
                  {{
                    copiedCode
                      ? session.t('notificationSettings.telegram.copied')
                      : session.t('notificationSettings.telegram.copyCommand')
                  }}
                </span>
              </button>
            </div>
          </div>

          <div v-else class="flex items-center justify-between gap-3">
            <span class="text-sm text-on-surface-variant">
              {{ session.t('notificationSettings.telegram.codeExpired') }}
            </span>
            <button
              type="button"
              class="px-3.5 py-1.5 text-xs font-semibold text-on-primary bg-primary hover:opacity-95 rounded-lg transition-opacity cursor-pointer"
              @click="handleCreateTelegramCode"
            >
              {{ session.t('notificationSettings.telegram.getNewCode') }}
            </button>
          </div>
        </div>
      </section>

      <!-- Card 3b: This Browser (WebPush) -->
      <section
        v-if="showWebPushCard"
        class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs p-5 sm:p-6 space-y-3"
      >
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 class="font-headline-md text-lg font-bold text-on-surface flex items-center gap-2">
              <span class="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
                notifications_active
              </span>
              <span>{{ session.t('notificationSettings.webpush.title') }}</span>
            </h2>
            <p class="text-xs text-on-surface-variant mt-1">
              {{ session.t('notificationSettings.webpush.description') }}
            </p>
          </div>

          <div v-if="thisBrowserBinding" class="flex items-center gap-3">
            <span
              class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold bg-secondary-container text-on-secondary-container"
            >
              {{
                session.t('notificationSettings.webpush.enabledOn', {
                  label: thisBrowserBinding.label || session.t('notificationSettings.bindings.thisBrowser'),
                })
              }}
            </span>
            <button
              type="button"
              :disabled="pushLoading"
              class="px-3 py-1.5 text-xs font-semibold text-error hover:bg-error-container/30 rounded-lg transition-colors cursor-pointer"
              @click="handleDisableBrowserPush"
            >
              {{ session.t('notificationSettings.webpush.turnOff') }}
            </button>
          </div>

          <button
            v-else
            type="button"
            :disabled="pushLoading"
            class="px-4 py-2 text-xs font-semibold text-on-primary bg-primary hover:opacity-95 rounded-lg disabled:opacity-50 transition-opacity self-start sm:self-auto cursor-pointer"
            @click="handleEnableBrowserPush"
          >
            {{
              pushLoading
                ? session.t('common.loading')
                : session.t('notificationSettings.webpush.enableButton')
            }}
          </button>
        </div>

        <p v-if="pushState === 'denied'" class="text-xs text-on-surface-variant">
          {{ session.t('notificationSettings.webpush.permissionDenied') }}
        </p>
        <p v-else-if="pushState === 'not_configured'" class="text-xs text-on-surface-variant">
          {{ session.t('notificationSettings.reasons.CHANNEL_NOT_ENABLED') }}
        </p>
        <p v-else-if="pushErrorMsg" class="text-xs text-error">
          {{ pushErrorMsg }}
        </p>
      </section>

      <!-- Card 4: Linked chats and devices -->
      <section class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs overflow-hidden">
        <div class="p-5 sm:p-6 border-b border-surface-container">
          <h2 class="font-headline-md text-lg font-bold text-on-surface">
            {{ session.t('notificationSettings.bindings.title') }}
          </h2>
          <p class="text-xs text-on-surface-variant mt-1">
            {{ session.t('notificationSettings.bindings.description') }}
          </p>
        </div>

        <div v-if="bindings.length === 0" class="p-6 text-sm text-on-surface-variant">
          {{ session.t('notificationSettings.bindings.empty') }}
        </div>

        <ul v-else class="divide-y divide-surface-container">
          <li
            v-for="b in bindings"
            :key="b.binding_id"
            class="p-4 sm:px-6 flex items-center justify-between gap-4"
          >
            <div class="flex items-center gap-3 min-w-0">
              <div
                class="w-9 h-9 rounded-lg bg-surface-container flex items-center justify-center text-on-surface shrink-0"
              >
                <span class="material-symbols-outlined text-[18px]" aria-hidden="true">
                  {{ b.channel === 'telegram' ? 'send' : 'devices' }}
                </span>
              </div>
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-sm font-semibold text-on-surface truncate">
                    {{ b.label || session.t(`notificationSettings.channels.${b.channel}`) }}
                  </span>
                  <span
                    class="px-2 py-0.5 text-[11px] font-semibold rounded-md bg-surface-container text-on-surface-variant"
                  >
                    {{ session.t(`notificationSettings.channels.${b.channel}`) }}
                  </span>
                  <span
                    v-if="b.channel === 'webpush' && b.binding_id === storedBrowserBindingId"
                    class="px-2 py-0.5 text-[11px] font-semibold rounded-md bg-secondary-container text-on-secondary-container"
                  >
                    {{ session.t('notificationSettings.bindings.thisBrowser') }}
                  </span>
                </div>
                <div class="text-xs text-on-surface-variant mt-0.5">
                  {{
                    session.t('notificationSettings.bindings.addedOn', {
                      date: formatShortDate(b.created_at, session.lang),
                    })
                  }}
                </div>
              </div>
            </div>

            <button
              type="button"
              :disabled="deletingBindingId === b.binding_id"
              class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-error hover:bg-error-container/30 rounded-lg disabled:opacity-50 transition-colors shrink-0 cursor-pointer"
              @click="handleUnlinkBinding(b)"
            >
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">
                link_off
              </span>
              <span>{{ session.t('notificationSettings.bindings.unlink') }}</span>
            </button>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
