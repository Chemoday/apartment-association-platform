<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { localeMessagesRevision } from '@/locales/index.js'
import { canAccessRoute } from '@/router/access.js'
import { applyRouteA11yMetadata, routeAnnouncement } from '@/router/title.js'
import { startUnreadPolling } from '@/composables/useUnreadCount.js'
import { startChatStatePolling, stopChatStatePolling } from '@/composables/useChatState.js'
import AppHeader from './components/AppHeader.vue'
import AppEmergencyBanner from './components/AppEmergencyBanner.vue'
import AppSidebar from './components/AppSidebar.vue'
import AppBottomNav from './components/AppBottomNav.vue'
import AppFooter from './components/AppFooter.vue'
import NetworkStatusBanner from '@/components/domain/NetworkStatusBanner.vue'

const route = useRoute()
const session = useSessionStore()

const hasRoleAccess = computed<boolean>(() => canAccessRoute(route, session))

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
  stopChatStatePolling()
})
</script>

<template>
  <div class="min-h-screen flex flex-col bg-background text-on-surface">
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-on-primary focus:text-xs focus:font-semibold focus:shadow-lg"
    >
      {{ session.t('a11y.skipToContent') }}
    </a>
    <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ routeAnnouncement }}
    </div>
    <NetworkStatusBanner />
    <AppHeader />
    <AppEmergencyBanner />
    <AppSidebar />
    <main id="main-content" tabindex="-1" class="flex-1 w-full pb-20 md:pb-0 focus:outline-none">
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
            <span class="material-symbols-outlined text-[24px]" aria-hidden="true">lock</span>
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
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_back</span>
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

