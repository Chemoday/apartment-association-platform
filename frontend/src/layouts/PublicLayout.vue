<script setup lang="ts">
import { onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { localeMessagesRevision } from '@/locales/index.js'
import { applyRouteA11yMetadata, routeAnnouncement } from '@/router/title.js'
import AppFooter from './components/AppFooter.vue'
import NetworkStatusBanner from '@/components/domain/NetworkStatusBanner.vue'

const route = useRoute()
const session = useSessionStore()

watch(
  () => [session.lang, session.buildingName, localeMessagesRevision.value],
  () => {
    applyRouteA11yMetadata(route, session, { announce: false })
  },
)

onMounted(() => {
  applyRouteA11yMetadata(route, session, { announce: false })
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
    <main id="main-content" tabindex="-1" class="flex-1 flex flex-col justify-center focus:outline-none">
      <slot />
    </main>
    <AppFooter />
  </div>
</template>
