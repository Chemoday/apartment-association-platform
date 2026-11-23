<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
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
import {
  getFinalWarningMonths,
  resolveResidentFormContext,
  resolveStartPreviousValueSubmission,
} from '@/utils/nextSubmission.js'
import { localizeError } from '@/locales/index.js'
import { useSessionStore } from '@/stores/session.js'
import { useRole } from '@/composables/useRole.js'
import BaseButton from '@/components/base/BaseButton.vue'
import BaseModal from '@/components/base/BaseModal.vue'
import StatusChip from '@/components/domain/StatusChip.vue'
import MeterCardAnomalyModal from './MeterCardAnomalyModal.vue'

const props = defineProps({
  meter: {
    type: Object, // DashboardMeter or MasterMeterRow or MatrixMeter
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
  preservedBillPreviousDraft: {
    type: Object, // { value: string, touched?: boolean } | null
    default: null,
  },
})

const emit = defineEmits(['saved', 'open-history', 'draft-change', 'wrong-period'])

const session = useSessionStore()
const { canSubmitAnyMeter } = useRole()

const formCtx = computed(() => resolveResidentFormContext(props.meter, props.useNextSubmission))
const effectivePeriodCode = computed(() => formCtx.value.periodCode || props.periodCode)
const effectiveNeedsStart = computed(() => formCtx.value.needsStart)
const effectivePreviousValue = computed(() => formCtx.value.previousValue)
const effectiveAverageDelta = computed(() => formCtx.value.averageDelta)
const effectiveReading = computed(() => formCtx.value.reading)
const readingOrigin = computed(() => effectiveReading.value?.previous_origin || null)

const normalizedSerialNumber = computed(() => {
  if (props.meter.serial_number === null || props.meter.serial_number === undefined) return ''
  return String(props.meter.serial_number).trim()
})

const input = ref(
  props.preservedDraft !== null ? props.preservedDraft : effectiveReading.value?.value || '',
)
const billPreviousInput = ref(
  props.preservedBillPreviousDraft?.touched
    ? String(props.preservedBillPreviousDraft.value ?? '')
    : formCtx.value.initialBillPreviousValue,
)
const billPreviousTouched = ref(Boolean(props.preservedBillPreviousDraft?.touched))
const billPreviousError = ref('')
const pendingBillPreviousPatch = ref(null) // { include: boolean, value?: string | null } | null
const localSavedBaseline = ref(null) // { meterId, periodCode, initialBillPreviousValue, hasPrefilledBillPrevious } | null
const reason = ref('')
const submitting = ref(false)
const flow = ref(createAnomalyFlowState())
const finalConfirmPending = ref(null) // { value: string, confirmationLevel: number, billPreviousPatch: any } | null

let isUnmounted = false
let submitSeq = 0

onBeforeUnmount(() => {
  isUnmounted = true
  submitSeq += 1
})

function activeBillBaseline() {
  const local = localSavedBaseline.value
  if (
    local &&
    local.meterId === props.meter.meter_id &&
    local.periodCode === effectivePeriodCode.value
  ) {
    return local
  }
  return {
    initialBillPreviousValue: formCtx.value.initialBillPreviousValue,
    hasPrefilledBillPrevious: formCtx.value.hasPrefilledBillPrevious,
  }
}

watch(
  () => [
    props.meter.meter_id,
    effectivePeriodCode.value,
    session.actingUserId,
    props.preservedDraft,
    props.preservedBillPreviousDraft,
    effectiveReading.value?.value,
  ],
  ([newMeterId, newPeriod, newUserId, draft, billDraft, newVal], oldTuple) => {
    const prevMeterId = oldTuple?.[0]
    const prevPeriod = oldTuple?.[1]
    const prevUserId = oldTuple?.[2]
    const prevVal = oldTuple?.[5]

    if (newMeterId !== prevMeterId || newPeriod !== prevPeriod || newUserId !== prevUserId) {
      submitSeq += 1
      submitting.value = false
      localSavedBaseline.value = null
      input.value = draft !== null && draft !== undefined ? draft : newVal || ''
      reason.value = ''
      flow.value = createAnomalyFlowState()
      finalConfirmPending.value = null
      pendingBillPreviousPatch.value = null
      billPreviousError.value = ''
      if (billDraft?.touched) {
        billPreviousInput.value = String(billDraft.value ?? '')
        billPreviousTouched.value = true
      } else {
        billPreviousInput.value = formCtx.value.initialBillPreviousValue
        billPreviousTouched.value = false
      }
      return
    }

    if (draft !== null && draft !== undefined) {
      input.value = draft
    } else if (newVal !== prevVal) {
      input.value = newVal || ''
    }

    if (billDraft?.touched) {
      billPreviousInput.value = String(billDraft.value ?? '')
      billPreviousTouched.value = true
      billPreviousError.value = ''
    }
  },
)

watch(
  () => [
    formCtx.value.needsStart,
    formCtx.value.initialBillPreviousValue,
    formCtx.value.hasPrefilledBillPrevious,
    effectiveReading.value?.reading_id,
    effectiveReading.value?.previous_origin,
  ],
  () => {
    const local = localSavedBaseline.value
    const serverCaughtUpToLocalSave =
      Boolean(local) &&
      local.meterId === props.meter.meter_id &&
      local.periodCode === effectivePeriodCode.value &&
      Boolean(local.readingId) &&
      effectiveReading.value?.reading_id === local.readingId &&
      formCtx.value.initialBillPreviousValue === local.initialBillPreviousValue &&
      formCtx.value.hasPrefilledBillPrevious === local.hasPrefilledBillPrevious

    if (serverCaughtUpToLocalSave) {
      localSavedBaseline.value = null
      if (!billPreviousTouched.value && !props.preservedBillPreviousDraft?.touched) {
        billPreviousInput.value = formCtx.value.initialBillPreviousValue
      }
      return
    }

    localSavedBaseline.value = null
    flow.value = createAnomalyFlowState()
    finalConfirmPending.value = null
    pendingBillPreviousPatch.value = null
    billPreviousError.value = ''

    if (!props.preservedBillPreviousDraft?.touched) {
      billPreviousInput.value = formCtx.value.initialBillPreviousValue
      billPreviousTouched.value = false
    }
  },
)

const displayUnit = computed(() => {
  const unitKey = `units.${props.meter.unit}`
  const translated = session.t(unitKey)
  if (translated && translated !== unitKey) return translated
  return props.meter.unit === 'm3' ? 'm³' : props.meter.unit
})

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
    case 'HEATING':
      return session.t('readings.meterCard.thermalEnergy')
    case 'GAS':
      return session.t('resources.GAS')
    default: {
      const key = `resources.${props.meter.resource_type}`
      const translated = session.t(key)
      return translated && translated !== key ? translated : props.meter.resource_type
    }
  }
})

const meterDetailLabel = computed(
  () => props.meter.location_label || normalizedSerialNumber.value || '',
)

const meterModalSubtitle = computed(() =>
  meterDetailLabel.value ? `${resourceLabel.value} • ${meterDetailLabel.value}` : resourceLabel.value,
)

const resourceIcon = computed(() => {
  switch (props.meter.resource_type) {
    case 'COLD_WATER':
      return 'water_drop'
    case 'HOT_WATER':
      return 'mode_heat'
    case 'ELECTRICITY':
      return 'bolt'
    case 'GAS':
      return 'local_fire_department'
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
    case 'GAS':
      return 'text-orange-600'
    default:
      return 'text-secondary'
  }
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

const normalizedBillPrevious = computed(() => {
  if (!effectiveNeedsStart.value) return null
  const trimmed = String(billPreviousInput.value ?? '').trim()
  if (!trimmed) return null
  return normalizeMeterInput(trimmed)
})

// Live consumption delta computed via scaled BigInt
const liveDelta = computed(() => {
  if (isInputDisabled.value && readingOrigin.value === 'START') {
    return null
  }
  const normalized = normalizeMeterInput(input.value)
  if (effectiveNeedsStart.value) {
    if (normalized !== null && normalizedBillPrevious.value !== null) {
      return subtractMeterValues(normalized, normalizedBillPrevious.value)
    }
    return null
  }
  if (normalized !== null && effectivePreviousValue.value !== null) {
    return subtractMeterValues(normalized, effectivePreviousValue.value)
  }
  if (readingOrigin.value === 'START') return null
  return effectiveReading.value?.consumption_delta || null
})

// Whether the current input matches the previous reading (resulting in 0.000 consumption)
const isSameAsPrevious = computed(() => {
  if (effectiveNeedsStart.value) return false
  const normalized = normalizeMeterInput(input.value)
  if (normalized === null || effectivePreviousValue.value === null) return false
  return compareMeterValues(normalized, effectivePreviousValue.value) === 0
})

const errorMessage = computed(() => {
  if (!flow.value.fieldError) return ''
  if (flow.value.fieldError === 'VALIDATION_ERROR') {
    return localizeError('VALIDATION_ERROR', {}, session.lang)
  }
  const rawPrev = flow.value.apiError?.payload?.previous_value
  const formattedServerPrev =
    rawPrev !== undefined && rawPrev !== null
      ? String(rawPrev).includes(' ')
        ? String(rawPrev)
        : `${rawPrev} ${displayUnit.value}`
      : undefined
  const fallbackPrev =
    formattedServerPrev ||
    (normalizedBillPrevious.value
      ? `${normalizedBillPrevious.value} ${displayUnit.value}`
      : effectivePreviousValue.value !== null
        ? `${effectivePreviousValue.value} ${displayUnit.value}`
        : undefined)
  return localizeError(
    flow.value.fieldError,
    {
      ...flow.value.apiError?.payload,
      ...(fallbackPrev !== undefined ? { previous_value: fallbackPrev } : {}),
    },
    session.lang,
  )
})

const billPreviousErrorMessage = computed(() => {
  if (!billPreviousError.value) return ''
  return localizeError(billPreviousError.value, {}, session.lang)
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
  pendingBillPreviousPatch.value = null
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

function handleBillPreviousEdit(event) {
  billPreviousInput.value = event.target.value
  billPreviousTouched.value = true
  billPreviousError.value = ''
  pendingBillPreviousPatch.value = null
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

function handleReasonInput(event) {
  reason.value = event?.target?.value ?? ''
  if (flow.value.fieldError === 'REASON_REQUIRED') {
    flow.value = resetAnomalyOnEdit(flow.value)
  }
}

function applyPreviousReading() {
  if (
    isInputDisabled.value ||
    submitting.value ||
    effectiveNeedsStart.value ||
    effectivePreviousValue.value === null
  ) {
    return
  }
  updateInputValue(effectivePreviousValue.value)
}

function stepReadingByTenths(stepTenths) {
  if (isInputDisabled.value || submitting.value) return
  const fallbackBase =
    (effectiveNeedsStart.value ? null : effectivePreviousValue.value) ||
    effectiveReading.value?.value ||
    '0.000'
  const nextVal = stepMeterValue(input.value, fallbackBase, stepTenths)
  updateInputValue(nextVal)
}

async function performSubmit(value, confirmationLevel, billPreviousPatch = null) {
  const seq = ++submitSeq
  const submittedMeterId = props.meter.meter_id
  const submittedPeriodCode = effectivePeriodCode.value
  const submittedUserId = session.actingUserId
  const submittedNeedsStart = effectiveNeedsStart.value
  const submittedDraftValue = input.value
  const submittedBillPreviousValue = billPreviousInput.value
  const submittedBillPreviousTouched = billPreviousTouched.value

  const isStale = () =>
    isUnmounted ||
    seq !== submitSeq ||
    props.meter.meter_id !== submittedMeterId ||
    effectivePeriodCode.value !== submittedPeriodCode ||
    session.actingUserId !== submittedUserId

  submitting.value = true
  try {
    const payload = {
      meter_id: submittedMeterId,
      period_code: submittedPeriodCode,
      value,
      confirmation_level: confirmationLevel,
      reason: reason.value.trim() || null,
    }
    if (submittedNeedsStart && billPreviousPatch?.include) {
      payload.previous_value = billPreviousPatch.value
    }
    const savedReading = await submitReading(payload)
    if (isStale()) return

    flow.value = createAnomalyFlowState()
    finalConfirmPending.value = null
    pendingBillPreviousPatch.value = null
    billPreviousError.value = ''
    billPreviousTouched.value = false
    reason.value = ''

    if (submittedNeedsStart) {
      if (savedReading?.previous_origin === 'SUBMITTED') {
        const derivedPrev =
          (savedReading?.value != null && savedReading?.consumption_delta != null
            ? subtractMeterValues(savedReading.value, savedReading.consumption_delta)
            : null) ||
          (typeof billPreviousPatch?.value === 'string' ? billPreviousPatch.value : null) ||
          activeBillBaseline().initialBillPreviousValue
        if (derivedPrev) {
          billPreviousInput.value = derivedPrev
          localSavedBaseline.value = {
            meterId: submittedMeterId,
            periodCode: submittedPeriodCode,
            readingId: savedReading?.reading_id || null,
            initialBillPreviousValue: derivedPrev,
            hasPrefilledBillPrevious: true,
          }
        }
      } else if (savedReading?.previous_origin === 'START') {
        billPreviousInput.value = ''
        localSavedBaseline.value = {
          meterId: submittedMeterId,
          periodCode: submittedPeriodCode,
          readingId: savedReading?.reading_id || null,
          initialBillPreviousValue: '',
          hasPrefilledBillPrevious: false,
        }
      }
    }

    input.value = savedReading.value
    emit('saved', savedReading)
  } catch (error) {
    if (isStale()) return

    if (error?.errorCode === 'WRONG_PERIOD') {
      flow.value = createAnomalyFlowState()
      finalConfirmPending.value = null
      pendingBillPreviousPatch.value = null
      emit('wrong-period', {
        meterId: submittedMeterId,
        targetPeriodCode: error.payload?.target_period_code || null,
        draftValue: submittedDraftValue,
        billPreviousValue: submittedBillPreviousValue,
        billPreviousTouched: submittedBillPreviousTouched,
      })
      return
    }

    if (error?.errorCode === 'VALIDATION_ERROR') {
      const fieldErrs = Array.isArray(error.fieldErrors)
        ? error.fieldErrors
        : Array.isArray(error.payload?.errors)
          ? error.payload.errors
          : []
      const locFields = new Set(
        fieldErrs.map((e) => (Array.isArray(e?.loc) ? String(e.loc[e.loc.length - 1] ?? '') : '')),
      )
      pendingBillPreviousPatch.value = null
      if (locFields.has('previous_value')) {
        billPreviousError.value = 'invalid_number'
        if (!locFields.has('value') && !locFields.has('reason')) {
          flow.value = createAnomalyFlowState()
          return
        }
      }
      if (locFields.has('reason')) {
        flow.value = { ...createAnomalyFlowState(), fieldError: 'REASON_REQUIRED' }
        return
      }
      if (locFields.has('value')) {
        flow.value = { ...createAnomalyFlowState(), fieldError: 'invalid_number' }
        return
      }
      flow.value = { ...createAnomalyFlowState(), fieldError: 'VALIDATION_ERROR' }
      return
    }

    flow.value = transitionOnReadingError(flow.value, error)
    if (!flow.value.anomaly) {
      pendingBillPreviousPatch.value = null
    }
  } finally {
    if (!isUnmounted && seq === submitSeq) {
      submitting.value = false
    }
  }
}

async function submit(level = 0) {
  if (submitting.value || isInputDisabled.value) return

  const prep = prepareReadingSubmission(flow.value, input.value, level)
  flow.value = prep.nextState
  if (!prep.ok) {
    pendingBillPreviousPatch.value = null
    return
  }

  let billPreviousPatch = pendingBillPreviousPatch.value
  if (prep.confirmationLevel === 0 || !billPreviousPatch) {
    const baseline = activeBillBaseline()
    const resolved = resolveStartPreviousValueSubmission({
      needsStart: effectiveNeedsStart.value,
      rawInput: billPreviousInput.value,
      initialValue: baseline.initialBillPreviousValue,
      hasPrefilled: baseline.hasPrefilledBillPrevious,
      touched: billPreviousTouched.value,
    })
    if (!resolved.ok) {
      billPreviousError.value = resolved.errorCode || 'invalid_number'
      pendingBillPreviousPatch.value = null
      return
    }
    billPreviousError.value = ''
    billPreviousPatch = resolved
    pendingBillPreviousPatch.value = resolved
  }

  if (needsReasonField.value && !reason.value.trim()) {
    flow.value = {
      ...flow.value,
      fieldError: 'REASON_REQUIRED',
    }
    pendingBillPreviousPatch.value = null
    return
  }

  if (props.useNextSubmission && formCtx.value.isFinal && level === 0) {
    finalConfirmPending.value = {
      value: prep.value,
      confirmationLevel: prep.confirmationLevel,
      billPreviousPatch,
    }
    return
  }

  await performSubmit(prep.value, prep.confirmationLevel, billPreviousPatch)
}

async function confirmFinalSubmission() {
  if (!finalConfirmPending.value || submitting.value) return
  const pending = finalConfirmPending.value
  finalConfirmPending.value = null
  await performSubmit(pending.value, pending.confirmationLevel, pending.billPreviousPatch)
}

function cancelFinalSubmission() {
  finalConfirmPending.value = null
  pendingBillPreviousPatch.value = null
}

function handleCancelAnomaly() {
  flow.value = resetAnomalyOnEdit(flow.value)
  pendingBillPreviousPatch.value = null
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
          <div
            v-if="meter.location_label || normalizedSerialNumber"
            class="flex items-center gap-1.5 text-xs text-on-surface-variant mt-0.5 pl-6"
          >
            <span v-if="meter.location_label" class="truncate">{{ meter.location_label }}</span>
            <span
              v-if="normalizedSerialNumber"
              data-testid="meter-serial-number"
              class="font-mono text-[11px] whitespace-nowrap shrink-0"
            >
              <template v-if="meter.location_label">• </template>#{{ normalizedSerialNumber }}
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

      <!-- Origin / Previous Reading Summary -->
      <div
        v-if="readingOrigin === 'START'"
        data-testid="meter-origin-start"
        class="flex items-start gap-1.5 py-1.5 px-2.5 my-1 rounded-md bg-surface-container text-on-surface-variant text-xs font-medium"
      >
        <span class="material-symbols-outlined text-[15px] shrink-0 mt-0.5">flag</span>
        <span>{{ session.t('readings.meterCard.originStart') }}</span>
      </div>

      <div
        v-else-if="readingOrigin === 'SUBMITTED'"
        data-testid="meter-origin-submitted"
        class="flex items-baseline justify-between gap-2 py-1.5 px-2.5 my-1 rounded-md bg-secondary-container/35 text-on-surface text-xs"
      >
        <span class="inline-flex items-center gap-1.5 font-medium text-on-surface-variant min-w-0">
          <span class="material-symbols-outlined text-[15px] text-secondary shrink-0">receipt_long</span>
          <span class="truncate">{{ session.t('readings.meterCard.originSubmitted') }}</span>
        </span>
        <span
          v-if="effectiveReading?.previous_value"
          class="font-mono tabular-nums text-on-surface font-semibold shrink-0"
        >
          {{ effectiveReading.previous_value }} {{ displayUnit }}
        </span>
      </div>

      <div
        v-else-if="effectiveNeedsStart && effectivePreviousValue === null"
        data-testid="meter-no-start-yet"
        class="flex items-center gap-1.5 py-1 text-xs text-on-surface-variant font-medium"
      >
        <span class="material-symbols-outlined text-[15px] shrink-0">flag</span>
        <span>{{ session.t('readings.meterCard.noStartYet') }}</span>
      </div>

      <div
        v-else-if="effectivePreviousValue !== null"
        class="flex items-baseline justify-between py-1 text-on-surface-variant font-label-md text-label-md"
      >
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
          v-if="!isInputDisabled && !effectiveNeedsStart && effectivePreviousValue !== null"
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
            data-testid="meter-current-input"
            :value="input"
            type="text"
            inputmode="decimal"
            :disabled="isInputDisabled || submitting"
            :placeholder="effectiveNeedsStart ? (effectiveReading?.value || '0.000') : (effectivePreviousValue || '0.000')"
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
          data-testid="meter-save-btn"
          :disabled="submitting"
          class="h-11 px-3.5 rounded-lg bg-primary text-on-primary hover:bg-primary-container font-label-md text-xs font-semibold transition-colors shrink-0 inline-flex items-center gap-1 disabled:opacity-50"
          @click="submit(0)"
        >
          <span v-if="submitting" class="material-symbols-outlined text-[16px] animate-spin">sync</span>
          <span v-else class="material-symbols-outlined text-[16px]">check</span>
          <span>{{ session.t('common.save') }}</span>
        </button>
      </div>

      <!-- Optional "Reading on your last bill" field for meters without a start (#038) -->
      <div
        v-if="effectiveNeedsStart && !isInputDisabled"
        data-testid="meter-bill-previous-section"
        class="mt-2 pt-2 border-t border-surface-container/60"
      >
        <div class="flex items-center justify-between gap-2 mb-1">
          <label
            :for="`meter-prev-input-${meter.meter_id}`"
            class="font-label-md text-xs text-on-surface font-semibold"
          >
            {{ session.t('readings.meterCard.lastBillReadingLabel') }}
          </label>
          <span class="text-[11px] text-on-surface-variant font-normal">
            {{ session.t('readings.meterCard.optionalTag') }}
          </span>
        </div>
        <div class="relative">
          <input
            :id="`meter-prev-input-${meter.meter_id}`"
            data-testid="meter-bill-previous-input"
            :value="billPreviousInput"
            type="text"
            inputmode="decimal"
            :disabled="isInputDisabled || submitting"
            :placeholder="session.t('readings.meterCard.lastBillReadingPlaceholder')"
            class="w-full h-10 px-3 pr-12 bg-surface-container-lowest border rounded-lg font-numeric-display tabular-nums text-sm text-on-surface font-medium focus:outline-none focus:ring-2 focus:ring-primary shadow-2xs disabled:opacity-60 disabled:bg-surface-container"
            :class="billPreviousError ? 'border-error focus:ring-error' : 'border-outline-variant'"
            @input="handleBillPreviousEdit"
            @keydown.enter.prevent="submit(0)"
          />
          <span class="absolute right-3 inset-y-0 flex items-center text-xs text-on-surface-variant font-medium pointer-events-none select-none">
            {{ displayUnit }}
          </span>
        </div>
        <p
          v-if="billPreviousErrorMessage"
          role="alert"
          data-testid="meter-bill-previous-error"
          class="text-xs text-error font-semibold mt-1 flex items-center gap-1"
        >
          <span class="material-symbols-outlined text-[15px] shrink-0">error</span>
          <span>{{ billPreviousErrorMessage }}</span>
        </p>
        <p
          v-else
          data-testid="meter-bill-previous-help"
          class="text-[11px] text-on-surface-variant mt-1 leading-snug"
        >
          {{ session.t('readings.meterCard.lastBillReadingHelp') }}
        </p>
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
          :value="reason"
          type="text"
          maxlength="500"
          :disabled="isInputDisabled || submitting"
          :placeholder="session.t('readings.meterCard.reasonPlaceholder')"
          class="w-full h-9 px-2.5 bg-surface-container-lowest border border-outline-variant rounded-md text-xs text-on-surface focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
          @input="handleReasonInput"
        />
      </div>

      <!-- Field / API Error Message -->
      <p
        v-if="errorMessage"
        role="alert"
        data-testid="meter-error-message"
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
        @click="$emit('open-history', historyReadingId, meter.location_label ? `${resourceLabel} (${meter.location_label})` : resourceLabel)"
      >
        <span class="material-symbols-outlined text-[15px]">history</span>
        <span>{{ session.t('readings.meterCard.history') }}</span>
      </button>
    </div>

    <!-- Late Final Reading Confirmation Modal -->
    <BaseModal
      :open="Boolean(finalConfirmPending)"
      :title="session.t('readings.meterCard.finalWarningTitle')"
      :subtitle="meterModalSubtitle"
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
      :meter-label="meterModalSubtitle"
      :submitting="submitting"
      @confirm="(step) => submit(step)"
      @cancel="handleCancelAnomaly"
    />
  </div>
</template>
