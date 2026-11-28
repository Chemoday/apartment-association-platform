<script lang="ts">
import type { Component } from 'vue'
import {
  IconAdjustmentsHorizontal,
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconBell,
  IconBriefcase,
  IconBuildingCommunity,
  IconCalculator,
  IconCalendarRepeat,
  IconCheck,
  IconCheckbox,
  IconCircleCheck,
  IconCircleDot,
  IconClipboardCheck,
  IconClipboardList,
  IconClock,
  IconCopy,
  IconDoor,
  IconDownload,
  IconFolderOpen,
  IconGauge,
  IconHomeCog,
  IconInbox,
  IconInfoCircle,
  IconLayoutDashboard,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconLoader2,
  IconLock,
  IconMail,
  IconMapPin,
  IconMessageCircle,
  IconMessages,
  IconNetwork,
  IconPencil,
  IconPlus,
  IconReceipt2,
  IconRosetteDiscountCheck,
  IconSearch,
  IconSearchOff,
  IconSend,
  IconShield,
  IconSpeakerphone,
  IconThermometer,
  IconTool,
  IconTrash,
  IconUpload,
  IconUsers,
  IconWifiOff,
  IconX,
} from '@tabler/icons-vue'

export const APP_ICON_MAP: Record<string, Component> = {
  // Navigation groups & routes (matching src/router/routes.ts)
  space_dashboard: IconLayoutDashboard,
  home_iot_device: IconHomeCog,
  forum: IconMessages,
  admin_panel_settings: IconBriefcase,
  apartment: IconBuildingCommunity,
  speed: IconGauge,
  mail: IconMail,
  chat: IconMessageCircle,
  how_to_vote: IconCheckbox,
  report_problem: IconAlertTriangle,
  folder_open: IconFolderOpen,
  account_balance: IconReceipt2,
  meeting_room: IconDoor,
  group: IconUsers,
  hub: IconNetwork,
  fact_check: IconClipboardCheck,
  event_repeat: IconCalendarRepeat,
  history_edu: IconClipboardList,
  tune: IconAdjustmentsHorizontal,

  // Sidebar & Navbar chrome
  left_panel_close: IconLayoutSidebarLeftCollapse,
  left_panel_open: IconLayoutSidebarLeftExpand,
  location_on: IconMapPin,
  notifications: IconBell,
  wifi_off: IconWifiOff,

  // Status, Alerts & Badges
  check_circle: IconCircleCheck,
  priority_high: IconAlertCircle,
  schedule: IconClock,
  calculate: IconCalculator,
  shield: IconShield,
  lock: IconLock,
  verified: IconRosetteDiscountCheck,
  info: IconInfoCircle,
  warning: IconAlertTriangle,
  error: IconAlertCircle,
  campaign: IconSpeakerphone,
  thermostat: IconThermometer,

  // Actions & Controls
  build: IconTool,
  arrow_forward: IconArrowRight,
  arrow_back: IconArrowLeft,
  close: IconX,
  sync: IconLoader2,
  content_copy: IconCopy,
  check: IconCheck,
  inbox: IconInbox,
  search_off: IconSearchOff,
  plus: IconPlus,
  download: IconDownload,
  upload: IconUpload,
  edit: IconPencil,
  trash: IconTrash,
  search: IconSearch,
  send: IconSend,
}
</script>

<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    name: string
    size?: number | string
    stroke?: number | string
  }>(),
  {
    size: 18,
    stroke: 1.65,
  },
)

const iconComponent = computed<Component>(() => APP_ICON_MAP[props.name] || IconCircleDot)
</script>

<template>
  <component
    :is="iconComponent"
    :size="size"
    :stroke-width="stroke"
    class="shrink-0 inline-block"
    aria-hidden="true"
  />
</template>
