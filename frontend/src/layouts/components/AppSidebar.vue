<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import { unread } from '@/composables/useUnreadCount.js'
import { useChatState } from '@/composables/useChatState.js'
import { useNavigation } from '@/composables/useNavigation.js'
import { objectShortName } from '@/utils/objectName.js'
import AppIcon from '@/components/base/AppIcon.vue'

withDefaults(
  defineProps<{
    collapsed?: boolean
  }>(),
  {
    collapsed: false,
  },
)

defineEmits<{
  (e: 'toggle-collapse'): void
}>()

const session = useSessionStore()
const { buildingRole } = useRole()
const { recentCount: chatRecentCount } = useChatState()
const { visibleNavGroups, isRouteActive } = useNavigation()

const buildingMonogram = computed<string>(() => {
  const name = (session.buildingName || 'KÜ').trim()
  const parts = name.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase()
  }
  return name.slice(0, 2).toUpperCase() || 'KÜ'
})

const localizedBuildingRole = computed<string>(() => {
  const key = `buildingRoleLabels.${buildingRole.value}`
  const translated = session.t(key)
  return translated === key ? buildingRole.value : translated
})

const userDisplayName = computed<string>(() => {
  if (session.activeMembership?.preview_badge?.display_label) {
    return session.activeMembership.preview_badge.display_label
  }
  return session.activeMembership?.apartment_number
    ? objectShortName(
        session.activeMembership.apartment_kind,
        session.activeMembership.apartment_number,
        session.t,
      )
    : localizedBuildingRole.value
})

const userInitial = computed<string>(() => {
  const label = userDisplayName.value.trim()
  return (label[0] || 'U').toUpperCase()
})

const roleMetaLabel = computed<string>(() => {
  const roleLabel = session.activeMembership?.preview_badge?.role_badge || localizedBuildingRole.value
  if (session.activeMembership?.apartment_number) {
    const apt = objectShortName(
      session.activeMembership.apartment_kind,
      session.activeMembership.apartment_number,
      session.t,
    )
    return `${roleLabel} · ${apt}`
  }
  return roleLabel
})
</script>

<template>
  <!-- Warm Nordic Editorial vertical sidebar for desktop and tablet viewports (md+) -->
  <aside
    data-testid="app-sidebar"
    :class="collapsed ? 'w-[72px]' : 'w-[252px]'"
    class="hidden md:flex md:flex-col md:sticky md:top-0 md:h-screen shrink-0 bg-surface-container-low border-r border-outline-variant/45 transition-[width] duration-200 z-30"
  >
    <!-- Brand Header + Collapse Toggle -->
    <div
      class="h-16 px-3 flex items-center border-b border-outline-variant/40 shrink-0"
      :class="collapsed ? 'justify-center' : 'justify-between gap-2'"
    >
      <RouterLink
        to="/"
        data-testid="sidebar-brand-link"
        :aria-label="collapsed ? session.buildingName : undefined"
        :title="collapsed ? session.buildingName : undefined"
        class="flex items-center gap-2.5 min-w-0 group"
      >
        <div
          class="w-9 h-9 rounded-[var(--radius-control)] bg-primary text-on-primary font-headline-md text-sm font-semibold flex items-center justify-center shrink-0 shadow-xs group-hover:bg-primary-container transition-colors"
          aria-hidden="true"
        >
          {{ buildingMonogram }}
        </div>
        <div v-if="!collapsed" class="flex flex-col min-w-0">
          <span class="font-headline-md text-[15px] font-semibold leading-tight text-on-surface truncate">
            {{ session.buildingName }}
          </span>
          <span class="font-label-md text-[11px] font-medium text-on-surface-variant truncate mt-0.5">
            {{ session.building?.district || 'Tallinn' }} · {{ session.buildingRegistryCode }}
          </span>
        </div>
      </RouterLink>

      <button
        v-if="!collapsed"
        type="button"
        data-testid="sidebar-collapse-toggle"
        :aria-expanded="true"
        :aria-label="session.t('a11y.collapseSidebar')"
        :title="session.t('a11y.collapseSidebar')"
        class="w-8 h-8 rounded-[var(--radius-control)] inline-flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors shrink-0 cursor-pointer"
        @click="$emit('toggle-collapse')"
      >
        <AppIcon name="left_panel_close" :size="18" />
      </button>
    </div>

    <!-- Expand Button Row when Collapsed -->
    <div
      v-if="collapsed"
      class="px-2 pt-2.5 pb-1 flex justify-center shrink-0"
    >
      <button
        type="button"
        data-testid="sidebar-collapse-toggle"
        :aria-expanded="false"
        :aria-label="session.t('a11y.expandSidebar')"
        :title="session.t('a11y.expandSidebar')"
        class="w-9 h-9 rounded-[var(--radius-control)] inline-flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container transition-colors cursor-pointer"
        @click="$emit('toggle-collapse')"
      >
        <AppIcon name="left_panel_open" :size="19" />
      </button>
    </div>

    <!-- Grouped Navigation Links -->
    <nav
      :aria-label="session.t('a11y.mainNavigation')"
      class="flex-1 overflow-y-auto px-2.5 py-3 space-y-4"
    >
      <section
        v-for="(group, groupIdx) in visibleNavGroups"
        :key="group.id"
        :data-testid="`nav-group-${group.id}`"
        class="space-y-0.5"
      >
        <div
          v-if="!collapsed"
          class="px-2.5 pb-1 pt-0.5 font-label-md text-[10px] font-semibold uppercase tracking-[0.09em] text-on-surface-variant select-none"
        >
          {{ session.t(`navGroups.${group.labelKey}`) }}
        </div>
        <div
          v-else-if="groupIdx > 0"
          class="mx-2 my-2 border-t border-outline-variant/45"
          aria-hidden="true"
        />

        <RouterLink
          v-for="item in group.items"
          :key="item.name"
          :to="item.path"
          :data-testid="`nav-link-${item.meta.navKey}`"
          :aria-current="isRouteActive(item) ? 'page' : undefined"
          :aria-label="collapsed ? session.t(`nav.${item.meta.navKey}`) : undefined"
          :title="collapsed ? session.t(`nav.${item.meta.navKey}`) : undefined"
          class="group relative flex items-center rounded-[var(--radius-control)] font-label-md text-[13px] transition-colors"
          :class="[
            collapsed ? 'justify-center h-10 w-10 mx-auto' : 'gap-2.5 px-2.5 py-2',
            isRouteActive(item)
              ? 'bg-primary text-on-primary font-semibold shadow-xs'
              : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface font-medium',
          ]"
        >
          <AppIcon :name="String(item.meta.icon || '')" :size="18" />

          <span v-if="!collapsed" class="flex-1 truncate">
            {{ session.t(`nav.${item.meta.navKey}`) }}
          </span>

          <!-- Badges (Expanded) -->
          <template v-if="!collapsed">
            <span
              v-if="item.meta.navKey === 'messages' && unread > 0"
              class="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none shrink-0"
              :class="isRouteActive(item) ? 'bg-on-primary/20 text-on-primary' : 'bg-error text-on-error'"
            >
              {{ unread > 99 ? '99+' : unread }}
            </span>
            <span
              v-else-if="item.meta.navKey === 'chat' && chatRecentCount > 0"
              data-testid="sidebar-nav-chat-activity-count"
              class="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none shrink-0"
              :class="isRouteActive(item) ? 'bg-on-primary/20 text-on-primary' : 'bg-secondary text-on-secondary'"
            >
              {{ chatRecentCount > 99 ? '99+' : chatRecentCount }}
            </span>
            <span
              v-else-if="item.meta.navKey === 'accounting'"
              class="inline-flex items-center px-1.5 py-0.5 rounded-full font-label-md text-[9px] uppercase font-bold leading-none shrink-0"
              :class="
                isRouteActive(item)
                  ? 'bg-on-primary/20 text-on-primary'
                  : 'bg-secondary-container text-on-secondary-container'
              "
            >
              {{ session.t('nav.newBadge') }}
            </span>
          </template>

          <!-- Compact activity dot when Collapsed -->
          <span
            v-else-if="
              (item.meta.navKey === 'messages' && unread > 0) ||
              (item.meta.navKey === 'chat' && chatRecentCount > 0)
            "
            class="absolute top-1.5 right-1.5 w-2 h-2 rounded-full"
            :class="item.meta.navKey === 'messages' ? 'bg-error' : 'bg-secondary'"
            aria-hidden="true"
          />
        </RouterLink>
      </section>
    </nav>

    <!-- User & Role Footer -->
    <div class="p-2.5 border-t border-outline-variant/40 shrink-0">
      <RouterLink
        to="/settings/profile"
        data-testid="sidebar-user-footer"
        :aria-label="collapsed ? `${userDisplayName} (${roleMetaLabel})` : undefined"
        :title="collapsed ? `${userDisplayName} (${roleMetaLabel})` : undefined"
        class="flex items-center rounded-[var(--radius-control)] transition-colors hover:bg-surface-container"
        :class="collapsed ? 'justify-center p-1.5' : 'gap-2.5 px-2.5 py-2'"
      >
        <div
          class="w-8 h-8 rounded-full bg-primary-fixed text-on-primary-fixed font-label-md text-xs font-bold flex items-center justify-center shrink-0"
          aria-hidden="true"
        >
          {{ userInitial }}
        </div>
        <div v-if="!collapsed" class="flex-1 min-w-0">
          <div class="text-xs font-semibold text-on-surface truncate leading-tight">
            {{ userDisplayName }}
          </div>
          <div class="text-[11px] text-on-surface-variant truncate mt-0.5">
            {{ roleMetaLabel }}
          </div>
        </div>
      </RouterLink>
    </div>
  </aside>
</template>
