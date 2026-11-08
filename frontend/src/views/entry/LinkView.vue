<script setup>
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { refreshSession } from '@/api/client.js'
import { acceptInvitation, completeRegistration, redeemLink } from '@/api/endpoints/auth.js'
import { takeLinkToken } from '@/utils/linkToken.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const router = useRouter()
const session = useSessionStore()

// Token taken once from in-memory stash; empty on reload or direct visit
const token = ref(takeLinkToken())
const redeemedInvitationToken = ref('')

// 'ready' | 'working' | 'registration' | 'accept_signed_in' | 'accept_sign_in_first' | 'invalid' | 'rate_limited' | 'no_link' | 'unsupported' | 'network_error'
const state = ref(token.value ? 'ready' : 'no_link')
const serverError = ref(null)
const retrySeconds = ref(0)
let retryTimer = null

// Section 10.1 & 10.2 Invitation & Registration state (kept strictly in component memory)
const invitation = ref(null)
const registrationToken = ref('')
const regSubmitting = ref(false)
const regFieldError = ref('')
const regForm = reactive({
  fullName: '',
  phone: '',
  locale: 'et',
  privacyMode: 'INITIALS',
})

const acceptSubmitting = ref(false)

const privacyModes = ['APARTMENT_ONLY', 'INITIALS', 'FULL_NAME']

const headingText = computed(() => {
  if (session.building?.name) {
    return session.t('auth.link.titleWithBuilding', { building: session.building.name })
  }
  return session.t('auth.link.title')
})

const invitationHeadingText = computed(() => {
  const inv = invitation.value
  if (!inv) return session.t('auth.link.title')
  if (inv.kind === 'OWNER') {
    return session.t('auth.registration.invitedAsOwner', {
      number: inv.apartment_number || '14',
    })
  }
  if (inv.kind === 'TENANT') {
    return session.t('auth.registration.invitedAsTenant', {
      number: inv.apartment_number || '14',
    })
  }
  const roleKey = inv.building_role || 'BOARD'
  return session.t('auth.registration.invitedAsStaff', {
    role: session.t(`buildingRole.${roleKey}`),
  })
})

function computeInitialsFromName(name) {
  const parts = String(name || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 0) return 'K. K.'
  return parts.map((p) => `${p[0].toUpperCase()}.`).join(' ')
}

function getRegistrationPrivacyPreview(mode) {
  const apt = invitation.value?.apartment_number || '14'
  const typedName = regForm.fullName.trim()
  if (mode === 'APARTMENT_ONLY') {
    return `Apt. ${apt}`
  }
  if (mode === 'INITIALS') {
    const initials = computeInitialsFromName(typedName)
    return `${initials} (Apt. ${apt})`
  }
  const displayName = typedName || 'Kati Kask'
  return `${displayName} (Apt. ${apt})`
}

const formattedRetryTime = computed(() => {
  const sec = Math.max(0, retrySeconds.value)
  const mins = Math.floor(sec / 60)
  const rem = String(sec % 60).padStart(2, '0')
  return `${mins}:${rem}`
})

function startRetryCountdown(seconds) {
  stopRetryCountdown()
  retrySeconds.value = Math.max(1, Math.ceil(Number(seconds) || 60))
  if (typeof window !== 'undefined') {
    retryTimer = window.setInterval(() => {
      if (retrySeconds.value <= 1) {
        retrySeconds.value = 0
        stopRetryCountdown()
        if (state.value === 'rate_limited') {
          state.value = 'ready'
        }
      } else {
        retrySeconds.value -= 1
      }
    }, 1000)
  }
}

function stopRetryCountdown() {
  if (retryTimer !== null && typeof window !== 'undefined') {
    window.clearInterval(retryTimer)
    retryTimer = null
  }
}

async function handleContinue() {
  if (!token.value || state.value === 'working' || retrySeconds.value > 0) return
  state.value = 'working'
  serverError.value = null

  try {
    const currentToken = token.value
    const result = await redeemLink(currentToken)
    token.value = '' // A link works once

    switch (result?.status) {
      case 'SIGNED_IN':
        if (result.session) {
          await session.completeSignIn(result.session)
          router.replace({ name: 'dashboard' })
        } else {
          state.value = 'unsupported'
        }
        break
      case 'REGISTRATION_REQUIRED':
        invitation.value = result.invitation || {
          kind: 'OWNER',
          apartment_number: '14',
          building_role: null,
        }
        registrationToken.value = result.registration_token || 'reg-demo'
        state.value = 'registration'
        break
      case 'SIGN_IN_TO_ACCEPT': {
        invitation.value = result.invitation || {
          kind: 'TENANT',
          apartment_number: '14',
          building_role: null,
        }
        redeemedInvitationToken.value = currentToken
        let hasActiveSession = session.isSignedIn
        if (!hasActiveSession) {
          try {
            hasActiveSession = await refreshSession()
          } catch {
            hasActiveSession = false
          }
        }
        state.value = hasActiveSession ? 'accept_signed_in' : 'accept_sign_in_first'
        break
      }
      default:
        state.value = 'unsupported'
        break
    }
  } catch (err) {
    if (
      err?.status === 400 ||
      err?.errorCode === 'INVALID_LINK' ||
      err?.status === 422 ||
      err?.errorCode === 'VALIDATION_ERROR'
    ) {
      token.value = ''
      state.value = 'invalid'
    } else if (err?.status === 429 || err?.errorCode === 'RATE_LIMITED') {
      state.value = 'rate_limited'
      startRetryCountdown(err.payload?.retry_after_seconds || 60)
    } else {
      // Network error or 5xx: keep token in memory so "Try again" works
      serverError.value = err
      state.value = 'network_error'
    }
  }
}

async function handleSubmitRegistration() {
  regFieldError.value = ''
  serverError.value = null
  const nameTrimmed = regForm.fullName.trim()
  if (!nameTrimmed || nameTrimmed.length > 255) {
    regFieldError.value = session.t('auth.registration.nameRequired')
    return
  }

  regSubmitting.value = true
  try {
    const res = await completeRegistration({
      registration_token: registrationToken.value,
      full_name: nameTrimmed,
      phone: regForm.phone.trim() || null,
      locale: regForm.locale,
      privacy_display_mode:
        invitation.value?.kind === 'STAFF' ? null : regForm.privacyMode,
    })
    if (res?.session) {
      await session.completeSignIn(res.session)
      router.replace({ name: 'dashboard' })
    }
  } catch (err) {
    if (err?.status === 400 || err?.errorCode === 'INVALID_LINK') {
      regFieldError.value = session.t('auth.registration.expiredError')
    } else if (err?.status === 409 || err?.errorCode === 'EMAIL_ALREADY_REGISTERED') {
      regFieldError.value = session.t('auth.registration.alreadyRegisteredError')
    } else {
      serverError.value = err
    }
  } finally {
    regSubmitting.value = false
  }
}

async function handleAcceptInvitation() {
  if (acceptSubmitting.value) return
  acceptSubmitting.value = true
  serverError.value = null
  try {
    await acceptInvitation(redeemedInvitationToken.value || 'demo-accept')
    await session.loadMe()
    router.replace({ name: 'dashboard' })
  } catch (err) {
    serverError.value = err
  } finally {
    acceptSubmitting.value = false
  }
}

function handleNotNow() {
  router.push({ name: 'dashboard' })
}

function goToLogin() {
  router.push({ name: 'login' })
}

onBeforeUnmount(() => {
  stopRetryCountdown()
})
</script>

<template>
  <div class="min-h-[calc(100vh-5rem)] flex flex-col items-center justify-center px-4 py-10">
    <div
      class="w-full rounded-xl bg-surface-container-lowest border border-surface-container p-6 sm:p-8 shadow-xs space-y-6"
      :class="state === 'registration' ? 'max-w-lg' : 'max-w-md'"
    >
      <!-- State 1 & 2: Ready / Working -->
      <template v-if="state === 'ready' || state === 'working'">
        <div class="space-y-2">
          <span class="text-xs font-bold uppercase tracking-widest text-primary">
            {{ session.buildingName }}
          </span>
          <h1 class="font-headline-lg text-2xl font-bold text-on-surface tracking-tight">
            {{ headingText }}
          </h1>
          <p class="text-sm text-on-surface-variant leading-relaxed">
            {{ session.t('auth.link.readyText') }}
          </p>
        </div>

        <button
          type="button"
          :disabled="state === 'working'"
          class="w-full py-3 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity disabled:opacity-60 inline-flex items-center justify-center gap-2 cursor-pointer"
          @click="handleContinue"
        >
          <span
            v-if="state === 'working'"
            class="w-4 h-4 rounded-full border-2 border-on-primary border-t-transparent animate-spin"
            aria-hidden="true"
          />
          <span>{{ session.t('auth.link.continueBtn') }}</span>
        </button>
      </template>

      <!-- Section 10.2 / Appendix A.8 State: Registration Form (REGISTRATION_REQUIRED) -->
      <template v-else-if="state === 'registration'">
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-bold uppercase tracking-widest text-primary">
              {{ session.buildingName }}
            </span>
            <span class="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold uppercase tracking-wider">
              DEMO
            </span>
          </div>
          <h1 class="font-headline-lg text-xl sm:text-2xl font-bold text-on-surface tracking-tight">
            {{ invitationHeadingText }}
          </h1>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('auth.registration.subtitle') }}
          </p>
        </div>

        <ErrorCard v-if="serverError" :error="serverError" @retry="handleSubmitRegistration" />

        <form class="space-y-4" novalidate @submit.prevent="handleSubmitRegistration">
          <!-- Full Name -->
          <div class="space-y-1.5">
            <label for="reg-full-name" class="block font-label-md text-xs font-semibold text-on-surface">
              {{ session.t('auth.registration.fullNameLabel') }}
            </label>
            <input
              id="reg-full-name"
              v-model="regForm.fullName"
              type="text"
              maxlength="255"
              autocomplete="name"
              :placeholder="session.t('auth.registration.fullNamePlaceholder')"
              class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border text-sm text-on-surface focus:outline-none focus:border-primary"
              :class="regFieldError ? 'border-error' : 'border-outline-variant/50'"
              @input="regFieldError = ''"
            />
            <p v-if="regFieldError" class="text-xs font-medium text-error">
              {{ regFieldError }}
            </p>
          </div>

          <!-- Phone (Optional) & Language -->
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div class="space-y-1.5">
              <label for="reg-phone" class="block font-label-md text-xs font-semibold text-on-surface">
                {{ session.t('auth.registration.phoneLabel') }}
              </label>
              <input
                id="reg-phone"
                v-model="regForm.phone"
                type="tel"
                maxlength="50"
                autocomplete="tel"
                placeholder="+372 555 0100"
                class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-outline-variant/50 text-sm text-on-surface focus:outline-none focus:border-primary"
              />
            </div>

            <div class="space-y-1.5">
              <label for="reg-locale" class="block font-label-md text-xs font-semibold text-on-surface">
                {{ session.t('auth.registration.languageLabel') }}
              </label>
              <select
                id="reg-locale"
                v-model="regForm.locale"
                class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-outline-variant/50 text-sm text-on-surface focus:outline-none focus:border-primary"
              >
                <option value="et">{{ session.t('notificationSettings.language.et') }}</option>
                <option value="ru">{{ session.t('notificationSettings.language.ru') }}</option>
                <option value="en">{{ session.t('notificationSettings.language.en') }}</option>
              </select>
            </div>
          </div>

          <!-- How Neighbours See Your Name (Hidden for STAFF per Section 10.2) -->
          <div v-if="invitation?.kind !== 'STAFF'" class="space-y-2 pt-1">
            <label class="block font-label-md text-xs font-semibold text-on-surface">
              {{ session.t('auth.registration.privacyLabel') }}
            </label>
            <div class="space-y-2">
              <button
                v-for="mode in privacyModes"
                :key="mode"
                type="button"
                class="w-full p-3 rounded-lg border text-left transition-all flex items-center justify-between gap-3 cursor-pointer"
                :class="
                  regForm.privacyMode === mode
                    ? 'border-secondary bg-secondary-container/25'
                    : 'border-surface-container bg-surface-container-low hover:bg-surface-container'
                "
                @click="regForm.privacyMode = mode"
              >
                <div class="flex items-center gap-2.5 min-w-0">
                  <span
                    class="material-symbols-outlined text-[18px] shrink-0"
                    :class="regForm.privacyMode === mode ? 'text-secondary' : 'text-on-surface-variant'"
                    aria-hidden="true"
                  >
                    {{ regForm.privacyMode === mode ? 'radio_button_checked' : 'radio_button_unchecked' }}
                  </span>
                  <div class="min-w-0">
                    <span class="font-label-lg text-xs font-bold text-on-surface block">
                      {{ session.t(`privacy.${mode}`) }}
                    </span>
                    <span class="text-[11px] text-on-surface-variant block truncate">
                      {{ session.t(`profile.privacy.descriptions.${mode}`) }}
                    </span>
                  </div>
                </div>

                <span class="px-2 py-0.5 rounded bg-surface-container-lowest border border-surface-container text-[11px] font-semibold text-on-surface whitespace-nowrap shrink-0">
                  {{ getRegistrationPrivacyPreview(mode) }}
                </span>
              </button>
            </div>
          </div>

          <div class="pt-2 space-y-2">
            <button
              type="submit"
              :disabled="regSubmitting"
              class="w-full py-3 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 inline-flex items-center justify-center gap-2 cursor-pointer"
            >
              <span
                v-if="regSubmitting"
                class="w-4 h-4 rounded-full border-2 border-on-primary border-t-transparent animate-spin"
                aria-hidden="true"
              />
              <span>{{ session.t('auth.registration.createAccountBtn') }}</span>
            </button>
            <p class="text-center text-xs text-on-surface-variant">
              {{ session.t('auth.registration.validFor30Min') }}
            </p>
          </div>
        </form>
      </template>

      <!-- Section 10.1 / Appendix A.8 State: Accept Invitation (Signed In) -->
      <template v-else-if="state === 'accept_signed_in'">
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-bold uppercase tracking-widest text-primary">
              {{ session.buildingName }}
            </span>
            <span class="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold uppercase tracking-wider">
              DEMO
            </span>
          </div>
          <h1 class="font-headline-lg text-xl font-bold text-on-surface tracking-tight">
            {{ invitationHeadingText }}
          </h1>
          <p class="text-sm text-on-surface-variant leading-relaxed">
            {{ session.t('auth.registration.acceptSignedInText') }}
          </p>
        </div>

        <ErrorCard v-if="serverError" :error="serverError" @retry="handleAcceptInvitation" />

        <div class="flex flex-col sm:flex-row gap-2.5 pt-2">
          <button
            type="button"
            :disabled="acceptSubmitting"
            class="flex-1 py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
            @click="handleAcceptInvitation"
          >
            {{ session.t('auth.registration.acceptBtn') }}
          </button>
          <button
            type="button"
            class="py-2.5 px-4 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-label-md text-sm font-semibold transition-colors cursor-pointer"
            @click="handleNotNow"
          >
            {{ session.t('auth.registration.notNowBtn') }}
          </button>
        </div>
      </template>

      <!-- Section 10.1 / Appendix A.8 State: Accept Invitation (Not Signed In) -->
      <template v-else-if="state === 'accept_sign_in_first'">
        <div class="space-y-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-bold uppercase tracking-widest text-primary">
              {{ session.buildingName }}
            </span>
            <span class="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold uppercase tracking-wider">
              DEMO
            </span>
          </div>
          <h1 class="font-headline-lg text-xl font-bold text-on-surface tracking-tight">
            {{ invitationHeadingText }}
          </h1>
          <p class="text-sm text-on-surface-variant leading-relaxed">
            {{ session.t('auth.registration.acceptSignInFirstText') }}
          </p>
        </div>

        <div class="space-y-2.5 pt-2">
          <button
            type="button"
            class="w-full py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity cursor-pointer"
            @click="goToLogin"
          >
            {{ session.t('auth.registration.signInToAcceptBtn') }}
          </button>
          <button
            type="button"
            class="w-full py-2 px-3 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface-variant text-xs font-semibold transition-colors cursor-pointer"
            @click="state = 'accept_signed_in'"
          >
            {{ session.t('auth.registration.demoPreviewSignedInAccept') }}
          </button>
        </div>
      </template>

      <!-- State 3: Invalid / Expired / Used Link -->
      <template v-else-if="state === 'invalid'">
        <div class="flex flex-col items-center text-center space-y-4 py-2">
          <div class="w-12 h-12 rounded-full bg-error-container text-error flex items-center justify-center">
            <span class="material-symbols-outlined text-[26px]" aria-hidden="true">warning</span>
          </div>
          <div class="space-y-2">
            <h1 class="font-headline-lg text-xl font-bold text-on-surface">
              {{ session.t('auth.link.invalidTitle') }}
            </h1>
            <p class="text-sm text-on-surface-variant leading-relaxed">
              {{ session.t('auth.link.invalidText') }}
            </p>
          </div>
          <button
            type="button"
            class="w-full py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity cursor-pointer"
            @click="goToLogin"
          >
            {{ session.t('auth.link.getNewLinkBtn') }}
          </button>
        </div>
      </template>

      <!-- State 4: Rate Limited (429) -->
      <template v-else-if="state === 'rate_limited'">
        <div class="space-y-4">
          <div class="space-y-2">
            <h1 class="font-headline-lg text-xl font-bold text-on-surface">
              {{ session.t('auth.link.rateLimitedTitle') }}
            </h1>
            <p class="text-sm text-on-surface-variant font-mono tabular-nums">
              {{ session.t('auth.link.rateLimitedText', { time: formattedRetryTime }) }}
            </p>
          </div>
          <button
            type="button"
            disabled
            class="w-full py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold opacity-50 cursor-not-allowed"
          >
            {{ session.t('auth.link.continueBtn') }}
          </button>
        </div>
      </template>

      <!-- State 5: No Token (Reloaded or opened directly) -->
      <template v-else-if="state === 'no_link'">
        <div class="space-y-4">
          <div class="space-y-2">
            <h1 class="font-headline-lg text-xl font-bold text-on-surface">
              {{ session.t('auth.link.noLinkTitle') }}
            </h1>
            <p class="text-sm text-on-surface-variant leading-relaxed">
              {{ session.t('auth.link.noLinkText') }}
            </p>
          </div>
          <button
            type="button"
            class="w-full py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity cursor-pointer"
            @click="goToLogin"
          >
            {{ session.t('auth.link.getNewLinkBtn') }}
          </button>
        </div>
      </template>

      <!-- Unsupported link status -->
      <template v-else-if="state === 'unsupported'">
        <div class="space-y-4">
          <p class="text-sm text-on-surface-variant leading-relaxed">
            {{ session.t('auth.link.unsupportedText') }}
          </p>
          <button
            type="button"
            class="w-full py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity cursor-pointer"
            @click="goToLogin"
          >
            {{ session.t('auth.link.getNewLinkBtn') }}
          </button>
        </div>
      </template>

      <!-- Network or 5xx Error (Token preserved in memory for retry) -->
      <template v-else-if="state === 'network_error'">
        <div class="space-y-4">
          <ErrorCard :error="serverError" @retry="handleContinue" />
        </div>
      </template>
    </div>
  </div>
</template>
