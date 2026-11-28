<script setup lang="ts">
import { useSessionStore } from '@/stores/session.js'
import { useNetworkStatus } from '@/composables/useNetworkStatus.js'
import AppIcon from '@/components/base/AppIcon.vue'

const session = useSessionStore()
const { isOnline } = useNetworkStatus()
</script>

<template>
  <div
    v-if="!isOnline"
    role="status"
    aria-live="polite"
    data-testid="network-offline-banner"
    class="w-full bg-error-container text-on-error-container border-b border-error/25 px-3 sm:px-gutter py-2"
  >
    <div class="max-w-[1280px] mx-auto flex items-center justify-center gap-2 text-xs font-medium">
      <AppIcon name="wifi_off" :size="16" />
      <span>
        <strong>{{ session.t('network.offlineTitle') }}</strong>
        <span class="hidden sm:inline"> — {{ session.t('network.offlineHint') }}</span>
      </span>
    </div>
  </div>
</template>
