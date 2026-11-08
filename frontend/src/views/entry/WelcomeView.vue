<script setup>
import { computed, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import DemoRoleCard from './components/DemoRoleCard.vue'

const router = useRouter()
const session = useSessionStore()

const endedBannerText = computed(() => {
  if (session.sessionEndedReason === 'closed') {
    return session.t('auth.sessionClosedNotice')
  }
  if (session.sessionEndedReason === 'expired') {
    return session.t('auth.sessionExpiredNotice')
  }
  return ''
})

async function handleSelectUser(userId) {
  session.clearSessionEndedReason()
  await session.switchUser(userId)
  router.push({ name: 'dashboard' })
}

function goToLogin() {
  session.clearSessionEndedReason()
  router.push({ name: 'login' })
}

onBeforeUnmount(() => {
  session.clearSessionEndedReason()
})
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 sm:px-6 py-10 sm:py-12 space-y-8">
    <!-- Dismissible Session Ended / Closed Notice -->
    <div
      v-if="endedBannerText"
      role="status"
      class="rounded-xl bg-surface-container border border-outline-variant/30 px-4 py-3.5 flex items-center justify-between gap-3"
    >
      <div class="flex items-center gap-2.5 text-sm text-on-surface">
        <span class="material-symbols-outlined text-[20px] text-primary shrink-0" aria-hidden="true">
          info
        </span>
        <span>{{ endedBannerText }}</span>
      </div>
      <button
        type="button"
        class="p-1 rounded-md text-on-surface-variant hover:text-on-surface cursor-pointer"
        aria-label="Dismiss"
        @click="session.clearSessionEndedReason()"
      >
        <span class="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
      </button>
    </div>

    <div class="space-y-2">
      <span class="text-xs font-bold uppercase tracking-widest text-primary">
        {{ session.buildingName }} • Tallinn
      </span>
      <h1 class="text-3xl font-bold text-on-surface tracking-tight">
        {{ session.t('welcome.title') }}
      </h1>
      <p class="text-sm text-on-surface-variant max-w-2xl">
        {{ session.t('welcome.subtitle') }}
      </p>
    </div>

    <!-- Demo Role Cards -->
    <div v-if="session.demoUsers.length > 0" class="grid grid-cols-1 md:grid-cols-3 gap-6">
      <DemoRoleCard
        v-for="u in session.demoUsers"
        :key="u.user_id"
        :user="u"
        :active="!session.isSignedIn && u.user_id === session.actingUserId"
        @select="handleSelectUser"
      />
    </div>

    <!-- Quieter Sign-In Card (Epic E7) -->
    <div class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div class="space-y-1">
        <h2 class="font-headline-md text-lg font-bold text-on-surface">
          {{ session.t('auth.welcomeCardTitle') }}
        </h2>
        <p class="text-sm text-on-surface-variant">
          {{ session.t('auth.welcomeCardText') }}
        </p>
      </div>

      <button
        type="button"
        class="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-on-primary font-label-lg text-sm font-semibold hover:opacity-95 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
        @click="goToLogin"
      >
        <span class="material-symbols-outlined text-[18px]" aria-hidden="true">mail</span>
        <span>{{ session.t('auth.welcomeCardButton') }}</span>
      </button>
    </div>
  </div>
</template>
