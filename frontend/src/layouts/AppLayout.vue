<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { localeMessagesRevision } from '@/locales/index.js'
import { canAccessRoute } from '@/router/access.js'
import { applyRouteA11yMetadata, routeAnnouncement } from '@/router/title.js'
import { startUnreadPolling, stopUnreadPolling } from '@/composables/useUnreadCount.js'
import { startChatStatePolling, stopChatStatePolling } from '@/composables/useChatState.js'
import AppHeader from './components/AppHeader.vue'
import AppEmergencyBanner from './components/AppEmergencyBanner.vue'
import AppSidebar from './components/AppSidebar.vue'
import AppBottomNav from './components/AppBottomNav.vue'
import AppFooter from './components/AppFooter.vue'
import NetworkStatusBanner from '@/components/domain/NetworkStatusBanner.vue'
import AppIcon from '@/components/base/AppIcon.vue'

const SIDEBAR_STORAGE_KEY = 'kortermaja_sidebar_collapsed'

function readSidebarCollapsed(): boolean {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'
    }
  } catch {
    // Ignore storage read errors
  }
  return false
}

const route = useRoute()
const session = useSessionStore()
const sidebarCollapsed = ref<boolean>(readSidebarCollapsed())

const hasRoleAccess = computed<boolean>(() => canAccessRoute(route, session))

function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, sidebarCollapsed.value ? '1' : '0')
    }
  } catch {
    // Ignore storage write errors
  }
}

watch(
  () => [session.lang, session.buildingName, localeMessagesRevision.value],
  () => {
    applyRouteA11yMetadata(route, session, { announce: false })
  },
)

onMounted(() => {
  applyRouteA11yMetadata(route, session, { announce: false })
  startUnreadPolling(session)
  startChatStatePolling(session, route)
})

onBeforeUnmount(() => {
  stopUnreadPolling()
  stopChatStatePolling()
})
</script>

<template>
  <div class="min-h-screen flex flex-col md:flex-row bg-background text-on-surface">
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-on-primary focus:text-xs focus:font-semibold focus:shadow-lg"
    >
      {{ session.t('a11y.skipToContent') }}
    </a>
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ routeAnnouncement }}
    </div>

    <!-- Left Vertical Warm Nordic Sidebar on md+ -->
    <AppSidebar
      :collapsed="sidebarCollapsed"
      class="print:hidden"
      @toggle-collapse="toggleSidebar"
    />

    <!-- Right Workspace Column -->
    <div class="flex-1 min-w-0 flex flex-col min-h-screen">
      <NetworkStatusBanner class="print:hidden" />
      <AppHeader class="print:hidden" />
      <AppEmergencyBanner class="print:hidden" />

      <main id="main-content" tabindex="-1" class="flex-1 w-full min-w-0 pb-20 md:pb-0 print:pb-0 focus:outline-none">
        <slot v-if="hasRoleAccess" />
        <div
          v-else
          class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-space-xl"
        >
          <div
            class="bg-surface-container-lowest border border-outline-variant/45 rounded-[var(--radius-card)] p-space-lg text-center max-w-lg mx-auto space-y-4 shadow-card"
            role="alert"
          >
            <div class="w-12 h-12 rounded-full bg-error-container text-on-error-container flex items-center justify-center mx-auto">
              <AppIcon name="lock" :size="22" />
            </div>
            <h1 class="font-headline-md text-headline-md text-on-surface">
              {{ session.t('common.noAccessTitle') }}
            </h1>
            <p class="font-body-md text-body-md text-on-surface-variant">
              {{ session.t('errors.FORBIDDEN') }}
            </p>
            <div>
              <RouterLink
                to="/"
                class="inline-flex items-center gap-1.5 px-4 py-2 rounded-[var(--radius-control)] bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors"
              >
                <AppIcon name="arrow_back" :size="16" />
                <span>{{ session.t('nav.dashboard') }}</span>
              </RouterLink>
            </div>
          </div>
        </div>
      </main>

      <div class="print:hidden">
        <AppBottomNav />
        <AppFooter />
      </div>
    </div>
  </div>
</template>

