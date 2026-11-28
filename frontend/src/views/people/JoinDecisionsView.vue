<script setup lang="ts">
import { useSessionStore } from '@/stores/session.js'
import JoinDecisionsPanel from './components/JoinDecisionsPanel.vue'

const session = useSessionStore()
</script>

<template>
  <div class="max-w-5xl mx-auto space-y-6">
    <header>
      <h1 class="font-headline-lg text-2xl font-extrabold text-on-surface tracking-tight">
        {{ session.t('people.joinDecisions.title') }}
      </h1>
      <p class="font-body-md text-sm text-on-surface-variant mt-1">
        {{ session.t('people.joinDecisions.subtitle') }}
      </p>
    </header>

    <JoinDecisionsPanel />
  </div>
</template>
