<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { APP_ROUTES, NAV_GROUPS } from '@/router/routes.js'

const route = useRoute()
const session = useSessionStore()
const { buildingRole } = useRole()

const activeSheetGroupId = ref(null)

const visibleNavRoutes = computed(() =>
  APP_ROUTES.filter((r) => {
    if (!r.meta?.navKey) return false
    if (r.meta?.requiresApartmentOrBoard) {
      const isBoardOrChairman = ['CHAIRMAN', 'BOARD'].includes(buildingRole.value)
      const hasApartments = (session.memberships?.length || 0) > 0
      if (!isBoardOrChairman && !hasApartments) return false
    }
    const allowed = r.meta?.roles
    if (!allowed || allowed.length === 0) return true
    return allowed.includes(buildingRole.value)
  }),
)

const visibleNavGroups = computed(() =>
  NAV_GROUPS.map((group) => {
    const items = visibleNavRoutes.value.filter(
      (r) => (r.meta?.navGroup || 'services') === group.id,
    )
    return {
      ...group,
      items,
    }
  }).filter((group) => group.items.length > 0),
)

const activeSheetGroup = computed(
  () => visibleNavGroups.value.find((g) => g.id === activeSheetGroupId.value) || null,
)

function isRouteActive(item) {
  if (item.path === '/') return route.path === '/'
  return route.path === item.path || route.path.startsWith(`${item.path}/`)
}

function isGroupActive(group) {
  return group.items.some((item) => isRouteActive(item))
}

function toggleSheet(groupId) {
  activeSheetGroupId.value = activeSheetGroupId.value === groupId ? null : groupId
}

function closeSheet() {
  activeSheetGroupId.value = null
}

function handleKeydown(e) {
  if (e.key === 'Escape' && activeSheetGroupId.value) {
    activeSheetGroupId.value = null
  }
}

watch(
  () => route.fullPath,
  () => {
    activeSheetGroupId.value = null
  },
)

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <!-- Mobile Bottom Sheet Drawer for Nested Group Items -->
  <div
    v-if="activeSheetGroup"
    class="md:hidden fixed inset-0 z-40 bg-black/45 backdrop-blur-2xs flex items-end"
    role="dialog"
    aria-modal="true"
    :aria-label="session.t(`navGroups.${activeSheetGroup.labelKey}`)"
    @click="closeSheet"
  >
    <div
      class="w-full bg-surface-container-lowest border-t border-surface-container rounded-t-2xl p-4 pb-20 shadow-2xl space-y-2.5 max-h-[75vh] overflow-y-auto"
      @click.stop
    >
      <div class="w-10 h-1 rounded-full bg-surface-container-high mx-auto mb-1" />

      <div class="flex items-center justify-between pb-2 border-b border-surface-container">
        <div class="flex items-center gap-2">
          <span class="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
            {{ activeSheetGroup.icon }}
          </span>
          <span class="font-headline-sm text-sm font-bold text-on-surface">
            {{ session.t(`navGroups.${activeSheetGroup.labelKey}`) }}
          </span>
        </div>
        <button
          type="button"
          class="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low cursor-pointer"
          :aria-label="session.t('common.close')"
          @click="closeSheet"
        >
          <span class="material-symbols-outlined text-[18px]" aria-hidden="true">close</span>
        </button>
      </div>

      <div class="space-y-1.5 pt-1">
        <RouterLink
          v-for="item in activeSheetGroup.items"
          :key="item.name"
          :to="item.path"
          :data-testid="`mobile-nav-link-${item.meta.navKey}`"
          class="w-full p-3 rounded-xl flex items-start gap-3 text-left transition-colors"
          :class="
            isRouteActive(item)
              ? 'bg-primary-container/20 border border-primary/25 text-on-surface'
              : 'bg-surface-container-low/60 hover:bg-surface-container text-on-surface'
          "
          @click="closeSheet"
        >
          <div
            class="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
            :class="
              isRouteActive(item)
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container text-on-surface-variant'
            "
          >
            <span class="material-symbols-outlined text-[19px]" aria-hidden="true">
              {{ item.meta.icon }}
            </span>
          </div>

          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-bold text-on-surface">
                {{ session.t(`nav.${item.meta.navKey}`) }}
              </span>
              <span
                v-if="item.meta.navKey === 'accounting'"
                class="inline-flex items-center px-1.5 py-0.5 rounded-full bg-secondary-fixed text-on-secondary-fixed font-label-md text-[10px] uppercase font-bold"
              >
                {{ session.t('nav.newBadge') }}
              </span>
            </div>
            <p class="text-[11px] text-on-surface-variant leading-snug mt-0.5">
              {{ session.t(`navDesc.${item.meta.navKey}`) }}
            </p>
          </div>
        </RouterLink>
      </div>
    </div>
  </div>

  <!-- Primary 4-Tab Mobile Bottom Bar -->
  <nav
    aria-label="Mobile Navigation"
    class="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-surface-container-lowest/95 backdrop-blur-md border-t border-surface-container px-2 py-1.5 flex items-center justify-around"
  >
    <template v-for="group in visibleNavGroups" :key="group.id">
      <!-- Single-item group (e.g., Home Dashboard) -->
      <RouterLink
        v-if="group.items.length === 1"
        :to="group.items[0].path"
        :data-testid="`mobile-nav-group-${group.id}`"
        class="flex flex-col items-center justify-center py-1 px-3 rounded-xl text-[11px] font-label-md transition-colors min-w-[68px] min-h-[46px]"
        :class="
          isRouteActive(group.items[0]) && !activeSheetGroupId
            ? 'text-primary font-bold bg-surface-container-high/60'
            : 'text-on-surface-variant hover:text-on-surface'
        "
        @click="closeSheet"
      >
        <span class="material-symbols-outlined text-[20px]" aria-hidden="true">
          {{ group.items[0].meta.icon }}
        </span>
        <span class="truncate max-w-[80px] mt-0.5">
          {{ session.t(`navGroupsShort.${group.shortLabelKey}`) }}
        </span>
      </RouterLink>

      <!-- Multi-item group opens Bottom Sheet -->
      <button
        v-else
        type="button"
        :data-testid="`mobile-nav-group-${group.id}`"
        :aria-expanded="activeSheetGroupId === group.id"
        class="flex flex-col items-center justify-center py-1 px-3 rounded-xl text-[11px] font-label-md transition-colors min-w-[68px] min-h-[46px] cursor-pointer relative"
        :class="
          activeSheetGroupId === group.id || isGroupActive(group)
            ? 'text-primary font-bold bg-surface-container-high/60'
            : 'text-on-surface-variant hover:text-on-surface'
        "
        @click="toggleSheet(group.id)"
      >
        <span class="material-symbols-outlined text-[20px]" aria-hidden="true">
          {{ group.icon }}
        </span>
        <span class="truncate max-w-[80px] mt-0.5">
          {{ session.t(`navGroupsShort.${group.shortLabelKey}`) }}
        </span>
      </button>
    </template>
  </nav>
</template>
