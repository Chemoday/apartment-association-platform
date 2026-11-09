<script setup>
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'

const route = useRoute()
const session = useSessionStore()

const tabs = [
  {
    name: 'settings-profile',
    path: '/settings/profile',
    icon: 'person',
    labelKey: 'auth.menu.profile',
  },
  {
    name: 'settings-notifications',
    path: '/settings/notifications',
    icon: 'tune',
    labelKey: 'auth.menu.notificationSettings',
  },
  {
    name: 'settings-security',
    path: '/settings/security',
    icon: 'shield_lock',
    labelKey: 'auth.menu.security',
  },
]

function isTabActive(tab) {
  return route.name === tab.name || route.path.startsWith(tab.path)
}
</script>

<template>
  <nav
    aria-label="Account Settings Navigation"
    data-testid="settings-shell-tabs"
    class="flex items-center gap-1.5 p-1 rounded-xl bg-surface-container-low border border-surface-container overflow-x-auto"
  >
    <RouterLink
      v-for="tab in tabs"
      :key="tab.name"
      :to="{ name: tab.name }"
      :data-testid="`settings-tab-${tab.name}`"
      class="px-3.5 py-2 rounded-lg font-label-md text-xs transition-all whitespace-nowrap shrink-0 inline-flex items-center gap-2"
      :class="
        isTabActive(tab)
          ? 'bg-surface-container-lowest text-primary font-bold shadow-2xs border border-surface-container'
          : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container font-medium'
      "
    >
      <span class="material-symbols-outlined text-[16px]" aria-hidden="true">
        {{ tab.icon }}
      </span>
      <span>{{ session.t(tab.labelKey) }}</span>
    </RouterLink>
  </nav>
</template>
