<script setup>
import { useSessionStore } from '@/stores/session.js'

const session = useSessionStore()

const directoryContacts = [
  {
    id: 'emergency',
    titleKey: 'dashboard.directoryEmergency',
    subKey: 'dashboard.directoryEmergencySub',
    phone: '+372 654 3210',
    icon: 'support_agent',
    isEmergency: true,
  },
  {
    id: 'board',
    titleKey: 'dashboard.directoryBoard',
    subKey: 'dashboard.directoryBoardSub',
    phone: '+372 555 1234',
    icon: 'shield_person',
    isEmergency: false,
  },
  {
    id: 'janitor',
    titleKey: 'dashboard.directoryJanitor',
    subKey: 'dashboard.directoryJanitorSub',
    phone: '+372 555 4321',
    icon: 'cleaning_services',
    isEmergency: false,
  },
  {
    id: 'elevator',
    titleKey: 'dashboard.directoryElevator',
    subKey: 'dashboard.directoryElevatorSub',
    phone: '+372 600 7000',
    icon: 'elevator',
    isEmergency: false,
  },
]
</script>

<template>
  <div
    data-testid="dashboard-house-directory"
    class="bg-surface-container-lowest rounded-2xl p-space-md sm:p-space-lg shadow-xs border border-surface-container space-y-space-md"
  >
    <div class="flex items-center justify-between gap-2 pb-2 border-b border-surface-container">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
          contacts
        </span>
        <div>
          <h3 class="font-title-sm text-sm font-bold text-on-surface uppercase tracking-wider">
            {{ session.t('dashboard.directoryTitle') }}
          </h3>
          <p class="text-xs text-on-surface-variant">
            {{ session.t('dashboard.directorySubtitle') }}
          </p>
        </div>
      </div>
    </div>

    <!-- Contact Cards Grid -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      <div
        v-for="contact in directoryContacts"
        :key="contact.id"
        class="p-3 rounded-xl border border-surface-container flex items-center justify-between gap-3 transition-colors"
        :class="
          contact.isEmergency
            ? 'bg-error-container/20 border-error/30 text-on-surface'
            : 'bg-surface-container-low hover:bg-surface-container'
        "
      >
        <div class="flex items-center gap-2.5 min-w-0">
          <div
            class="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            :class="
              contact.isEmergency
                ? 'bg-error text-on-error'
                : 'bg-surface-container-highest text-primary'
            "
          >
            <span class="material-symbols-outlined text-[20px]" aria-hidden="true">
              {{ contact.icon }}
            </span>
          </div>

          <div class="min-w-0">
            <h4 class="text-xs font-bold text-on-surface truncate">
              {{ session.t(contact.titleKey) }}
            </h4>
            <p class="text-[11px] text-on-surface-variant truncate">
              {{ session.t(contact.subKey) }}
            </p>
          </div>
        </div>

        <a
          :href="`tel:${contact.phone.replace(/\\s+/g, '')}`"
          :data-testid="`directory-call-${contact.id}`"
          class="px-2.5 py-1.5 rounded-lg font-mono text-xs font-bold transition-colors inline-flex items-center gap-1 shrink-0 whitespace-nowrap"
          :class="
            contact.isEmergency
              ? 'bg-error text-on-error hover:bg-error/90'
              : 'bg-surface-container-lowest border border-surface-container text-primary hover:bg-primary hover:text-on-primary'
          "
        >
          <span class="material-symbols-outlined text-[14px]" aria-hidden="true">call</span>
          <span>{{ contact.phone }}</span>
        </a>
      </div>
    </div>
  </div>
</template>
