<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import {
  createInvitation,
  deleteInvitation,
  getResidents,
  removeTenant,
  replaceTenant,
  resendInvitation,
} from '@/api/endpoints/invitations.js'
import { localizeError } from '@/locales/index.js'
import { formatShortDate } from '@/utils/dates.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'
import SettingsShellTabs from './components/SettingsShellTabs.vue'

const router = useRouter()
const session = useSessionStore()
const {
  buildingRole,
  canViewMatrix,
  canManagePeriods,
  canPublishOfficial,
  greetingName,
} = useRole()

const privacySavingId = ref('')
const privacySavedId = ref('')
const privacyError = ref(null)

const localeSaving = ref(false)
const localeSaved = ref(false)
const localeError = ref('')

const memberships = computed(() => session.memberships || [])
const activeMembership = computed(() => session.activeMembership)

const ownedMemberships = computed(() =>
  memberships.value.filter((m) => m.relation_type === 'OWNER'),
)

const privacyModes = ['APARTMENT_ONLY', 'INITIALS', 'FULL_NAME']

const uiLanguageLabels = {
  en: 'English (EN)',
  et: 'Eesti (ET)',
  ru: 'Русский (RU)',
}

const currentRoleLabel = computed(() =>
  session.t(`buildingRole.${buildingRole.value || 'USER'}`),
)

function getSimulatedBadgePreview(membership, mode) {
  if (!membership) return ''
  if (membership.privacy_display_mode === mode) {
    return membership.preview_badge?.display_label || `Apt. ${membership.apartment_number}`
  }
  const apt = membership.apartment_number
  if (mode === 'APARTMENT_ONLY') {
    return `Apt. ${apt}`
  }
  if (mode === 'INITIALS') {
    return `I. P. (Apt. ${apt})`
  }
  return `Resident (Apt. ${apt})`
}

async function handleSelectPrivacyMode(membership, mode) {
  if (!membership || privacySavingId.value || membership.privacy_display_mode === mode) return
  privacySavingId.value = membership.membership_id
  privacySavedId.value = ''
  privacyError.value = null
  try {
    await session.changePrivacyMode(membership.membership_id, mode)
    privacySavedId.value = membership.membership_id
    setTimeout(() => {
      if (privacySavedId.value === membership.membership_id) {
        privacySavedId.value = ''
      }
    }, 2500)
  } catch (err) {
    privacyError.value = err
  } finally {
    privacySavingId.value = ''
  }
}

async function handleNotificationLocaleChange(event) {
  const raw = event.target.value
  const targetLocale = raw === '' ? null : raw
  localeSaving.value = true
  localeSaved.value = false
  localeError.value = ''
  try {
    await session.changeNotificationLocale(targetLocale)
    localeSaved.value = true
    setTimeout(() => {
      localeSaved.value = false
    }, 2500)
  } catch (err) {
    localeError.value = localizeError(err)
  } finally {
    localeSaving.value = false
  }
}

// Task A4: Real API state for "My residents" (Owner only, requires Bearer token)
const residentsByApt = reactive({})
const loadingByApt = reactive({})
const errorByApt = reactive({})
const residentsBanner = ref('')
const quickDemoSigningIn = ref(false)

function showResidentsBanner(msg) {
  residentsBanner.value = msg
  setTimeout(() => {
    if (residentsBanner.value === msg) {
      residentsBanner.value = ''
    }
  }, 4500)
}

function getApartmentData(aptId) {
  return (
    residentsByApt[aptId] || {
      residents: [],
      pending_invitations: [],
    }
  )
}

function getDaysUntilExpiry(isoString) {
  if (!isoString) return 7
  const diffMs = new Date(isoString).getTime() - Date.now()
  return Math.max(1, Math.ceil(diffMs / 86_400_000))
}

async function loadApartmentResidents(membership) {
  if (!membership || !session.isSignedIn) return
  const aptId = membership.apartment_id
  loadingByApt[aptId] = true
  errorByApt[aptId] = null
  try {
    const res = await getResidents(aptId)
    residentsByApt[aptId] = {
      apartment_id: res?.apartment_id || aptId,
      apartment_number: res?.apartment_number || membership.apartment_number,
      residents: Array.isArray(res?.residents) ? res.residents : [],
      pending_invitations: Array.isArray(res?.pending_invitations) ? res.pending_invitations : [],
    }
  } catch (err) {
    errorByApt[aptId] = err
  } finally {
    loadingByApt[aptId] = false
  }
}

async function loadAllOwnedResidents() {
  if (!session.isSignedIn) return
  await Promise.all(ownedMemberships.value.map((m) => loadApartmentResidents(m)))
}

watch(
  () => [session.isSignedIn, session.sessionRevision, ownedMemberships.value.length],
  () => {
    if (session.isSignedIn) {
      loadAllOwnedResidents()
    }
  },
  { immediate: true },
)

async function handleQuickDemoSignIn() {
  if (quickDemoSigningIn.value) return
  quickDemoSigningIn.value = true
  try {
    await session.signInAsDemoRole()
  } finally {
    quickDemoSigningIn.value = false
  }
}

const inviteModalApt = ref(null)
const inviteInput = ref('')
const inviteModalError = ref('')
const inviteBusy = ref(false)

const replaceModalState = ref(null)
const replaceInput = ref('')
const replaceModalError = ref('')
const replaceBusy = ref(false)

const removeModalState = ref(null)
const removeBusy = ref(false)

function openInviteModal(membership) {
  inviteModalApt.value = membership
  inviteInput.value = ''
  inviteModalError.value = ''
}

async function submitInviteTenant() {
  if (!inviteModalApt.value || inviteBusy.value) return
  const membership = inviteModalApt.value
  const trimmed = inviteInput.value.trim()

  if (!trimmed || !trimmed.includes('@')) {
    inviteModalError.value = session.t('profile.residents.invalidContact')
    return
  }

  inviteBusy.value = true
  inviteModalError.value = ''
  try {
    await createInvitation({
      kind: 'TENANT',
      email: trimmed,
      apartment_id: membership.apartment_id,
    })
    inviteModalApt.value = null
    inviteInput.value = ''
    showResidentsBanner(session.t('profile.residents.invitationSentBanner'))
    await loadApartmentResidents(membership)
  } catch (err) {
    const code = err?.errorCode || err?.payload?.error_code
    if (err?.status === 404 || code === 'APARTMENT_NOT_FOUND') {
      inviteModalApt.value = null
      showResidentsBanner(session.t('profile.residents.alreadyChangedReloaded'))
      await loadApartmentResidents(membership)
    } else {
      inviteModalError.value = localizeError(err)
    }
  } finally {
    inviteBusy.value = false
  }
}

async function handleResendInvite(membership, inv) {
  try {
    await resendInvitation(inv.invitation_id)
    showResidentsBanner(session.t('profile.residents.invitationResentBanner'))
    await loadApartmentResidents(membership)
  } catch (err) {
    showResidentsBanner(localizeError(err))
    await loadApartmentResidents(membership)
  }
}

async function handleCancelInvite(membership, invId) {
  try {
    await deleteInvitation(invId)
    showResidentsBanner(session.t('profile.residents.invitationCancelledBanner'))
    await loadApartmentResidents(membership)
  } catch (err) {
    const code = err?.errorCode || err?.payload?.error_code
    if (err?.status === 404 || code === 'INVITATION_NOT_FOUND') {
      showResidentsBanner(session.t('profile.residents.alreadyChangedReloaded'))
    } else {
      showResidentsBanner(localizeError(err))
    }
    await loadApartmentResidents(membership)
  }
}

function openReplaceModal(membership, resident) {
  replaceModalState.value = { membership, resident }
  replaceInput.value = ''
  replaceModalError.value = ''
}

async function submitReplaceTenant() {
  if (!replaceModalState.value || replaceBusy.value) return
  const trimmed = replaceInput.value.trim()
  if (!trimmed || !trimmed.includes('@')) {
    replaceModalError.value = session.t('profile.residents.invalidContact')
    return
  }
  const { membership, resident } = replaceModalState.value
  replaceBusy.value = true
  replaceModalError.value = ''
  try {
    await replaceTenant(membership.apartment_id, resident.user_id, {
      email: trimmed,
    })
    replaceModalState.value = null
    replaceInput.value = ''
    showResidentsBanner(session.t('profile.residents.tenantReplacedBanner'))
    await loadApartmentResidents(membership)
  } catch (err) {
    const code = err?.errorCode || err?.payload?.error_code
    if (
      err?.status === 404 ||
      code === 'MEMBERSHIP_NOT_FOUND' ||
      code === 'APARTMENT_NOT_FOUND'
    ) {
      replaceModalState.value = null
      showResidentsBanner(session.t('profile.residents.alreadyChangedReloaded'))
      await loadApartmentResidents(membership)
    } else {
      replaceModalError.value = localizeError(err)
    }
  } finally {
    replaceBusy.value = false
  }
}

function openRemoveModal(membership, resident) {
  removeModalState.value = { membership, resident }
}

async function confirmRemoveTenant() {
  if (!removeModalState.value || removeBusy.value) return
  const { membership, resident } = removeModalState.value
  removeBusy.value = true
  try {
    await removeTenant(membership.apartment_id, resident.user_id)
    removeModalState.value = null
    showResidentsBanner(session.t('profile.residents.tenantRemovedBanner'))
    await loadApartmentResidents(membership)
  } catch (err) {
    removeModalState.value = null
    const code = err?.errorCode || err?.payload?.error_code
    if (
      err?.status === 404 ||
      code === 'MEMBERSHIP_NOT_FOUND' ||
      code === 'APARTMENT_NOT_FOUND'
    ) {
      showResidentsBanner(session.t('profile.residents.alreadyChangedReloaded'))
    } else {
      showResidentsBanner(localizeError(err))
    }
    await loadApartmentResidents(membership)
  } finally {
    removeBusy.value = false
  }
}
</script>

<template>
  <div class="w-full max-w-[960px] mx-auto px-gutter py-space-lg space-y-6">
    <!-- Page Header -->
    <div class="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
      <div class="flex flex-col gap-1">
        <span class="font-label-md text-xs uppercase tracking-wider text-secondary font-semibold">
          {{ session.t('profile.kicker') }}
        </span>
        <h1 class="font-headline-xl text-2xl sm:text-3xl font-bold text-on-surface tracking-tight">
          {{ session.t('profile.title') }}
        </h1>
        <p class="text-sm text-on-surface-variant">
          {{ session.t('profile.subtitle') }}
        </p>
      </div>

      <!-- Unified Account Settings Navigation Shell -->
      <SettingsShellTabs />
    </div>

    <ErrorCard v-if="privacyError" :error="privacyError" @retry="privacyError = null" />

    <!-- Card 1: Identity, Building Association & Role Summary -->
    <section class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xs">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-5 pb-5 border-b border-surface-container">
        <div class="flex items-start gap-4">
          <div class="w-12 h-12 rounded-xl bg-primary text-on-primary flex items-center justify-center font-headline-md text-lg font-bold shrink-0 shadow-xs">
            {{ activeMembership?.apartment_number || buildingRole.slice(0, 2) }}
          </div>
          <div class="space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="font-headline-md text-lg font-bold text-on-surface">
                {{ greetingName }}
              </h2>
              <span class="px-2 py-0.5 rounded bg-primary text-on-primary text-[11px] font-bold tracking-wider uppercase">
                {{ activeMembership?.preview_badge?.role_badge || buildingRole }}
              </span>
              <span
                class="px-2 py-0.5 rounded text-[11px] font-semibold"
                :class="
                  session.isSignedIn
                    ? 'bg-secondary-container text-on-secondary-container'
                    : 'bg-amber-100 text-amber-900'
                "
              >
                {{
                  session.isSignedIn
                    ? session.t('profile.identity.signedInMode')
                    : session.t('profile.identity.demoMode')
                }}
              </span>
            </div>
            <p class="text-xs text-on-surface-variant">
              {{ session.t(`buildingRole.${buildingRole}`) }} · {{ session.buildingName }} ({{ session.buildingAddress }})
            </p>
          </div>
        </div>

        <!-- Forum AuthorBadge Live Preview -->
        <div class="flex flex-col sm:items-end gap-1 bg-surface-container-low px-4 py-3 rounded-lg border border-surface-container">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">
            {{ session.t('profile.identity.publicBadgeLabel') }}
          </span>
          <div class="flex items-center gap-2">
            <span class="material-symbols-outlined text-[16px] text-secondary" aria-hidden="true">
              verified_user
            </span>
            <span class="font-label-lg text-sm font-bold text-on-surface">
              {{ activeMembership?.preview_badge?.display_label || greetingName }}
            </span>
            <span class="px-1.5 py-0.5 rounded bg-surface-container-highest text-on-surface text-[10px] font-bold uppercase">
              {{ activeMembership?.preview_badge?.role_badge || buildingRole }}
            </span>
          </div>
        </div>
      </div>

      <!-- Association & Role Capabilities Strip -->
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-5">
        <div class="flex flex-col gap-0.5">
          <span class="text-xs text-on-surface-variant">
            {{ session.t('profile.identity.associationLabel') }}
          </span>
          <span class="font-label-lg text-sm font-semibold text-on-surface">
            {{ session.buildingName }} ({{ session.t('common.reg') }} {{ session.buildingRegistryCode }})
          </span>
        </div>

        <div class="flex flex-col gap-0.5">
          <span class="text-xs text-on-surface-variant">
            {{ session.t('profile.identity.buildingRoleLabel') }}
          </span>
          <span class="font-label-lg text-sm font-semibold text-on-surface">
            {{ session.t(`buildingRole.${buildingRole}`) }}
          </span>
        </div>

        <div class="flex flex-col gap-0.5">
          <span class="text-xs text-on-surface-variant">
            {{ session.t('profile.identity.boardAccessLabel') }}
          </span>
          <div class="flex flex-wrap items-center gap-1.5 pt-0.5">
            <span
              v-if="canViewMatrix"
              class="px-2 py-0.5 rounded bg-secondary-container/70 text-on-secondary-container text-[11px] font-semibold"
            >
              {{ session.t('profile.identity.capMatrix') }}
            </span>
            <span
              v-if="canManagePeriods"
              class="px-2 py-0.5 rounded bg-secondary-container/70 text-on-secondary-container text-[11px] font-semibold"
            >
              {{ session.t('profile.identity.capPeriods') }}
            </span>
            <span
              v-if="canPublishOfficial"
              class="px-2 py-0.5 rounded bg-secondary-container/70 text-on-secondary-container text-[11px] font-semibold"
            >
              {{ session.t('profile.identity.capNotices') }}
            </span>
            <span
              v-if="!canViewMatrix && !canManagePeriods && !canPublishOfficial"
              class="text-xs text-on-surface-variant font-medium"
            >
              {{ session.t('profile.identity.capResidentStandard') }}
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- Card 2: My Apartments & Access Rights (from GET /api/v1/property/me memberships) -->
    <section class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xs space-y-5">
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div class="space-y-0.5">
          <h2 class="font-headline-md text-lg font-bold text-on-surface">
            {{ session.t('profile.apartments.title') }}
          </h2>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('profile.apartments.subtitle') }}
          </p>
        </div>
        <span
          v-if="memberships.length > 0"
          class="self-start sm:self-center px-2.5 py-1 rounded-full bg-surface-container text-on-surface font-label-md text-xs font-semibold"
        >
          {{ session.t('profile.apartments.countBadge', { count: memberships.length }) }}
        </span>
      </div>

      <!-- Empty State for Staff without Apartments (e.g. Accountant) -->
      <div
        v-if="memberships.length === 0"
        class="rounded-lg bg-surface-container-low p-5 border border-surface-container flex items-start gap-3.5"
      >
        <span class="material-symbols-outlined text-[22px] text-secondary shrink-0 mt-0.5" aria-hidden="true">
          badge
        </span>
        <div class="space-y-1">
          <h3 class="font-label-lg text-sm font-bold text-on-surface">
            {{ session.t('profile.apartments.staffEmptyTitle') }}
          </h3>
          <p class="text-xs text-on-surface-variant leading-relaxed">
            {{ session.t('profile.apartments.staffEmptyText') }}
          </p>
        </div>
      </div>

      <!-- Apartment Membership Cards -->
      <div v-else class="grid grid-cols-1 gap-5">
        <div
          v-for="m in memberships"
          :key="m.membership_id"
          class="rounded-xl border p-5 transition-colors space-y-5"
          :class="
            activeMembership?.membership_id === m.membership_id
              ? 'border-primary/40 bg-surface-container-low/40'
              : 'border-surface-container bg-surface-container-lowest'
          "
        >
          <!-- Apartment Header -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-surface-container">
            <div class="flex items-center gap-3">
              <div class="w-10 h-10 rounded-full bg-primary text-on-primary flex items-center justify-center font-label-lg text-sm font-bold shrink-0">
                {{ m.apartment_number }}
              </div>
              <div>
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="font-headline-md text-base font-bold text-on-surface">
                    {{ session.t('common.apartmentNumber', { number: m.apartment_number }) }}
                  </h3>
                  <span class="px-2 py-0.5 rounded-full bg-surface-container-high text-on-surface text-[11px] font-bold uppercase">
                    {{ m.relation_type }}
                  </span>
                  <span
                    v-if="activeMembership?.membership_id === m.membership_id && memberships.length > 1"
                    class="px-2 py-0.5 rounded bg-secondary-container text-on-secondary-container text-[11px] font-semibold"
                  >
                    {{ session.t('profile.apartments.activeChip') }}
                  </span>
                </div>
                <p class="text-xs text-on-surface-variant">
                  {{ session.t('common.floorEntrance', { floor: m.floor, entrance: m.entrance }) }}
                  <template v-if="m.since">
                    <span aria-hidden="true"> · </span>
                    <span>
                      {{
                        session.t('profile.apartments.memberSince', {
                          date: formatShortDate(m.since, session.lang),
                        })
                      }}
                    </span>
                  </template>
                </p>
              </div>
            </div>

            <div class="flex items-center gap-2">
              <button
                v-if="memberships.length > 1 && activeMembership?.membership_id !== m.membership_id"
                type="button"
                class="px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
                @click="session.selectApartment(m.apartment_id)"
              >
                {{ session.t('profile.apartments.setActiveBtn') }}
              </button>
              <button
                type="button"
                class="px-3 py-1.5 rounded-lg bg-primary text-on-primary hover:opacity-95 text-xs font-semibold transition-opacity inline-flex items-center gap-1 cursor-pointer"
                @click="router.push('/readings')"
              >
                <span class="material-symbols-outlined text-[15px]" aria-hidden="true">speed</span>
                <span>{{ session.t('dashboard.manageAptMeters', { number: m.apartment_number }) }}</span>
              </button>
            </div>
          </div>

          <!-- Permissions Row -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div class="p-3 rounded-lg bg-surface-container-low flex items-center justify-between">
              <span class="text-xs text-on-surface-variant">
                {{ session.t('profile.apartments.permReadings') }}
              </span>
              <span
                class="inline-flex items-center gap-1 text-xs font-semibold"
                :class="m.can_submit_readings ? 'text-secondary' : 'text-on-surface-variant'"
              >
                <span class="material-symbols-outlined text-[15px]" aria-hidden="true">
                  {{ m.can_submit_readings ? 'check_circle' : 'lock' }}
                </span>
                {{ m.can_submit_readings ? session.t('dashboard.authorized') : session.t('dashboard.readOnly') }}
              </span>
            </div>

            <div class="p-3 rounded-lg bg-surface-container-low flex items-center justify-between">
              <span class="text-xs text-on-surface-variant">
                {{ session.t('profile.apartments.permBills') }}
              </span>
              <span
                class="inline-flex items-center gap-1 text-xs font-semibold"
                :class="m.can_view_bills ? 'text-secondary' : 'text-on-surface-variant'"
              >
                <span class="material-symbols-outlined text-[15px]" aria-hidden="true">
                  {{ m.can_view_bills ? 'check_circle' : 'lock' }}
                </span>
                {{ m.can_view_bills ? session.t('dashboard.authorized') : session.t('dashboard.no') }}
              </span>
            </div>

            <div class="p-3 rounded-lg bg-surface-container-low flex items-center justify-between">
              <span class="text-xs text-on-surface-variant">
                {{ session.t('profile.apartments.permVote') }}
              </span>
              <span
                class="inline-flex items-center gap-1 text-xs font-semibold"
                :class="m.can_vote ? 'text-secondary' : 'text-on-surface-variant'"
              >
                <span class="material-symbols-outlined text-[15px]" aria-hidden="true">
                  {{ m.can_vote ? 'how_to_vote' : 'block' }}
                </span>
                {{ m.can_vote ? session.t('dashboard.yesOwner') : session.t('dashboard.no') }}
              </span>
            </div>
          </div>

          <!-- Neighbour Visibility Radio Cards (PATCH /property/memberships/{id}/privacy) -->
          <div class="space-y-2.5 pt-1">
            <div class="flex items-center justify-between">
              <div>
                <h4 class="font-label-lg text-xs font-bold uppercase tracking-wider text-on-surface">
                  {{ session.t('profile.privacy.title') }}
                </h4>
                <p class="text-xs text-on-surface-variant">
                  {{ session.t('profile.privacy.subtitle') }}
                </p>
              </div>
              <span
                v-if="privacySavedId === m.membership_id"
                class="text-xs font-semibold text-secondary inline-flex items-center gap-1"
              >
                <span class="material-symbols-outlined text-[15px]" aria-hidden="true">check</span>
                {{ session.t('notificationSettings.language.saved') }}
              </span>
            </div>

            <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <button
                v-for="mode in privacyModes"
                :key="mode"
                type="button"
                :disabled="privacySavingId === m.membership_id"
                class="p-3.5 rounded-lg border text-left transition-all flex flex-col justify-between gap-2 cursor-pointer"
                :class="
                  m.privacy_display_mode === mode
                    ? 'border-secondary bg-secondary-container/25 shadow-2xs'
                    : 'border-surface-container bg-surface-container-lowest hover:bg-surface-container-low'
                "
                @click="handleSelectPrivacyMode(m, mode)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="font-label-lg text-xs font-bold text-on-surface">
                    {{ session.t(`privacy.${mode}`) }}
                  </span>
                  <span
                    class="material-symbols-outlined text-[17px]"
                    :class="m.privacy_display_mode === mode ? 'text-secondary' : 'text-on-surface-variant/40'"
                    aria-hidden="true"
                  >
                    {{ m.privacy_display_mode === mode ? 'radio_button_checked' : 'radio_button_unchecked' }}
                  </span>
                </div>
                <p class="text-[11px] text-on-surface-variant leading-snug">
                  {{ session.t(`profile.privacy.descriptions.${mode}`) }}
                </p>
                <div class="pt-1 border-t border-surface-container/80 flex items-center justify-between text-[11px]">
                  <span class="text-on-surface-variant">{{ session.t('common.preview') }}:</span>
                  <span class="font-semibold text-on-surface truncate max-w-[130px]">
                    {{ getSimulatedBadgePreview(m, mode) }}
                  </span>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Card 3: Language & Communication Preferences (UI Language + PATCH /property/me/locale) -->
    <section class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xs space-y-5">
      <div class="space-y-0.5">
        <h2 class="font-headline-md text-lg font-bold text-on-surface">
          {{ session.t('profile.preferences.title') }}
        </h2>
        <p class="text-xs text-on-surface-variant">
          {{ session.t('profile.preferences.subtitle') }}
        </p>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-5 pt-1">
        <!-- Interface Language (Header / Local Switcher) -->
        <div class="p-4 rounded-xl bg-surface-container-low border border-surface-container flex flex-col justify-between gap-3">
          <div class="space-y-1">
            <label class="font-label-lg text-sm font-bold text-on-surface block">
              {{ session.t('profile.preferences.uiLanguageLabel') }}
            </label>
            <p class="text-xs text-on-surface-variant">
              {{ session.t('profile.preferences.uiLanguageHint') }}
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <button
              v-for="loc in session.supportedLocales"
              :key="loc.code || loc"
              type="button"
              class="px-4 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
              :class="
                session.lang === (loc.code || loc)
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-container-lowest text-on-surface hover:bg-surface-container'
              "
              @click="session.setLang(loc.code || loc)"
            >
              {{ uiLanguageLabels[loc.code || loc] || loc.label || String(loc.code || loc).toUpperCase() }}
            </button>
          </div>
        </div>

        <!-- Notification Message Language (PATCH /property/me/locale) -->
        <div class="p-4 rounded-xl bg-surface-container-low border border-surface-container flex flex-col justify-between gap-3">
          <div class="space-y-1">
            <div class="flex items-center justify-between gap-2">
              <label for="profile-notification-locale" class="font-label-lg text-sm font-bold text-on-surface">
                {{ session.t('notificationSettings.language.title') }}
              </label>
              <span
                v-if="localeSaved"
                class="text-xs font-semibold text-secondary inline-flex items-center gap-1"
              >
                <span class="material-symbols-outlined text-[15px]" aria-hidden="true">check</span>
                {{ session.t('notificationSettings.language.saved') }}
              </span>
            </div>
            <p class="text-xs text-on-surface-variant">
              {{ session.t('notificationSettings.language.description') }}
            </p>
          </div>

          <div class="space-y-1.5">
            <select
              id="profile-notification-locale"
              :value="session.me?.locale ?? ''"
              :disabled="localeSaving"
              class="w-full px-3.5 py-2 rounded-lg bg-surface-container-lowest border border-outline-variant/60 text-sm text-on-surface focus:outline-none focus:border-primary"
              @change="handleNotificationLocaleChange"
            >
              <option value="">{{ session.t('notificationSettings.language.buildingDefault') }}</option>
              <option value="et">{{ session.t('notificationSettings.language.et') }}</option>
              <option value="ru">{{ session.t('notificationSettings.language.ru') }}</option>
              <option value="en">{{ session.t('notificationSettings.language.en') }}</option>
            </select>
            <p v-if="localeError" class="text-xs text-error">
              {{ localeError }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- Card 4: My Residents & Tenant Invitations (Task A4 — Owner only) -->
    <section
      v-if="ownedMemberships.length > 0"
      class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xs space-y-5"
    >
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div class="space-y-1">
          <h2 class="font-headline-md text-lg font-bold text-on-surface">
            {{ session.t('profile.residents.title') }}
          </h2>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('profile.residents.subtitle') }}
          </p>
        </div>
        <span class="text-xs text-on-surface-variant font-medium">
          {{ session.t('profile.residents.limitNote') }}
        </span>
      </div>

      <!-- Feedback Banner -->
      <div
        v-if="residentsBanner"
        class="rounded-xl bg-secondary-container/70 text-on-secondary-container px-4 py-3 text-xs font-semibold flex items-center justify-between gap-3"
      >
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-[18px]" aria-hidden="true">check_circle</span>
          <span>{{ residentsBanner }}</span>
        </div>
        <button
          type="button"
          class="text-xs underline cursor-pointer"
          @click="residentsBanner = ''"
        >
          {{ session.t('common.dismiss') }}
        </button>
      </div>

      <!-- Sign-in Required Placeholder when browsing in Demo Mode without Bearer token -->
      <div
        v-if="!session.isSignedIn"
        class="rounded-xl bg-surface-container-low border border-surface-container p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
      >
        <div class="space-y-1">
          <h3 class="font-label-lg text-sm font-bold text-on-surface">
            {{ session.t('profile.residents.signInPlaceholderTitle') }}
          </h3>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('profile.residents.signInPlaceholderDesc') }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            :disabled="quickDemoSigningIn"
            class="px-4 py-2 rounded-lg bg-secondary-container text-on-secondary-container font-label-md text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
            @click="handleQuickDemoSignIn"
          >
            {{ session.t('auth.demoQuickSignIn.btn', { role: currentRoleLabel }) }}
          </button>
          <button
            type="button"
            class="px-4 py-2 rounded-lg bg-primary text-on-primary font-label-md text-xs font-semibold hover:opacity-95 transition-opacity cursor-pointer"
            @click="router.push({ name: 'login' })"
          >
            {{ session.t('auth.signInLink') }}
          </button>
        </div>
      </div>

      <!-- Signed-in Apartment Resident Lists -->
      <template v-else>
        <div
          v-for="m in ownedMemberships"
          :key="`residents-${m.membership_id}`"
          class="rounded-xl border border-surface-container p-5 space-y-5 bg-surface-container-low/30"
        >
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-surface-container">
            <div>
              <h3 class="font-headline-md text-base font-bold text-on-surface">
                {{ session.t('common.apartmentNumber', { number: m.apartment_number }) }}
              </h3>
            </div>

            <button
              type="button"
              class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-95 transition-opacity inline-flex items-center gap-1.5 self-start sm:self-center cursor-pointer"
              @click="openInviteModal(m)"
            >
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">person_add</span>
              <span>{{ session.t('profile.residents.inviteTenantBtn') }}</span>
            </button>
          </div>

          <ErrorCard
            v-if="errorByApt[m.apartment_id]"
            :error="errorByApt[m.apartment_id]"
            @retry="loadApartmentResidents(m)"
          />

          <!-- Active Residents List -->
          <div class="divide-y divide-surface-container">
            <div
              v-for="res in getApartmentData(m.apartment_id).residents"
              :key="res.membership_id"
              class="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
            >
              <div class="flex items-center gap-3">
                <div class="w-9 h-9 rounded-lg bg-surface-container flex items-center justify-center text-on-surface shrink-0">
                  <span class="material-symbols-outlined text-[18px]" aria-hidden="true">
                    {{ res.relation_type === 'OWNER' ? 'verified_user' : 'person' }}
                  </span>
                </div>
                <div class="space-y-0.5">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-label-lg text-sm font-semibold text-on-surface">
                      {{ res.display_label }}
                    </span>
                    <span
                      class="px-2 py-0.5 rounded text-[10px] font-bold uppercase"
                      :class="
                        res.relation_type === 'OWNER'
                          ? 'bg-primary text-on-primary'
                          : 'bg-surface-container-high text-on-surface'
                      "
                    >
                      {{ res.relation_type }}
                    </span>
                  </div>
                  <p class="text-xs text-on-surface-variant">
                    {{
                      session.t('profile.residents.sinceDate', {
                        date: formatShortDate(res.since, session.lang),
                      })
                    }}
                    <template v-if="res.invited_email">
                      <span aria-hidden="true"> · </span>
                      <span class="font-mono">{{ res.invited_email }}</span>
                    </template>
                  </p>
                </div>
              </div>

              <div v-if="res.relation_type === 'TENANT'" class="flex items-center gap-2 self-start sm:self-center">
                <button
                  type="button"
                  class="px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
                  @click="openReplaceModal(m, res)"
                >
                  {{ session.t('profile.residents.replaceBtn') }}
                </button>
                <button
                  type="button"
                  class="px-3 py-1.5 rounded-lg text-error hover:bg-error-container/30 text-xs font-semibold transition-colors cursor-pointer"
                  @click="openRemoveModal(m, res)"
                >
                  {{ session.t('profile.residents.removeBtn') }}
                </button>
              </div>
            </div>
          </div>

          <!-- Pending Invitations Section -->
          <div
            v-if="getApartmentData(m.apartment_id).pending_invitations.length > 0"
            class="pt-3 border-t border-surface-container space-y-2.5"
          >
            <h4 class="font-label-md text-xs font-bold uppercase tracking-wider text-on-surface-variant">
              {{ session.t('profile.residents.pendingTitle') }}
            </h4>
            <div class="divide-y divide-surface-container">
              <div
                v-for="inv in getApartmentData(m.apartment_id).pending_invitations"
                :key="inv.invitation_id"
                class="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div class="flex flex-wrap items-center gap-2.5">
                  <span class="material-symbols-outlined text-[18px] text-on-surface-variant" aria-hidden="true">
                    schedule_send
                  </span>
                  <span class="font-mono text-xs font-semibold text-on-surface">
                    {{ inv.email }}
                  </span>
                  <span
                    v-if="inv.status && inv.status !== 'PENDING'"
                    class="px-2 py-0.5 rounded bg-surface-container text-on-surface-variant text-[10px] font-semibold"
                  >
                    {{ session.t(`people.invitationStatuses.${inv.status}`) }}
                  </span>
                  <span
                    v-else
                    class="text-xs text-on-surface-variant"
                  >
                    ·
                    {{
                      session.t('profile.residents.expiresInDays', {
                        days: getDaysUntilExpiry(inv.expires_at),
                      })
                    }}
                  </span>
                </div>

                <div class="flex items-center gap-2 self-start sm:self-center">
                  <button
                    v-if="!inv.status || inv.status === 'PENDING' || inv.status === 'EXPIRED'"
                    type="button"
                    class="px-2.5 py-1 rounded text-xs font-semibold text-primary hover:bg-surface-container transition-colors cursor-pointer"
                    @click="handleResendInvite(m, inv)"
                  >
                    {{ session.t('profile.residents.resendBtn') }}
                  </button>
                  <button
                    type="button"
                    class="px-2.5 py-1 rounded text-xs font-semibold text-error hover:bg-error-container/30 transition-colors cursor-pointer"
                    @click="handleCancelInvite(m, inv.invitation_id)"
                  >
                    {{ session.t('common.cancel') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </section>

    <!-- Modal: Invite a Tenant -->
    <Teleport to="body">
      <div
        v-if="inviteModalApt"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
      >
        <div class="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xl space-y-4">
          <div class="flex items-center justify-between gap-2">
            <h3 class="font-headline-md text-lg font-bold text-on-surface">
              {{
                session.t('profile.residents.inviteModalTitle', {
                  number: inviteModalApt.apartment_number,
                })
              }}
            </h3>
          </div>
          <p class="text-xs text-on-surface-variant leading-relaxed">
            {{ session.t('profile.residents.inviteModalDesc') }}
          </p>

          <div class="space-y-1.5">
            <label for="tenant-invite-contact" class="block font-label-md text-xs font-semibold text-on-surface">
              {{ session.t('auth.login.emailLabel') }}
            </label>
            <input
              id="tenant-invite-contact"
              v-model="inviteInput"
              type="email"
              autocomplete="off"
              :placeholder="session.t('profile.residents.contactPlaceholder')"
              class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-outline-variant/60 text-sm text-on-surface focus:outline-none focus:border-primary"
              @keyup.enter="submitInviteTenant"
            />
            <p v-if="inviteModalError" class="text-xs text-error">
              {{ inviteModalError }}
            </p>
          </div>

          <div class="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              :disabled="inviteBusy"
              class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="inviteModalApt = null"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="inviteBusy"
              class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="submitInviteTenant"
            >
              {{ session.t('profile.residents.sendInviteBtn') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Modal: Replace Tenant -->
    <Teleport to="body">
      <div
        v-if="replaceModalState"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
      >
        <div class="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xl space-y-4">
          <div class="flex items-center justify-between gap-2">
            <h3 class="font-headline-md text-lg font-bold text-on-surface">
              {{ session.t('profile.residents.replaceModalTitle') }}
            </h3>
          </div>
          <p class="text-xs text-on-surface-variant leading-relaxed">
            {{
              session.t('profile.residents.replaceModalDesc', {
                label: replaceModalState.resident.display_label,
              })
            }}
          </p>

          <div class="space-y-1.5">
            <label for="tenant-replace-contact" class="block font-label-md text-xs font-semibold text-on-surface">
              {{ session.t('auth.login.emailLabel') }}
            </label>
            <input
              id="tenant-replace-contact"
              v-model="replaceInput"
              type="email"
              autocomplete="off"
              :placeholder="session.t('profile.residents.contactPlaceholder')"
              class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-outline-variant/60 text-sm text-on-surface focus:outline-none focus:border-primary"
              @keyup.enter="submitReplaceTenant"
            />
            <p v-if="replaceModalError" class="text-xs text-error">
              {{ replaceModalError }}
            </p>
          </div>

          <div class="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              :disabled="replaceBusy"
              class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="replaceModalState = null"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="replaceBusy"
              class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="submitReplaceTenant"
            >
              {{ session.t('profile.residents.replaceBtn') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Modal: Remove Tenant Confirmation -->
    <Teleport to="body">
      <div
        v-if="removeModalState"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
      >
        <div class="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xl space-y-4">
          <h3 class="font-headline-md text-lg font-bold text-on-surface">
            {{ session.t('profile.residents.removeModalTitle') }}
          </h3>
          <p class="text-sm text-on-surface-variant leading-relaxed">
            {{
              session.t('profile.residents.removeModalDesc', {
                label: removeModalState.resident.display_label,
              })
            }}
          </p>
          <div class="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              :disabled="removeBusy"
              class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="removeModalState = null"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="removeBusy"
              class="px-4 py-2 rounded-lg bg-error text-on-error text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="confirmRemoveTenant"
            >
              {{ session.t('profile.residents.removeBtn') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
