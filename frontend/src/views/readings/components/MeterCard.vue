<script setup>
import { computed, ref, watch } from 'vue'
import { submitReading } from '@/api/endpoints/meters.js'
import {
  compareMeterValues,
  formatSignedDelta,
  normalizeMeterInput,
  stepMeterValue,
  subtractMeterValues,
} from '@/utils/meterValue.js'
import {
  createAnomalyFlowState,
  prepareReadingSubmission,
  resetAnomalyOnEdit,
  transitionOnReadingError,
} from '@/utils/anomalyFlow.js'
import { formatDate, formatMonthName } from '@/utils/dates.js'
import { getFinalWarningMonths, resolveResidentFormContext } from '@/utils/nextSubmission.js'
import { localizeError } from '@/locales/index.js'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import BaseButton from '@/components/base/BaseButton.vue'
import BaseModal from '@/components/base/BaseModal.vue'
import StatusChip from '@/components/domain/StatusChip.vue'
import MeterCardAnomalyModal from './MeterCardAnomalyModal.vue'

const props = defineProps({
  meter: {
    type: Object, // DashboardMeter or MasterMeterRow
    required: true,
  },
  periodCode: {
    type: String,
    required: true,
  },
  periodStatus: {
    type: String,
    default: 'OPEN_FOR_RESIDENTS',
  },
  canSubmit: {
    type: Boolean,
    default: true,
  },
  useNextSubmission: {
    type: Boolean,
    default: false,
  },
  preservedDraft: {
    type: String,
    default: null,
  },
})

const emit = defineEmits(['saved', 'open-history', 'draft-change', 'wrong-period'])

const session = useSessionStore()
const { canSubmitAnyMeter } = useRole()

const formCtx = computed(() => resolveResidentFormContext(props.meter, props.useNextSubmission))
const effectivePeriodCode = computed(() => formCtx.value.periodCode || props.periodCode)
const effectivePreviousValue = computed(() =>
  props.useNextSubmission ? formCtx.value.previousValue : props.meter.previous_value,
)
const effectiveAverageDelta = computed(() =>
  props.useNextSubmission ? formCtx.value.averageDelta : props.meter.average_delta,
)
const effectiveReading = computed(() =>
  props.useNextSubmission ? formCtx.value.reading : props.meter.reading,
)

const input = ref(
  props.preservedDraft !== null ? props.preservedDraft : effectiveReading.value?.value || '',
)
const reason = ref('')
const submitting = ref(false)
const flow = ref(createAnomalyFlowState())
const finalConfirmPending = ref(null) // { value: string, confirmationLevel: number } | null

watch(
  () => [props.preservedDraft, formCtx.value.periodCode, effectiveReading.value?.value],
  ([draft, newPeriod, newVal], oldTuple) => {
    if (draft !== null && draft !== undefined) {
      input.value = draft
      return
    }
    const prevPeriod = oldTuple?.[1]
    if (props.useNextSubmission && newPeriod !== prevPeriod) {
      input.value = newVal || ''
      flow.value = createAnomalyFlowState()
      finalConfirmPending.value = null
      return
    }
    if (newVal) {
      input.value = newVal
    }
  },
)

const displayUnit = computed(() => (props.meter.unit === 'm3' ? 'm³' : props.meter.unit))

const targetMonthTitle = computed(() => {
  if (!props.useNextSubmission || !formCtx.value.periodCode) return ''
  return formatMonthName(formCtx.value.periodCode, session.lang, { capitalize: true })
})

const formattedSubDueDate = computed(() => {
  if (!formCtx.value.dueDate) return ''
  return formatDate(formCtx.value.dueDate, session.lang)
})

const finalWarningMonths = computed(() =>
  formCtx.value.periodCode
    ? getFinalWarningMonths(formCtx.value.periodCode, session.lang)
    : { prevMonth: '', nextMonth: '' },
)

const resourceLabel = computed(() => {
  switch (props.meter.resource_type) {
    case 'COLD_WATER':
      return session.t('readings.meterCard.coldWater')
    case 'HOT_WATER':
      return session.t('readings.meterCard.hotWater')
    case 'ELECTRICITY':
      return session.t('readings.meterCard.electricity')
    case 'HEAT':
      return session.t('readings.meterCard.thermalEnergy')
    default:
      return props.meter.resource_type
  }
})

const resourceIcon = computed(() => {
  switch (props.meter.resource_type) {
    case 'COLD_WATER':
      return 'water_drop'
    case 'HOT_WATER':
      return 'mode_heat'
    case 'ELECTRICITY':
      return 'bolt'
    default:
      return 'speed'
  }
})

const resourceIconClass = computed(() => {
  switch (props.meter.resource_type) {
    case 'COLD_WATER':
      return 'text-blue-600'
    case 'HOT_WATER':
      return 'text-amber-600'
    case 'ELECTRICITY':
      return 'text-amber-500'
    default:
      return 'text-secondary'
  }
})

// Live consumption delta computed via scaled BigInt
const liveDelta = computed(() => {
  const normalized = normalizeMeterInput(input.value)
  if (normalized !== null && effectivePreviousValue.value) {
    return subtractMeterValues(normalized, effectivePreviousValue.value)
  }
  return effectiveReading.value?.consumption_delta || null
})

// Whether the current input matches the previous reading (resulting in 0.000 consumption)
const isSameAsPrevious = computed(() => {
  const normalized = normalizeMeterInput(input.value)
  if (normalized === null || !effectivePreviousValue.value) return false
  return compareMeterValues(normalized, effectivePreviousValue.value) === 0
})

// Board/Accountant changing an existing reading must provide a reason (REASON_REQUIRED)
const needsReasonField = computed(
  () => Boolean(effectiveReading.value) && canSubmitAnyMeter.value,
)

const isLockedByBoardForResident = computed(
  () =>
    effectiveReading.value?.source === 'ADMIN_OVERRIDE' && !canSubmitAnyMeter.value,
)

const isInputDisabled = computed(() => {
  if (!props.canSubmit) return true
  if (props.useNextSubmission) {
    if (!formCtx.value.hasForm) return true
    if (isLockedByBoardForResident.value) return true
    return false
  }
  if (props.periodStatus === 'LOCKED') return true
  if (props.periodStatus !== 'OPEN_FOR_RESIDENTS' && !canSubmitAnyMeter.value) return true
  if (isLockedByBoardForResident.value) return true
  return false
})

const errorMessage = computed(() => {
  if (!flow.value.fieldError) return ''
  return localizeError(
    flow.value.fieldError,
    {
      ...flow.value.apiError?.payload,
      previous_value:
        flow.value.apiError?.payload?.previous_value ||
        `${effectivePreviousValue.value} ${displayUnit.value}`,
    },
    session.lang,
  )
})

const historyReadingId = computed(
  () => effectiveReading.value?.reading_id || props.meter.reading?.reading_id || '',
)

const meterStatus = computed(() => {
  const reading = effectiveReading.value
  if (!reading) return 'MISSING'
  if (reading.is_anomaly_confirmed) return 'ANOMALY_CONFIRMED'
  if (reading.source === 'ADMIN_OVERRIDE') return 'ADMIN_OVERRIDE'
  if (reading.source === 'AUTO_ESTIMATED') return 'AUTO_ESTIMATED'
  return 'SUBMITTED'
})

function updateInputValue(nextVal) {
  input.value = nextVal
  // Editing the input while a popup is open cancels it; the next submit starts again at level 0
  if (flow.value.anomaly || flow.value.fieldError) {
    flow.value = resetAnomalyOnEdit(flow.value)
  }
  if (finalConfirmPending.value) {
    finalConfirmPending.value = null
  }
  emit('draft-change', {
    meterId: props.meter.meter_id,
    value: input.value,
    delta: liveDelta.value,
  })
}

function handleInputEdit(event) {
  updateInputValue(event.target.value)
}

function applyPreviousReading() {
  if (isInputDisabled.value || submitting.value || !effectivePreviousValue.value) return
  updateInputValue(effectivePreviousValue.value)
}

function stepReadingByTenths(stepTenths) {
  if (isInputDisabled.value || submitting.value) return
  const fallbackBase =
    effectivePreviousValue.value || effectiveReading.value?.value || '0.000'
  const nextVal = stepMeterValue(input.value, fallbackBase, stepTenths)
  updateInputValue(nextVal)
}

async function performSubmit(value, confirmationLevel) {
  submitting.value = true
  try {
    const savedReading = await submitReading({
      meter_id: props.meter.meter_id,
      period_code: effectivePeriodCode.value,
      value,
      confirmation_level: confirmationLevel,
      reason: reason.value.trim() || null,
    })
    flow.value = createAnomalyFlowState()
    finalConfirmPending.value = null
    input.value = savedReading.value
    emit('saved', savedReading)
  } catch (error) {
    if (error?.errorCode === 'WRONG_PERIOD') {
      flow.value = createAnomalyFlowState()
      finalConfirmPending.value = null
      emit('wrong-period', {
        meterId: props.meter.meter_id,
        targetPeriodCode: error.payload?.target_period_code || null,
        draftValue: input.value,
      })
      return
    }
    flow.value = transitionOnReadingError(flow.value, error)
  } finally {
    submitting.value = false
  }
}

async function submit(level = 0) {
  if (submitting.value || isInputDisabled.value) return

  const prep = prepareReadingSubmission(flow.value, input.value, level)
  flow.value = prep.nextState
  if (!prep.ok) return

  if (needsReasonField.value && !reason.value.trim()) {
    flow.value = {
      ...flow.value,
      fieldError: 'REASON_REQUIRED',
    }
    return
  }

  if (props.useNextSubmission && formCtx.value.isFinal && level === 0) {
    finalConfirmPending.value = {
      value: prep.value,
      confirmationLevel: prep.confirmationLevel,
    }
    return
  }

  await performSubmit(prep.value, prep.confirmationLevel)
}

async function confirmFinalSubmission() {
  if (!finalConfirmPending.value || submitting.value) return
  const pending = finalConfirmPending.value
  finalConfirmPending.value = null
  await performSubmit(pending.value, pending.confirmationLevel)
}

function cancelFinalSubmission() {
  finalConfirmPending.value = null
}

function handleCancelAnomaly() {
  flow.value = resetAnomalyOnEdit(flow.value)
}

function handleEnter(e) {
  submit(0)
  if (typeof document !== 'undefined') {
    const allInputs = Array.from(
      document.querySelectorAll('input[id^="meter-input-"]:not([disabled])'),
    )
    const currentIndex = allInputs.indexOf(e.target)
    if (currentIndex >= 0 && currentIndex < allInputs.length - 1) {
      allInputs[currentIndex + 1].focus()
      allInputs[currentIndex + 1].select()
    }
  }
}

defineExpose({
  submit,
})
</script>

<template>
  <div class="bg-surface-container-low p-space-md rounded-lg flex flex-col justify-between gap-space-sm border border-surface-container">
    <!-- Top Info Row -->
    <div>
      <div class="flex items-start justify-between text-on-surface-variant mb-2 gap-2">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5 font-label-md text-label-md text-on-surface font-semibold">
            <span class="material-symbols-outlined text-[18px] shrink-0" :class="resourceIconClass">
              {{ resourceIcon }}
            </span>
            <span class="truncate">{{ resourceLabel }}</span>
          </div>
          <div class="flex items-center gap-1.5 text-xs text-on-surface-variant mt-0.5 pl-6">
            <span v-if="meter.location_label" class="truncate">{{ meter.location_label }}</span>
            <span v-if="meter.serial_number" class="font-mono text-[11px] whitespace-nowrap shrink-0">
              • #{{ meter.serial_number }}
            </span>
          </div>
        </div>
        <div class="shrink-0">
          <StatusChip :status="meterStatus" />
        </div>
      </div>

      <div
        v-if="useNextSubmission && formCtx.hasForm"
        class="flex flex-wrap items-center justify-between gap-1.5 py-1.5 px-2.5 mb-1.5 rounded-md text-xs"
        :class="
          formCtx.isFinal
            ? 'bg-amber-100/90 text-amber-950 dark:bg-amber-950/50 dark:text-amber-200 border border-amber-300/70'
            : 'bg-surface-container text-on-surface'
        "
      >
        <div class="flex items-center gap-1.5 font-semibold">
          <span class="material-symbols-outlined text-[15px]">calendar_today</span>
          <span>{{ session.t('readings.meterCard.readingForMonth', { month: targetMonthTitle }) }}</span>
          <span
            v-if="formCtx.isFinal"
            class="px-1.5 py-0.5 rounded bg-amber-200/90 dark:bg-amber-900 text-amber-950 dark:text-amber-100 text-[10px] font-bold uppercase tracking-wider"
          >
            {{ session.t('readings.meterCard.lateFinalBadge') }}
          </span>
        </div>
        <span v-if="formattedSubDueDate" class="text-[11px] opacity-85 font-medium">
          {{ session.t('readings.meterCard.dueBy', { date: formattedSubDueDate }) }}
        </span>
      </div>

      <p
        v-if="useNextSubmission && formCtx.hasForm && formCtx.isFinal"
        class="text-[11px] text-amber-900 dark:text-amber-200 mb-1.5 leading-snug"
      >
        {{ session.t('readings.meterCard.finalWarningBody', finalWarningMonths) }}
      </p>

      <div class="flex items-baseline justify-between py-1 text-on-surface-variant font-label-md text-label-md">
        <span>{{ session.t('readings.meterCard.previousReading') }}</span>
        <span class="font-mono tabular-nums text-on-surface font-medium">
          {{ effectivePreviousValue }} {{ displayUnit }}
        </span>
      </div>

      <div
        v-if="meter.previous_delta || effectiveAverageDelta"
        class="flex flex-wrap items-center justify-between gap-2 pb-1 text-[11px] text-on-surface-variant border-b border-surface-container/60"
      >
        <span v-if="meter.previous_delta" class="font-mono tabular-nums">
          {{ session.t('readings.meterCard.lastMonth') }}
          <strong class="text-on-surface">+{{ meter.previous_delta }} {{ displayUnit }}</strong>
        </span>
        <span v-if="effectiveAverageDelta" class="font-mono tabular-nums">
          {{ session.t('readings.meterCard.threeMoAvg') }}
          <strong class="text-on-surface">{{ effectiveAverageDelta }} {{ displayUnit }}</strong>
        </span>
      </div>
    </div>

    <!-- Nothing to submit state when next_submission is null in resident mode -->
    <div
      v-if="useNextSubmission && !formCtx.hasForm"
      class="p-3 rounded-lg bg-surface-container text-on-surface-variant text-xs flex items-start gap-2"
    >
      <span class="material-symbols-outlined text-[16px] shrink-0 mt-0.5">lock_clock</span>
      <div>
        <p class="font-semibold text-on-surface">
          {{ session.t('readings.meterCard.nothingToSubmitTitle') }}
        </p>
        <p class="text-[11px] opacity-85 mt-0.5">
          {{ session.t('readings.meterCard.nothingToSubmitDesc') }}
        </p>
      </div>
    </div>

    <!-- Input Field -->
    <div v-else class="flex flex-col gap-1">
      <div class="flex items-center justify-between gap-2 mb-0.5">
        <div class="flex items-center gap-2">
          <label
            :for="`meter-input-${meter.meter_id}`"
            class="font-label-md text-label-md text-on-surface font-semibold"
          >
            {{ session.t('readings.meterCard.newReading') }}
          </label>

          <!-- Inline live consumption delta chip -->
          <span
            v-if="liveDelta !== null && !isInputDisabled"
            class="px-2 py-0.5 rounded-full text-[11px] font-mono font-bold inline-flex items-center gap-1 transition-all"
            :class="
              liveDelta.startsWith('-')
                ? 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-200'
                : isSameAsPrevious
                  ? 'bg-surface-container-high text-on-surface-variant'
                  : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200'
            "
          >
            <span>{{ isSameAsPrevious ? '0.000' : formatSignedDelta(liveDelta) }}</span>
            <span class="text-[10px] font-normal opacity-80">{{ displayUnit }}</span>
          </span>
        </div>

        <button
          v-if="!isInputDisabled && effectivePreviousValue"
          type="button"
          :disabled="submitting"
          :aria-pressed="isSameAsPrevious"
          :title="session.t('readings.meterCard.sameAsPreviousTooltip', { value: effectivePreviousValue, unit: displayUnit })"
          class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] leading-none transition-colors border cursor-pointer select-none disabled:opacity-50"
          :class="
            isSameAsPrevious
              ? 'bg-secondary-container/70 text-on-secondary-container border-secondary/40 font-semibold'
              : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant/60 hover:text-on-surface hover:border-outline hover:bg-surface-container-high/50 font-medium'
          "
          @click="applyPreviousReading"
        >
          <svg
            v-if="isSameAsPrevious"
            class="w-2.5 h-2.5 text-secondary shrink-0"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M2.5 6.5L5 9L9.5 3.5" />
          </svg>
          <svg
            v-else
            class="w-2.5 h-2.5 text-on-surface-variant shrink-0"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect x="2" y="2" width="8" height="8" rx="1.5" />
          </svg>
          <span>{{ session.t('readings.meterCard.sameAsPreviousBtn', { unit: displayUnit }) }}</span>
        </button>
        <span v-else class="text-on-surface-variant text-[11px] font-normal">{{ displayUnit }}</span>
      </div>

      <div class="flex items-center gap-2">
        <div class="relative flex-1">
          <input
            :id="`meter-input-${meter.meter_id}`"
            :value="input"
            type="text"
            inputmode="decimal"
            :disabled="isInputDisabled || submitting"
            :placeholder="effectivePreviousValue"
            class="w-full h-11 px-3 pr-16 bg-surface-container-lowest border rounded-lg font-numeric-display tabular-nums text-lg text-on-surface font-semibold focus:outline-none focus:ring-2 focus:ring-primary shadow-2xs disabled:opacity-60 disabled:bg-surface-container"
            :class="flow.fieldError ? 'border-error focus:ring-error' : 'border-outline-variant'"
            @input="handleInputEdit"
            @keydown.enter.prevent="handleEnter"
            @keydown.up.prevent="stepReadingByTenths(1)"
            @keydown.down.prevent="stepReadingByTenths(-1)"
          />
          <div class="absolute right-2 inset-y-0 flex items-center gap-1">
            <span class="text-xs text-on-surface-variant font-medium pointer-events-none select-none">
              {{ displayUnit }}
            </span>
            <div
              v-if="!isInputDisabled"
              class="flex flex-col items-center justify-center w-4 h-6 rounded border border-outline-variant/50 bg-surface-container-low/80 overflow-hidden divide-y divide-outline-variant/40 shrink-0"
            >
              <button
                type="button"
                :disabled="submitting"
                :title="session.t('readings.meterCard.stepUpTooltip')"
                :aria-label="session.t('readings.meterCard.stepUpTooltip')"
                class="w-full h-3 flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high active:bg-primary/15 transition-colors disabled:opacity-40 cursor-pointer"
                @click="stepReadingByTenths(1)"
              >
                <svg class="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2.5 6.25L5 3.75L7.5 6.25" />
                </svg>
              </button>
              <button
                type="button"
                :disabled="submitting"
                :title="session.t('readings.meterCard.stepDownTooltip')"
                :aria-label="session.t('readings.meterCard.stepDownTooltip')"
                class="w-full h-3 flex items-center justify-center text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high active:bg-primary/15 transition-colors disabled:opacity-40 cursor-pointer"
                @click="stepReadingByTenths(-1)"
              >
                <svg class="w-2.5 h-2.5" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M2.5 3.75L5 6.25L7.5 3.75" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <button
          v-if="!isInputDisabled"
          type="button"
          :disabled="submitting"
          class="h-11 px-3.5 rounded-lg bg-primary text-on-primary hover:bg-primary-container font-label-md text-xs font-semibold transition-colors shrink-0 inline-flex items-center gap-1 disabled:opacity-50"
          @click="submit(0)"
        >
          <span v-if="submitting" class="material-symbols-outlined text-[16px] animate-spin">sync</span>
          <span v-else class="material-symbols-outlined text-[16px]">check</span>
          <span>{{ session.t('common.save') }}</span>
        </button>
      </div>

      <!-- Optional/Required Reason field when Board/Accountant overrides an existing reading -->
      <div v-if="needsReasonField && !isInputDisabled" class="mt-1.5">
        <label
          :for="`meter-reason-${meter.meter_id}`"
          class="block font-label-md text-[11px] text-on-surface-variant mb-0.5"
        >
          {{ session.t('readings.meterCard.reasonLabel') }}
        </label>
        <input
          :id="`meter-reason-${meter.meter_id}`"
          v-model="reason"
          type="text"
          maxlength="500"
          :placeholder="session.t('readings.meterCard.reasonPlaceholder')"
          class="w-full h-9 px-2.5 bg-surface-container-lowest border border-outline-variant rounded-md text-xs text-on-surface focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <!-- Field / API Error Message -->
      <p
        v-if="errorMessage"
        role="alert"
        class="text-xs text-error font-semibold mt-1 flex items-center gap-1"
      >
        <span class="material-symbols-outlined text-[15px] shrink-0">error</span>
        <span>{{ errorMessage }}</span>
      </p>

      <p
        v-else-if="isLockedByBoardForResident"
        class="text-[11px] text-on-surface-variant mt-1 flex items-center gap-1"
      >
        <span class="material-symbols-outlined text-[14px] text-secondary">shield</span>
        <span>
          {{ session.t('readings.meterCard.verifiedByBoard') }}
        </span>
      </p>
    </div>

    <!-- Consumption Delta & Audit History Trigger -->
    <div class="pt-1 flex items-center justify-between font-label-md text-label-md border-t border-surface-container/60">
      <div class="flex items-center gap-1.5">
        <span class="text-on-surface-variant">
          {{ session.t('readings.meterCard.consumption') }}
        </span>
        <span
          v-if="liveDelta !== null"
          class="font-bold font-mono tabular-nums flex items-center gap-0.5"
          :class="
            liveDelta.startsWith('-')
              ? 'text-error'
              : effectiveReading?.is_anomaly_confirmed
                ? 'text-error'
                : 'text-secondary'
          "
        >
          {{ formatSignedDelta(liveDelta) }} {{ displayUnit }}
        </span>
        <span v-else class="text-on-surface-variant">—</span>
      </div>

      <button
        v-if="historyReadingId"
        type="button"
        class="text-xs text-on-surface-variant hover:text-on-surface inline-flex items-center gap-1 font-medium transition-colors"
        @click="$emit('open-history', historyReadingId, `${resourceLabel} (${meter.location_label})`)"
      >
        <span class="material-symbols-outlined text-[15px]">history</span>
        <span>{{ session.t('readings.meterCard.history') }}</span>
      </button>
    </div>

    <!-- Late Final Reading Confirmation Modal -->
    <BaseModal
      :open="Boolean(finalConfirmPending)"
      :title="session.t('readings.meterCard.finalWarningTitle')"
      :subtitle="`${resourceLabel} • ${meter.location_label || meter.serial_number || ''}`"
      max-width="max-w-md"
      @close="cancelFinalSubmission"
    >
      <template #icon>
        <div class="w-9 h-9 rounded-lg bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-[20px]">event_busy</span>
        </div>
      </template>

      <div class="space-y-3">
        <p class="font-body-sm text-body-sm text-on-surface leading-relaxed">
          {{ session.t('readings.meterCard.finalWarningBody', finalWarningMonths) }}
        </p>
        <div
          v-if="finalConfirmPending"
          class="p-3 rounded-xl bg-surface-container-low border border-surface-container flex items-center justify-between text-xs"
        >
          <span class="text-on-surface-variant">{{ session.t('readings.meterCard.newReading') }}</span>
          <strong class="font-mono text-sm text-on-surface">
            {{ finalConfirmPending.value }} {{ displayUnit }}
          </strong>
        </div>
      </div>

      <template #footer>
        <BaseButton variant="secondary" :disabled="submitting" @click="cancelFinalSubmission">
          {{ session.t('common.cancel') }}
        </BaseButton>
        <BaseButton variant="primary" :loading="submitting" @click="confirmFinalSubmission">
          {{ session.t('readings.meterCard.finalConfirmBtn', finalWarningMonths) }}
        </BaseButton>
      </template>
    </BaseModal>

    <!-- Two-Popup Anomaly Confirmation Modal (child of MeterCard only) -->
    <MeterCardAnomalyModal
      :anomaly="flow.anomaly"
      :pending-value="flow.pendingValue || ''"
      :unit="meter.unit"
      :meter-label="`${resourceLabel} • ${meter.location_label || meter.serial_number || ''}`"
      :submitting="submitting"
      @confirm="(step) => submit(step)"
      @cancel="handleCancelAnomaly"
    />
  </div>
</template>
