<script setup>
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { unsubscribeByToken } from '@/api/endpoints/notifications.js'
import { takeLinkToken } from '@/utils/linkToken.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const session = useSessionStore()

function extractInitialToken() {
  const fromStash = takeLinkToken()
  if (fromStash) {
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      window.history.replaceState(null, '', '/unsubscribe')
    }
    return fromStash
  }
  if (typeof window !== 'undefined' && window.location.hash && window.location.hash.length > 1) {
    const raw = window.location.hash.slice(1).trim()
    const extracted = raw.startsWith('token=') ? raw.slice('token='.length) : raw
    if (window.history?.replaceState) {
      window.history.replaceState(null, '', '/unsubscribe')
    }
    return extracted
  }
  return ''
}

// Token is kept strictly in component memory and stripped from the URL bar immediately
const token = ref(extractInitialToken())

// 'confirm' | 'done' | 'invalid'
const state = ref(token.value && token.value.length <= 128 ? 'confirm' : 'invalid')
const submitting = ref(false)
const unsubscribedEventType = ref('')
const networkError = ref(null)

const doneMessage = computed(() => {
  const ev = unsubscribedEventType.value || 'READING_DEADLINE'
  const specificKey = `unsubscribe.offByEvent.${ev}`
  const translated = session.t(specificKey)
  if (translated && translated !== specificKey) {
    return translated
  }
  const eventTitleKey = `notificationSettings.events.${ev}.title`
  const eventTitle =
    session.t(eventTitleKey) !== eventTitleKey ? session.t(eventTitleKey) : ev
  return session.t('unsubscribe.offGeneric', { event: eventTitle })
})

async function handleConfirmUnsubscribe() {
  if (!token.value || submitting.value) return
  submitting.value = true
  networkError.value = null
  try {
    const res = await unsubscribeByToken(token.value)
    unsubscribedEventType.value = res?.event_type || 'READING_DEADLINE'
    state.value = 'done'
  } catch (err) {
    if (
      err?.status === 400 ||
      err?.status === 422 ||
      err?.errorCode === 'INVALID_LINK' ||
      err?.errorCode === 'VALIDATION_ERROR'
    ) {
      state.value = 'invalid'
    } else {
      networkError.value = err
    }
  } finally {
    submitting.value = false
  }
}

function loadDemoToken(nextToken) {
  token.value = nextToken
  unsubscribedEventType.value = ''
  networkError.value = null
  state.value = nextToken ? 'confirm' : 'invalid'
  if (typeof window !== 'undefined' && window.history?.replaceState) {
    window.history.replaceState(null, '', '/unsubscribe')
  }
}
</script>

<template>
  <div class="min-h-[calc(100vh-5rem)] flex flex-col items-center justify-center px-4 py-10">
    <div class="w-full max-w-md space-y-4">
      <div class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 sm:p-8 shadow-xs space-y-6">
        <!-- State 1: Confirm Unsubscribe (button click required so mail scanners never trigger POST) -->
        <template v-if="state === 'confirm'">
          <div class="flex flex-col items-center text-center space-y-4">
            <div class="w-12 h-12 rounded-full bg-surface-container flex items-center justify-center text-primary">
              <span class="material-symbols-outlined text-[24px]" aria-hidden="true">
                unsubscribe
              </span>
            </div>

            <div class="space-y-2">
              <span class="font-label-md text-xs uppercase tracking-wider text-secondary font-semibold block">
                {{ session.t('unsubscribe.kicker') }}
              </span>
              <h1 class="font-headline-lg text-xl sm:text-2xl font-bold text-on-surface tracking-tight">
                {{ session.t('unsubscribe.confirmTitle') }}
              </h1>
              <p class="text-sm text-on-surface-variant leading-relaxed">
                {{ session.t('unsubscribe.confirmBody') }}
              </p>
            </div>

            <ErrorCard
              v-if="networkError"
              :error="networkError"
              @retry="handleConfirmUnsubscribe"
            />

            <div class="w-full pt-2 space-y-3">
              <button
                type="button"
                :disabled="submitting"
                class="w-full py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 inline-flex items-center justify-center gap-2 cursor-pointer"
                @click="handleConfirmUnsubscribe"
              >
                <span class="material-symbols-outlined text-[18px]" aria-hidden="true">
                  notifications_off
                </span>
                <span>
                  {{
                    submitting
                      ? session.t('common.loading')
                      : session.t('unsubscribe.confirmBtn')
                  }}
                </span>
              </button>

              <RouterLink
                to="/settings/notifications"
                class="block w-full py-1.5 text-xs font-semibold text-on-surface-variant hover:text-on-surface transition-colors"
              >
                {{ session.t('unsubscribe.openSettingsBtn') }}
              </RouterLink>
            </div>
          </div>
        </template>

        <!-- State 2: Unsubscribed (200 OK) -->
        <template v-else-if="state === 'done'">
          <div class="flex flex-col items-center text-center space-y-4">
            <div class="w-12 h-12 rounded-full bg-secondary-container text-on-secondary-container flex items-center justify-center">
              <span class="material-symbols-outlined text-[24px]" aria-hidden="true">
                check_circle
              </span>
            </div>

            <div class="space-y-2">
              <span class="font-label-md text-xs uppercase tracking-wider text-secondary font-semibold block">
                {{ session.t('unsubscribe.kicker') }}
              </span>
              <h1 class="font-headline-lg text-xl sm:text-2xl font-bold text-on-surface tracking-tight">
                {{ doneMessage }}
              </h1>
              <p class="text-sm text-on-surface-variant leading-relaxed">
                {{ session.t('unsubscribe.turnBackOnHint') }}
              </p>
            </div>

            <div class="w-full pt-2">
              <RouterLink
                to="/settings/notifications"
                class="w-full py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity inline-flex items-center justify-center gap-2"
              >
                <span class="material-symbols-outlined text-[18px]" aria-hidden="true">tune</span>
                <span>{{ session.t('unsubscribe.openSettingsBtn') }}</span>
              </RouterLink>
            </div>
          </div>
        </template>

        <!-- State 3: Invalid / Expired Link (400 INVALID_LINK or missing hash) -->
        <template v-else>
          <div class="flex flex-col items-center text-center space-y-4">
            <div class="w-12 h-12 rounded-full bg-error-container/30 text-error flex items-center justify-center">
              <span class="material-symbols-outlined text-[24px]" aria-hidden="true">
                link_off
              </span>
            </div>

            <div class="space-y-2">
              <span class="font-label-md text-xs uppercase tracking-wider text-secondary font-semibold block">
                {{ session.t('unsubscribe.kicker') }}
              </span>
              <h1 class="font-headline-lg text-xl font-bold text-on-surface tracking-tight">
                {{ session.t('unsubscribe.invalidTitle') }}
              </h1>
              <p class="text-sm text-on-surface-variant leading-relaxed">
                {{ session.t('unsubscribe.invalidBody') }}
              </p>
            </div>

            <div class="w-full pt-2">
              <RouterLink
                to="/settings/notifications"
                class="w-full py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity inline-flex items-center justify-center gap-2"
              >
                <span class="material-symbols-outlined text-[18px]" aria-hidden="true">tune</span>
                <span>{{ session.t('unsubscribe.openSettingsBtn') }}</span>
              </RouterLink>
            </div>
          </div>
        </template>

        <!-- Demo Mode Simulator for testing valid vs invalid tokens -->
        <div
          v-if="session.demoUsers.length > 0"
          class="w-full pt-5 border-t border-surface-container text-left space-y-2.5"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold text-on-surface">
              {{ session.t('unsubscribe.demoTitle') }}
            </span>
            <span class="px-1.5 py-0.5 rounded bg-secondary-container text-on-secondary-container text-[10px] font-bold uppercase tracking-wider">
              DEMO
            </span>
          </div>
          <p class="text-xs text-on-surface-variant leading-relaxed">
            {{ session.t('unsubscribe.demoHint') }}
          </p>
          <div class="flex flex-col sm:flex-row gap-2 pt-1">
            <button
              type="button"
              class="flex-1 py-2 px-3 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
              @click="loadDemoToken('demo-reading-deadline')"
            >
              <span>{{ session.t('unsubscribe.demoValidBtn') }}</span>
            </button>
            <button
              type="button"
              class="flex-1 py-2 px-3 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
              @click="loadDemoToken('expired-token')"
            >
              <span>{{ session.t('unsubscribe.demoInvalidBtn') }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
