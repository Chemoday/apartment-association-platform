<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import { unread } from '@/composables/useUnreadCount.js'
import { useChatState } from '@/composables/useChatState.js'
import { useNavigation } from '@/composables/useNavigation.js'
import AppIcon from '@/components/base/AppIcon.vue'

const route = useRoute()
const session = useSessionStore()
const { canShowChat, recentCount: chatRecentCount } = useChatState()
const { visibleNavGroups, isRouteActive, isGroupActive } = useNavigation()

const activeSheetGroupId = ref<string | null>(null)

const activeSheetGroup = computed(
  () => visibleNavGroups.value.find((g) => g.id === activeSheetGroupId.value) || null,
)

function toggleSheet(groupId: string): void {
  activeSheetGroupId.value = activeSheetGroupId.value === groupId ? null : groupId
}

function closeSheet(): void {
  activeSheetGroupId.value = null
}

function handleKeydown(e: KeyboardEvent): void {
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
      class="w-full bg-surface-container-lowest border-t border-outline-variant/50 rounded-t-2xl p-4 pb-20 shadow-xl space-y-2.5 max-h-[75vh] overflow-y-auto"
      @click.stop
    >
      <div class="w-10 h-1 rounded-full bg-outline-variant/70 mx-auto mb-1" />

      <div class="flex items-center justify-between pb-2 border-b border-outline-variant/40">
        <div class="flex items-center gap-2">
          <AppIcon :name="activeSheetGroup.icon" :size="20" class="text-primary" />
          <span class="font-headline-md text-base font-semibold text-on-surface">
            {{ session.t(`navGroups.${activeSheetGroup.labelKey}`) }}
          </span>
        </div>
        <button
          type="button"
          class="p-1.5 rounded-lg text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low cursor-pointer"
          :aria-label="session.t('common.close')"
          @click="closeSheet"
        >
          <AppIcon name="close" :size="18" />
        </button>
      </div>

      <div class="space-y-1.5 pt-1">
        <RouterLink
          v-for="item in activeSheetGroup.items"
          :key="item.name"
          :to="item.path"
          :data-testid="`mobile-nav-link-${item.meta.navKey}`"
          class="w-full p-3 rounded-[var(--radius-control)] flex items-start gap-3 text-left transition-colors border"
          :class="
            isRouteActive(item)
              ? 'bg-primary-fixed/50 border-primary/25 text-on-surface'
              : 'bg-surface-container-low/70 border-transparent hover:bg-surface-container text-on-surface'
          "
          @click="closeSheet"
        >
          <div
            class="w-9 h-9 rounded-[var(--radius-control)] flex items-center justify-center shrink-0 mt-0.5"
            :class="
              isRouteActive(item)
                ? 'bg-primary text-on-primary'
                : 'bg-surface-container text-on-surface-variant'
            "
          >
            <AppIcon :name="String(item.meta.icon || '')" :size="19" />
          </div>

          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2">
              <span class="text-xs font-bold text-on-surface">
                {{ session.t(`nav.${item.meta.navKey}`) }}
              </span>
              <span
                v-if="item.meta.navKey === 'messages' && unread > 0"
                class="inline-flex items-center px-1.5 py-0.5 rounded-full bg-error text-on-error font-label-md text-[10px] font-bold"
              >
                {{ unread }}
              </span>
              <span
                v-else-if="item.meta.navKey === 'chat' && chatRecentCount > 0"
                data-testid="mobile-nav-chat-activity-count"
                class="inline-flex items-center px-1.5 py-0.5 rounded-full bg-secondary text-on-secondary font-label-md text-[10px] font-bold"
              >
                {{ chatRecentCount > 99 ? '99+' : chatRecentCount }}
              </span>
              <span
                v-else-if="item.meta.navKey === 'accounting'"
                class="inline-flex items-center px-1.5 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-label-md text-[10px] uppercase font-bold"
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

  <!-- Primary 4-Tab Mobile Bottom Bar with iOS Safe-Area support -->
  <nav
    :aria-label="session.t('a11y.mobileNavigation')"
    class="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-surface-container-lowest/95 backdrop-blur-md border-t border-outline-variant/50 px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] flex items-center justify-around shadow-lg"
  >
    <template v-for="group in visibleNavGroups" :key="group.id">
      <!-- Single-item group (e.g., Home Dashboard) -->
      <RouterLink
        v-if="group.items.length === 1"
        :to="group.items[0].path"
        :data-testid="`mobile-nav-group-${group.id}`"
        class="flex flex-col items-center justify-center py-1 px-3 rounded-[var(--radius-control)] text-[11px] font-label-md transition-colors min-w-[68px] min-h-[46px]"
        :class="
          isRouteActive(group.items[0]) && !activeSheetGroupId
            ? 'text-primary font-bold bg-primary-fixed/60'
            : 'text-on-surface-variant hover:text-on-surface'
        "
        @click="closeSheet"
      >
        <AppIcon :name="String(group.items[0].meta.icon || '')" :size="20" />
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
        class="flex flex-col items-center justify-center py-1 px-3 rounded-[var(--radius-control)] text-[11px] font-label-md transition-colors min-w-[68px] min-h-[46px] cursor-pointer relative"
        :class="
          activeSheetGroupId === group.id || isGroupActive(group)
            ? 'text-primary font-bold bg-primary-fixed/60'
            : 'text-on-surface-variant hover:text-on-surface'
        "
        @click="toggleSheet(group.id)"
      >
        <span
          v-if="group.id === 'community' && (unread > 0 || (canShowChat && chatRecentCount > 0))"
          class="absolute top-1 right-4 w-2 h-2 rounded-full"
          :class="unread > 0 ? 'bg-error' : 'bg-secondary'"
        />
        <AppIcon :name="group.icon" :size="20" />
        <span class="truncate max-w-[80px] mt-0.5">
          {{ session.t(`navGroupsShort.${group.shortLabelKey}`) }}
        </span>
      </button>
    </template>
  </nav>
</template>
