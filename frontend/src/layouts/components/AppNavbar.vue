<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useChatState } from '@/composables/useChatState.js'
import AppNavbarRoleSwitcher from './AppNavbarRoleSwitcher.vue'
import AppNavbarPrivacySelector from './AppNavbarPrivacySelector.vue'
import AppNotificationBell from './AppNotificationBell.vue'
import AppNavbarUserMenu from './AppNavbarUserMenu.vue'
import AppNavbarLanguageDropdown from './AppNavbarLanguageDropdown.vue'

const session = useSessionStore()
const { canShowChat, recentCount, recentMinutes } = useChatState()

const chatTooltip = computed<string>(() => {
  if (recentCount.value > 0) {
    return session.t('chat.indicatorActiveTooltip', {
      count: recentCount.value,
      minutes: recentMinutes.value,
    })
  }
  return session.t('chat.indicatorTitle')
})

const chatCountLabel = computed<string>(() => {
  if (recentCount.value <= 0) return ''
  return recentCount.value > 99 ? '99+' : String(recentCount.value)
})
</script>

<template>
  <div class="h-16 sm:h-20 w-full max-w-[1280px] mx-auto px-3 sm:px-gutter flex items-center justify-between gap-2 sm:gap-4">
    <!-- Brand -->
    <div class="flex items-center gap-4 min-w-0 shrink-0">
      <RouterLink to="/" class="flex flex-col shrink-0 group">
        <div class="flex items-center gap-1.5">
          <span class="font-headline-md text-base sm:text-headline-md font-bold tracking-tight text-on-surface whitespace-nowrap">
            {{ session.buildingName }}
          </span>
          <span class="hidden sm:inline-flex items-center px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-label-md text-[11px] font-semibold">
            {{ session.building?.district || 'Tallinn' }}
          </span>
        </div>
        <span class="hidden sm:block font-label-md text-[11px] text-on-surface-variant whitespace-nowrap">
          {{ session.buildingAddress }} • Reg {{ session.buildingRegistryCode }}
        </span>
      </RouterLink>
    </div>

    <!-- Right Controls -->
    <div class="flex items-center gap-1.5 sm:gap-2 shrink-0">
      <!-- Demo Mode: Role Switcher + Sign in link -->
      <template v-if="!session.isSignedIn">
        <AppNavbarRoleSwitcher />
        <RouterLink
          to="/login"
          class="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-primary hover:bg-surface-container-low transition-colors whitespace-nowrap shrink-0"
        >
          {{ session.t('auth.signInLink') }}
        </RouterLink>
      </template>

      <AppNavbarPrivacySelector />

      <!-- Building Chat Icon (visible on desktop & mobile only while enabled and caller can take part) -->
      <RouterLink
        v-if="canShowChat"
        to="/chat"
        data-testid="navbar-chat-link"
        :title="chatTooltip"
        :aria-label="chatTooltip"
        class="relative inline-flex items-center justify-center w-9 h-9 rounded-full text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors shrink-0"
      >
        <span class="material-symbols-outlined text-[20px]" aria-hidden="true">chat</span>
        <span
          v-if="recentCount > 0"
          data-testid="navbar-chat-activity-dot"
          class="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-secondary text-on-secondary font-label-md text-[10px] font-bold inline-flex items-center justify-center gap-0.5 leading-none shadow-xs"
        >
          <span class="w-1.5 h-1.5 rounded-full bg-current shrink-0" aria-hidden="true" />
          <span>{{ chatCountLabel }}</span>
        </span>
      </RouterLink>

      <!-- Notification Bell (sits left of user menu in both modes) -->
      <AppNotificationBell />

      <!-- Language Switcher Dropdown (EN / ET / RU) -->
      <AppNavbarLanguageDropdown />

      <!-- User Menu (Role chip + Apt label + Settings / Sign out dropdown) -->
      <AppNavbarUserMenu />
    </div>
  </div>
</template>
