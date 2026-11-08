<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import {
  closeAccount,
  endMembership,
  listPeople,
  setRole,
} from '@/api/endpoints/auth.js'
import {
  createInvitation,
  deleteInvitation,
  listInvitations,
  resendInvitation,
} from '@/api/endpoints/invitations.js'
import { localizeError } from '@/locales/index.js'
import { formatShortDate } from '@/utils/dates.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'

const router = useRouter()
const session = useSessionStore()

const activeTab = ref('people') // 'people' | 'invitations'
const searchQuery = ref('')
const bannerMessage = ref('')

const people = ref([])
const invitations = ref([])
const loading = ref(false)
const loadError = ref(null)
const quickDemoSigningIn = ref(false)

const filteredPeople = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return people.value
  return people.value.filter(
    (p) =>
      String(p.display_label || '')
        .toLowerCase()
        .includes(q) ||
      String(p.building_role || '')
        .toLowerCase()
        .includes(q) ||
      String(p.invited_email || '')
        .toLowerCase()
        .includes(q) ||
      (p.memberships || []).some(
        (m) =>
          String(m.apartment_number || '').includes(q) ||
          String(m.display_label || '')
            .toLowerCase()
            .includes(q) ||
          String(m.invited_email || '')
            .toLowerCase()
            .includes(q),
      ),
  )
})

const pendingInvitationsCount = computed(
  () => invitations.value.filter((i) => i.status === 'PENDING').length,
)

function showBanner(msg) {
  bannerMessage.value = msg
  setTimeout(() => {
    if (bannerMessage.value === msg) {
      bannerMessage.value = ''
    }
  }, 4500)
}

async function loadPeopleAndInvitations() {
  if (!session.isSignedIn) {
    people.value = []
    invitations.value = []
    return
  }
  loading.value = true
  loadError.value = null
  try {
    const [peopleRes, invRes] = await Promise.all([listPeople(), listInvitations()])
    people.value = Array.isArray(peopleRes?.people)
      ? peopleRes.people
      : Array.isArray(peopleRes)
        ? peopleRes
        : []
    invitations.value = Array.isArray(invRes) ? invRes : []
  } catch (err) {
    loadError.value = err
  } finally {
    loading.value = false
  }
}

async function handleQuickDemoSignInChairman() {
  if (quickDemoSigningIn.value) return
  quickDemoSigningIn.value = true
  try {
    await session.signInAsDemoRole('CHAIRMAN')
  } finally {
    quickDemoSigningIn.value = false
  }
}

onMounted(loadPeopleAndInvitations)

watch(
  () => [session.isSignedIn, session.sessionRevision],
  () => {
    loadPeopleAndInvitations()
  },
)

// Modal 1: Change Role (PUT /auth/users/{id}/role; 409 LAST_CHAIRMAN guard)
const roleModalPerson = ref(null)
const selectedNewRole = ref('USER')
const roleModalError = ref('')
const roleSaving = ref(false)

const buildingRoles = ['USER', 'BOARD', 'ACCOUNTANT', 'CHAIRMAN']

const roleClosesAccountWarning = computed(() => {
  if (!roleModalPerson.value) return false
  const membershipsCount = (roleModalPerson.value.memberships || []).length
  return membershipsCount === 0 && selectedNewRole.value === 'USER'
})

function openChangeRoleModal(person) {
  roleModalPerson.value = person
  selectedNewRole.value = person.building_role
  roleModalError.value = ''
}

async function submitChangeRole() {
  if (!roleModalPerson.value || roleSaving.value) return
  const target = roleModalPerson.value
  roleSaving.value = true
  roleModalError.value = ''
  try {
    const res = await setRole(target.user_id, {
      building_role: selectedNewRole.value,
    })
    roleModalPerson.value = null
    if (res?.account_closed) {
      people.value = people.value.filter((p) => p.user_id !== target.user_id)
      showBanner(
        session.t('people.banners.roleUpdatedAccountClosed', {
          label: target.display_label,
          role: session.t(`buildingRole.${selectedNewRole.value}`),
        }),
      )
    } else {
      target.building_role = res?.building_role || selectedNewRole.value
      showBanner(
        session.t('people.banners.roleUpdated', {
          label: target.display_label,
          role: session.t(`buildingRole.${target.building_role}`),
        }),
      )
      await loadPeopleAndInvitations()
    }
  } catch (err) {
    const code = err?.errorCode || err?.payload?.error_code
    if (err?.status === 404 || code === 'USER_NOT_FOUND') {
      roleModalPerson.value = null
      showBanner(session.t('people.alreadyChangedReloaded'))
      await loadPeopleAndInvitations()
    } else {
      roleModalError.value = localizeError(err)
    }
  } finally {
    roleSaving.value = false
  }
}

// Modal 2: End Membership (DELETE /auth/users/{id}/memberships/{membership_id})
const endMembershipModal = ref(null)
const endMembershipBusy = ref(false)

function openEndMembershipModal(person, membership) {
  endMembershipModal.value = { person, membership }
}

async function confirmEndMembership() {
  if (!endMembershipModal.value || endMembershipBusy.value) return
  const { person, membership } = endMembershipModal.value
  endMembershipBusy.value = true
  try {
    const res = await endMembership(person.user_id, membership.membership_id)
    endMembershipModal.value = null
    const wasLastMembershipForUser =
      res?.account_closed ||
      ((person.memberships || []).length === 1 && person.building_role === 'USER')
    if (wasLastMembershipForUser) {
      showBanner(
        session.t('people.banners.membershipEndedAccountClosed', {
          label: person.display_label,
        }),
      )
    } else {
      showBanner(
        session.t('people.banners.membershipEnded', {
          label: person.display_label,
          number: membership.apartment_number,
        }),
      )
    }
    await loadPeopleAndInvitations()
  } catch (err) {
    endMembershipModal.value = null
    const code = err?.errorCode || err?.payload?.error_code
    if (
      err?.status === 404 ||
      code === 'USER_NOT_FOUND' ||
      code === 'MEMBERSHIP_NOT_FOUND'
    ) {
      showBanner(session.t('people.alreadyChangedReloaded'))
    } else {
      showBanner(localizeError(err))
    }
    await loadPeopleAndInvitations()
  } finally {
    endMembershipBusy.value = false
  }
}

// Modal 3: Close Account (DELETE /auth/users/{id})
const closeAccountPerson = ref(null)
const closeAccountError = ref('')
const closeAccountBusy = ref(false)

function openCloseAccountModal(person) {
  closeAccountPerson.value = person
  closeAccountError.value = ''
}

async function confirmCloseAccount() {
  if (!closeAccountPerson.value || closeAccountBusy.value) return
  const target = closeAccountPerson.value
  closeAccountBusy.value = true
  closeAccountError.value = ''
  try {
    await closeAccount(target.user_id)
    closeAccountPerson.value = null
    showBanner(
      session.t('people.banners.accountClosed', {
        label: target.display_label,
      }),
    )
    await loadPeopleAndInvitations()
  } catch (err) {
    const code = err?.errorCode || err?.payload?.error_code
    if (err?.status === 404 || code === 'USER_NOT_FOUND') {
      closeAccountPerson.value = null
      showBanner(session.t('people.alreadyChangedReloaded'))
      await loadPeopleAndInvitations()
    } else {
      closeAccountError.value = localizeError(err)
    }
  } finally {
    closeAccountBusy.value = false
  }
}

// Modal 4: Invite Owner
const showInviteOwnerModal = ref(false)
const inviteOwnerForm = reactive({
  contact: '',
  apartmentNumber: '05',
})
const inviteOwnerError = ref('')
const inviteOwnerBusy = ref(false)

function openInviteOwner() {
  inviteOwnerForm.contact = ''
  inviteOwnerForm.apartmentNumber = '05'
  inviteOwnerError.value = ''
  showInviteOwnerModal.value = true
}

async function submitInviteOwner() {
  if (inviteOwnerBusy.value) return
  const trimmed = inviteOwnerForm.contact.trim()
  const apt = inviteOwnerForm.apartmentNumber.trim()
  if (!trimmed || !trimmed.includes('@')) {
    inviteOwnerError.value = session.t('profile.residents.invalidContact')
    return
  }
  if (!apt) {
    inviteOwnerError.value = session.t('people.modals.apartmentRequired')
    return
  }
  inviteOwnerBusy.value = true
  inviteOwnerError.value = ''
  try {
    await createInvitation({
      kind: 'OWNER',
      email: trimmed,
      apartment_number: apt.padStart(2, '0'),
    })
    showInviteOwnerModal.value = false
    activeTab.value = 'invitations'
    showBanner(session.t('people.banners.invitationSent'))
    await loadPeopleAndInvitations()
  } catch (err) {
    inviteOwnerError.value = localizeError(err)
  } finally {
    inviteOwnerBusy.value = false
  }
}

// Modal 5: Invite Staff
const showInviteStaffModal = ref(false)
const inviteStaffForm = reactive({
  contact: '',
  buildingRole: 'BOARD',
})
const inviteStaffError = ref('')
const inviteStaffBusy = ref(false)

function openInviteStaff() {
  inviteStaffForm.contact = ''
  inviteStaffForm.buildingRole = 'BOARD'
  inviteStaffError.value = ''
  showInviteStaffModal.value = true
}

async function submitInviteStaff() {
  if (inviteStaffBusy.value) return
  const trimmed = inviteStaffForm.contact.trim()
  if (!trimmed || !trimmed.includes('@')) {
    inviteStaffError.value = session.t('profile.residents.invalidContact')
    return
  }
  inviteStaffBusy.value = true
  inviteStaffError.value = ''
  try {
    await createInvitation({
      kind: 'STAFF',
      email: trimmed,
      building_role: inviteStaffForm.buildingRole,
    })
    showInviteStaffModal.value = false
    activeTab.value = 'invitations'
    showBanner(session.t('people.banners.invitationSent'))
    await loadPeopleAndInvitations()
  } catch (err) {
    inviteStaffError.value = localizeError(err)
  } finally {
    inviteStaffBusy.value = false
  }
}

async function handleResendInvitation(inv) {
  try {
    await resendInvitation(inv.invitation_id)
    showBanner(session.t('people.banners.invitationResent'))
    await loadPeopleAndInvitations()
  } catch (err) {
    const code = err?.errorCode || err?.payload?.error_code
    if (err?.status === 404 || code === 'INVITATION_NOT_FOUND') {
      showBanner(session.t('people.alreadyChangedReloaded'))
    } else {
      showBanner(localizeError(err))
    }
    await loadPeopleAndInvitations()
  }
}

async function handleCancelInvitation(invId) {
  try {
    await deleteInvitation(invId)
    showBanner(session.t('people.banners.invitationCancelled'))
    await loadPeopleAndInvitations()
  } catch (err) {
    const code = err?.errorCode || err?.payload?.error_code
    if (err?.status === 404 || code === 'INVITATION_NOT_FOUND') {
      showBanner(session.t('people.alreadyChangedReloaded'))
    } else {
      showBanner(localizeError(err))
    }
    await loadPeopleAndInvitations()
  }
}

function openInvitationPreviewLink(inv) {
  if (inv.kind === 'STAFF') {
    const role = inv.building_role || 'BOARD'
    router.push({ name: 'login-link', hash: `#demo-register-staff-${role}` })
    return
  }
  const kind = inv.kind === 'TENANT' ? 'tenant' : 'owner'
  const apt = inv.apartment_number || '14'
  router.push({ name: 'login-link', hash: `#demo-register-${kind}-${apt}` })
}
</script>

<template>
  <div class="w-full max-w-[1120px] mx-auto px-gutter py-space-lg space-y-6">
    <!-- Page Header -->
    <div class="flex flex-col md:flex-row md:items-end justify-between gap-4">
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <span class="font-label-md text-xs uppercase tracking-wider text-secondary font-semibold">
            {{ session.t('people.kicker') }}
          </span>
        </div>
        <h1 class="font-headline-xl text-2xl sm:text-3xl font-bold text-on-surface tracking-tight">
          {{ session.t('people.title') }}
        </h1>
        <p class="text-sm text-on-surface-variant">
          {{ session.t('people.subtitle') }}
        </p>
      </div>

      <!-- Action Buttons: Invite Owner & Invite Staff -->
      <div v-if="session.isSignedIn" class="flex flex-wrap items-center gap-2.5 shrink-0">
        <button
          type="button"
          class="px-4 py-2.5 rounded-lg bg-primary text-on-primary font-label-lg text-xs font-semibold hover:opacity-95 transition-opacity inline-flex items-center gap-1.5 cursor-pointer"
          @click="openInviteOwner"
        >
          <span class="material-symbols-outlined text-[17px]" aria-hidden="true">person_add</span>
          <span>{{ session.t('people.actions.inviteOwner') }}</span>
        </button>
        <button
          type="button"
          class="px-4 py-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-label-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 cursor-pointer"
          @click="openInviteStaff"
        >
          <span class="material-symbols-outlined text-[17px]" aria-hidden="true">badge</span>
          <span>{{ session.t('people.actions.inviteStaff') }}</span>
        </button>
      </div>
    </div>

    <!-- Sign-in Required Placeholder when browsing in Demo Mode without Bearer token -->
    <div
      v-if="!session.isSignedIn"
      class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 sm:p-8 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4"
    >
      <div class="space-y-1">
        <h2 class="font-headline-md text-lg font-bold text-on-surface">
          {{ session.t('people.signInPlaceholderTitle') }}
        </h2>
        <p class="text-sm text-on-surface-variant">
          {{ session.t('people.signInPlaceholderDesc') }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2.5 shrink-0">
        <button
          type="button"
          :disabled="quickDemoSigningIn"
          class="px-4 py-2.5 rounded-lg bg-secondary-container text-on-secondary-container font-label-md text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
          @click="handleQuickDemoSignInChairman"
        >
          {{
            session.t('auth.demoQuickSignIn.btn', {
              role: session.t('buildingRole.CHAIRMAN'),
            })
          }}
        </button>
        <button
          type="button"
          class="px-5 py-2.5 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
          @click="router.push({ name: 'login' })"
        >
          {{ session.t('auth.signInLink') }}
        </button>
      </div>
    </div>

    <template v-else>
      <ErrorCard v-if="loadError" :error="loadError" @retry="loadPeopleAndInvitations" />

      <!-- Feedback Banner -->
      <div
        v-if="bannerMessage"
        class="rounded-xl bg-secondary-container/70 text-on-secondary-container px-4 py-3 text-xs font-semibold flex items-center justify-between gap-3"
      >
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-[18px]" aria-hidden="true">check_circle</span>
          <span>{{ bannerMessage }}</span>
        </div>
        <button
          type="button"
          class="text-xs underline cursor-pointer"
          @click="bannerMessage = ''"
        >
          {{ session.t('common.dismiss') }}
        </button>
      </div>

      <!-- Tabs: People & Invitations -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-surface-container pb-3">
        <div class="flex items-center gap-2">
          <button
            type="button"
            class="px-4 py-2 rounded-lg font-label-lg text-xs font-bold transition-colors inline-flex items-center gap-2 cursor-pointer"
            :class="
              activeTab === 'people'
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-low text-on-surface-variant hover:text-on-surface'
            "
            @click="activeTab = 'people'"
          >
            <span class="material-symbols-outlined text-[16px]" aria-hidden="true">group</span>
            <span>{{ session.t('people.tabs.people') }} ({{ people.length }})</span>
          </button>

          <button
            type="button"
            class="px-4 py-2 rounded-lg font-label-lg text-xs font-bold transition-colors inline-flex items-center gap-2 cursor-pointer"
            :class="
              activeTab === 'invitations'
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container-low text-on-surface-variant hover:text-on-surface'
            "
            @click="activeTab = 'invitations'"
          >
            <span class="material-symbols-outlined text-[16px]" aria-hidden="true">mail</span>
            <span>{{ session.t('people.tabs.invitations') }} ({{ invitations.length }})</span>
            <span
              v-if="pendingInvitationsCount > 0"
              class="px-1.5 py-0.5 rounded-full text-[10px] font-bold"
              :class="
                activeTab === 'invitations'
                  ? 'bg-on-primary text-primary'
                  : 'bg-secondary-container text-on-secondary-container'
              "
            >
              {{ pendingInvitationsCount }}
            </span>
          </button>
        </div>

        <!-- Search Filter on People Tab -->
        <div v-if="activeTab === 'people'" class="relative w-full sm:w-64">
          <span class="material-symbols-outlined text-[17px] text-on-surface-variant absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true">
            search
          </span>
          <input
            v-model="searchQuery"
            type="search"
            :placeholder="session.t('people.searchPlaceholder')"
            class="w-full pl-9 pr-3 py-1.5 rounded-lg bg-surface-container-lowest border border-surface-container text-xs text-on-surface focus:outline-none focus:border-primary"
          />
        </div>
      </div>

      <!-- TAB 1: PEOPLE -->
      <section
        v-if="activeTab === 'people'"
        class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs divide-y divide-surface-container"
      >
        <div
          v-if="!loading && filteredPeople.length === 0"
          class="p-6 text-center text-xs text-on-surface-variant"
        >
          {{ session.t('people.emptyPeople') }}
        </div>

        <div
          v-for="person in filteredPeople"
          :key="person.user_id"
          class="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
        >
          <div class="flex items-start gap-3.5 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center text-primary shrink-0">
              <span class="material-symbols-outlined text-[20px]" aria-hidden="true">
                {{ person.building_role === 'CHAIRMAN' ? 'shield_person' : 'person' }}
              </span>
            </div>

            <div class="space-y-1.5 min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-headline-md text-sm font-bold text-on-surface">
                  {{ person.display_label }}
                </span>
                <span
                  v-if="person.is_me"
                  class="px-2 py-0.5 rounded bg-secondary-container text-on-secondary-container text-[10px] font-bold uppercase tracking-wider"
                >
                  {{ session.t('people.youBadge') }}
                </span>
                <span
                  class="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider"
                  :class="
                    person.building_role === 'CHAIRMAN'
                      ? 'bg-primary text-on-primary'
                      : person.building_role === 'BOARD' || person.building_role === 'ACCOUNTANT'
                        ? 'bg-secondary-container text-on-secondary-container'
                        : 'bg-surface-container-high text-on-surface'
                  "
                >
                  {{ session.t(`buildingRole.${person.building_role}`) }}
                </span>
                <span
                  v-if="person.invited_email"
                  class="font-mono text-xs text-on-surface-variant"
                >
                  · {{ person.invited_email }}
                </span>
              </div>

              <!-- Apartment Memberships for this Person -->
              <div v-if="(person.memberships || []).length > 0" class="flex flex-wrap items-center gap-2">
                <div
                  v-for="mem in person.memberships"
                  :key="mem.membership_id"
                  class="inline-flex flex-wrap items-center gap-1.5 px-2.5 py-1 rounded-lg bg-surface-container-low border border-surface-container text-xs"
                >
                  <span class="font-semibold text-on-surface">
                    {{ session.t('common.aptShort', { number: mem.apartment_number }) }}
                  </span>
                  <span class="text-[10px] font-bold uppercase text-secondary">
                    {{ mem.relation_type }}
                  </span>
                  <span
                    v-if="mem.display_label && mem.display_label !== person.display_label"
                    class="text-on-surface text-[11px] font-medium"
                  >
                    · {{ mem.display_label }}
                  </span>
                  <span
                    v-if="mem.invited_email"
                    class="font-mono text-on-surface-variant text-[11px]"
                  >
                    · {{ mem.invited_email }}
                  </span>
                  <span class="text-on-surface-variant text-[11px]">
                    ·
                    {{
                      session.t('profile.residents.sinceDate', {
                        date: formatShortDate(mem.since, session.lang),
                      })
                    }}
                  </span>
                  <button
                    type="button"
                    class="ml-1 text-[11px] font-semibold text-error hover:underline cursor-pointer"
                    @click="openEndMembershipModal(person, mem)"
                  >
                    {{ session.t('people.actions.endMembership') }}
                  </button>
                </div>
              </div>
              <p v-else class="text-xs text-on-surface-variant">
                {{ session.t('people.noApartmentAssigned') }}
              </p>
            </div>
          </div>

          <!-- Per-Person Actions -->
          <div class="flex flex-wrap items-center gap-2 self-start lg:self-center shrink-0">
            <button
              v-if="(person.memberships || []).length > 0 || person.building_role !== 'USER'"
              type="button"
              class="px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="openChangeRoleModal(person)"
            >
              {{ session.t('people.actions.changeRole') }}
            </button>
            <button
              type="button"
              class="px-3 py-1.5 rounded-lg text-error hover:bg-error-container/30 text-xs font-semibold transition-colors cursor-pointer"
              @click="openCloseAccountModal(person)"
            >
              {{ session.t('people.actions.closeAccount') }}
            </button>
          </div>
        </div>
      </section>

      <!-- TAB 2: INVITATIONS -->
      <section
        v-else
        class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs divide-y divide-surface-container"
      >
        <div
          v-if="!loading && invitations.length === 0"
          class="p-6 text-center text-xs text-on-surface-variant"
        >
          {{ session.t('people.emptyInvitations') }}
        </div>

        <div
          v-for="inv in invitations"
          :key="inv.invitation_id"
          class="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
        >
          <div class="flex items-start gap-3.5 min-w-0">
            <div class="w-10 h-10 rounded-xl bg-surface-container flex items-center justify-center text-on-surface-variant shrink-0">
              <span class="material-symbols-outlined text-[20px]" aria-hidden="true">
                mail
              </span>
            </div>

            <div class="space-y-1 min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-mono text-sm font-bold text-on-surface">
                  {{ inv.email }}
                </span>

                <!-- Kind Chip (OWNER, TENANT, STAFF) -->
                <span class="px-2 py-0.5 rounded bg-surface-container-high text-on-surface text-[10px] font-bold uppercase">
                  {{ inv.kind }}
                  <template v-if="inv.apartment_number">
                    · {{ session.t('common.aptShort', { number: inv.apartment_number }) }}
                  </template>
                  <template v-else-if="inv.building_role">
                    · {{ inv.building_role }}
                  </template>
                </span>

                <!-- Status Chip (PENDING, ACCEPTED, EXPIRED, NO_LONGER_VALID) -->
                <span
                  class="px-2 py-0.5 rounded text-[11px] font-semibold"
                  :class="
                    inv.status === 'PENDING'
                      ? 'bg-amber-100 text-amber-900'
                      : inv.status === 'ACCEPTED'
                        ? 'bg-secondary-container text-on-secondary-container'
                        : 'bg-surface-container text-on-surface-variant'
                  "
                >
                  {{ session.t(`people.invitationStatuses.${inv.status}`) }}
                </span>
              </div>

              <p class="text-xs text-on-surface-variant">
                {{
                  session.t('people.invitedOn', {
                    date: formatShortDate(inv.created_at, session.lang),
                  })
                }}
                <template v-if="inv.status === 'NO_LONGER_VALID'">
                  <span aria-hidden="true"> · </span>
                  <span class="text-error font-medium">
                    {{ session.t('people.noLongerValidHint') }}
                  </span>
                </template>
              </p>
            </div>
          </div>

          <!-- Invitation Actions -->
          <div class="flex flex-wrap items-center gap-2 self-start lg:self-center shrink-0">
            <button
              v-if="inv.status === 'PENDING'"
              type="button"
              class="px-3 py-1.5 rounded-lg bg-secondary-container/70 hover:bg-secondary-container text-on-secondary-container text-xs font-semibold transition-colors inline-flex items-center gap-1 cursor-pointer"
              @click="openInvitationPreviewLink(inv)"
            >
              <span class="material-symbols-outlined text-[15px]" aria-hidden="true">open_in_new</span>
              <span>{{ session.t('people.actions.previewLinkDemo') }}</span>
            </button>

            <button
              v-if="inv.status === 'PENDING' || inv.status === 'EXPIRED'"
              type="button"
              class="px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="handleResendInvitation(inv)"
            >
              {{ session.t('profile.residents.resendBtn') }}
            </button>

            <button
              v-if="
                inv.status === 'PENDING' ||
                inv.status === 'EXPIRED' ||
                inv.status === 'NO_LONGER_VALID'
              "
              type="button"
              class="px-3 py-1.5 rounded-lg text-error hover:bg-error-container/30 text-xs font-semibold transition-colors cursor-pointer"
              @click="handleCancelInvitation(inv.invitation_id)"
            >
              {{ session.t('people.actions.deleteInvitation') }}
            </button>
          </div>
        </div>
      </section>
    </template>

    <!-- MODAL 1: Change Role -->
    <Teleport to="body">
      <div
        v-if="roleModalPerson"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
      >
        <div class="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xl space-y-4">
          <div class="flex items-center justify-between gap-2">
            <h3 class="font-headline-md text-lg font-bold text-on-surface">
              {{ session.t('people.modals.changeRoleTitle', { label: roleModalPerson.display_label }) }}
            </h3>
          </div>

          <div class="space-y-2">
            <button
              v-for="r in buildingRoles"
              :key="r"
              type="button"
              class="w-full p-3 rounded-lg border text-left flex items-center justify-between transition-colors cursor-pointer"
              :class="
                selectedNewRole === r
                  ? 'border-primary bg-primary-fixed/20 font-semibold'
                  : 'border-surface-container bg-surface-container-low hover:bg-surface-container'
              "
              @click="
                selectedNewRole = r;
                roleModalError = '';
              "
            >
              <span class="text-xs text-on-surface">{{ session.t(`buildingRole.${r}`) }}</span>
              <span
                class="material-symbols-outlined text-[18px]"
                :class="selectedNewRole === r ? 'text-primary' : 'text-on-surface-variant'"
                aria-hidden="true"
              >
                {{ selectedNewRole === r ? 'radio_button_checked' : 'radio_button_unchecked' }}
              </span>
            </button>
          </div>

          <!-- Hint when stepping down from own CHAIRMAN role -->
          <div
            v-if="
              roleModalPerson.is_me &&
              roleModalPerson.building_role === 'CHAIRMAN' &&
              selectedNewRole !== 'CHAIRMAN'
            "
            class="rounded-lg bg-secondary-container/40 border border-secondary/30 p-3 text-xs text-on-surface leading-relaxed"
          >
            {{ session.t('people.modals.selfChairmanHandoverHint') }}
          </div>

          <!-- Warning when changing a membership-less person to USER closes their account -->
          <div
            v-if="roleClosesAccountWarning"
            class="rounded-lg bg-error-container/30 border border-error/40 p-3 text-xs text-on-surface leading-relaxed"
          >
            {{ session.t('people.modals.roleUserClosesAccountWarning') }}
          </div>

          <p v-if="roleModalError" class="text-xs font-medium text-error">
            {{ roleModalError }}
          </p>

          <div class="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              :disabled="roleSaving"
              class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="roleModalPerson = null"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="roleSaving"
              class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="submitChangeRole"
            >
              {{ session.t('common.save') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- MODAL 2: End Membership -->
    <Teleport to="body">
      <div
        v-if="endMembershipModal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
      >
        <div class="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xl space-y-4">
          <h3 class="font-headline-md text-lg font-bold text-on-surface">
            {{
              session.t('people.modals.endMembershipTitle', {
                number: endMembershipModal.membership.apartment_number,
              })
            }}
          </h3>
          <p class="text-sm text-on-surface-variant leading-relaxed">
            {{
              session.t('people.modals.endMembershipDesc', {
                label: endMembershipModal.person.display_label,
                number: endMembershipModal.membership.apartment_number,
              })
            }}
          </p>
          <div class="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              :disabled="endMembershipBusy"
              class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="endMembershipModal = null"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="endMembershipBusy"
              class="px-4 py-2 rounded-lg bg-error text-on-error text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="confirmEndMembership"
            >
              {{ session.t('people.actions.endMembership') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- MODAL 3: Close Account (Destructive Modal with Effects from Appendix A.9) -->
    <Teleport to="body">
      <div
        v-if="closeAccountPerson"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
      >
        <div class="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xl space-y-4">
          <h3 class="font-headline-md text-lg font-bold text-on-surface">
            {{ session.t('people.modals.closeAccountTitle', { label: closeAccountPerson.display_label }) }}
          </h3>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('people.modals.closeAccountIntro') }}
          </p>

          <ul class="space-y-2 rounded-lg bg-error-container/25 p-3.5 text-xs text-on-surface">
            <li class="flex items-center gap-2">
              <span class="material-symbols-outlined text-[16px] text-error" aria-hidden="true">logout</span>
              <span>{{ session.t('people.modals.effectSignedOut') }}</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="material-symbols-outlined text-[16px] text-error" aria-hidden="true">person_remove</span>
              <span>{{ session.t('people.modals.effectDataRemoved') }}</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="material-symbols-outlined text-[16px] text-secondary" aria-hidden="true">history</span>
              <span>{{ session.t('people.modals.effectMeterHistoryKept') }}</span>
            </li>
            <li class="flex items-center gap-2">
              <span class="material-symbols-outlined text-[16px] text-secondary" aria-hidden="true">forum</span>
              <span>{{ session.t('people.modals.effectForumBadgeKept') }}</span>
            </li>
          </ul>

          <p v-if="closeAccountError" class="text-xs font-medium text-error">
            {{ closeAccountError }}
          </p>

          <div class="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              :disabled="closeAccountBusy"
              class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="closeAccountPerson = null"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="closeAccountBusy"
              class="px-4 py-2 rounded-lg bg-error text-on-error text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="confirmCloseAccount"
            >
              {{ session.t('people.actions.closeAccount') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- MODAL 4: Invite Owner -->
    <Teleport to="body">
      <div
        v-if="showInviteOwnerModal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
      >
        <div class="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xl space-y-4">
          <div class="flex items-center justify-between gap-2">
            <h3 class="font-headline-md text-lg font-bold text-on-surface">
              {{ session.t('people.actions.inviteOwner') }}
            </h3>
          </div>

          <div class="space-y-3">
            <div class="space-y-1.5">
              <label for="invite-owner-contact" class="block font-label-md text-xs font-semibold text-on-surface">
                {{ session.t('auth.login.emailLabel') }}
              </label>
              <input
                id="invite-owner-contact"
                v-model="inviteOwnerForm.contact"
                type="email"
                autocomplete="off"
                :placeholder="session.t('auth.login.emailPlaceholder')"
                class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-outline-variant/50 text-sm text-on-surface focus:outline-none focus:border-primary"
              />
            </div>

            <div class="space-y-1.5">
              <label for="invite-owner-apt" class="block font-label-md text-xs font-semibold text-on-surface">
                {{ session.t('people.modals.apartmentNumberLabel') }}
              </label>
              <input
                id="invite-owner-apt"
                v-model="inviteOwnerForm.apartmentNumber"
                type="text"
                maxlength="5"
                placeholder="14"
                class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-outline-variant/50 text-sm text-on-surface focus:outline-none focus:border-primary"
              />
            </div>

            <div class="rounded-lg bg-surface-container-low border border-surface-container p-3 text-xs text-on-surface-variant leading-relaxed">
              {{ session.t('people.modals.ownerTenantPromotionHint') }}
            </div>

            <p v-if="inviteOwnerError" class="text-xs font-medium text-error">
              {{ inviteOwnerError }}
            </p>
          </div>

          <div class="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              :disabled="inviteOwnerBusy"
              class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="showInviteOwnerModal = false"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="inviteOwnerBusy"
              class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="submitInviteOwner"
            >
              {{ session.t('profile.residents.sendInviteBtn') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- MODAL 5: Invite Staff -->
    <Teleport to="body">
      <div
        v-if="showInviteStaffModal"
        class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
        role="dialog"
        aria-modal="true"
      >
        <div class="w-full max-w-md rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xl space-y-4">
          <div class="flex items-center justify-between gap-2">
            <h3 class="font-headline-md text-lg font-bold text-on-surface">
              {{ session.t('people.actions.inviteStaff') }}
            </h3>
          </div>

          <div class="space-y-3">
            <div class="space-y-1.5">
              <label for="invite-staff-contact" class="block font-label-md text-xs font-semibold text-on-surface">
                {{ session.t('auth.login.emailLabel') }}
              </label>
              <input
                id="invite-staff-contact"
                v-model="inviteStaffForm.contact"
                type="email"
                autocomplete="off"
                :placeholder="session.t('auth.login.emailPlaceholder')"
                class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-outline-variant/50 text-sm text-on-surface focus:outline-none focus:border-primary"
              />
            </div>

            <div class="space-y-1.5">
              <label for="invite-staff-role" class="block font-label-md text-xs font-semibold text-on-surface">
                {{ session.t('profile.identity.buildingRoleLabel') }}
              </label>
              <select
                id="invite-staff-role"
                v-model="inviteStaffForm.buildingRole"
                class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-outline-variant/50 text-sm text-on-surface focus:outline-none focus:border-primary"
              >
                <option value="BOARD">{{ session.t('buildingRole.BOARD') }}</option>
                <option value="ACCOUNTANT">{{ session.t('buildingRole.ACCOUNTANT') }}</option>
                <option value="CHAIRMAN">{{ session.t('buildingRole.CHAIRMAN') }}</option>
              </select>
            </div>

            <!-- Two-chairmen handover notice when inviting a CHAIRMAN -->
            <div
              v-if="inviteStaffForm.buildingRole === 'CHAIRMAN'"
              class="rounded-lg bg-secondary-container/40 border border-secondary/30 p-3 text-xs text-on-surface leading-relaxed"
            >
              {{ session.t('people.modals.chairmanHandoverNotice') }}
            </div>

            <p v-if="inviteStaffError" class="text-xs font-medium text-error">
              {{ inviteStaffError }}
            </p>
          </div>

          <div class="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              :disabled="inviteStaffBusy"
              class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold transition-colors cursor-pointer"
              @click="showInviteStaffModal = false"
            >
              {{ session.t('common.cancel') }}
            </button>
            <button
              type="button"
              :disabled="inviteStaffBusy"
              class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:opacity-95 transition-opacity disabled:opacity-50 cursor-pointer"
              @click="submitInviteStaff"
            >
              {{ session.t('profile.residents.sendInviteBtn') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
