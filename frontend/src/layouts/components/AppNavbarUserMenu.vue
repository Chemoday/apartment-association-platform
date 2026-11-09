<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'

const router = useRouter()
const route = useRoute()
const session = useSessionStore()
const { buildingRole } = useRole()

const menuOpen = ref(false)
const savingPrivacy = ref(false)
const rootRef = ref(null)

const membership = computed(() => session.activeMembership)
const privacyModes = ['APARTMENT_ONLY', 'INITIALS', 'FULL_NAME']

const apartmentLabel = computed(() => {
  if (session.activeMembership?.apartment_number) {
    return `Apt ${session.activeMembership.apartment_number}`
  }
  return session.activeMembership?.preview_badge?.display_label || buildingRole.value
})

const roleChipLabel = computed(() => {
  if (session.activeMembership?.preview_badge?.role_badge) {
    return session.activeMembership.preview_badge.role_badge
  }
  return buildingRole.value
})

async function selectPrivacyMode(mode) {
  if (!membership.value || savingPrivacy.value) return
  savingPrivacy.value = true
  try {
    await session.changePrivacyMode(membership.value.membership_id, mode)
  } finally {
    savingPrivacy.value = false
  }
}

function navigateTo(routeName) {
  menuOpen.value = false
  router.push({ name: routeName })
}

async function handleSignOut() {
  menuOpen.value = false
  await session.signOut()
  router.push({ name: 'welcome' })
}

function handleDocumentClick(e) {
  if (menuOpen.value && rootRef.value && !rootRef.value.contains(e.target)) {
    menuOpen.value = false
  }
}

watch(
  () => route.fullPath,
  () => {
    menuOpen.value = false
  },
)

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
})
</script>

<template>
  <div ref="rootRef" class="relative shrink-0">
    <button
      type="button"
      :aria-expanded="menuOpen"
      class="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface font-label-md text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      @click="menuOpen = !menuOpen"
    >
      <span class="px-1.5 py-0.5 rounded bg-primary text-on-primary text-[10px] font-bold tracking-wider uppercase">
        {{ roleChipLabel }}
      </span>
      <span class="max-w-[110px] sm:max-w-[140px] truncate">
        {{ apartmentLabel }}
      </span>
      <span class="material-symbols-outlined text-[16px] text-on-surface-variant shrink-0">
        expand_more
      </span>
    </button>

    <div
      v-if="menuOpen"
      class="absolute right-0 mt-1.5 w-64 rounded-xl bg-surface-container-lowest shadow-lg border border-surface-container py-1.5 z-50"
    >
      <!-- Mobile & Tablet (< lg) Active Apartment & Privacy Switcher (since AppNavbarPrivacySelector is hidden < lg) -->
      <div
        v-if="membership"
        class="lg:hidden px-3.5 py-2.5 mb-1 border-b border-surface-container bg-surface-container-low/50 space-y-2"
      >
        <div v-if="session.memberships.length > 1">
          <span class="block text-[10px] uppercase tracking-wider font-bold text-on-surface-variant mb-1">
            {{ session.t('header.activeApartment') }}
          </span>
          <div class="flex flex-wrap gap-1">
            <button
              v-for="m in session.memberships"
              :key="m.membership_id"
              type="button"
              class="px-2 py-1 rounded text-xs font-semibold transition-colors cursor-pointer"
              :class="
                m.apartment_id === membership.apartment_id
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
              "
              @click="session.selectApartment(m.apartment_id)"
            >
              {{ session.t('common.aptShort', { number: m.apartment_number }) }}
            </button>
          </div>
        </div>

        <div>
          <span class="block text-[10px] uppercase tracking-wider font-bold text-on-surface-variant mb-1">
            {{ session.t('header.neighborDisplayBadge') }}
          </span>
          <div class="grid grid-cols-3 gap-1">
            <button
              v-for="mode in privacyModes"
              :key="mode"
              type="button"
              :disabled="savingPrivacy"
              class="px-1.5 py-1 rounded text-[10px] font-semibold truncate transition-colors cursor-pointer"
              :class="
                membership.privacy_display_mode === mode
                  ? 'bg-secondary-fixed text-on-secondary-fixed'
                  : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
              "
              @click="selectPrivacyMode(mode)"
            >
              {{ session.t(`privacy.${mode}`) }}
            </button>
          </div>
        </div>
      </div>

      <button
        type="button"
        class="w-full px-3.5 py-2 text-left text-xs text-on-surface hover:bg-surface-container-low flex items-center gap-2.5 transition-colors cursor-pointer"
        @click="navigateTo('settings-profile')"
      >
        <span class="material-symbols-outlined text-[17px] text-on-surface-variant" aria-hidden="true">
          person
        </span>
        <span>{{ session.t('auth.menu.profile') }}</span>
      </button>

      <button
        type="button"
        class="w-full px-3.5 py-2 text-left text-xs text-on-surface hover:bg-surface-container-low flex items-center gap-2.5 transition-colors cursor-pointer"
        @click="navigateTo('settings-notifications')"
      >
        <span class="material-symbols-outlined text-[17px] text-on-surface-variant" aria-hidden="true">
          tune
        </span>
        <span>{{ session.t('auth.menu.notificationSettings') }}</span>
      </button>

      <button
        type="button"
        class="w-full px-3.5 py-2 text-left text-xs text-on-surface hover:bg-surface-container-low flex items-center gap-2.5 transition-colors cursor-pointer"
        @click="navigateTo('settings-security')"
      >
        <span class="material-symbols-outlined text-[17px] text-on-surface-variant" aria-hidden="true">
          shield_lock
        </span>
        <span>{{ session.t('auth.menu.security') }}</span>
      </button>

      <template v-if="session.isSignedIn">
        <div class="my-1 border-t border-surface-container" />
        <button
          type="button"
          class="w-full px-3.5 py-2 text-left text-xs text-error hover:bg-error-container/30 flex items-center gap-2.5 font-semibold transition-colors cursor-pointer"
          @click="handleSignOut"
        >
          <span class="material-symbols-outlined text-[17px]" aria-hidden="true">logout</span>
          <span>{{ session.t('auth.menu.signOut') }}</span>
        </button>
      </template>
    </div>
  </div>
</template>
