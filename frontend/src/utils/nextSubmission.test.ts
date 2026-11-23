import test from 'node:test'
import assert from 'node:assert/strict'
import { formatMonthName, getNextPeriodCode } from './dates.js'
import {
  getFinalWarningMonths,
  isMeterReportedForActivePeriod,
  resolveResidentFormContext,
  resolveStartPreviousValueSubmission,
  summarizeNextSubmissions,
} from './nextSubmission.js'
import { localizeError } from '../locales/index.js'

test('getNextPeriodCode increments months and rolls over year boundaries', () => {
  assert.equal(getNextPeriodCode('2026-10'), '2026-11')
  assert.equal(getNextPeriodCode('2026-11'), '2026-12')
  assert.equal(getNextPeriodCode('2026-12'), '2027-01')
})

test('formatMonthName localizes standalone month names across en, et, and ru', () => {
  assert.equal(formatMonthName('2026-10', 'en', { capitalize: true }), 'October')
  assert.equal(formatMonthName('2026-11', 'en', { capitalize: true }), 'November')
  assert.equal(formatMonthName('2026-10', 'et'), 'oktoober')
  assert.equal(formatMonthName('2026-11', 'et', { capitalize: true }), 'November')
  assert.ok(formatMonthName('2026-10', 'ru', { capitalize: true }).length > 0)
  assert.ok(formatMonthName('2026-11', 'ru', { capitalize: true }).length > 0)
})

test('summarizeNextSubmissions prioritizes earliest pending next_submission period and counts reported meters', () => {
  const apt: any = {
    meters: [
      {
        meter_id: 'm1',
        reading: { value: '10.000' },
        next_submission: {
          period_code: '2026-11',
          due_date: '2026-12-04T21:59:59Z',
          final: false,
          previous_value: '10.000',
          average_delta: '3.000',
          reading: null,
        },
      },
      {
        meter_id: 'm2',
        reading: null,
        next_submission: {
          period_code: '2026-10',
          due_date: '2026-11-04T21:59:59Z',
          final: true,
          previous_value: '20.000',
          average_delta: '2.000',
          reading: null,
        },
      },
    ],
  }

  const summaryPending = summarizeNextSubmissions([apt])
  assert.equal(summaryPending.reported, 0)
  assert.equal(summaryPending.total, 2)
  assert.equal(summaryPending.allSubmitted, false)
  assert.equal(summaryPending.pendingPeriodCode, '2026-10')
  assert.equal(summaryPending.activePeriodCode, '2026-10')

  // Mark m2 submitted (moving to 2026-11 unreported) and m1 reported for 2026-11
  apt.meters[0].next_submission.reading = { value: '12.500', consumption_delta: '2.500' }
  apt.meters[1].next_submission = {
    period_code: '2026-11',
    due_date: '2026-12-04T21:59:59Z',
    final: false,
    previous_value: '21.000',
    average_delta: '2.000',
    reading: null,
  }

  assert.equal(isMeterReportedForActivePeriod(apt.meters[0]), true)
  assert.equal(isMeterReportedForActivePeriod(apt.meters[1]), false)

  const summaryNovPending = summarizeNextSubmissions([apt])
  assert.equal(summaryNovPending.reported, 1)
  assert.equal(summaryNovPending.allSubmitted, false)
  assert.equal(summaryNovPending.activePeriodCode, '2026-11')

  apt.meters[1].next_submission.reading = { value: '22.000', consumption_delta: '1.000' }
  const summaryDone = summarizeNextSubmissions([apt])
  assert.equal(summaryDone.reported, 2)
  assert.equal(summaryDone.allSubmitted, true)
  assert.equal(summaryDone.pendingPeriodCode, null)
  assert.equal(summaryDone.activePeriodCode, '2026-11')
})

test('resolveResidentFormContext uses next_submission when enabled and handles null', () => {
  const meter = {
    meter_id: 'm1',
    previous_value: '100.000',
    average_delta: '4.000',
    reading: { reading_id: 'r-oct', value: '104.000' },
    next_submission: {
      period_code: '2026-11',
      due_date: '2026-12-04T21:59:59Z',
      final: false,
      previous_value: '104.000',
      average_delta: '3.500',
      reading: null,
    },
  }

  const residentCtx = resolveResidentFormContext(meter, true)
  assert.equal(residentCtx.hasForm, true)
  assert.equal(residentCtx.periodCode, '2026-11')
  assert.equal(residentCtx.previousValue, '104.000')
  assert.equal(residentCtx.averageDelta, '3.500')
  assert.equal(residentCtx.reading, null)
  assert.equal(residentCtx.isFinal, false)

  const boardCtx = resolveResidentFormContext(meter, false)
  assert.equal(boardCtx.hasForm, true)
  assert.equal(boardCtx.previousValue, '100.000')
  assert.equal(boardCtx.reading?.value, '104.000')

  const lockedResidentCtx = resolveResidentFormContext(
    { ...meter, next_submission: null },
    true,
  )
  assert.equal(lockedResidentCtx.hasForm, false)
})

test('getFinalWarningMonths and WRONG_PERIOD error localization format target months', () => {
  const octDec = getFinalWarningMonths('2026-10', 'en')
  assert.equal(octDec.prevMonth, 'October')
  assert.equal(octDec.nextMonth, 'November')

  const decJan = getFinalWarningMonths('2026-12', 'en')
  assert.equal(decJan.prevMonth, 'December')
  assert.equal(decJan.nextMonth, 'January')

  const msgEn = localizeError('WRONG_PERIOD', { target_period_code: '2026-11' }, 'en')
  assert.match(msgEn, /November/)
  const msgEt = localizeError('WRONG_PERIOD', { target_period_code: '2026-11' }, 'et')
  assert.match(msgEt, /November/i)
  const msgRu = localizeError('WRONG_PERIOD', { target_period_code: '2026-11' }, 'ru')
  assert.equal(msgRu.includes('{month}'), false)
})

test('resolveResidentFormContext handles needs_start, START empty prefill, SUBMITTED prefill, and board mode (#038)', () => {
  // 1. Fresh meter without a start (no reading yet)
  const freshMeter = {
    meter_id: 'm-start',
    serial_number: null,
    previous_value: null,
    needs_start: true,
    average_delta: null,
    reading: null,
    next_submission: {
      period_code: '2026-11',
      due_date: '2026-12-04T21:59:59Z',
      final: false,
      previous_value: null,
      needs_start: true,
      average_delta: null,
      reading: null,
    },
  }
  const freshCtx = resolveResidentFormContext(freshMeter, true)
  assert.equal(freshCtx.hasForm, true)
  assert.equal(freshCtx.needsStart, true)
  assert.equal(freshCtx.previousValue, null)
  assert.equal(freshCtx.initialBillPreviousValue, '')
  assert.equal(freshCtx.hasPrefilledBillPrevious, false)

  // 2. Existing START reading -> bill field stays EMPTY (never prefilled with its own value!)
  const startMeter = {
    ...freshMeter,
    previous_value: '1250.000',
    next_submission: {
      ...freshMeter.next_submission,
      previous_value: '1250.000',
      needs_start: true,
      reading: {
        reading_id: 'r-start',
        value: '1250.000',
        previous_value: '1250.000',
        consumption_delta: '0.000',
        source: 'RESIDENT',
        is_anomaly_confirmed: false,
        previous_origin: 'START',
      },
    },
  }
  const startCtx = resolveResidentFormContext(startMeter, true)
  assert.equal(startCtx.needsStart, true)
  assert.equal(startCtx.previousValue, '1250.000')
  assert.equal(startCtx.initialBillPreviousValue, '')
  assert.equal(startCtx.hasPrefilledBillPrevious, false)

  // 3. Existing SUBMITTED reading -> bill field prefills reading.previous_value
  const submittedMeter = {
    ...freshMeter,
    previous_value: '120.500',
    next_submission: {
      ...freshMeter.next_submission,
      previous_value: '120.500',
      needs_start: true,
      reading: {
        reading_id: 'r-sub',
        value: '125.000',
        previous_value: '120.500',
        consumption_delta: '4.500',
        source: 'RESIDENT',
        is_anomaly_confirmed: false,
        previous_origin: 'SUBMITTED',
      },
    },
  }
  const submittedCtx = resolveResidentFormContext(submittedMeter, true)
  assert.equal(submittedCtx.needsStart, true)
  assert.equal(submittedCtx.initialBillPreviousValue, '120.500')
  assert.equal(submittedCtx.hasPrefilledBillPrevious, true)

  // 4. Board mode (useNextSubmission = false) reads meter.needs_start and meter.reading directly
  const boardSubmitted = resolveResidentFormContext(
    {
      meter_id: 'm-board',
      previous_value: '50.000',
      needs_start: true,
      reading: {
        reading_id: 'r-b',
        value: '55.000',
        previous_value: '50.000',
        consumption_delta: '5.000',
        source: 'RESIDENT',
        is_anomaly_confirmed: false,
        previous_origin: 'SUBMITTED',
      },
    },
    false,
  )
  assert.equal(boardSubmitted.hasForm, true)
  assert.equal(boardSubmitted.needsStart, true)
  assert.equal(boardSubmitted.initialBillPreviousValue, '50.000')
  assert.equal(boardSubmitted.hasPrefilledBillPrevious, true)

  // 5. Locked resident mode (next_submission: null) preserves meter.reading & hasForm: false
  const closedCtx = resolveResidentFormContext(
    {
      meter_id: 'm-closed',
      previous_value: '1250.000',
      needs_start: true,
      reading: startMeter.next_submission.reading,
      next_submission: null,
    },
    true,
  )
  assert.equal(closedCtx.hasForm, false)
  assert.equal(closedCtx.needsStart, true)
  assert.equal(closedCtx.reading?.previous_origin, 'START')
})

test('resolveStartPreviousValueSubmission enforces omitted vs null vs normalized string rules (#038)', () => {
  // Never sends previous_value when needsStart is false
  assert.deepEqual(
    resolveStartPreviousValueSubmission({
      needsStart: false,
      rawInput: '100.000',
      initialValue: '',
      hasPrefilled: false,
      touched: true,
    }),
    { ok: true, include: false },
  )

  // Untouched prefilled SUBMITTED field omits previous_value (keeps stored bill value)
  assert.deepEqual(
    resolveStartPreviousValueSubmission({
      needsStart: true,
      rawInput: '120.500',
      initialValue: '120.500',
      hasPrefilled: true,
      touched: false,
    }),
    { ok: true, include: false },
  )

  // Touched prefilled field edited to canonically equal value (e.g. '120,5' vs '120.500') still omits
  assert.deepEqual(
    resolveStartPreviousValueSubmission({
      needsStart: true,
      rawInput: '120,5',
      initialValue: '120.500',
      hasPrefilled: true,
      touched: true,
    }),
    { ok: true, include: false },
  )

  // Clearing a prefilled SUBMITTED field sends explicit null
  assert.deepEqual(
    resolveStartPreviousValueSubmission({
      needsStart: true,
      rawInput: '',
      initialValue: '120.500',
      hasPrefilled: true,
      touched: true,
    }),
    { ok: true, include: true, value: null },
  )
  assert.deepEqual(
    resolveStartPreviousValueSubmission({
      needsStart: true,
      rawInput: '   ',
      initialValue: '120.500',
      hasPrefilled: true,
      touched: true,
    }),
    { ok: true, include: true, value: null },
  )

  // Leaving a non-prefilled field empty omits previous_value (even if focused/touched)
  assert.deepEqual(
    resolveStartPreviousValueSubmission({
      needsStart: true,
      rawInput: '',
      initialValue: '',
      hasPrefilled: false,
      touched: true,
    }),
    { ok: true, include: false },
  )

  // Entering a valid decimal normalizes comma to dot and includes previous_value
  assert.deepEqual(
    resolveStartPreviousValueSubmission({
      needsStart: true,
      rawInput: ' 120,25 ',
      initialValue: '',
      hasPrefilled: false,
      touched: true,
    }),
    { ok: true, include: true, value: '120.25' },
  )
  assert.deepEqual(
    resolveStartPreviousValueSubmission({
      needsStart: true,
      rawInput: '0',
      initialValue: '',
      hasPrefilled: false,
      touched: true,
    }),
    { ok: true, include: true, value: '0' },
  )

  // Invalid inputs return invalid_number error
  for (const bad of ['abc', '-10', '1.2345', '12.3.4']) {
    assert.deepEqual(
      resolveStartPreviousValueSubmission({
        needsStart: true,
        rawInput: bad,
        initialValue: '',
        hasPrefilled: false,
        touched: true,
      }),
      { ok: false, include: false, errorCode: 'invalid_number' },
    )
  }
})
