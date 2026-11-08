<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'

const router = useRouter()
const route = useRoute()
const session = useSessionStore()
const { buildingRole, isChairman } = useRole()

const menuOpen = ref(false)
const rootRef = ref(null)

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
      class="absolute right-0 mt-1.5 w-56 rounded-xl bg-surface-container-lowest shadow-lg border border-surface-container py-1.5 z-50"
    >
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
        v-if="isChairman"
        type="button"
        class="w-full px-3.5 py-2 text-left text-xs text-on-surface hover:bg-surface-container-low flex items-center justify-between gap-2 transition-colors cursor-pointer"
        @click="navigateTo('people')"
      >
        <span class="flex items-center gap-2.5">
          <span class="material-symbols-outlined text-[17px] text-on-surface-variant" aria-hidden="true">
            group
          </span>
          <span>{{ session.t('nav.people') }}</span>
        </span>
        <span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-[9px] font-bold uppercase">
          DEMO
        </span>
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
