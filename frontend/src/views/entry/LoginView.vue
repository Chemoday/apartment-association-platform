<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { passwordLogin, requestMagicLink } from '@/api/endpoints/auth.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const RESEND_COOLDOWN_SEC = 60

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

// Kept strictly in component memory — never placed in URL, store, or storage
const loginTab = ref(route.query.tab === 'password' ? 'password' : 'link') // 'link' | 'password'
const email = ref('')
const password = ref('')
const state = ref('form') // 'form' | 'sent'
const submitting = ref(false)
const fieldError = ref('')
const passwordError = ref('')
const serverError = ref(null)
const resendSeconds = ref(0)
const passwordLockoutSeconds = ref(0)
let cooldownTimer = null
let lockoutTimer = null

const formattedCooldown = computed(() => {
  const sec = Math.max(0, resendSeconds.value)
  const mins = Math.floor(sec / 60)
  const rem = String(sec % 60).padStart(2, '0')
  return `${mins}:${rem}`
})

const formattedLockout = computed(() => {
  const sec = Math.max(0, passwordLockoutSeconds.value)
  const mins = Math.floor(sec / 60)
  const rem = String(sec % 60).padStart(2, '0')
  return `${mins}:${rem}`
})

function isValidEmail(val) {
  const trimmed = String(val || '').trim()
  if (trimmed.length < 3 || trimmed.length > 320) return false
  const atIndex = trimmed.indexOf('@')
  if (atIndex <= 0) return false
  const domain = trimmed.slice(atIndex + 1)
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

function startResendCooldown() {
  stopResendCooldown()
  resendSeconds.value = RESEND_COOLDOWN_SEC
  if (typeof window !== 'undefined') {
    cooldownTimer = window.setInterval(() => {
      if (resendSeconds.value <= 1) {
        resendSeconds.value = 0
        stopResendCooldown()
      } else {
        resendSeconds.value -= 1
      }
    }, 1000)
  }
}

function stopResendCooldown() {
  if (cooldownTimer !== null && typeof window !== 'undefined') {
    window.clearInterval(cooldownTimer)
    cooldownTimer = null
  }
}

function startPasswordLockout(seconds) {
  stopPasswordLockout()
  passwordLockoutSeconds.value = Math.max(1, Number(seconds) || 60)
  if (typeof window !== 'undefined') {
    lockoutTimer = window.setInterval(() => {
      if (passwordLockoutSeconds.value <= 1) {
        passwordLockoutSeconds.value = 0
        stopPasswordLockout()
      } else {
        passwordLockoutSeconds.value -= 1
      }
    }, 1000)
  }
}

function stopPasswordLockout() {
  if (lockoutTimer !== null && typeof window !== 'undefined') {
    window.clearInterval(lockoutTimer)
    lockoutTimer = null
  }
}

function switchTab(nextTab) {
  loginTab.value = nextTab
  fieldError.value = ''
  passwordError.value = ''
  serverError.value = null
  if (nextTab === 'link') {
    password.value = ''
  }
}

async function handleSubmit() {
  fieldError.value = ''
  passwordError.value = ''
  serverError.value = null
  const trimmed = email.value.trim()
  email.value = trimmed

  if (!isValidEmail(trimmed)) {
    fieldError.value = session.t('auth.login.invalidEmail')
    return
  }

  if (loginTab.value === 'password') {
    await handlePasswordSubmit(trimmed)
    return
  }

  submitting.value = true
  try {
    await requestMagicLink(trimmed)
    state.value = 'sent'
    startResendCooldown()
  } catch (err) {
    if (err?.status === 422 || err?.errorCode === 'VALIDATION_ERROR') {
      fieldError.value = session.t('auth.login.invalidEmail')
    } else {
      serverError.value = err
    }
  } finally {
    submitting.value = false
  }
}

async function handlePasswordSubmit(trimmedEmail) {
  if (passwordLockoutSeconds.value > 0) return
  if (!password.value || password.value.length > 1024) {
    passwordError.value = session.t('auth.login.invalidCredentials')
    return
  }

  submitting.value = true
  try {
    const sessionResp = await passwordLogin({
      email: trimmedEmail,
      password: password.value,
    })
    password.value = ''
    await session.completeSignIn(sessionResp)
    router.push({ name: 'dashboard' })
  } catch (err) {
    if (err?.status === 401 || err?.errorCode === 'INVALID_CREDENTIALS') {
      passwordError.value = session.t('auth.login.invalidCredentials')
    } else if (err?.status === 429 || err?.errorCode === 'RATE_LIMITED') {
      startPasswordLockout(err?.payload?.retry_after_seconds || 60)
    } else if (err?.status === 422 || err?.errorCode === 'VALIDATION_ERROR') {
      fieldError.value = session.t('auth.login.invalidEmail')
    } else {
      serverError.value = err
    }
  } finally {
    submitting.value = false
  }
}

async function handleResend() {
  if (resendSeconds.value > 0 || submitting.value) return
  await handleSubmit()
}

function handleUseAnotherEmail() {
  stopResendCooldown()
  state.value = 'form'
  fieldError.value = ''
  passwordError.value = ''
  serverError.value = null
}

function openDemoMagicLink() {
  router.push({ name: 'login-link', hash: '#demo-valid-token' })
}

function openExpiredDemoLink() {
  router.push({ name: 'login-link', hash: '#expired-demo-token' })
}

function openDemoRegisterLink() {
  router.push({ name: 'login-link', hash: '#demo-register-owner-14' })
}

function openDemoAcceptLink() {
  router.push({ name: 'login-link', hash: '#demo-accept-tenant-14' })
}

onBeforeUnmount(() => {
  stopResendCooldown()
  stopPasswordLockout()
  password.value = ''
})
</script>

<template>
  <div class="min-h-[calc(100vh-5rem)] flex flex-col items-center justify-center px-4 py-10">
    <div class="w-full max-w-md space-y-4">
      <RouterLink
        to="/welcome"
        class="inline-flex items-center gap-1.5 text-xs font-semibold text-on-surface-variant hover:text-on-surface transition-colors"
      >
        <span class="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_back</span>
        <span>{{ session.t('auth.login.back') }}</span>
      </RouterLink>

      <div class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 sm:p-8 shadow-xs space-y-6">
        <!-- State 1: Form -->
        <template v-if="state === 'form'">
          <div class="space-y-2">
            <h1 class="font-headline-lg text-2xl font-bold text-on-surface tracking-tight">
              {{ session.t('auth.login.title') }}
            </h1>
            <p class="text-sm text-on-surface-variant leading-relaxed">
              {{
                loginTab === 'password'
                  ? session.t('auth.login.passwordSubtitle')
                  : session.t('auth.login.subtitle')
              }}
            </p>
          </div>

          <!-- Segmented Tabs: Sign-in link vs Password -->
          <div
            role="tablist"
            class="grid grid-cols-2 gap-1 p-1 rounded-lg bg-surface-container-low border border-surface-container"
          >
            <button
              type="button"
              role="tab"
              :aria-selected="loginTab === 'link'"
              class="py-2 px-3 rounded-md font-label-md text-xs font-semibold transition-colors cursor-pointer"
              :class="
                loginTab === 'link'
                  ? 'bg-primary text-on-primary shadow-2xs'
                  : 'text-on-surface-variant hover:text-on-surface'
              "
              @click="switchTab('link')"
            >
              {{ session.t('auth.login.tabLink') }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="loginTab === 'password'"
              class="py-2 px-3 rounded-md font-label-md text-xs font-semibold transition-colors cursor-pointer"
              :class="
                loginTab === 'password'
                  ? 'bg-primary text-on-primary shadow-2xs'
                  : 'text-on-surface-variant hover:text-on-surface'
              "
              @click="switchTab('password')"
            >
              {{ session.t('auth.login.tabPassword') }}
            </button>
          </div>

          <ErrorCard
            v-if="serverError"
            :error="serverError"
            @retry="handleSubmit"
          />

          <form class="space-y-4" novalidate @submit.prevent="handleSubmit">
            <div class="space-y-1.5">
              <label
                for="magic-link-email"
                class="block font-label-md text-xs font-semibold text-on-surface"
              >
                {{ session.t('auth.login.emailLabel') }}
              </label>
              <input
                id="magic-link-email"
                v-model="email"
                type="email"
                autocomplete="email"
                maxlength="320"
                :placeholder="session.t('auth.login.emailPlaceholder')"
                class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
                :class="fieldError ? 'border-error' : 'border-outline-variant/40'"
                @input="fieldError = ''"
              />
              <p v-if="fieldError" class="text-xs font-medium text-error">
                {{ fieldError }}
              </p>
            </div>

            <!-- Password Field (Only in Password Tab) -->
            <div v-if="loginTab === 'password'" class="space-y-1.5">
              <label
                for="login-password-input"
                class="block font-label-md text-xs font-semibold text-on-surface"
              >
                {{ session.t('auth.login.passwordLabel') }}
              </label>
              <input
                id="login-password-input"
                v-model="password"
                type="password"
                autocomplete="current-password"
                maxlength="1024"
                :placeholder="session.t('auth.login.passwordPlaceholder')"
                class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/40 transition-colors"
                :class="passwordError ? 'border-error' : 'border-outline-variant/40'"
                @input="passwordError = ''"
              />
              <p v-if="passwordError" class="text-xs font-medium text-error" role="alert">
                {{ passwordError }}
              </p>
              <p
                v-if="session.demoUsers.length > 0"
                class="text-[11px] font-mono text-on-surface-variant"
              >
                {{ session.t('auth.login.demoPasswordHint') }}
              </p>
            </div>

            <!-- 429 RATE_LIMITED Notice + Send Link Instead Action -->
            <div
              v-if="loginTab === 'password' && passwordLockoutSeconds > 0"
              role="alert"
              class="p-3.5 rounded-lg bg-error-container/25 border border-error/30 space-y-2.5"
            >
              <p class="text-xs font-semibold text-error font-mono tabular-nums">
                {{ session.t('auth.login.rateLimitedWait', { time: formattedLockout }) }}
              </p>
              <button
                type="button"
                class="w-full py-2 px-3 rounded-lg bg-surface-container-lowest hover:bg-surface-container text-primary text-xs font-semibold border border-outline-variant/40 transition-colors cursor-pointer"
                @click="switchTab('link')"
              >
                {{ session.t('auth.login.sendLinkInsteadBtn') }}
              </button>
            </div>

            <button
              type="submit"
              :disabled="submitting || (loginTab === 'password' && passwordLockoutSeconds > 0)"
              class="w-full py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 inline-flex items-center justify-center gap-2 cursor-pointer"
            >
              <span class="material-symbols-outlined text-[18px]" aria-hidden="true">
                {{ loginTab === 'password' ? 'login' : 'send' }}
              </span>
              <span>
                {{
                  loginTab === 'password'
                    ? session.t('auth.login.passwordSubmitBtn')
                    : session.t('auth.login.submitBtn')
                }}
              </span>
            </button>

            <!-- Forgot Password -> Switch to Link Tab -->
            <div v-if="loginTab === 'password'" class="text-center pt-1">
              <button
                type="button"
                class="text-xs font-semibold text-primary hover:underline cursor-pointer"
                @click="switchTab('link')"
              >
                {{ session.t('auth.login.forgotPasswordBtn') }}
              </button>
            </div>
          </form>
        </template>

        <!-- State 2: Sent (Neutral 202 confirmation) -->
        <template v-else>
          <div class="flex flex-col items-center text-center space-y-4 py-2">
            <div class="w-12 h-12 rounded-full bg-primary-fixed/30 text-primary flex items-center justify-center">
              <span class="material-symbols-outlined text-[26px]" aria-hidden="true">
                mark_email_read
              </span>
            </div>

            <div class="space-y-2">
              <h1 class="font-headline-lg text-xl font-bold text-on-surface tracking-tight">
                {{ session.t('auth.login.sentTitle') }}
              </h1>
              <p class="text-sm text-on-surface-variant leading-relaxed">
                {{ session.t('auth.login.sentBody1') }}
              </p>
              <p class="text-xs text-on-surface-variant leading-relaxed">
                {{ session.t('auth.login.sentBody2') }}
              </p>
            </div>

            <ErrorCard
              v-if="serverError"
              :error="serverError"
              @retry="handleResend"
            />

            <div class="w-full pt-2 space-y-3">
              <button
                type="button"
                :disabled="resendSeconds > 0 || submitting"
                class="w-full py-2.5 px-4 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-label-md text-xs font-semibold transition-colors disabled:opacity-50 font-mono tabular-nums cursor-pointer"
                @click="handleResend"
              >
                <template v-if="resendSeconds > 0">
                  {{ session.t('auth.login.resendCountdown', { time: formattedCooldown }) }}
                </template>
                <template v-else>
                  {{ session.t('auth.login.resendBtn') }}
                </template>
              </button>

              <button
                type="button"
                class="w-full py-1.5 text-xs font-semibold text-primary hover:underline cursor-pointer"
                @click="handleUseAnotherEmail"
              >
                {{ session.t('auth.login.useAnotherEmail') }}
              </button>
            </div>
          </div>
        </template>

        <!-- Demo Magic-Link & Invitation Simulator (Always accessible in demo mode) -->
        <div
          v-if="session.demoUsers.length > 0"
          class="w-full pt-5 border-t border-surface-container text-left space-y-2.5"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold text-on-surface">
              {{ session.t('auth.login.demoSimulatorTitle') }}
            </span>
            <span class="px-1.5 py-0.5 rounded bg-secondary-container text-on-secondary-container text-[10px] font-bold uppercase tracking-wider">
              DEMO
            </span>
          </div>
          <p class="text-xs text-on-surface-variant leading-relaxed">
            {{ session.t('auth.login.demoSimulatorHint') }}
          </p>
          <div class="flex flex-col sm:flex-row gap-2 pt-1">
            <button
              type="button"
              class="flex-1 py-2 px-3 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-95 transition-opacity inline-flex items-center justify-center gap-1.5 cursor-pointer"
              @click="openDemoMagicLink"
            >
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">link</span>
              <span>{{ session.t('auth.login.demoOpenLinkBtn') }}</span>
            </button>
            <button
              type="button"
              class="py-2 px-3 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
              @click="openExpiredDemoLink"
            >
              <span>{{ session.t('auth.login.demoTestInvalidBtn') }}</span>
            </button>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              type="button"
              class="py-2 px-3 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
              @click="openDemoRegisterLink"
            >
              <span class="material-symbols-outlined text-[15px] text-secondary" aria-hidden="true">person_add</span>
              <span>{{ session.t('auth.login.demoTestRegistrationBtn') }}</span>
            </button>
            <button
              type="button"
              class="py-2 px-3 rounded-lg bg-surface-container-low hover:bg-surface-container text-on-surface text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 cursor-pointer"
              @click="openDemoAcceptLink"
            >
              <span class="material-symbols-outlined text-[15px] text-secondary" aria-hidden="true">how_to_reg</span>
              <span>{{ session.t('auth.login.demoTestAcceptBtn') }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Demo Installation Notice -->
      <p
        v-if="session.demoUsers.length > 0"
        class="text-center text-xs text-on-surface-variant px-2"
      >
        {{ session.t('auth.login.demoNote') }}
      </p>
    </div>
  </div>
</template>
