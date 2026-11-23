<script setup lang="ts">
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

function goBack() {
  const backPath =
    typeof window !== 'undefined' && typeof window.history.state?.back === 'string'
      ? window.history.state.back
      : ''
  if (backPath && backPath !== route.fullPath) {
    router.back()
  } else {
    router.push({ name: 'dashboard' })
  }
}
</script>

<template>
  <div class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-space-xl">
    <section
      class="bg-surface-container-lowest border border-surface-container rounded-2xl p-space-lg text-center max-w-lg mx-auto space-y-4 shadow-xs"
      role="alert"
      aria-labelledby="forbidden-title"
    >
      <div
        class="w-12 h-12 rounded-full bg-error-container text-on-error-container flex items-center justify-center mx-auto"
      >
        <span class="material-symbols-outlined text-[24px]" aria-hidden="true">lock</span>
      </div>
      <p class="font-mono text-xs font-semibold uppercase tracking-wider text-error">403</p>
      <h1 id="forbidden-title" class="font-title-lg text-title-lg font-bold text-on-surface">
        {{ session.t('errorsPage.forbiddenTitle') }}
      </h1>
      <p class="font-body-md text-body-md text-on-surface-variant leading-relaxed">
        {{ session.t('errorsPage.forbiddenBody') }}
      </p>
      <div class="flex flex-wrap items-center justify-center gap-2 pt-2">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-outline-variant text-xs font-semibold text-on-surface hover:bg-surface-container-low transition-colors"
          @click="goBack"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_back</span>
          <span>{{ session.t('errorsPage.goBack') }}</span>
        </button>
        <RouterLink
          :to="{ name: 'dashboard' }"
          class="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary-container transition-colors"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">space_dashboard</span>
          <span>{{ session.t('errorsPage.backToDashboard') }}</span>
        </RouterLink>
      </div>
    </section>
  </div>
</template>
