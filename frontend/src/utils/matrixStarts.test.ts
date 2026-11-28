import test from 'node:test'
import assert from 'node:assert/strict'
import {
  collectMeterStartOrigins,
  formatIncompleteBalanceMessage,
  resolveSkippedMetersWithoutStart,
  summarizeWaterBalance,
} from './matrixStarts.js'
import {
  buildPeriodCsv,
  defaultMeterThresholdScaled,
  escapeCsvCell,
  subDecimal,
  toBigInt3,
  validatePeriodStatusTransition,
} from './metersMockHelpers.js'
import { i18n } from '../locales/index.js'

test('summarizeWaterBalance preserves null master_total/loss when any water master is missing or START (#039)', () => {
  // Partial read: COLD_WATER has master_total, HOT_WATER has null -> overall water master_total & loss MUST be null
  const partial = summarizeWaterBalance([
    {
      resource_type: 'COLD_WATER',
      unit: 'm3',
      master_total: '28.500',
      apartments_sum: '22.550',
      unallocated_loss: '5.950',
      starting_meters: 1,
    },
    {
      resource_type: 'HOT_WATER',
      unit: 'm3',
      master_total: null,
      apartments_sum: '7.850',
      unallocated_loss: null,
      starting_meters: 2,
    },
  ])
  assert.ok(partial)
  assert.equal(partial.allMastersRead, false)
  assert.equal(partial.master_total, null)
  assert.equal(partial.unallocated_loss, null)
  assert.equal(partial.lossPercentage, null)
  assert.equal(partial.apartments_sum, '30.400')
  assert.equal(partial.waterStartingMeters, 3)
  assert.equal(partial.totalStartingMeters, 3)

  // All read: computes exact BigInt totals and loss percentage
  const complete = summarizeWaterBalance([
    {
      resource_type: 'COLD_WATER',
      unit: 'm3',
      master_total: '28.500',
      apartments_sum: '22.550',
      unallocated_loss: '5.950',
      starting_meters: 0,
    },
    {
      resource_type: 'HOT_WATER',
      unit: 'm3',
      master_total: '21.500',
      apartments_sum: '25.000',
      unallocated_loss: '-3.500',
      starting_meters: 0,
    },
  ])
  assert.ok(complete)
  assert.equal(complete.allMastersRead, true)
  assert.equal(complete.master_total, '50.000')
  assert.equal(complete.apartments_sum, '47.550')
  assert.equal(complete.unallocated_loss, '2.450')
  assert.equal(complete.lossPercentage, '4.90%')
  assert.equal(complete.isNegativeLoss, false)

  // Negative overall loss formats cleanly with minus sign
  const negative = summarizeWaterBalance([
    {
      resource_type: 'COLD_WATER',
      unit: 'm3',
      master_total: '20.000',
      apartments_sum: '21.000',
      unallocated_loss: '-1.000',
      starting_meters: 0,
    },
  ])
  assert.ok(negative)
  assert.equal(negative.unallocated_loss, '-1.000')
  assert.equal(negative.lossPercentage, '-5.00%')
  assert.equal(negative.isNegativeLoss, true)

  // Zero master_total with non-zero apartments_sum MUST NOT report fake 0.00% loss (P2-2)
  const zeroMasterNegLoss = summarizeWaterBalance([
    {
      resource_type: 'COLD_WATER',
      unit: 'm3',
      master_total: '0.000',
      apartments_sum: '5.000',
      unallocated_loss: '-5.000',
      starting_meters: 0,
    },
  ])
  assert.ok(zeroMasterNegLoss)
  assert.equal(zeroMasterNegLoss.unallocated_loss, '-5.000')
  assert.equal(zeroMasterNegLoss.isNegativeLoss, true)
  assert.equal(zeroMasterNegLoss.lossPercentage, null)

  // Zero master_total and zero loss -> 0.00%
  const zeroZero = summarizeWaterBalance([
    {
      resource_type: 'COLD_WATER',
      unit: 'm3',
      master_total: '0.000',
      apartments_sum: '0.000',
      unallocated_loss: '0.000',
      starting_meters: 0,
    },
  ])
  assert.equal(zeroZero?.lossPercentage, '0.00%')

  // Non-null master_total with null unallocated_loss keeps awaiting state (P2-2)
  const nullLoss = summarizeWaterBalance([
    {
      resource_type: 'COLD_WATER',
      unit: 'm3',
      master_total: '10.000',
      apartments_sum: '8.000',
      unallocated_loss: null,
      starting_meters: 0,
    },
  ])
  assert.equal(nullLoss?.allMastersRead, false)
  assert.equal(nullLoss?.master_total, null)
  assert.equal(nullLoss?.unallocated_loss, null)

  // Empty balances (--no-building-meters) -> null
  assert.equal(summarizeWaterBalance([]), null)

  // Starting meters on non-water resource still counted in totalStartingMeters
  const withElec = summarizeWaterBalance([
    {
      resource_type: 'COLD_WATER',
      unit: 'm3',
      master_total: '10.000',
      apartments_sum: '9.500',
      unallocated_loss: '0.500',
      starting_meters: 0,
    },
    {
      resource_type: 'ELECTRICITY',
      unit: 'kWh',
      master_total: null,
      apartments_sum: '0.000',
      unallocated_loss: null,
      starting_meters: 2,
    },
  ])
  assert.ok(withElec)
  assert.equal(withElec.waterStartingMeters, 0)
  assert.equal(withElec.totalStartingMeters, 2)
})

test('collectMeterStartOrigins counts START and SUBMITTED origins separately (#039)', () => {
  assert.deepEqual(collectMeterStartOrigins([]), {
    hasStart: false,
    hasSubmitted: false,
    startCount: 0,
    submittedCount: 0,
  })
  assert.deepEqual(
    collectMeterStartOrigins([
      { reading: { previous_origin: 'HISTORY' } },
      { reading: { previous_origin: 'START' } },
      { reading: { previous_origin: 'SUBMITTED' } },
      { reading: null },
    ]),
    {
      hasStart: true,
      hasSubmitted: true,
      startCount: 1,
      submittedCount: 1,
    },
  )
})

test('resolveSkippedMetersWithoutStart maps meter IDs to apartment & resource sorted numerically with fallback (#039)', () => {
  const apartments = [
    {
      apartment_number: '14',
      meters: [
        { meter_id: 'm-14-hw', resource_type: 'HOT_WATER', location_label: 'Laundry Hot Water' },
      ],
    },
    {
      apartment_number: '2',
      meters: [
        { meter_id: 'm-2-cw', resource_type: 'COLD_WATER', location_label: 'Bathroom Cold Water' },
      ],
    },
  ]

  const resolved = resolveSkippedMetersWithoutStart(
    ['m-14-hw', 'm-unknown', 'm-2-cw', 'm-14-hw'],
    apartments,
  )
  assert.deepEqual(resolved, [
    {
      meter_id: 'm-2-cw',
      apartment_number: '2',
      resource_type: 'COLD_WATER',
      location_label: 'Bathroom Cold Water',
    },
    {
      meter_id: 'm-14-hw',
      apartment_number: '14',
      resource_type: 'HOT_WATER',
      location_label: 'Laundry Hot Water',
    },
    {
      meter_id: 'm-unknown',
      apartment_number: null,
      resource_type: null,
      location_label: null,
    },
  ])
})

test('formatIncompleteBalanceMessage localizes singular, Russian 3-form plurals (1/2/5/11/21/22), and plural counts (#039, P2-5)', () => {
  for (const locale of ['en', 'et', 'ru'] as const) {
    const t = (key: string, params?: Record<string, any>) =>
      i18n.global.t(key, params || {}, { locale })
    assert.equal(formatIncompleteBalanceMessage(0, t, locale), '')
    const one = formatIncompleteBalanceMessage(1, t, locale)
    const many = formatIncompleteBalanceMessage(3, t, locale)
    assert.ok(one.includes('1'))
    assert.ok(many.includes('3'))
    assert.notEqual(one, many)
  }

  const enT = (key: string, params?: Record<string, any>) =>
    i18n.global.t(key, params || {}, { locale: 'en' })
  assert.equal(
    formatIncompleteBalanceMessage(1, enT, 'en'),
    "This month's balance is incomplete: 1 meter started this month",
  )
  assert.equal(
    formatIncompleteBalanceMessage(4, enT, 'en'),
    "This month's balance is incomplete: 4 meters started this month",
  )

  const ruT = (key: string, params?: Record<string, any>) =>
    i18n.global.t(key, params || {}, { locale: 'ru' })
  assert.equal(
    formatIncompleteBalanceMessage(1, ruT, 'ru'),
    'Баланс за этот месяц неполный: 1 счётчик начал учёт в этом месяце',
  )
  assert.equal(
    formatIncompleteBalanceMessage(2, ruT, 'ru'),
    'Баланс за этот месяц неполный: 2 счётчика начали учёт в этом месяце',
  )
  assert.equal(
    formatIncompleteBalanceMessage(5, ruT, 'ru'),
    'Баланс за этот месяц неполный: 5 счётчиков начали учёт в этом месяце',
  )
  assert.equal(
    formatIncompleteBalanceMessage(11, ruT, 'ru'),
    'Баланс за этот месяц неполный: 11 счётчиков начали учёт в этом месяце',
  )
  assert.equal(
    formatIncompleteBalanceMessage(21, ruT, 'ru'),
    'Баланс за этот месяц неполный: 21 счётчик начал учёт в этом месяце',
  )
  assert.equal(
    formatIncompleteBalanceMessage(22, ruT, 'ru'),
    'Баланс за этот месяц неполный: 22 счётчика начали учёт в этом месяце',
  )
})

test('metersMockHelpers handles signed BigInt, status state machine, MWh thresholds, and 15-column CSV with formula guard (P1-8, P2-3, P2-6)', () => {
  // Signed BigInt parses negative decimals accurately (regression for -1.500 -> -500n bug)
  assert.equal(toBigInt3('-1.500'), -1500n)
  assert.equal(toBigInt3('-0.500'), -500n)
  assert.equal(subDecimal('1.000', '2.500'), '-1.500')

  // Period status state machine enforces one-step transitions
  assert.deepEqual(validatePeriodStatusTransition('OPEN_FOR_RESIDENTS', 'REVIEW_BY_BOARD'), {
    ok: true,
    nextStatus: 'REVIEW_BY_BOARD',
  })
  const jump = validatePeriodStatusTransition('OPEN_FOR_RESIDENTS', 'LOCKED')
  assert.equal(jump.ok, false)
  if (!jump.ok) {
    assert.equal(jump.status, 409)
    assert.equal(jump.errorCode, 'INVALID_PERIOD_TRANSITION')
    assert.deepEqual('payload' in jump ? jump.payload.allowed_statuses : null, ['REVIEW_BY_BOARD'])
  }
  const badStatus = validatePeriodStatusTransition('OPEN_FOR_RESIDENTS', 'BOGUS')
  assert.equal(badStatus.ok, false)
  if (!badStatus.ok) {
    assert.equal(badStatus.status, 422)
    assert.equal(badStatus.errorCode, 'VALIDATION_ERROR')
  }

  // Unit-aware MWh thresholds
  assert.equal(defaultMeterThresholdScaled('ELECTRICITY', 'kWh'), 1000000n)
  assert.equal(defaultMeterThresholdScaled('ELECTRICITY', 'MWh'), 1000n)
  assert.equal(defaultMeterThresholdScaled('HEAT', 'kWh'), 2000000n)
  assert.equal(defaultMeterThresholdScaled('HEAT', 'MWh'), 2000n)

  // CSV formula-injection guard & 15-column contract with MASTER rows
  assert.equal(escapeCsvCell('=SUM(A1)'), "'=SUM(A1)")
  assert.equal(escapeCsvCell('  +1+1'), "'  +1+1")
  assert.equal(escapeCsvCell('\tcmd'), "'\tcmd")
  assert.equal(escapeCsvCell('\uFF1D1+1'), "'\uFF1D1+1")
  assert.equal(escapeCsvCell('-1.500', { numeric: true }), '-1.500')

  const csv = buildPeriodCsv(
    '2026-10',
    [
      {
        apartment_number: '14',
        apartment_kind: 'APARTMENT',
        entrance: 2,
        meters: [
          {
            meter_id: 'm-1',
            resource_type: 'HOT_WATER',
            serial_number: null,
            location_label: '=FormulaRoom',
            unit: 'm3',
            previous_value: '45.000',
            reading: {
              value: '45.000',
              previous_value: '45.000',
              consumption_delta: '0.000',
              source: 'RESIDENT',
              is_anomaly_confirmed: false,
              previous_origin: 'START',
            },
          },
        ],
      },
      {
        apartment_number: '12',
        apartment_kind: 'GARAGE',
        entrance: null,
        meters: [
          {
            meter_id: 'm-gar-1',
            resource_type: 'ELECTRICITY',
            serial_number: 'EL-12',
            location_label: 'Garage',
            unit: 'kWh',
            previous_value: '100.000',
            reading: {
              value: '115.000',
              previous_value: '100.000',
              consumption_delta: '15.000',
              source: 'RESIDENT',
              is_anomaly_confirmed: false,
              previous_origin: 'HISTORY',
            },
          },
        ],
      },
    ],
    [
      {
        meter_id: 'm-master',
        resource_type: 'COLD_WATER',
        serial_number: 'MAIN-01',
        location_label: 'Basement',
        unit: 'm3',
        previous_value: '100.000',
        reading: {
          value: '125.000',
          previous_value: '100.000',
          consumption_delta: '25.000',
          source: 'ADMIN_OVERRIDE',
          is_anomaly_confirmed: false,
          previous_origin: 'HISTORY',
        },
      },
    ],
  )
  const rows = csv.split('\n')
  assert.equal(rows.length, 4)
  assert.equal(rows[0].split(',').length, 16)
  assert.ok(rows[0].endsWith(',previous_origin,apartment_kind'))
  assert.equal(rows[1].includes(',null,'), false)
  assert.ok(rows[1].includes("'=FormulaRoom"))
  assert.ok(rows[1].endsWith(',START,APARTMENT'))
  // Garage row has empty entrance and ends with GARAGE
  assert.ok(rows[2].startsWith('2026-10,,12,m-gar-1,'))
  assert.ok(rows[2].endsWith(',HISTORY,GARAGE'))
  // MASTER row has empty apartment_kind as 16th column
  assert.ok(rows[3].startsWith('2026-10,,MASTER,m-master,'))
  assert.ok(rows[3].endsWith(',HISTORY,'))
})
