<script setup>
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import AppLayout from '@/layouts/AppLayout.vue'
import PublicLayout from '@/layouts/PublicLayout.vue'
import BackendOfflineModal from '@/components/domain/BackendOfflineModal.vue'

const route = useRoute()
const session = useSessionStore()

const layoutComponent = computed(() =>
  route.meta?.layout === 'PublicLayout' ? PublicLayout : AppLayout,
)

onMounted(async () => {
  await session.bootstrap()
})
</script>

<template>
  <component :is="layoutComponent">
    <RouterView />
  </component>
  <BackendOfflineModal />
</template>
