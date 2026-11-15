<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { useChat } from '@/composables/useChat.js'
import { setChatScreenOpen, useChatState } from '@/composables/useChatState.js'
import { localizeError } from '@/locales/index.js'
import { formatDateTime } from '@/utils/dates.js'
import { CHAT_MAX_LENGTH } from '@/utils/chat.js'
import AuthorBadge from '@/components/domain/AuthorBadge.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const session = useSessionStore()
const { isChairman } = useRole()
const { maxLength: stateMaxLength } = useChatState()

const {
  messages,
  initialLoading,
  loadError,
  disabled,
  forbidden,
  sending,
  sendError,
  cooldownSeconds,
  start,
  stop,
  reload,
  sendMessage,
  notifyTyping,
} = useChat({ autoLifecycle: false })

const draftBody = ref('')
const localValidationError = ref('')
const selectedApartmentId = ref(null)
const listRef = ref(null)

const effectiveMaxLength = computed(() => stateMaxLength.value || CHAT_MAX_LENGTH)

const memberships = computed(() =>
  Array.isArray(session.me?.memberships) ? session.me.memberships : [],
)

const hasMultipleApartments = computed(() => memberships.value.length > 1)

watch(
  memberships,
  (mems) => {
    if (!Array.isArray(mems) || mems.length === 0) {
      selectedApartmentId.value = null
      return
    }
    const stillValid = mems.some((m) => m.apartment_id === selectedApartmentId.value)
    if (!stillValid) {
      const activeId = session.activeMembership?.apartment_id
      selectedApartmentId.value =
        activeId && mems.some((m) => m.apartment_id === activeId)
          ? activeId
          : mems[0].apartment_id
    }
  },
  { immediate: true },
)

const trimmedBody = computed(() => draftBody.value.trim())

const canSubmit = computed(
  () =>
    !disabled.value &&
    !forbidden.value &&
    !sending.value &&
    cooldownSeconds.value === 0 &&
    draftBody.value.length <= effectiveMaxLength.value &&
    trimmedBody.value.length >= 1 &&
    trimmedBody.value.length <= effectiveMaxLength.value,
)

const inlineErrorText = computed(() => {
  if (localValidationError.value) return localValidationError.value
  if (sendError.value) {
    return localizeError(sendError.value, {}, session.lang)
  }
  return ''
})

function scrollToBottom(force = false) {
  nextTick(() => {
    const el = listRef.value
    if (!el || typeof el.scrollHeight !== 'number') return
    if (force) {
      el.scrollTop = el.scrollHeight
      return
    }
    const distanceFromBottom = el.scrollHeight - el.scrollTop - (el.clientHeight || 0)
    if (distanceFromBottom < 120) {
      el.scrollTop = el.scrollHeight
    }
  })
}

watch(
  () => messages.value.length,
  (newLen, oldLen) => {
    if (newLen > oldLen) {
      scrollToBottom(oldLen === 0)
    }
  },
)

function handleComposerInput() {
  localValidationError.value = ''
  sendError.value = null
  notifyTyping()
}

async function handleSubmit() {
  localValidationError.value = ''
  const trimmed = trimmedBody.value
  if (trimmed.length === 0 || trimmed.length > effectiveMaxLength.value) {
    localValidationError.value = session.t('chat.validationEmpty', {
      max: effectiveMaxLength.value,
    })
    return
  }
  if (sending.value || cooldownSeconds.value > 0) return

  const payload = { body: draftBody.value }
  if (hasMultipleApartments.value && selectedApartmentId.value) {
    payload.author_apartment_id = selectedApartmentId.value
  }

  const res = await sendMessage(payload)
  if (res?.ok) {
    draftBody.value = ''
    scrollToBottom(true)
  }
}

function handleEnterSend(event) {
  if (event?.isComposing || event?.keyCode === 229 || event?.shiftKey) return
  event?.preventDefault?.()
  handleSubmit()
}

onMounted(() => {
  setChatScreenOpen(true)
  start()
})

onBeforeUnmount(() => {
  stop()
  setChatScreenOpen(false)
})
</script>

<template>
  <div class="w-full max-w-[960px] mx-auto px-3 sm:px-gutter py-space-lg space-y-5">
    <!-- Page Header -->
    <header class="space-y-1.5">
      <p class="text-xs font-medium text-on-surface-variant tracking-wide uppercase">
        {{ session.t('chat.kicker') }}
      </p>
      <h1 class="font-title-lg text-2xl sm:text-3xl font-bold text-on-surface tracking-tight">
        {{ session.t('chat.title') }}
      </h1>
      <p class="font-body-md text-sm text-on-surface-variant max-w-2xl">
        {{ session.t('chat.subtitle') }}
      </p>
    </header>

    <!-- Ephemeral Privacy Notice (Always visible on chat screen) -->
    <div
      data-testid="chat-ephemeral-disclaimer"
      class="bg-surface-container-low border border-surface-container rounded-xl px-4 py-3 flex items-start gap-2.5 text-xs text-on-surface-variant"
      role="note"
    >
      <span class="material-symbols-outlined text-[18px] text-primary shrink-0 mt-0.5" aria-hidden="true">
        schedule
      </span>
      <p class="font-medium text-on-surface leading-relaxed">
        {{ session.t('chat.disclaimer') }}
      </p>
    </div>

    <!-- Fail-Closed Non-Participant (403) -->
    <div
      v-if="forbidden"
      data-testid="chat-forbidden-state"
      class="p-8 rounded-2xl bg-surface-container-lowest border border-surface-container text-center space-y-3"
      role="alert"
    >
      <div class="w-12 h-12 rounded-full bg-surface-container-high mx-auto flex items-center justify-center text-on-surface-variant">
        <span class="material-symbols-outlined text-[24px]" aria-hidden="true">lock</span>
      </div>
      <h2 class="font-bold text-base text-on-surface">
        {{ session.t('chat.forbiddenTitle') }}
      </h2>
      <p class="text-sm text-on-surface-variant max-w-md mx-auto">
        {{ session.t('chat.forbiddenBody') }}
      </p>
      <div class="pt-1">
        <RouterLink
          to="/"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary/90 transition-colors"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_back</span>
          <span>{{ session.t('chat.backToDashboard') }}</span>
        </RouterLink>
      </div>
    </div>

    <!-- Disabled State (409 CHAT_DISABLED) -->
    <div
      v-else-if="disabled"
      data-testid="chat-disabled-state"
      class="p-8 rounded-2xl bg-surface-container-lowest border border-surface-container text-center space-y-3"
      role="status"
    >
      <div class="w-12 h-12 rounded-full bg-surface-container-high mx-auto flex items-center justify-center text-on-surface-variant">
        <span class="material-symbols-outlined text-[24px]" aria-hidden="true">speaker_notes_off</span>
      </div>
      <h2 class="font-bold text-base text-on-surface">
        {{ session.t('chat.disabledTitle') }}
      </h2>
      <p class="text-sm text-on-surface-variant max-w-md mx-auto">
        {{ session.t('chat.disabledBody') }}
      </p>
      <div class="pt-1 flex flex-wrap items-center justify-center gap-2.5">
        <RouterLink
          v-if="isChairman"
          to="/settings/association"
          data-testid="chat-open-settings-link"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary/90 transition-colors"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">tune</span>
          <span>{{ session.t('chat.openSettingsBtn') }}</span>
        </RouterLink>
        <RouterLink
          to="/"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-outline-variant text-on-surface-variant text-xs font-semibold hover:bg-surface-container transition-colors"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_back</span>
          <span>{{ session.t('chat.backToDashboard') }}</span>
        </RouterLink>
      </div>
    </div>

    <!-- Initial Loading Skeleton -->
    <div
      v-else-if="initialLoading"
      data-testid="chat-loading"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-6 space-y-4"
    >
      <div v-for="i in 3" :key="i" class="space-y-2">
        <div class="h-3 w-36 bg-surface-container animate-pulse rounded" />
        <div class="h-12 w-3/4 bg-surface-container animate-pulse rounded-xl" />
      </div>
    </div>

    <!-- Load Error -->
    <ErrorCard
      v-else-if="loadError"
      :error="loadError"
      @retry="reload"
    />

    <!-- Live Chat Room -->
    <section
      v-else
      data-testid="chat-room"
      class="bg-surface-container-lowest border border-surface-container rounded-2xl shadow-xs flex flex-col overflow-hidden"
    >
      <!-- Message History Window (Oldest First) -->
      <div
        ref="listRef"
        data-testid="chat-message-list"
        role="log"
        aria-live="polite"
        class="p-4 sm:p-5 space-y-3 min-h-[280px] max-h-[55vh] overflow-y-auto"
      >
        <div
          v-if="messages.length === 0"
          data-testid="chat-empty-state"
          class="py-12 text-center text-sm text-on-surface-variant"
        >
          {{ session.t('chat.empty') }}
        </div>

        <div
          v-for="msg in messages"
          :key="msg.id"
          data-testid="chat-message-row"
          :data-message-id="msg.id"
          :data-own="String(Boolean(msg.is_own))"
          class="flex flex-col max-w-[85%] sm:max-w-[75%]"
          :class="msg.is_own ? 'ml-auto items-end' : 'mr-auto items-start'"
        >
          <div class="flex flex-wrap items-center gap-2 px-1 mb-1">
            <AuthorBadge :badge="msg.author_badge" :is-mine="Boolean(msg.is_own)" />
            <span class="text-[11px] text-on-surface-variant tabular-nums">
              {{ formatDateTime(msg.created_at, session.lang) }}
            </span>
          </div>

          <div
            class="rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed border whitespace-pre-wrap break-words text-on-surface"
            :class="
              msg.is_own
                ? 'bg-primary/10 border-primary/25 rounded-tr-xs'
                : 'bg-surface-container-low border-surface-container rounded-tl-xs'
            "
          >
            {{ msg.body }}
          </div>
        </div>
      </div>

      <!-- Composer Bar -->
      <form
        data-testid="chat-composer-form"
        class="border-t border-surface-container bg-surface-container-low/50 p-3.5 sm:p-4 space-y-2.5"
        novalidate
        @submit.prevent="handleSubmit"
      >
        <!-- Multi-Apartment Selector (only if user has >1 membership) -->
        <div v-if="hasMultipleApartments" class="flex items-center gap-2">
          <label
            for="chat-apartment-select"
            class="text-xs font-medium text-on-surface-variant shrink-0"
          >
            {{ session.t('chat.apartmentSelectLabel') }}
          </label>
          <select
            id="chat-apartment-select"
            v-model="selectedApartmentId"
            data-testid="chat-apartment-select"
            :disabled="sending"
            class="px-2.5 py-1.5 rounded-lg border border-outline-variant bg-surface-container-lowest text-xs text-on-surface focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option
              v-for="m in memberships"
              :key="m.apartment_id"
              :value="m.apartment_id"
            >
              {{ session.t('common.apartmentNumber', { number: m.apartment_number }) }}
            </option>
          </select>
        </div>

        <!-- 429 Cooldown Banner -->
        <div
          v-if="cooldownSeconds > 0"
          data-testid="chat-rate-limit-banner"
          class="px-3 py-2 rounded-lg bg-error-container/70 border border-error/30 text-xs font-medium text-on-error-container"
          role="alert"
        >
          {{ session.t('chat.rateLimitNotice', { seconds: cooldownSeconds }) }}
        </div>

        <!-- Inline Send Error -->
        <div
          v-else-if="inlineErrorText"
          data-testid="chat-send-error"
          class="px-3 py-2 rounded-lg bg-error-container/70 border border-error/30 text-xs font-medium text-on-error-container"
          role="alert"
        >
          {{ inlineErrorText }}
        </div>

        <div class="flex flex-col sm:flex-row items-stretch sm:items-end gap-2.5">
          <div class="flex-1 min-w-0">
            <textarea
              v-model="draftBody"
              data-testid="chat-body-input"
              rows="2"
              :maxlength="effectiveMaxLength"
              :placeholder="session.t('chat.composerPlaceholder')"
              :aria-label="session.t('chat.composerPlaceholder')"
              :disabled="sending"
              class="w-full px-3.5 py-2.5 rounded-xl border border-outline-variant bg-surface-container-lowest text-sm text-on-surface placeholder:text-on-surface-variant/70 focus:outline-none focus:ring-2 focus:ring-primary resize-y min-h-[60px] max-h-40 disabled:opacity-60"
              @input="handleComposerInput"
              @keydown.enter.exact="handleEnterSend"
            />
          </div>

          <button
            type="submit"
            data-testid="chat-send-btn"
            :disabled="!canSubmit"
            class="px-4 py-2.5 rounded-xl bg-primary text-on-primary text-xs font-semibold hover:bg-primary/90 transition-colors whitespace-nowrap shrink-0 inline-flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed sm:h-[44px]"
          >
            <span class="material-symbols-outlined text-[16px]" aria-hidden="true">send</span>
            <span>
              {{
                cooldownSeconds > 0
                  ? session.t('chat.sendCooldownBtn', { seconds: cooldownSeconds })
                  : sending
                    ? session.t('chat.sendingBtn')
                    : session.t('chat.sendBtn')
              }}
            </span>
          </button>
        </div>

        <div class="flex items-center justify-between gap-2 text-[11px] text-on-surface-variant">
          <span>{{ session.t('chat.sendHint') }}</span>
          <span
            data-testid="chat-char-counter"
            class="font-mono tabular-nums"
            :class="draftBody.length >= effectiveMaxLength ? 'text-error font-semibold' : ''"
          >
            {{ session.t('chat.charCounter', { used: draftBody.length, max: effectiveMaxLength }) }}
          </span>
        </div>
      </form>
    </section>
  </div>
</template>
