<script setup>
import { computed } from 'vue'
import { useSessionStore } from '@/stores/session.js'
import { formatDate } from '@/utils/dates.js'

const props = defineProps({
  period: {
    type: Object,
    default: null,
  },
})

const session = useSessionStore()

const formattedDueDate = computed(() => {
  if (props.period?.due_date) {
    return formatDate(props.period.due_date, session.lang)
  }
  return '25 Nov 2026'
})
</script>

<template>
  <div
    data-testid="dashboard-house-calendar"
    class="bg-surface-container-lowest rounded-2xl p-space-md sm:p-space-lg shadow-xs border border-surface-container space-y-space-md"
  >
    <div class="flex items-center justify-between gap-2 pb-2 border-b border-surface-container">
      <div class="flex items-center gap-2">
        <span class="material-symbols-outlined text-[20px] text-primary" aria-hidden="true">
          calendar_month
        </span>
        <h3 class="font-title-sm text-sm font-bold text-on-surface uppercase tracking-wider">
          {{ session.t('dashboard.houseCalendarTitle') }}
        </h3>
      </div>
      <span class="px-2 py-0.5 rounded-full bg-secondary-container text-on-secondary-container font-label-md text-[11px] font-semibold">
        {{ period?.period_code || '2026-10' }}
      </span>
    </div>

    <!-- Timeline of Key Upcoming Deadlines and Events -->
    <div class="relative pl-6 space-y-4 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-surface-container-high">
      <!-- Item 1: Readings Submission Deadline -->
      <div class="relative">
        <span class="absolute -left-6 top-1 w-2.5 h-2.5 rounded-full bg-primary ring-4 ring-surface-container-lowest" />
        <div class="flex flex-col">
          <span class="font-label-md text-xs font-bold text-primary">
            {{ formattedDueDate }}
          </span>
          <span class="text-xs font-bold text-on-surface">
            {{ session.t('dashboard.calendarReadingsDeadline') }}
          </span>
          <span class="text-[11px] text-on-surface-variant">
            {{ session.t('dashboard.calendarReadingsDeadlineSub') }}
          </span>
        </div>
      </div>

      <!-- Item 2: Bulky Waste Pickup -->
      <div class="relative">
        <span class="absolute -left-6 top-1 w-2.5 h-2.5 rounded-full bg-secondary ring-4 ring-surface-container-lowest" />
        <div class="flex flex-col">
          <span class="font-label-md text-xs font-bold text-secondary">
            14 Nov • 09:00 - 13:00
          </span>
          <span class="text-xs font-bold text-on-surface">
            {{ session.t('dashboard.calendarWastePickup') }}
          </span>
          <span class="text-[11px] text-on-surface-variant">
            {{ session.t('dashboard.calendarWastePickupSub') }}
          </span>
        </div>
      </div>

      <!-- Item 3: Heating Substation Calibration -->
      <div class="relative">
        <span class="absolute -left-6 top-1 w-2.5 h-2.5 rounded-full bg-surface-container-highest ring-4 ring-surface-container-lowest" />
        <div class="flex flex-col">
          <span class="font-label-md text-xs font-bold text-on-surface-variant">
            Utilitas Tallinn
          </span>
          <span class="text-xs font-bold text-on-surface">
            {{ session.t('dashboard.calendarHeatingCheck') }}
          </span>
          <span class="text-[11px] text-on-surface-variant">
            {{ session.t('dashboard.calendarHeatingCheckSub') }}
          </span>
        </div>
      </div>

      <!-- Item 4: General Assembly -->
      <div class="relative">
        <span class="absolute -left-6 top-1 w-2.5 h-2.5 rounded-full bg-primary/60 ring-4 ring-surface-container-lowest" />
        <div class="flex flex-col">
          <span class="font-label-md text-xs font-bold text-on-surface-variant">
            08 Dec • 18:30
          </span>
          <span class="text-xs font-bold text-on-surface">
            {{ session.t('dashboard.calendarGeneralMeeting') }}
          </span>
          <span class="text-[11px] text-on-surface-variant">
            {{ session.t('dashboard.calendarGeneralMeetingSub') }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
