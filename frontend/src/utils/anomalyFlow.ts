import { asApiErrorLike } from '@/api/client.js'
import { normalizeMeterInput } from './meterValue.js'

export interface AnomalyPopupInfo {
  step: number
  delta: string
  average: string | null
  limit: string | null
}

export interface AnomalyFlowState {
  anomaly: AnomalyPopupInfo | null
  pendingValue: string | null
  fieldError: string | null
  apiError: unknown
}

export interface PreparedReadingSubmission {
  ok: boolean
  value?: string
  confirmationLevel?: number
  nextState: AnomalyFlowState
}

/**
 * Pure state helpers for the two-popup anomaly confirmation flow (Task 6).
 * Always starts at confirmation_level: 0.
 * Editing input while a popup is open cancels the popup and restarts at level 0.
 */
export function createAnomalyFlowState(): AnomalyFlowState {
  return {
    anomaly: null,
    pendingValue: null,
    fieldError: null,
    apiError: null,
  }
}

/**
 * Prepare a submission payload and validate input before sending.
 */
export function prepareReadingSubmission(
  state: AnomalyFlowState,
  rawInput: string | number | null | undefined,
  requestedLevel: number = 0,
): PreparedReadingSubmission {
  const level = state.anomaly ? requestedLevel : 0
  const value = level === 0 ? normalizeMeterInput(rawInput) : state.pendingValue

  if (value === null) {
    return {
      ok: false,
      nextState: {
        ...state,
        anomaly: null,
        fieldError: 'invalid_number',
        apiError: null,
      },
    }
  }

  return {
    ok: true,
    value,
    confirmationLevel: level,
    nextState: {
      ...state,
      pendingValue: value,
      fieldError: null,
      apiError: null,
    },
  }
}

/**
 * Transition state based on an API error from POST /api/v1/meters/readings.
 */
export function transitionOnReadingError(
  state: AnomalyFlowState,
  error: unknown,
): AnomalyFlowState {
  const errLike = asApiErrorLike(error)
  const code = errLike.errorCode || ''
  const payload = (errLike.payload || {}) as Record<string, string | null | undefined>

  if (code === 'ANOMALY_CONFIRMATION_STEP_1') {
    return {
      ...state,
      fieldError: null,
      apiError: null,
      anomaly: {
        step: 1,
        delta: payload.consumption_delta || '0.000',
        average: payload.average_delta || null,
        limit: payload.max_reasonable_delta || null,
      },
    }
  }

  if (code === 'ANOMALY_CONFIRMATION_STEP_2') {
    return {
      ...state,
      fieldError: null,
      apiError: null,
      anomaly: {
        step: 2,
        delta: payload.consumption_delta || state.anomaly?.delta || '0.000',
        average: state.anomaly?.average || null,
        limit: state.anomaly?.limit || null,
      },
    }
  }

  if (code === 'READING_BELOW_PREVIOUS') {
    return {
      ...state,
      anomaly: null,
      fieldError: 'READING_BELOW_PREVIOUS',
      apiError: error,
    }
  }

  if (code === 'REASON_REQUIRED') {
    return {
      ...state,
      anomaly: null,
      fieldError: 'REASON_REQUIRED',
      apiError: error,
    }
  }

  return {
    ...state,
    anomaly: null,
    fieldError: code || 'UNKNOWN_ERROR',
    apiError: error,
  }
}

/**
 * Reset anomaly flow when the user edits the input value or cancels the modal.
 */
export function resetAnomalyOnEdit(state: AnomalyFlowState): AnomalyFlowState {
  return {
    ...state,
    anomaly: null,
    pendingValue: null,
    fieldError: null,
    apiError: null,
  }
}
