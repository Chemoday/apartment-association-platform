import test from 'node:test'
import assert from 'node:assert/strict'
import { formatMonthName, getNextPeriodCode } from './dates.js'
import {
  getFinalWarningMonths,
  isMeterReportedForActivePeriod,
  resolveResidentFormContext,
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
