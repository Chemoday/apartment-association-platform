<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { APP_ROUTES, NAV_GROUPS } from '@/router/routes.js'

const route = useRoute()
const session = useSessionStore()
const { buildingRole } = useRole()

const openGroupId = ref(null)
const navRef = ref(null)

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

function isRouteActive(item) {
  if (item.path === '/') return route.path === '/'
  return route.path === item.path || route.path.startsWith(`${item.path}/`)
}

function isGroupActive(group) {
  return group.items.some((item) => isRouteActive(item))
}

const activeGroupWithSubnav = computed(() => {
  const found = visibleNavGroups.value.find(
    (g) => g.items.length > 1 && isGroupActive(g),
  )
  return found || null
})

function toggleGroup(groupId) {
  openGroupId.value = openGroupId.value === groupId ? null : groupId
}

function closeDropdown() {
  openGroupId.value = null
}

function handleDocumentClick(e) {
  if (openGroupId.value && navRef.value && !navRef.value.contains(e.target)) {
    openGroupId.value = null
  }
}

function handleKeydown(e) {
  if (e.key === 'Escape' && openGroupId.value) {
    openGroupId.value = null
  }
}

watch(
  () => route.fullPath,
  () => {
    openGroupId.value = null
  },
)

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <!-- Unified grouped primary navigation for desktop and tablet viewports (md+) -->
  <nav
    ref="navRef"
    aria-label="Main Navigation"
    class="hidden md:block sticky top-16 sm:top-20 z-30 w-full bg-surface-container-lowest/95 backdrop-blur-md border-b border-surface-container"
  >
    <!-- Primary Grouped Bar -->
    <div class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-2 flex items-center justify-between gap-3">
      <div class="flex items-center gap-1.5 flex-wrap">
        <template v-for="group in visibleNavGroups" :key="group.id">
          <!-- Single-item group (e.g. Home Dashboard, or single accessible item in group) renders as direct link -->
          <RouterLink
            v-if="group.items.length === 1"
            :to="group.items[0].path"
            :data-testid="`nav-link-${group.items[0].meta.navKey}`"
            class="px-3.5 py-2 rounded-xl font-label-md text-xs transition-all whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
            :class="
              isRouteActive(group.items[0])
                ? 'bg-primary text-on-primary font-semibold shadow-2xs'
                : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface font-medium'
            "
            @click="closeDropdown"
          >
            <span class="material-symbols-outlined text-[17px]" aria-hidden="true">
              {{ group.items[0].meta.icon }}
            </span>
            <span>{{ session.t(`nav.${group.items[0].meta.navKey}`) }}</span>
          </RouterLink>

          <!-- Multi-item group renders as Popover Dropdown Trigger -->
          <div v-else class="relative">
            <button
              type="button"
              :data-testid="`nav-group-${group.id}`"
              :aria-expanded="openGroupId === group.id"
              aria-haspopup="true"
              class="px-3.5 py-2 rounded-xl font-label-md text-xs transition-all whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 cursor-pointer"
              :class="
                isGroupActive(group)
                  ? 'bg-primary text-on-primary font-semibold shadow-2xs'
                  : openGroupId === group.id
                    ? 'bg-surface-container-high text-on-surface font-semibold'
                    : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface font-medium'
              "
              @click.stop="toggleGroup(group.id)"
            >
              <span class="material-symbols-outlined text-[17px]" aria-hidden="true">
                {{ group.icon }}
              </span>
              <span>{{ session.t(`navGroups.${group.labelKey}`) }}</span>
              <span
                class="px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none"
                :class="
                  isGroupActive(group)
                    ? 'bg-on-primary/20 text-on-primary'
                    : 'bg-surface-container-high text-on-surface-variant'
                "
              >
                {{ group.items.length }}
              </span>
              <span
                class="material-symbols-outlined text-[16px] transition-transform duration-200"
                :class="openGroupId === group.id ? 'rotate-180' : ''"
                aria-hidden="true"
              >
                expand_more
              </span>
            </button>

            <!-- Dropdown Menu Panel -->
            <div
              v-if="openGroupId === group.id"
              role="menu"
              class="absolute left-0 mt-2 w-80 rounded-2xl bg-surface-container-lowest border border-surface-container shadow-xl p-2 z-50 space-y-1"
            >
              <div class="px-2.5 py-1.5 border-b border-surface-container flex items-center justify-between text-[11px] font-label-md uppercase tracking-wider text-on-surface-variant">
                <span>{{ session.t(`navGroups.${group.labelKey}`) }}</span>
                <span>{{ session.t('navGroups.sectionsCount', { count: group.items.length }) }}</span>
              </div>

              <RouterLink
                v-for="item in group.items"
                :key="item.name"
                :to="item.path"
                role="menuitem"
                :data-testid="`nav-link-${item.meta.navKey}`"
                class="w-full p-2.5 rounded-xl flex items-start gap-3 text-left transition-colors"
                :class="
                  isRouteActive(item)
                    ? 'bg-primary-container/20 text-on-surface font-semibold'
                    : 'hover:bg-surface-container-low text-on-surface'
                "
                @click="closeDropdown"
              >
                <div
                  class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 transition-colors"
                  :class="
                    isRouteActive(item)
                      ? 'bg-primary text-on-primary'
                      : 'bg-surface-container text-on-surface-variant'
                  "
                >
                  <span class="material-symbols-outlined text-[18px]" aria-hidden="true">
                    {{ item.meta.icon }}
                  </span>
                </div>

                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between gap-1.5">
                    <span class="text-xs font-bold text-on-surface truncate">
                      {{ session.t(`nav.${item.meta.navKey}`) }}
                    </span>
                    <span
                      v-if="item.meta.navKey === 'accounting'"
                      class="inline-flex items-center px-1.5 py-0.5 rounded-full bg-secondary-fixed text-on-secondary-fixed font-label-md text-[10px] uppercase font-bold shrink-0"
                    >
                      {{ session.t('nav.newBadge') }}
                    </span>
                  </div>
                  <p class="text-[11px] text-on-surface-variant leading-snug mt-0.5 line-clamp-2">
                    {{ session.t(`navDesc.${item.meta.navKey}`) }}
                  </p>
                </div>
              </RouterLink>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Contextual Sub-bar: 1-click switching between sibling sections of the active group -->
    <div
      v-if="activeGroupWithSubnav"
      data-testid="nav-contextual-subbar"
      class="w-full bg-surface-container-low/70 border-t border-surface-container"
    >
      <div class="w-full max-w-[1280px] mx-auto px-3 sm:px-gutter py-1.5 flex items-center gap-2 overflow-x-auto">
        <span class="inline-flex items-center gap-1 text-[11px] font-semibold text-on-surface-variant shrink-0 pr-1 border-r border-surface-container-high">
          <span class="material-symbols-outlined text-[15px]" aria-hidden="true">
            {{ activeGroupWithSubnav.icon }}
          </span>
          <span>{{ session.t(`navGroups.${activeGroupWithSubnav.labelKey}`) }}</span>
        </span>

        <div class="flex items-center gap-1">
          <RouterLink
            v-for="subItem in activeGroupWithSubnav.items"
            :key="subItem.name"
            :to="subItem.path"
            :data-testid="`subnav-link-${subItem.meta.navKey}`"
            class="px-2.5 py-1 rounded-lg font-label-md text-xs transition-colors whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
            :class="
              isRouteActive(subItem)
                ? 'bg-surface-container-lowest text-primary font-bold shadow-2xs border border-surface-container'
                : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'
            "
          >
            <span class="material-symbols-outlined text-[15px]" aria-hidden="true">
              {{ subItem.meta.icon }}
            </span>
            <span>{{ session.t(`nav.${subItem.meta.navKey}`) }}</span>
            <span
              v-if="subItem.meta.navKey === 'accounting'"
              class="inline-flex items-center px-1.5 py-0.5 rounded-full bg-secondary-fixed text-on-secondary-fixed font-label-md text-[9px] uppercase font-bold"
            >
              {{ session.t('nav.newBadge') }}
            </span>
          </RouterLink>
        </div>
      </div>
    </div>
  </nav>
</template>
