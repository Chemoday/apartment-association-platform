<script setup>
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { localizeError } from '@/locales/index.js'
import { formatShortDate } from '@/utils/dates.js'
import {
  formatBadgeObjectToken,
  formatObjectLocation,
  objectName,
  objectShortName,
} from '@/utils/objectName.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'
import SettingsShellTabs from './components/SettingsShellTabs.vue'
import ProfileResidentsCard from './components/ProfileResidentsCard.vue'

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

function objectBadgeText(membership) {
  if (!membership) return ''
  if ((membership.apartment_kind || 'APARTMENT') === 'APARTMENT') {
    return membership.apartment_number
  }
  return formatBadgeObjectToken(membership.apartment_kind, membership.apartment_number)
}

function getSimulatedBadgePreview(membership, mode) {
  if (!membership) return ''
  const token = formatBadgeObjectToken(
    membership.apartment_kind,
    membership.apartment_number,
    'Apt.',
  )
  if (membership.privacy_display_mode === mode) {
    return membership.preview_badge?.display_label || token
  }
  if (mode === 'APARTMENT_ONLY') {
    return token
  }
  if (mode === 'INITIALS') {
    return `I. P. (${token})`
  }
  return `Resident (${token})`
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
            {{ activeMembership ? objectBadgeText(activeMembership) : buildingRole.slice(0, 2) }}
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
                {{ objectBadgeText(m) }}
              </div>
              <div>
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="font-headline-md text-base font-bold text-on-surface">
                    {{ objectName(m.apartment_kind, m.apartment_number, session.t) }}
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
                <p
                  v-if="formatObjectLocation(m, session.t) || m.since"
                  class="text-xs text-on-surface-variant"
                >
                  <template v-if="formatObjectLocation(m, session.t)">
                    {{ formatObjectLocation(m, session.t) }}
                  </template>
                  <template v-if="formatObjectLocation(m, session.t) && m.since">
                    <span aria-hidden="true"> · </span>
                  </template>
                  <template v-if="m.since">
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
                <span>
                  {{
                    session.t('dashboard.manageObjectMeters', {
                      object: objectShortName(m.apartment_kind, m.apartment_number, session.t),
                    })
                  }}
                </span>
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
    <ProfileResidentsCard :owned-memberships="ownedMemberships" />
  </div>
</template>
