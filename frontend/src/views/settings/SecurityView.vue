<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import {
  endAllSessions,
  endSession,
  getPasswordStatus,
  listSessions,
  removePassword,
  setPassword,
} from '@/api/endpoints/auth.js'
import { localizeError } from '@/locales/index.js'
import { removeThisBrowserPush } from '@/utils/webpush.js'
import { formatRelativeTime, formatShortDate } from '@/utils/dates.js'
import BaseSkeleton from '@/components/base/BaseSkeleton.vue'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const router = useRouter()
const session = useSessionStore()

const sessions = ref([])
const loading = ref(false)
const loadError = ref(null)
const busyId = ref('')
const showConfirmAllModal = ref(false)
const endingAll = ref(false)
const demoPreviewSessions = ref(false)
const quickDemoSigningIn = ref(false)

// Task A5: Password Card State
const hasPassword = ref(false)
const passwordLoading = ref(false)
const passwordLoadError = ref(null)
const passwordFormMode = ref('') // '' | 'set' | 'change' | 'remove'
const newPassword = ref('')
const currentPassword = ref('')
const needsReauth = ref(false)
const passwordFieldError = ref('')
const currentPasswordError = ref('')
const passwordSaving = ref(false)
const passwordToast = ref('')

const currentRoleLabel = computed(() =>
  session.t(`buildingRole.${session.buildingRole || 'USER'}`),
)

function showPasswordToast(msg) {
  passwordToast.value = msg
  setTimeout(() => {
    if (passwordToast.value === msg) {
      passwordToast.value = ''
    }
  }, 5000)
}

function seedDemoPreviewSessions() {
  const nowIso = new Date().toISOString()
  sessions.value = [
    {
      session_id: 'demo-session-1',
      device_kind: 'DESKTOP_BROWSER',
      auth_method: 'MAGIC_LINK',
      authenticated_at: nowIso,
      last_used_at: nowIso,
      current: true,
    },
    {
      session_id: 'demo-session-2',
      device_kind: 'MOBILE_BROWSER',
      auth_method: 'MAGIC_LINK',
      authenticated_at: '2026-10-28T18:30:00Z',
      last_used_at: '2026-10-30T11:20:00Z',
      current: false,
    },
  ]
}

async function loadPasswordStatus() {
  if (!session.isSignedIn) {
    hasPassword.value = false
    passwordFormMode.value = ''
    return
  }
  passwordLoading.value = true
  passwordLoadError.value = null
  try {
    const res = await getPasswordStatus()
    hasPassword.value = Boolean(res?.is_set)
  } catch (err) {
    passwordLoadError.value = err
  } finally {
    passwordLoading.value = false
  }
}

async function loadSessions() {
  if (!session.isSignedIn) {
    if (demoPreviewSessions.value) {
      seedDemoPreviewSessions()
    } else {
      sessions.value = []
    }
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const res = await listSessions()
    sessions.value = Array.isArray(res) ? res : []
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

async function loadAllSecurityData() {
  await Promise.all([loadPasswordStatus(), loadSessions()])
}

function openPasswordForm(mode) {
  passwordFormMode.value = mode
  newPassword.value = ''
  currentPassword.value = ''
  needsReauth.value = false
  passwordFieldError.value = ''
  currentPasswordError.value = ''
}

function cancelPasswordForm() {
  passwordFormMode.value = ''
  newPassword.value = ''
  currentPassword.value = ''
  needsReauth.value = false
  passwordFieldError.value = ''
  currentPasswordError.value = ''
}

async function handleSubmitSetOrChangePassword() {
  if (passwordSaving.value) return
  passwordFieldError.value = ''
  currentPasswordError.value = ''

  const normalized = (newPassword.value || '').normalize('NFKC')
  if (!normalized || normalized.length < 15) {
    passwordFieldError.value = session.t('errors.PASSWORD_TOO_WEAK_TOO_SHORT')
    return
  }
  if (normalized.length > 128) {
    passwordFieldError.value = session.t('errors.PASSWORD_TOO_WEAK_TOO_LONG')
    return
  }

  passwordSaving.value = true
  try {
    const body = { new_password: newPassword.value }
    if (currentPassword.value) {
      body.current_password = currentPassword.value
    }
    await setPassword(body)
    hasPassword.value = true
    cancelPasswordForm()
    showPasswordToast(session.t('security.password.savedSessionsClosedToast'))
    await loadSessions()
  } catch (err) {
    const code = err?.errorCode || err?.payload?.error_code
    if (err?.status === 422 && code === 'PASSWORD_TOO_WEAK') {
      passwordFieldError.value = localizeError(err)
    } else if (err?.status === 403 && code === 'REAUTHENTICATION_REQUIRED') {
      if (needsReauth.value && currentPassword.value) {
        currentPasswordError.value = session.t('errors.REAUTHENTICATION_REQUIRED')
      }
      needsReauth.value = true
    } else if (err?.status === 429 || code === 'RATE_LIMITED') {
      const msg = localizeError(err)
      if (needsReauth.value) {
        currentPasswordError.value = msg
      } else {
        passwordFieldError.value = msg
      }
    } else if (err?.status === 401 && code === 'INVALID_CREDENTIALS') {
      needsReauth.value = true
      currentPasswordError.value = session.t('auth.login.invalidCredentials')
    } else {
      passwordFieldError.value = localizeError(err)
    }
  } finally {
    passwordSaving.value = false
  }
}

async function handleConfirmRemovePassword() {
  if (passwordSaving.value) return
  passwordFieldError.value = ''
  currentPasswordError.value = ''

  passwordSaving.value = true
  try {
    const body = {}
    if (currentPassword.value) {
      body.current_password = currentPassword.value
    }
    await removePassword(body)
    hasPassword.value = false
    cancelPasswordForm()
    showPasswordToast(session.t('security.password.removedSessionsClosedToast'))
    await loadSessions()
  } catch (err) {
    const code = err?.errorCode || err?.payload?.error_code
    if (err?.status === 403 && code === 'REAUTHENTICATION_REQUIRED') {
      if (needsReauth.value && currentPassword.value) {
        currentPasswordError.value = session.t('errors.REAUTHENTICATION_REQUIRED')
      }
      needsReauth.value = true
    } else if (err?.status === 429 || code === 'RATE_LIMITED') {
      const msg = localizeError(err)
      if (needsReauth.value) {
        currentPasswordError.value = msg
      } else {
        passwordFieldError.value = msg
      }
    } else if (err?.status === 401 && code === 'INVALID_CREDENTIALS') {
      needsReauth.value = true
      currentPasswordError.value = session.t('auth.login.invalidCredentials')
    } else {
      passwordFieldError.value = localizeError(err)
    }
  } finally {
    passwordSaving.value = false
  }
}

async function handleQuickDemoSignIn() {
  if (quickDemoSigningIn.value) return
  quickDemoSigningIn.value = true
  try {
    await session.signInAsDemoRole()
  } finally {
    quickDemoSigningIn.value = false
  }
}

function getDeviceIcon(deviceKind) {
  if (deviceKind === 'DESKTOP_BROWSER') return 'computer'
  if (deviceKind === 'MOBILE_BROWSER') return 'smartphone'
  return 'devices'
}

function getDeviceLabel(deviceKind) {
  return session.t(`security.deviceKinds.${deviceKind || 'UNKNOWN'}`)
}

function getMethodLabel(authMethod) {
  return session.t(`security.authMethods.${authMethod || 'MAGIC_LINK'}`)
}

async function handleSignOutRow(row) {
  if (busyId.value) return
  if (!session.isSignedIn && demoPreviewSessions.value) {
    if (row.current) {
      demoPreviewSessions.value = false
      sessions.value = []
    } else {
      sessions.value = sessions.value.filter((s) => s.session_id !== row.session_id)
    }
    return
  }
  if (row.current) {
    busyId.value = row.session_id
    try {
      await session.signOut()
      router.push({ name: 'welcome' })
    } finally {
      busyId.value = ''
    }
    return
  }

  busyId.value = row.session_id
  try {
    await endSession(row.session_id)
    sessions.value = sessions.value.filter((s) => s.session_id !== row.session_id)
  } catch (err) {
    if (err?.status === 404 || err?.errorCode === 'SESSION_NOT_FOUND') {
      await loadSessions()
    } else {
      loadError.value = err
    }
  } finally {
    busyId.value = ''
  }
}

async function handleConfirmSignOutEverywhere() {
  if (endingAll.value) return
  if (!session.isSignedIn && demoPreviewSessions.value) {
    showConfirmAllModal.value = false
    demoPreviewSessions.value = false
    sessions.value = []
    return
  }
  endingAll.value = true
  try {
    await removeThisBrowserPush().catch(() => {})
    await endAllSessions()
    showConfirmAllModal.value = false
    session.resetAfterSessionEnd()
    router.push({ name: 'welcome' })
  } catch (err) {
    showConfirmAllModal.value = false
    loadError.value = err
  } finally {
    endingAll.value = false
  }
}

function toggleDemoPreviewSessions() {
  demoPreviewSessions.value = !demoPreviewSessions.value
  loadSessions()
}

function goToLogin() {
  router.push({ name: 'login', query: { tab: 'link' } })
}

onMounted(loadAllSecurityData)

watch(
  () => [session.isSignedIn, session.sessionRevision],
  () => {
    loadAllSecurityData()
  },
)
</script>

<template>
  <div class="w-full max-w-[960px] mx-auto px-gutter py-space-lg space-y-6">
    <!-- Page Header -->
    <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
      <div class="flex flex-col gap-1">
        <span class="font-label-md text-xs uppercase tracking-wider text-secondary font-semibold">
          {{ session.t('security.kicker') }}
        </span>
        <h1 class="font-headline-xl text-2xl sm:text-3xl font-bold text-on-surface tracking-tight">
          {{ session.t('security.title') }}
        </h1>
      </div>

      <!-- Demo Preview Toggle for Active Sessions -->
      <button
        v-if="!session.isSignedIn"
        type="button"
        class="self-start sm:self-auto px-3.5 py-2 rounded-lg border text-xs font-semibold transition-colors inline-flex items-center gap-2 cursor-pointer"
        :class="
          demoPreviewSessions
            ? 'border-secondary bg-secondary-container/40 text-on-secondary-container'
            : 'border-surface-container bg-surface-container-low text-on-surface hover:bg-surface-container'
        "
        @click="toggleDemoPreviewSessions"
      >
        <span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-bold uppercase">
          DEMO
        </span>
        <span>{{ session.t('security.demoPreviewToggle') }}</span>
      </button>
    </div>

    <!-- Password Toast / Banner -->
    <div
      v-if="passwordToast"
      class="rounded-xl bg-secondary-container/70 text-on-secondary-container px-4 py-3 text-xs font-semibold flex items-center justify-between gap-3"
    >
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-[18px]" aria-hidden="true">check_circle</span>
        <span>{{ passwordToast }}</span>
      </div>
      <button
        type="button"
        class="text-xs underline cursor-pointer"
        @click="passwordToast = ''"
      >
        {{ session.t('common.dismiss') }}
      </button>
    </div>

    <!-- Password Card (Task A5) -->
    <div
      v-if="session.isSignedIn"
      id="security-password-slot"
      class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xs space-y-5"
    >
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="font-headline-md text-lg font-bold text-on-surface">
              {{ session.t('security.password.title') }}
            </h2>
            <span
              v-if="!passwordLoading"
              class="px-2 py-0.5 rounded text-[11px] font-semibold"
              :class="
                hasPassword
                  ? 'bg-secondary-container text-on-secondary-container'
                  : 'bg-surface-container text-on-surface-variant'
              "
            >
              {{
                hasPassword
                  ? session.t('security.password.statusSet')
                  : session.t('security.password.statusNotSet')
              }}
            </span>
          </div>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('security.password.subtitle') }}
          </p>
        </div>

        <!-- Action Buttons when form is closed -->
        <div v-if="!passwordFormMode && !passwordLoading" class="flex flex-wrap items-center gap-2 shrink-0">
          <button
            v-if="!hasPassword"
            type="button"
            class="px-4 py-2 rounded-lg bg-primary text-on-primary font-label-md text-xs font-semibold hover:opacity-95 transition-opacity cursor-pointer"
            @click="openPasswordForm('set')"
          >
            {{ session.t('security.password.setBtn') }}
          </button>
          <template v-else>
            <button
              type="button"
              class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-label-md text-xs font-semibold transition-colors cursor-pointer"
              @click="openPasswordForm('change')"
            >
              {{ session.t('security.password.changeBtn') }}
            </button>
            <button
              type="button"
              class="px-4 py-2 rounded-lg text-error hover:bg-error-container/30 font-label-md text-xs font-semibold transition-colors cursor-pointer"
              @click="openPasswordForm('remove')"
            >
              {{ session.t('security.password.removeBtn') }}
            </button>
          </template>
        </div>
      </div>

      <ErrorCard v-if="passwordLoadError" :error="passwordLoadError" @retry="loadPasswordStatus" />

      <!-- Set or Change Password Form -->
      <form
        v-if="passwordFormMode === 'set' || passwordFormMode === 'change'"
        class="pt-4 border-t border-surface-container space-y-4"
        novalidate
        @submit.prevent="handleSubmitSetOrChangePassword"
      >
        <div class="space-y-1.5">
          <label for="security-new-password" class="block font-label-md text-xs font-semibold text-on-surface">
            {{ session.t('security.password.newPasswordLabel') }}
          </label>
          <input
            id="security-new-password"
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            minlength="15"
            maxlength="1024"
            class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-outline-variant/60 text-sm text-on-surface focus:outline-none focus:border-primary"
            @input="passwordFieldError = ''"
          />
          <p class="text-xs text-on-surface-variant">
            {{ session.t('security.password.hintMinLength') }}
          </p>
          <p v-if="passwordFieldError" class="text-xs font-medium text-error">
            {{ passwordFieldError }}
          </p>
        </div>

        <!-- Step-up Re-authentication (403 REAUTHENTICATION_REQUIRED) -->
        <div
          v-if="needsReauth"
          class="rounded-lg bg-surface-container-low border border-surface-container p-4 space-y-3"
        >
          <p class="text-xs text-on-surface font-medium">
            {{ session.t('security.password.reauthPrompt') }}
          </p>
          <div class="space-y-1.5">
            <label for="security-current-password" class="block font-label-md text-xs font-semibold text-on-surface">
              {{ session.t('security.password.currentPasswordLabel') }}
            </label>
            <input
              id="security-current-password"
              v-model="currentPassword"
              type="password"
              autocomplete="current-password"
              class="w-full px-3.5 py-2 rounded-lg bg-surface-container-lowest border border-outline-variant/60 text-sm text-on-surface focus:outline-none focus:border-primary"
              @input="currentPasswordError = ''"
            />
            <p v-if="currentPasswordError" class="text-xs font-medium text-error">
              {{ currentPasswordError }}
            </p>
          </div>
          <button
            type="button"
            class="text-xs font-semibold text-primary hover:underline cursor-pointer"
            @click="goToLogin"
          >
            {{ session.t('security.password.sendLinkInsteadBtn') }}
          </button>
        </div>

        <div class="flex items-center justify-end gap-2.5">
          <button
            type="button"
            :disabled="passwordSaving"
            class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
            @click="cancelPasswordForm"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="submit"
            :disabled="passwordSaving"
            class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
          >
            {{ session.t('common.save') }}
          </button>
        </div>
      </form>

      <!-- Remove Password Confirmation -->
      <div
        v-else-if="passwordFormMode === 'remove'"
        class="pt-4 border-t border-surface-container space-y-4"
      >
        <p class="text-sm text-on-surface-variant">
          {{ session.t('security.password.removeConfirmText') }}
        </p>

        <p v-if="passwordFieldError" class="text-xs font-medium text-error">
          {{ passwordFieldError }}
        </p>

        <!-- Step-up Re-authentication for Remove Password -->
        <div
          v-if="needsReauth"
          class="rounded-lg bg-surface-container-low border border-surface-container p-4 space-y-3"
        >
          <p class="text-xs text-on-surface font-medium">
            {{ session.t('security.password.reauthPrompt') }}
          </p>
          <div class="space-y-1.5">
            <label for="security-remove-current-password" class="block font-label-md text-xs font-semibold text-on-surface">
              {{ session.t('security.password.currentPasswordLabel') }}
            </label>
            <input
              id="security-remove-current-password"
              v-model="currentPassword"
              type="password"
              autocomplete="current-password"
              class="w-full px-3.5 py-2 rounded-lg bg-surface-container-lowest border border-outline-variant/60 text-sm text-on-surface focus:outline-none focus:border-primary"
              @input="currentPasswordError = ''"
            />
            <p v-if="currentPasswordError" class="text-xs font-medium text-error">
              {{ currentPasswordError }}
            </p>
          </div>
          <button
            type="button"
            class="text-xs font-semibold text-primary hover:underline cursor-pointer"
            @click="goToLogin"
          >
            {{ session.t('security.password.sendLinkInsteadBtn') }}
          </button>
        </div>

        <div class="flex items-center justify-end gap-2.5">
          <button
            type="button"
            :disabled="passwordSaving"
            class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
            @click="cancelPasswordForm"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            :disabled="passwordSaving"
            class="px-4 py-2 rounded-lg bg-error text-on-error text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
            @click="handleConfirmRemovePassword"
          >
            {{ session.t('security.password.removeBtn') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Demo Mode Placeholder -->
    <div
      v-if="!session.isSignedIn && !demoPreviewSessions"
      class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 sm:p-8 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4"
    >
      <div class="space-y-1">
        <h2 class="font-headline-md text-lg font-bold text-on-surface">
          {{ session.t('security.whereSignedInTitle') }}
        </h2>
        <p class="text-sm text-on-surface-variant">
          {{ session.t('security.demoPlaceholder') }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2.5 shrink-0">
        <button
          type="button"
          :disabled="quickDemoSigningIn"
          class="px-4 py-2.5 rounded-lg bg-secondary-container text-on-secondary-container font-label-md text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
          @click="handleQuickDemoSignIn"
        >
          {{ session.t('auth.demoQuickSignIn.btn', { role: currentRoleLabel }) }}
        </button>
        <button
          type="button"
          class="px-5 py-2.5 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
          @click="goToLogin"
        >
          {{ session.t('auth.signInLink') }}
        </button>
      </div>
    </div>

    <!-- Signed-In (or Demo Preview) Active Sessions Card -->
    <div
      v-else
      class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xs space-y-6"
    >
      <div class="space-y-1">
        <h2 class="font-headline-md text-lg font-bold text-on-surface">
          {{ session.t('security.whereSignedInTitle') }}
        </h2>
        <p class="text-xs text-on-surface-variant">
          {{ session.t('security.whereSignedInSubtitle') }}
        </p>
      </div>

      <ErrorCard v-if="loadError" :error="loadError" @retry="loadSessions" />

      <div v-if="loading && !sessions.length" class="space-y-3">
        <BaseSkeleton class="h-16 w-full rounded-lg" />
        <BaseSkeleton class="h-16 w-full rounded-lg" />
      </div>

      <div v-else class="divide-y divide-surface-container border-t border-b border-surface-container">
        <div
          v-for="row in sessions"
          :key="row.session_id"
          class="py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div class="flex items-start gap-3.5 min-w-0">
            <div class="w-10 h-10 rounded-lg bg-surface-container flex items-center justify-center text-on-surface shrink-0">
              <span class="material-symbols-outlined text-[20px]" aria-hidden="true">
                {{ getDeviceIcon(row.device_kind) }}
              </span>
            </div>

            <div class="space-y-0.5 min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-label-lg text-sm font-semibold text-on-surface">
                  {{ getDeviceLabel(row.device_kind) }}
                </span>
                <span
                  v-if="row.current"
                  class="px-2 py-0.5 rounded bg-secondary-container text-on-secondary-container text-[11px] font-semibold"
                >
                  {{ session.t('security.thisDevice') }}
                </span>
              </div>
              <p class="text-xs text-on-surface-variant">
                {{
                  session.t('security.signedInWith', {
                    date: formatShortDate(row.authenticated_at, session.lang),
                    method: getMethodLabel(row.auth_method),
                  })
                }}
                <span aria-hidden="true"> · </span>
                <span class="font-mono tabular-nums">
                  {{
                    session.t('security.lastActive', {
                      time: formatRelativeTime(row.last_used_at, session.lang),
                    })
                  }}
                </span>
              </p>
            </div>
          </div>

          <button
            type="button"
            :disabled="busyId === row.session_id"
            class="self-start sm:self-center px-3 py-1.5 rounded-lg text-xs font-semibold text-error hover:bg-error-container/30 transition-colors disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            @click="handleSignOutRow(row)"
          >
            {{ session.t('security.signOutBtn') }}
          </button>
        </div>
      </div>

      <!-- Sign Out Everywhere Section -->
      <div class="pt-2 space-y-2">
        <button
          type="button"
          class="px-4 py-2 rounded-lg border border-error text-error hover:bg-error-container/25 font-label-md text-xs font-semibold transition-colors cursor-pointer"
          @click="showConfirmAllModal = true"
        >
          {{ session.t('security.signOutEverywhereBtn') }}
        </button>
        <p class="text-xs text-on-surface-variant leading-relaxed">
          {{ session.t('security.linkedChatsNote') }}
        </p>
      </div>
    </div>

    <!-- Confirmation Modal for Sign Out Everywhere -->
    <Teleport to="body">
      <div
        v-if="showConfirmAllModal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
      >
        <div class="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xl space-y-4">
          <h3 class="font-headline-md text-lg font-bold text-on-surface">
            {{ session.t('security.confirmEverywhereTitle') }}
          </h3>
          <p class="text-sm text-on-surface-variant leading-relaxed">
            {{ session.t('security.confirmEverywhereText') }}
          </p>
          <div class="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              :disabled="endingAll"
              class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="showConfirmAllModal = false"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="endingAll"
              class="px-4 py-2 rounded-lg bg-error text-on-error text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="handleConfirmSignOutEverywhere"
            >
              {{ session.t('security.signOutEverywhereBtn') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
