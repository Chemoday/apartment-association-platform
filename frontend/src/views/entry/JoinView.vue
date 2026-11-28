<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import {
  getJoinPrivacyNotice,
  lookupJoinCode,
  submitJoinRequest,
} from '@/api/endpoints/join.js'
import type { JoinTarget, Locale, PrivacyNotice } from '@/api/schema.js'
import { localizeError } from '@/locales/index.js'
import { takeJoinCode } from '@/utils/linkToken.js'
import { objectName } from '@/utils/objectName.js'
import { safeHttpUrl } from '@/utils/safeUrls.js'
import BasePhoneInput from '@/components/base/BasePhoneInput.vue'

const session = useSessionStore()

const step = ref<'code' | 'confirm' | 'form' | 'done'>('code')
const joinCode = ref('')
const target = ref<JoinTarget | null>(null)
const privacyNotice = ref<PrivacyNotice | null>(null)
const showPrivacyDialog = ref(false)
let privacyNoticeSeq = 0

const fullName = ref('')
const phone = ref<string | null>(null)
const email = ref('')

const busy = ref(false)
const demoUnavailable = ref(false)
const errorMessage = ref('')
const phoneFieldError = ref('')

const targetObjectName = computed(() =>
  target.value
    ? objectName(target.value.apartment_kind, target.value.apartment_number, session.t)
    : '',
)

const safePrivacyNoticeUrl = computed(() => safeHttpUrl(privacyNotice.value?.custom_url))

function isNotFoundDemoError(err: unknown): boolean {
  const e = err as { status?: number; errorCode?: string; payload?: { error_code?: string } }
  const code = e?.errorCode || e?.payload?.error_code
  return e?.status === 404 && (!code || code === 'NOT_FOUND')
}

function formatJoinError(err: unknown): string {
  const e = err as {
    status?: number
    errorCode?: string
    payload?: { error_code?: string; retry_after_seconds?: number }
  }
  const code = e?.errorCode || e?.payload?.error_code
  if (e?.status === 400 || code === 'INVALID_JOIN_CODE') {
    return session.t('publicJoin.errors.invalidCode')
  }
  if (e?.status === 429 || code === 'RATE_LIMITED') {
    const secs = Number(e?.payload?.retry_after_seconds || 0)
    if (secs > 0) {
      const mins = Math.max(1, Math.ceil(secs / 60))
      return session.t('publicJoin.errors.rateLimitedMinutes', { minutes: mins })
    }
    return session.t('publicJoin.errors.rateLimited')
  }
  return localizeError((err ?? {}) as Record<string, unknown>)
}

function extractCodeFromHash(): string {
  if (typeof window === 'undefined') return ''
  const rawHash = window.location.hash || ''
  if (!rawHash || rawHash.length <= 1) return ''
  const params = new URLSearchParams(rawHash.slice(1))
  const code = params.get('code')?.trim() || ''
  if (code && window.history?.replaceState) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search)
  }
  return code
}

async function loadPrivacyNotice(lang: Locale) {
  const seq = ++privacyNoticeSeq
  try {
    const res = await getJoinPrivacyNotice(lang)
    if (seq === privacyNoticeSeq) {
      privacyNotice.value = res
    }
  } catch {
    if (seq === privacyNoticeSeq) {
      privacyNotice.value = null
    }
  }
}

async function handleLookup() {
  const trimmed = joinCode.value.trim()
  if (!trimmed || busy.value) return
  busy.value = true
  errorMessage.value = ''
  demoUnavailable.value = false
  try {
    target.value = await lookupJoinCode(trimmed)
    step.value = 'confirm'
  } catch (err) {
    if (isNotFoundDemoError(err)) {
      demoUnavailable.value = true
    } else {
      errorMessage.value = formatJoinError(err)
    }
  } finally {
    busy.value = false
  }
}

async function proceedToForm() {
  step.value = 'form'
  errorMessage.value = ''
  await loadPrivacyNotice((session.lang || 'en') as Locale)
}

function resetToCodeStep() {
  target.value = null
  step.value = 'code'
  errorMessage.value = ''
}

async function handleSubmit() {
  if (busy.value || !target.value) return
  errorMessage.value = ''
  phoneFieldError.value = ''

  const trimmedName = fullName.value.trim()
  const trimmedEmail = email.value.trim()
  const composedPhone = (phone.value || '').trim()

  if (!trimmedName || trimmedName.length > 200) {
    errorMessage.value = session.t('publicJoin.errors.nameRequired')
    return
  }
  if (!composedPhone) {
    phoneFieldError.value = session.t('publicJoin.errors.phoneInvalid')
    return
  }
  if (!trimmedEmail || !trimmedEmail.includes('@')) {
    errorMessage.value = session.t('publicJoin.errors.emailRequired')
    return
  }

  busy.value = true
  try {
    await submitJoinRequest({
      join_code: joinCode.value.trim(),
      full_name: trimmedName,
      phone: composedPhone,
      email: trimmedEmail,
      locale: (session.lang || 'en') as Locale,
    })
    step.value = 'done'
  } catch (err) {
    if (isNotFoundDemoError(err)) {
      demoUnavailable.value = true
      return
    }
    const e = err as {
      status?: number
      fieldErrors?: Array<{ loc?: string[] }>
      payload?: { errors?: Array<{ loc?: string[] }>; detail?: Array<{ loc?: string[] }> }
    }
    const fieldErrs = e?.fieldErrors ?? e?.payload?.errors ?? e?.payload?.detail
    const isPhoneErr =
      e?.status === 422 &&
      Array.isArray(fieldErrs) &&
      fieldErrs.some((d) => Array.isArray(d.loc) && d.loc.includes('phone'))
    if (isPhoneErr) {
      phoneFieldError.value = session.t('publicJoin.errors.phoneInvalid')
    } else {
      errorMessage.value = formatJoinError(err)
    }
  } finally {
    busy.value = false
  }
}

function switchLanguage(lang: Locale) {
  session.setLang(lang)
  if (step.value === 'form') {
    loadPrivacyNotice(lang)
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && showPrivacyDialog.value) {
    showPrivacyDialog.value = false
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeydown)
  }
  const initialCode = takeJoinCode() || extractCodeFromHash()
  if (initialCode) {
    joinCode.value = initialCode
    handleLookup()
  }
})

onBeforeUnmount(() => {
  privacyNoticeSeq += 1
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeydown)
  }
})
</script>

<template>
  <div class="min-h-screen bg-surface flex flex-col items-center justify-center p-4 sm:p-6">
    <div class="w-full max-w-md space-y-5">
      <!-- Language Switcher -->
      <div class="flex items-center justify-between">
        <span class="text-xs font-bold uppercase tracking-wider text-primary">
          {{ session.t('publicJoin.brandLabel') }}
        </span>
        <div class="inline-flex items-center gap-1 rounded-lg bg-surface-container-low p-1 border border-surface-container">
          <button
            v-for="lang in (['en', 'et', 'ru'] as const)"
            :key="lang"
            type="button"
            class="px-2 py-1 rounded text-[11px] font-bold uppercase cursor-pointer"
            :class="
              session.lang === lang
                ? 'bg-primary text-on-primary'
                : 'text-on-surface-variant hover:text-on-surface'
            "
            @click="switchLanguage(lang)"
          >
            {{ lang }}
          </button>
        </div>
      </div>

      <main class="rounded-2xl bg-surface-container-lowest border border-surface-container p-6 space-y-5 shadow-sm">
        <div v-if="demoUnavailable" class="space-y-3 text-center py-4">
          <span class="material-symbols-outlined text-3xl text-on-surface-variant" aria-hidden="true">
            info
          </span>
          <p class="text-sm font-semibold text-on-surface">
            {{ session.t('publicJoin.demoUnavailable') }}
          </p>
        </div>

        <!-- STEP 1A: Enter Code -->
        <form v-else-if="step === 'code'" class="space-y-4" @submit.prevent="handleLookup">
          <div>
            <h1 class="font-headline-md text-xl font-extrabold text-on-surface">
              {{ session.t('publicJoin.title') }}
            </h1>
            <p class="text-xs text-on-surface-variant mt-1">
              {{ session.t('publicJoin.codePrompt') }}
            </p>
          </div>

          <div class="space-y-1.5">
            <label for="join-code-input" class="block text-xs font-semibold text-on-surface">
              {{ session.t('publicJoin.codeLabel') }}
            </label>
            <input
              id="join-code-input"
              v-model="joinCode"
              type="text"
              autocomplete="off"
              autocapitalize="characters"
              spellcheck="false"
              placeholder="K7QF-M3TX-9R"
              class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-surface-container font-mono text-base tracking-widest uppercase text-on-surface focus:outline-none focus:border-primary"
            />
          </div>

          <div
            v-if="errorMessage"
            role="alert"
            class="px-3.5 py-2.5 rounded-lg bg-error-container text-on-error-container text-xs font-medium"
          >
            {{ errorMessage }}
          </div>

          <button
            type="submit"
            :disabled="busy || !joinCode.trim()"
            class="w-full py-2.5 rounded-lg bg-primary text-on-primary text-sm font-bold disabled:opacity-50 cursor-pointer"
          >
            {{ busy ? session.t('common.loading') : session.t('publicJoin.continueButton') }}
          </button>
        </form>

        <!-- STEP 1B: Confirm Association & Object -->
        <div v-else-if="step === 'confirm' && target" class="space-y-5">
          <div class="space-y-2">
            <p class="text-xs font-bold uppercase tracking-wider text-primary">
              {{ target.association_name }}
            </p>
            <h1 class="font-headline-md text-xl font-extrabold text-on-surface">
              {{
                session.t('publicJoin.confirmObjectQuestion', {
                  association: target.association_name,
                  object: targetObjectName,
                })
              }}
            </h1>
          </div>

          <div class="flex flex-col sm:flex-row gap-2.5">
            <button
              type="button"
              class="flex-1 py-2.5 rounded-lg bg-primary text-on-primary text-sm font-bold cursor-pointer"
              @click="proceedToForm"
            >
              {{ session.t('publicJoin.yesMyUnit') }}
            </button>
            <button
              type="button"
              class="px-4 py-2.5 rounded-lg bg-surface-container text-on-surface text-xs font-semibold cursor-pointer"
              @click="resetToCodeStep"
            >
              {{ session.t('publicJoin.notMineButton') }}
            </button>
          </div>
        </div>

        <!-- STEP 2: Leave Contact Details -->
        <form v-else-if="step === 'form' && target" class="space-y-4" @submit.prevent="handleSubmit">
          <div>
            <p class="text-xs font-bold text-primary">
              {{ target.association_name }} · {{ targetObjectName }}
            </p>
            <h1 class="font-headline-md text-lg font-extrabold text-on-surface mt-0.5">
              {{ session.t('publicJoin.formTitle') }}
            </h1>
            <p class="text-xs text-on-surface-variant mt-1">
              {{ session.t('publicJoin.dataUsageNotice') }}
            </p>
            <div v-if="privacyNotice" class="mt-1.5">
              <a
                v-if="safePrivacyNoticeUrl"
                :href="safePrivacyNoticeUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="text-xs font-semibold text-primary underline"
              >
                {{ session.t('publicJoin.privacyNoticeLink') }}
              </a>
              <button
                v-else-if="privacyNotice.text"
                type="button"
                class="text-xs font-semibold text-primary underline cursor-pointer"
                @click="showPrivacyDialog = true"
              >
                {{ session.t('publicJoin.privacyNoticeLink') }}
              </button>
            </div>
          </div>

          <div class="space-y-1">
            <label for="join-fullname" class="block text-xs font-semibold text-on-surface">
              {{ session.t('publicJoin.fullNameLabel') }}
            </label>
            <input
              id="join-fullname"
              v-model="fullName"
              type="text"
              required
              maxlength="200"
              autocomplete="name"
              class="w-full px-3.5 py-2 rounded-lg bg-surface-container-low border border-surface-container text-sm text-on-surface focus:outline-none focus:border-primary"
            />
          </div>

          <div class="space-y-1">
            <label for="join-phone" class="block text-xs font-semibold text-on-surface">
              {{ session.t('publicJoin.phoneLabel') }}
            </label>
            <BasePhoneInput
              id="join-phone"
              v-model="phone"
              :default-country="target.country_code"
              :required="true"
              :disabled="busy"
              :error="phoneFieldError"
            />
          </div>

          <div class="space-y-1">
            <label for="join-email" class="block text-xs font-semibold text-on-surface">
              {{ session.t('publicJoin.emailLabel') }}
            </label>
            <input
              id="join-email"
              v-model="email"
              type="email"
              required
              autocomplete="email"
              class="w-full px-3.5 py-2 rounded-lg bg-surface-container-low border border-surface-container text-sm text-on-surface focus:outline-none focus:border-primary"
            />
          </div>

          <div
            v-if="errorMessage"
            role="alert"
            class="px-3.5 py-2.5 rounded-lg bg-error-container text-on-error-container text-xs font-medium"
          >
            {{ errorMessage }}
          </div>

          <button
            type="submit"
            :disabled="busy"
            class="w-full py-2.5 rounded-lg bg-primary text-on-primary text-sm font-bold disabled:opacity-50 cursor-pointer"
          >
            {{ busy ? session.t('common.loading') : session.t('publicJoin.submitButton') }}
          </button>
        </form>

        <!-- DONE -->
        <div v-else-if="step === 'done'" class="space-y-3 text-center py-4">
          <span class="material-symbols-outlined text-4xl text-primary" aria-hidden="true">
            check_circle
          </span>
          <h1 class="font-headline-md text-lg font-extrabold text-on-surface">
            {{ session.t('publicJoin.doneTitle') }}
          </h1>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('publicJoin.doneBody') }}
          </p>
        </div>
      </main>
    </div>

    <!-- Privacy Notice Dialog -->
    <div
      v-if="showPrivacyDialog && privacyNotice?.text"
      class="fixed inset-0 z-50 bg-scrim/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div class="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-2xl bg-surface-container-lowest border border-surface-container p-6 space-y-4 shadow-xl">
        <h2 class="font-headline-md text-lg font-bold text-on-surface">
          {{ session.t('publicJoin.privacyNoticeLink') }}
        </h2>
        <div class="text-xs text-on-surface-variant whitespace-pre-line leading-relaxed">
          {{ privacyNotice.text }}
        </div>
        <div class="flex justify-end">
          <button
            type="button"
            class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold cursor-pointer"
            @click="showPrivacyDialog = false"
          >
            {{ session.t('common.close') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
