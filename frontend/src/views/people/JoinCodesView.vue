<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session.js'
import {
  cancelJoinCode,
  issueJoinCodes,
  listJoinCodes,
} from '@/api/endpoints/joinCodes.js'
import type { JoinCodesIssued, JoinCodeView } from '@/api/schema.js'
import { localizeError } from '@/locales/index.js'
import { formatShortDate } from '@/utils/dates.js'
import { objectName } from '@/utils/objectName.js'
import ErrorCard from '@/components/domain/ErrorCard.vue'
import JoinCodeSheet from '@/components/domain/JoinCodeSheet.vue'

const route = useRoute()
const router = useRouter()
const session = useSessionStore()

const codes = ref<JoinCodeView[]>([])
const issuedBatch = ref<JoinCodesIssued | null>(null)
const includeEnglish = ref(true)
const loading = ref(false)
const issuing = ref(false)
const cancellingId = ref<string | null>(null)
const confirmCancelCode = ref<JoinCodeView | null>(null)
const demoUnavailable = ref(false)
const loadError = ref<unknown>(null)
const actionError = ref('')
const bannerMessage = ref('')
let loadController: AbortController | null = null

const preselectedApartmentId = computed(() =>
  typeof route.query.apartmentId === 'string' && route.query.apartmentId.trim()
    ? route.query.apartmentId.trim()
    : null,
)

function isNotFoundError(err: unknown): boolean {
  const e = err as { status?: number; errorCode?: string; payload?: { error_code?: string } }
  const code = e?.errorCode || e?.payload?.error_code
  return e?.status === 404 && (!code || code === 'NOT_FOUND')
}

async function loadCodes() {
  if (loadController) {
    loadController.abort()
    loadController = null
  }
  if (!session.isSignedIn) {
    codes.value = []
    return
  }
  const controller = new AbortController()
  loadController = controller
  loading.value = true
  loadError.value = null
  demoUnavailable.value = false
  try {
    const res = await listJoinCodes({ signal: controller.signal })
    if (loadController === controller) {
      codes.value = res
    }
  } catch (err) {
    const e = err as { errorCode?: string; name?: string }
    if (e?.errorCode === 'REQUEST_ABORTED' || e?.name === 'AbortError') return
    if (loadController === controller) {
      if (isNotFoundError(err)) {
        demoUnavailable.value = true
      } else {
        loadError.value = err
      }
    }
  } finally {
    if (loadController === controller) {
      loading.value = false
    }
  }
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && confirmCancelCode.value && !cancellingId.value) {
    confirmCancelCode.value = null
  }
}

onMounted(async () => {
  if (typeof window !== 'undefined') {
    window.addEventListener('keydown', handleKeydown)
  }
  await loadCodes()
  const targetId = preselectedApartmentId.value
  if (!demoUnavailable.value && !loadError.value && targetId) {
    await router.replace({ name: 'join-codes' })
    await handleIssue([targetId])
  }
})

onBeforeUnmount(() => {
  if (loadController) {
    loadController.abort()
    loadController = null
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('keydown', handleKeydown)
  }
})

watch(
  () => [session.isSignedIn, session.sessionRevision],
  () => {
    issuedBatch.value = null
    loadCodes()
  },
)

async function handleIssue(apartmentIds: string[] | null) {
  if (issuing.value) return
  issuing.value = true
  actionError.value = ''
  bannerMessage.value = ''
  try {
    const res = await issueJoinCodes(apartmentIds)
    issuedBatch.value = res
    if (res.codes.length === 0) {
      bannerMessage.value = session.t('joinCodes.noneEligible')
    }
    await loadCodes()
  } catch (err) {
    if (isNotFoundError(err)) {
      demoUnavailable.value = true
    } else {
      actionError.value = localizeError((err ?? {}) as Record<string, unknown>)
    }
  } finally {
    issuing.value = false
  }
}

function printSheets() {
  if (typeof window !== 'undefined' && typeof window.print === 'function') {
    window.print()
  }
}

async function confirmCancel() {
  const target = confirmCancelCode.value
  if (!target || cancellingId.value) return
  cancellingId.value = target.code_id
  actionError.value = ''
  try {
    await cancelJoinCode(target.code_id)
    confirmCancelCode.value = null
    bannerMessage.value = session.t('joinCodes.cancelledBanner')
    await loadCodes()
  } catch (err) {
    confirmCancelCode.value = null
    const e = err as { status?: number; errorCode?: string; payload?: { error_code?: string } }
    const code = e?.errorCode || e?.payload?.error_code
    if (e?.status === 404 || code === 'JOIN_CODE_NOT_FOUND') {
      bannerMessage.value = session.t('joinCodes.alreadyGone')
      await loadCodes()
    } else {
      actionError.value = localizeError((err ?? {}) as Record<string, unknown>)
    }
  } finally {
    cancellingId.value = null
  }
}
</script>

<template>
  <div class="max-w-5xl mx-auto space-y-6">
    <header class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 print:hidden">
      <div>
        <button
          type="button"
          class="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline mb-2 cursor-pointer"
          @click="router.push({ name: 'connections' })"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">arrow_back</span>
          <span>{{ session.t('joinCodes.backToConnections') }}</span>
        </button>
        <h1 class="font-headline-lg text-2xl font-extrabold text-on-surface tracking-tight">
          {{ session.t('joinCodes.title') }}
        </h1>
        <p class="font-body-md text-sm text-on-surface-variant mt-1">
          {{ session.t('joinCodes.subtitle') }}
        </p>
      </div>

      <div v-if="!demoUnavailable" class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          :disabled="issuing"
          class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold inline-flex items-center gap-1.5 hover:opacity-95 disabled:opacity-50 cursor-pointer"
          @click="handleIssue(null)"
        >
          <span class="material-symbols-outlined text-[16px]" aria-hidden="true">qr_code_2</span>
          <span>
            {{ issuing ? session.t('common.loading') : session.t('joinCodes.issueForAllButton') }}
          </span>
        </button>
      </div>
    </header>

    <div
      v-if="demoUnavailable"
      class="rounded-xl bg-surface-container-lowest border border-surface-container p-6 text-sm text-on-surface-variant"
    >
      {{ session.t('joinCodes.demoUnavailable') }}
    </div>

    <ErrorCard v-else-if="loadError" :error="loadError" @retry="loadCodes" />

    <template v-else>
      <div
        v-if="bannerMessage"
        class="px-4 py-3 rounded-lg bg-secondary-container text-on-secondary-container text-xs font-semibold print:hidden"
      >
        {{ bannerMessage }}
      </div>

      <div
        v-if="actionError"
        role="alert"
        class="px-4 py-3 rounded-lg bg-error-container text-on-error-container text-xs font-medium print:hidden"
      >
        {{ actionError }}
      </div>

      <!-- Newly Issued Printable Sheets -->
      <section v-if="issuedBatch && issuedBatch.codes.length > 0" class="space-y-4">
        <div
          class="rounded-xl bg-amber-50 border border-amber-200 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 print:hidden"
        >
          <div class="text-xs text-amber-950 space-y-1">
            <p class="font-bold">{{ session.t('joinCodes.oneTimeWarningTitle') }}</p>
            <p>{{ session.t('joinCodes.oneTimeWarningBody') }}</p>
          </div>

          <div class="flex flex-wrap items-center gap-3 shrink-0">
            <label v-if="session.lang !== 'en'" class="inline-flex items-center gap-1.5 text-xs text-amber-950 cursor-pointer">
              <input v-model="includeEnglish" type="checkbox" class="accent-primary" />
              <span>{{ session.t('joinCodes.includeEnglishLabel') }}</span>
            </label>
            <button
              type="button"
              class="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold inline-flex items-center gap-1.5 cursor-pointer"
              @click="printSheets"
            >
              <span class="material-symbols-outlined text-[16px]" aria-hidden="true">print</span>
              <span>{{ session.t('joinCodes.printButton') }}</span>
            </button>
          </div>
        </div>

        <div class="space-y-6">
          <JoinCodeSheet
            v-for="item in issuedBatch.codes"
            :key="item.code_id"
            :association-name="issuedBatch.association_name"
            :join-url="issuedBatch.join_url"
            :code="item"
            :include-english="includeEnglish"
          />
        </div>
      </section>

      <!-- Unused Codes Table -->
      <section
        class="rounded-xl bg-surface-container-lowest border border-surface-container shadow-xs overflow-hidden print:hidden"
      >
        <div class="px-5 py-3.5 border-b border-surface-container bg-surface-container-low">
          <h2 class="text-sm font-headline-md font-bold text-on-surface">
            {{ session.t('joinCodes.unusedTitle') }} ({{ codes.length }})
          </h2>
        </div>

        <div v-if="loading" class="p-6 text-center text-xs text-on-surface-variant">
          {{ session.t('common.loading') }}
        </div>

        <div v-else-if="codes.length === 0" class="p-6 text-center text-xs text-on-surface-variant">
          {{ session.t('joinCodes.emptyUnused') }}
        </div>

        <div v-else class="overflow-x-auto">
          <table class="w-full text-left border-collapse text-xs">
            <thead>
              <tr class="border-b border-surface-container text-on-surface-variant uppercase text-[10px]">
                <th class="py-2.5 px-4 font-bold">{{ session.t('joinCodes.columns.object') }}</th>
                <th class="py-2.5 px-4 font-bold">{{ session.t('joinCodes.columns.created') }}</th>
                <th class="py-2.5 px-4 font-bold">{{ session.t('joinCodes.columns.expires') }}</th>
                <th class="py-2.5 px-4 font-bold text-right">{{ session.t('joinCodes.columns.actions') }}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-surface-container">
              <tr v-for="c in codes" :key="c.code_id">
                <td class="py-3 px-4 font-semibold text-on-surface">
                  {{ objectName(c.apartment_kind, c.apartment_number, session.t) }}
                </td>
                <td class="py-3 px-4 text-on-surface-variant">
                  {{ formatShortDate(c.created_at, session.lang) }}
                </td>
                <td class="py-3 px-4 text-on-surface-variant">
                  {{ formatShortDate(c.expires_at, session.lang) }}
                </td>
                <td class="py-3 px-4 text-right">
                  <button
                    type="button"
                    class="px-3 py-1 rounded-lg text-error hover:bg-error-container/30 text-xs font-semibold cursor-pointer"
                    @click="confirmCancelCode = c"
                  >
                    {{ session.t('joinCodes.cancelCode') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- Confirm Cancel Modal -->
    <div
      v-if="confirmCancelCode"
      class="fixed inset-0 z-50 bg-scrim/50 flex items-center justify-center p-4 print:hidden"
      role="dialog"
      aria-modal="true"
    >
      <div class="w-full max-w-md rounded-2xl bg-surface-container-lowest border border-surface-container p-6 space-y-4 shadow-xl">
        <h2 class="font-headline-md text-lg font-bold text-on-surface">
          {{ session.t('joinCodes.cancelModalTitle') }}
        </h2>
        <p class="text-sm text-on-surface-variant">
          {{
            session.t('joinCodes.cancelModalBody', {
              object: objectName(
                confirmCancelCode.apartment_kind,
                confirmCancelCode.apartment_number,
                session.t,
              ),
            })
          }}
        </p>
        <div class="flex justify-end gap-2 pt-2">
          <button
            type="button"
            :disabled="Boolean(cancellingId)"
            class="px-4 py-2 rounded-lg bg-surface-container text-on-surface text-xs font-semibold cursor-pointer"
            @click="confirmCancelCode = null"
          >
            {{ session.t('common.cancel') }}
          </button>
          <button
            type="button"
            :disabled="Boolean(cancellingId)"
            class="px-4 py-2 rounded-lg bg-error text-on-error text-xs font-bold cursor-pointer disabled:opacity-50"
            @click="confirmCancel"
          >
            {{ cancellingId ? session.t('common.loading') : session.t('joinCodes.cancelCode') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
