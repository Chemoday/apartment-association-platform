<script setup>
import { computed, onUnmounted } from 'vue'
import { RECONNECT_INTERVAL_MS, useSessionStore } from '@/stores/session.js'

const session = useSessionStore()

const isOpen = computed(() => session.backendOffline && !session.offlineDemoMode)

const secondsRemaining = computed(() =>
  Math.max(0, Math.ceil(session.retryCountdownMs / 1000)),
)

const progressPercent = computed(() => {
  const elapsed = RECONNECT_INTERVAL_MS - session.retryCountdownMs
  const pct = (elapsed / RECONNECT_INTERVAL_MS) * 100
  return Math.max(0, Math.min(100, pct))
})

onUnmounted(() => {
  session.stopReconnectLoop()
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="isOpen"
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-labelledby="backend-offline-title"
    >
      <div
        class="w-full max-w-md rounded-xl bg-surface-container-lowest text-on-surface border border-outline-variant/30 shadow-xl p-6 flex flex-col gap-5"
      >
        <!-- Header -->
        <div class="flex items-start gap-3.5">
          <div
            class="w-10 h-10 rounded-lg bg-error-container text-on-error-container flex items-center justify-center shrink-0"
          >
            <span class="material-symbols-outlined text-[22px] text-error" aria-hidden="true">
              cloud_off
            </span>
          </div>
          <div class="flex flex-col gap-1 min-w-0">
            <span class="font-label-md text-label-md text-on-surface-variant">
              {{ session.t('offlineModal.kicker') }}
            </span>
            <h2
              id="backend-offline-title"
              class="font-headline-md text-headline-md font-bold text-on-surface tracking-tight"
            >
              {{ session.t('offlineModal.title') }}
            </h2>
          </div>
        </div>

        <p class="font-body-md text-body-md text-on-surface-variant leading-relaxed">
          {{ session.t('offlineModal.description') }}
        </p>

        <!-- 10-Second Auto-Reconnect Progress Section -->
        <div class="p-4 rounded-lg bg-surface-container flex flex-col gap-2.5 border border-outline-variant/20">
          <div class="flex items-center justify-between gap-3">
            <span class="font-label-md text-label-md font-medium text-on-surface tabular-nums">
              <template v-if="session.retryingBackend">
                {{ session.t('offlineModal.retryingNow') }}
              </template>
              <template v-else>
                {{ session.t('offlineModal.retryingIn', { seconds: secondsRemaining }) }}
              </template>
            </span>

            <button
              type="button"
              :disabled="session.retryingBackend"
              class="px-3 py-1 rounded-md bg-surface-container-lowest text-on-surface border border-outline-variant/30 font-label-md text-label-md font-semibold hover:bg-surface-container-high transition-colors disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
              @click="session.retryBackendNow()"
            >
              {{ session.t('offlineModal.retryNowBtn') }}
            </button>
          </div>

          <!-- 10-second Progress Bar -->
          <div
            class="w-full h-2 rounded-full bg-surface-container-highest overflow-hidden"
            role="progressbar"
            :aria-valuenow="Math.round(progressPercent)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="h-full bg-primary transition-all duration-100 ease-linear rounded-full"
              :style="{ width: `${session.retryingBackend ? 100 : progressPercent}%` }"
            />
          </div>
        </div>

        <!-- Offline Demo Mode Call to Action -->
        <div class="pt-4 border-t border-outline-variant/25 flex flex-col gap-3">
          <p class="font-body-sm text-body-sm text-on-surface-variant leading-relaxed">
            {{ session.t('offlineModal.demoPrompt') }}
          </p>

          <button
            type="button"
            class="w-full py-2.5 px-4 rounded-lg bg-primary text-on-primary font-label-lg text-label-lg font-semibold hover:opacity-95 transition-opacity inline-flex items-center justify-center gap-2 shadow-xs whitespace-nowrap shrink-0 cursor-pointer"
            @click="session.activateOfflineDemoMode()"
          >
            <span class="material-symbols-outlined text-[18px]" aria-hidden="true">
              visibility
            </span>
            <span>{{ session.t('offlineModal.demoModeBtn') }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
