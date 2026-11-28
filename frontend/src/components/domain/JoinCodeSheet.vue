<script setup lang="ts">
import { computed } from 'vue'
import type { IssuedJoinCode } from '@/api/schema.js'
import { useSessionStore } from '@/stores/session.js'
import { formatShortDate } from '@/utils/dates.js'
import { objectName } from '@/utils/objectName.js'
import { generateQrPath } from '@/utils/qrCode.js'

const props = defineProps<{
  associationName: string
  joinUrl: string
  code: IssuedJoinCode
  includeEnglish?: boolean
}>()

const session = useSessionStore()

const fullJoinLink = computed(
  () => `${props.joinUrl}#code=${encodeURIComponent(props.code.join_code)}`,
)

const qrData = computed(() => {
  try {
    return generateQrPath(fullJoinLink.value)
  } catch {
    return null
  }
})

const formattedObjectName = computed(() =>
  objectName(props.code.apartment_kind, props.code.apartment_number, session.t),
)

const englishObjectName = computed(() => {
  const num = props.code.apartment_number
  if (props.code.apartment_kind === 'PARKING') return `Parking space ${num}`
  if (props.code.apartment_kind === 'GARAGE') return `Garage ${num}`
  return `Apartment ${num}`
})
</script>

<template>
  <article
    class="join-code-sheet rounded-xl bg-white text-slate-900 border border-slate-300 p-6 sm:p-8 space-y-5 shadow-xs print:border-0 print:shadow-none print:rounded-none print:break-after-page last:print:break-after-auto"
  >
    <div class="flex items-start justify-between gap-4 border-b border-slate-200 pb-4">
      <div>
        <p class="text-xs font-bold uppercase tracking-wider text-slate-500">
          {{ associationName }}
        </p>
        <h2 class="text-2xl font-extrabold text-slate-900 mt-1">
          {{ formattedObjectName }}
        </h2>
      </div>
      <div class="text-right text-xs text-slate-600">
        <p class="font-semibold">{{ session.t('joinCodes.sheet.validUntil') }}</p>
        <p class="font-mono font-bold text-slate-900">
          {{ formatShortDate(code.expires_at, session.lang) }}
        </p>
      </div>
    </div>

    <div class="flex flex-col sm:flex-row items-center gap-6">
      <div
        v-if="qrData"
        class="w-40 h-40 shrink-0 rounded-lg border border-slate-200 p-2 bg-white flex items-center justify-center"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          :viewBox="qrData.viewBox"
          shape-rendering="crispEdges"
          role="img"
          aria-label="QR code"
          class="w-full h-full"
        >
          <rect :width="qrData.size" :height="qrData.size" fill="#ffffff" />
          <path :d="qrData.path" fill="#000000" />
        </svg>
      </div>

      <div class="space-y-3 flex-1 min-w-0">
        <div>
          <p class="text-xs font-semibold text-slate-600">
            {{ session.t('joinCodes.sheet.joinAddress') }}
          </p>
          <p class="font-mono text-sm font-bold text-slate-900 break-all">
            {{ joinUrl }}
          </p>
        </div>

        <div>
          <p class="text-xs font-semibold text-slate-600">
            {{ session.t('joinCodes.sheet.codeLabel') }}
          </p>
          <p
            class="font-mono text-2xl font-extrabold tracking-widest text-slate-900 bg-slate-100 border border-slate-300 rounded-lg px-4 py-2 inline-block mt-1"
          >
            {{ code.join_code }}
          </p>
        </div>
      </div>
    </div>

    <div class="rounded-lg bg-slate-50 border border-slate-200 p-4 text-xs text-slate-700 space-y-2">
      <p class="font-bold text-slate-900">
        {{ session.t('joinCodes.sheet.instructionsTitle') }}
      </p>
      <ol class="list-decimal list-inside space-y-1">
        <li>{{ session.t('joinCodes.sheet.step1', { url: joinUrl }) }}</li>
        <li>{{ session.t('joinCodes.sheet.step2', { object: formattedObjectName }) }}</li>
        <li>{{ session.t('joinCodes.sheet.step3') }}</li>
      </ol>

      <div
        v-if="includeEnglish && session.lang !== 'en'"
        class="pt-3 mt-3 border-t border-slate-200 space-y-1 text-slate-600"
      >
        <p class="font-bold text-slate-800">How to join (English)</p>
        <ol class="list-decimal list-inside space-y-1">
          <li>Scan the QR code or open {{ joinUrl }} and enter the code above.</li>
          <li>Confirm that {{ englishObjectName }} is your unit and leave your contact details.</li>
          <li>The chairman will verify your request and send your personal sign-in invitation by e-mail.</li>
        </ol>
      </div>
    </div>
  </article>
</template>
