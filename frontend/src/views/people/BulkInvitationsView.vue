<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import {
  previewBulkInvitations,
  sendBulkInvitations,
} from '@/api/endpoints/invitations.js'
import type { BulkInvitationReport, BulkRowOutcome } from '@/api/schema.js'
import { localizeError } from '@/locales/index.js'
import { isBulkOutcomeProblem } from '@/utils/bulkInvitations.js'
import { objectShortName } from '@/utils/objectName.js'

const MAX_BULK_FILE_BYTES = 1_000_000

const router = useRouter()
const session = useSessionStore()

const rawText = ref('')
const fileInputRef = ref<HTMLInputElement | null>(null)
const loadedFileName = ref('')
let activeReader: FileReader | null = null

const previewReport = ref<BulkInvitationReport | null>(null)
const sendReport = ref<BulkInvitationReport | null>(null)
const previewStale = ref(false)

const checking = ref(false)
const sending = ref(false)
const showConfirmModal = ref(false)
const errorMessage = ref('')

const activeReport = computed<BulkInvitationReport | null>(
  () => sendReport.value ?? previewReport.value,
)

const readyCount = computed<number>(() => previewReport.value?.counts?.READY ?? 0)
const invitedCount = computed<number>(() => sendReport.value?.counts?.INVITED ?? 0)

const canSend = computed<boolean>(
  () =>
    !checking.value &&
    !sending.value &&
    !sendReport.value &&
    !previewStale.value &&
    Boolean(previewReport.value) &&
    readyCount.value > 0,
)

const summaryEntries = computed<Array<{ outcome: BulkRowOutcome; count: number }>>(() => {
  const counts = activeReport.value?.counts
  if (!counts) return []
  const order: BulkRowOutcome[] = [
    'INVITED',
    'READY',
    'ALREADY_PENDING',
    'DUPLICATE_IN_LIST',
    'APARTMENT_NOT_FOUND',
    'INVALID_EMAIL',
    'INVALID_LOCALE',
    'INVALID_KIND',
    'INVALID_ROW',
  ]
  return order
    .map((outcome) => ({ outcome, count: Number(counts[outcome] || 0) }))
    .filter((entry) => entry.count > 0)
})

watch(rawText, () => {
  errorMessage.value = ''
  if (previewReport.value) {
    previewStale.value = true
  }
  if (sendReport.value) {
    sendReport.value = null
  }
})

function openFilePicker() {
  fileInputRef.value?.click()
}

function handleFileSelected(event: Event) {
  const input = event.target as HTMLInputElement | null
  const file = input?.files?.[0]
  if (input) input.value = ''
  if (!file) return

  if (file.size > MAX_BULK_FILE_BYTES) {
    errorMessage.value = session.t('people.bulk.errors.listTooLong')
    return
  }

  if (activeReader) {
    activeReader.abort()
    activeReader = null
  }
  loadedFileName.value = file.name
  const reader = new FileReader()
  activeReader = reader
  reader.onload = () => {
    if (activeReader !== reader) return
    activeReader = null
    rawText.value = typeof reader.result === 'string' ? reader.result : ''
  }
  reader.onerror = () => {
    if (activeReader !== reader) return
    activeReader = null
    errorMessage.value = session.t('errors.UNKNOWN')
  }
  reader.readAsText(file)
}

function formatApiError(err: unknown): string {
  const e = err as {
    status?: number
    errorCode?: string
    payload?: { error_code?: string; retry_after_seconds?: number }
  }
  const code = e?.errorCode || e?.payload?.error_code
  if (e?.status === 429 || code === 'RATE_LIMITED') {
    const secs = Number(e?.payload?.retry_after_seconds || 0)
    if (secs > 0) {
      const mins = Math.max(1, Math.ceil(secs / 60))
      return session.t('people.bulk.errors.rateLimitedMinutes', { minutes: mins })
    }
    return session.t('people.bulk.errors.rateLimited')
  }
  if (e?.status === 413 || code === 'BULK_LIST_TOO_LONG' || code === 'FILE_TOO_LARGE') {
    return session.t('people.bulk.errors.listTooLong')
  }
  return localizeError((err ?? {}) as Record<string, unknown>)
}

async function handleCheckList() {
  if (checking.value || !rawText.value.trim()) return
  const snapshot = rawText.value
  checking.value = true
  errorMessage.value = ''
  sendReport.value = null
  try {
    const report = await previewBulkInvitations(snapshot)
    if (rawText.value !== snapshot) {
      previewReport.value = null
      previewStale.value = true
      return
    }
    previewReport.value = report
    previewStale.value = false
  } catch (err) {
    if (rawText.value === snapshot) {
      errorMessage.value = formatApiError(err)
    }
  } finally {
    checking.value = false
  }
}

function requestSendConfirmation() {
  if (!canSend.value) return
  showConfirmModal.value = true
}

async function confirmSend() {
  if (sending.value || !canSend.value) return
  const snapshot = rawText.value
  sending.value = true
  errorMessage.value = ''
  try {
    const report = await sendBulkInvitations(snapshot)
    sendReport.value = report
    previewReport.value = null
    previewStale.value = false
    showConfirmModal.value = false
  } catch (err) {
    showConfirmModal.value = false
    errorMessage.value = formatApiError(err)
  } finally {
    sending.value = false
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && showConfirmModal.value && !sending.value) {
    showConfirmModal.value = false
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeydown)
  }
})

onBeforeUnmount(() => {
  if (activeReader) {
    activeReader.abort()
    activeReader = null
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeydown)
  }
})

function goBackToInvitations() {
  router.push({ name: 'people', query: { tab: 'invitations' } })
}

function formatRowObject(row: BulkInvitationReport['rows'][number]): string {
  if (!row.apartment_number) return '—'
  if (row.apartment_kind) {
    return objectShortName(row.apartment_kind, row.apartment_number, session.t)
  }
  return row.apartment_number
}

function outcomeBadgeClass(outcome: BulkRowOutcome): string {
  if (outcome === 'INVITED' || outcome === 'READY') {
    return 'bg-secondary-container text-on-secondary-container'
  }
  if (outcome === 'ALREADY_PENDING' || outcome === 'DUPLICATE_IN_LIST') {
    return 'bg-amber-100 text-amber-900'
  }
  return 'bg-error-container text-on-error-container'
}
</script>

<template>
  <div class="max-w-5xl mx-auto space-y-6">
    <header class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline mb-2 cursor-pointer"
          @click="goBackToInvitations"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_back</span>
          <span>{{ session.t('people.bulk.backToInvitations') }}</span>
        </button>
        <h1 class="font-headline-lg text-2xl font-extrabold text-on-surface tracking-tight">
          {{ session.t('people.bulk.title') }}
        </h1>
        <p class="font-body-md text-sm text-on-surface-variant mt-1">
          {{ session.t('people.bulk.subtitle') }}
        </p>
      </div>
    </header>

    <!-- Input & File Picker Card -->
    <section
      class="rounded-xl bg-surface-container-lowest border border-surface-container p-5 space-y-4 shadow-xs"
    >
      <div class="rounded-lg bg-surface-container-low border border-surface-container p-3.5 text-xs text-on-surface-variant space-y-1.5">
        <p class="font-semibold text-on-surface">
          {{ session.t('people.bulk.formatHeading') }}
        </p>
        <p>{{ session.t('people.bulk.formatDescription') }}</p>
        <pre
          class="font-mono text-[11px] bg-surface-container-lowest border border-surface-container rounded px-3 py-2 text-on-surface overflow-x-auto"
        >14; owner@example.com; et
1; parking-owner@example.com; en; PARKING
12; garage-owner@example.com; ru; GARAGE</pre>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <label for="bulk-invitations-textarea" class="text-xs font-semibold text-on-surface">
          {{ session.t('people.bulk.listLabel') }}
        </label>
        <div class="flex items-center gap-2">
          <input
            ref="fileInputRef"
            type="file"
            accept=".csv,.txt,.tsv,text/csv,text/plain,text/tab-separated-values"
            class="hidden"
            @change="handleFileSelected"
          />
          <span v-if="loadedFileName" class="text-xs text-on-surface-variant font-mono">
            {{ loadedFileName }}
          </span>
          <button
            type="button"
            class="px-3 py-1.5 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            @click="openFilePicker"
          >
            <span class="material-symbols-outlined text-[16px]" aria-hidden="true">upload_file</span>
            <span>{{ session.t('people.bulk.pickFile') }}</span>
          </button>
        </div>
      </div>

      <textarea
        id="bulk-invitations-textarea"
        v-model="rawText"
        rows="8"
        :placeholder="session.t('people.bulk.placeholder')"
        class="w-full px-3.5 py-2.5 rounded-lg bg-surface-container-low border border-surface-container font-mono text-xs text-on-surface focus:outline-none focus:border-primary"
      ></textarea>

      <div
        v-if="errorMessage"
        role="alert"
        class="px-4 py-3 rounded-lg bg-error-container text-on-error-container text-xs font-medium"
      >
        {{ errorMessage }}
      </div>

      <div
        v-if="previewStale"
        class="px-4 py-2.5 rounded-lg bg-amber-100 text-amber-900 text-xs font-medium"
      >
        {{ session.t('people.bulk.previewStale') }}
      </div>

      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="text-[11px] text-on-surface-variant">
          {{ session.t('people.bulk.privacyHint') }}
        </p>

        <div class="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            :disabled="checking || sending || !rawText.trim()"
            class="px-4 py-2 rounded-lg bg-surface-container hover:bg-surface-container-high text-on-surface text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 cursor-pointer"
            @click="handleCheckList"
          >
            <span class="material-symbols-outlined text-[16px]" aria-hidden="true">fact_check</span>
            <span>
              {{ checking ? session.t('common.loading') : session.t('people.bulk.checkList') }}
            </span>
          </button>

          <button
            type="button"
            :disabled="!canSend"
            class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold inline-flex items-center gap-1.5 disabled:opacity-50 hover:opacity-95 cursor-pointer"
            @click="requestSendConfirmation"
          >
            <span class="material-symbols-outlined text-[16px]" aria-hidden="true">send</span>
            <span>
              {{ session.t('people.bulk.sendButton', { count: readyCount }) }}
            </span>
          </button>
        </div>
      </div>
    </section>

    <!-- Send Success Banner -->
    <div
      v-if="sendReport"
      class="px-5 py-4 rounded-xl bg-secondary-container text-on-secondary-container flex flex-col sm:flex-row sm:items-center justify-between gap-3"
    >
      <div class="text-sm font-semibold">
        {{ session.t('people.bulk.sentSummary', { count: invitedCount }) }}
      </div>
      <button
        type="button"
        class="px-3.5 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold inline-flex items-center gap-1.5 self-start sm:self-center cursor-pointer"
        @click="goBackToInvitations"
      >
        <span class="material-symbols-outlined text-[16px]" aria-hidden="true">mail</span>
        <span>{{ session.t('people.bulk.viewInvitations') }}</span>
      </button>
    </div>

    <!-- Report Table -->
    <section
      v-if="activeReport"
      class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs overflow-hidden"
    >
      <div
        class="p-4 border-b border-surface-container flex flex-wrap items-center justify-between gap-3 bg-surface-container-low"
      >
        <div class="flex flex-wrap items-center gap-2">
          <span
            v-for="entry in summaryEntries"
            :key="entry.outcome"
            class="px-2.5 py-1 rounded-full text-[11px] font-bold"
            :class="outcomeBadgeClass(entry.outcome)"
          >
            {{ session.t(`people.bulk.outcomes.${entry.outcome}`) }}: {{ entry.count }}
          </span>
        </div>
        <span class="text-xs font-semibold text-on-surface-variant">
          {{
            session.t('people.bulk.limitRemaining', {
              count: activeReport.limit_remaining,
            })
          }}
        </span>
      </div>

      <div v-if="activeReport.rows.length === 0" class="p-6 text-center text-xs text-on-surface-variant">
        {{ session.t('people.bulk.emptyRows') }}
      </div>

      <div v-else class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-xs">
          <thead>
            <tr class="border-b border-surface-container text-on-surface-variant uppercase text-[10px]">
              <th class="py-2.5 px-4 font-bold">{{ session.t('people.bulk.columns.line') }}</th>
              <th class="py-2.5 px-4 font-bold">{{ session.t('people.bulk.columns.object') }}</th>
              <th class="py-2.5 px-4 font-bold">{{ session.t('people.bulk.columns.email') }}</th>
              <th class="py-2.5 px-4 font-bold">{{ session.t('people.bulk.columns.locale') }}</th>
              <th class="py-2.5 px-4 font-bold">{{ session.t('people.bulk.columns.outcome') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-surface-container">
            <tr
              v-for="row in activeReport.rows"
              :key="`${row.line}-${row.email ?? ''}`"
              :class="isBulkOutcomeProblem(row.outcome) ? 'bg-error-container/15' : ''"
            >
              <td class="py-2.5 px-4 font-mono text-on-surface-variant">{{ row.line }}</td>
              <td class="py-2.5 px-4 font-semibold text-on-surface">{{ formatRowObject(row) }}</td>
              <td class="py-2.5 px-4 font-mono text-on-surface">{{ row.email || '—' }}</td>
              <td class="py-2.5 px-4 uppercase text-on-surface-variant">{{ row.locale || '—' }}</td>
              <td class="py-2.5 px-4">
                <span
                  class="inline-flex px-2 py-0.5 rounded text-[11px] font-semibold"
                  :class="outcomeBadgeClass(row.outcome)"
                >
                  {{ session.t(`people.bulk.outcomes.${row.outcome}`) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Confirm Send Modal -->
    <div
      v-if="showConfirmModal"
      class="fixed inset-0 z-50 bg-scrim/50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div class="w-full max-w-md rounded-2xl bg-surface-container-lowest border border-surface-container p-6 space-y-4 shadow-xl">
        <h2 class="font-headline-md text-lg font-bold text-on-surface">
          {{ session.t('people.bulk.confirmTitle') }}
        </h2>
        <p class="text-sm text-on-surface-variant">
          {{ session.t('people.bulk.confirmBody', { count: readyCount }) }}
        </p>
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            :disabled="sending"
            class="px-4 py-2 rounded-lg bg-surface-container text-on-surface text-xs font-semibold cursor-pointer"
            @click="showConfirmModal = false"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            :disabled="sending"
            class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold cursor-pointer disabled:opacity-50"
            @click="confirmSend"
          >
            {{ sending ? session.t('common.loading') : session.t('people.bulk.sendButton', { count: readyCount }) }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
