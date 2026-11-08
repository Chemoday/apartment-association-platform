<script setup>
import { computed, onMounted } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { startUnreadPolling } from '@/composables/useUnreadCount.js'
import AppHeader from './components/AppHeader.vue'
import AppEmergencyBanner from './components/AppEmergencyBanner.vue'
import AppSidebar from './components/AppSidebar.vue'
import AppBottomNav from './components/AppBottomNav.vue'
import AppFooter from './components/AppFooter.vue'

const route = useRoute()
const session = useSessionStore()

const hasRoleAccess = computed(() => {
  const role = session.me?.building_role || 'USER'
  if (route.meta?.requiresApartmentOrBoard) {
    const isBoardOrChairman = ['CHAIRMAN', 'BOARD'].includes(role)
    const hasApartments = (session.memberships?.length || 0) > 0
    if (!isBoardOrChairman && !hasApartments) return false
  }
  const allowedRoles = route.meta?.roles
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) return true
  return allowedRoles.includes(role)
})

onMounted(() => {
  startUnreadPolling(session)
})
</script>

<template>
  <div class="min-h-screen flex flex-col bg-background text-on-surface">
    <AppHeader />
    <AppEmergencyBanner />
    <AppSidebar />
    <main id="main" class="flex-1 w-full">
      <slot v-if="hasRoleAccess" />
      <div
        v-else
        class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-space-xl"
      >
        <div
          class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-lg text-center max-w-lg mx-auto space-y-4 shadow-xs"
          role="alert"
        >
          <div class="w-12 h-12 rounded-full bg-error-container text-on-error-container flex items-center justify-center mx-auto">
            <span class="material-symbols-outlined text-[24px]">lock</span>
          </div>
          <h1 class="font-title-lg text-title-lg font-bold text-on-surface">
            {{ session.t('common.noAccessTitle') }}
          </h1>
          <p class="font-body-md text-body-md text-on-surface-variant">
            {{ session.t('errors.FORBIDDEN') }}
          </p>
          <div>
            <RouterLink
              to="/"
              class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors"
            >
              <span class="material-symbols-outlined text-[16px]">arrow_back</span>
              <span>{{ session.t('nav.dashboard') }}</span>
            </RouterLink>
          </div>
        </div>
      </div>
    </main>
    <AppBottomNav />
    <AppFooter />
  </div>
</template>

