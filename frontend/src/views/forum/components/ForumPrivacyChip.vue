<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSessionStore } from '@/stores/session.js'

const emit = defineEmits(['changed'])

const session = useSessionStore()

const savingPrivacy = ref(false)
const privacyMenuOpen = ref(false)
const privacyMenuRef = ref(null)

const privacyModes = computed(() => [
  {
    value: 'FULL_NAME',
    label: session.t('forum.privacyFullName'),
    desc: 'Kati Kask • OWNER',
  },
  {
    value: 'INITIALS',
    label: session.t('forum.privacyInitials'),
    desc: 'K. K. (Apt 14) • OWNER',
  },
  {
    value: 'APARTMENT_ONLY',
    label: session.t('forum.privacyApartmentOnly'),
    desc: 'Apt 14 • OWNER',
  },
])

const currentPrivacyBadgeLabel = computed(() => {
  const mem = session.activeMembership
  if (!mem) return ''
  if (mem.preview_badge?.display_label) {
    return mem.preview_badge.display_label
  }
  const found = privacyModes.value.find((m) => m.value === mem.privacy_display_mode)
  return found ? found.label : session.t('forum.privacyFullName')
})

async function handlePrivacyChange(mode) {
  const membership = session.activeMembership
  if (!membership || savingPrivacy.value || membership.privacy_display_mode === mode) {
    privacyMenuOpen.value = false
    return
  }
  savingPrivacy.value = true
  try {
    await session.changePrivacyMode(membership.membership_id, mode)
    privacyMenuOpen.value = false
    emit('changed')
  } finally {
    savingPrivacy.value = false
  }
}

function handleDocumentClick(e) {
  if (privacyMenuOpen.value && privacyMenuRef.value && !privacyMenuRef.value.contains(e.target)) {
    privacyMenuOpen.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
})
</script>

<template>
  <!-- Compact Privacy Signature Popover Chip (for Residents with an Apartment Membership) -->
  <div v-if="session.activeMembership" ref="privacyMenuRef" class="relative">
    <button
      type="button"
      class="px-3 py-1.5 rounded-xl border border-outline-variant/50 bg-surface-container-low/60 hover:bg-surface-container-low text-xs font-medium inline-flex items-center gap-1.5 transition-colors"
      :title="session.t('forum.privacyWidgetTitle')"
      @click="privacyMenuOpen = !privacyMenuOpen"
    >
      <span class="material-symbols-outlined text-[16px] text-primary">badge</span>
      <span class="text-on-surface-variant hidden sm:inline">{{ session.t('forum.signingAsLabel') }}</span>
      <span class="font-semibold text-on-surface">{{ currentPrivacyBadgeLabel }}</span>
      <span class="material-symbols-outlined text-[15px] text-on-surface-variant">
        {{ privacyMenuOpen ? 'expand_less' : 'expand_more' }}
      </span>
    </button>

    <!-- Dropdown Popover -->
    <div
      v-if="privacyMenuOpen"
      class="absolute right-0 mt-2 w-72 bg-surface-container-lowest border border-surface-container-high rounded-2xl shadow-lg p-3.5 z-30 space-y-2.5"
    >
      <div>
        <h3 class="text-xs font-bold text-on-surface">
          {{ session.t('forum.privacyWidgetTitle') }}
        </h3>
        <p class="text-[11px] text-on-surface-variant mt-0.5 leading-snug">
          {{ session.t('forum.privacyWidgetDesc') }}
        </p>
      </div>

      <div class="space-y-1.5">
        <button
          v-for="mode in privacyModes"
          :key="mode.value"
          type="button"
          class="w-full text-left p-2 rounded-xl border transition-colors flex items-center justify-between gap-2"
          :class="
            session.activeMembership.privacy_display_mode === mode.value
              ? 'bg-primary/10 border-primary text-on-surface'
              : 'bg-surface-container-low/40 border-surface-container-high text-on-surface-variant hover:bg-surface-container-low'
          "
          :disabled="savingPrivacy"
          @click="handlePrivacyChange(mode.value)"
        >
          <div>
            <div class="text-xs font-semibold text-on-surface">{{ mode.label }}</div>
            <div class="text-[11px] text-on-surface-variant font-mono">{{ mode.desc }}</div>
          </div>
          <span
            class="material-symbols-outlined text-[18px]"
            :class="
              session.activeMembership.privacy_display_mode === mode.value
                ? 'text-primary'
                : 'text-outline-variant'
            "
          >
            {{
              session.activeMembership.privacy_display_mode === mode.value
                ? 'check_circle'
                : 'radio_button_unchecked'
            }}
          </span>
        </button>
      </div>
    </div>
  </div>
</template>
