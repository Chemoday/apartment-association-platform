import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildApartmentConsumptionResponse,
  buildBuildingConsumptionResponse,
  computeConsumptionChartGeometry,
  formatCompactPeriodTick,
  formatFixedBigInt,
  formatShortChartTick,
  getResourceChartStyle,
  parseConsumptionMonths,
  parseExactDecimalToScale,
  roundBigIntHalfUp,
} from './consumption.js'

test('parseConsumptionMonths validates 1..24 with default 12', () => {
  assert.deepEqual(parseConsumptionMonths(undefined), { ok: true, months: 12 })
  assert.deepEqual(parseConsumptionMonths(null), { ok: true, months: 12 })
  assert.deepEqual(parseConsumptionMonths(''), { ok: true, months: 12 })
  assert.deepEqual(parseConsumptionMonths('1'), { ok: true, months: 1 })
  assert.deepEqual(parseConsumptionMonths('24'), { ok: true, months: 24 })
  assert.deepEqual(parseConsumptionMonths(6), { ok: true, months: 6 })

  for (const invalid of ['0', '-1', '25', '12.5', 'abc', '12px']) {
    const res = parseConsumptionMonths(invalid)
    assert.equal(res.ok, false)
    assert.equal(res.status, 422)
    assert.equal(res.errorCode, 'VALIDATION_ERROR')
  }
})

test('getResourceChartStyle returns deterministic styles keyed by resource_type', () => {
  const cold = getResourceChartStyle('COLD_WATER')
  const hot = getResourceChartStyle('HOT_WATER')
  const elec = getResourceChartStyle('ELECTRICITY')
  const heat = getResourceChartStyle('HEAT')
  const heatingAlias = getResourceChartStyle('HEATING')
  const unknown = getResourceChartStyle('OTHER_UNKNOWN')

  assert.notEqual(cold.strokeHex, hot.strokeHex)
  assert.notEqual(hot.strokeHex, elec.strokeHex)
  assert.equal(heat.strokeHex, heatingAlias.strokeHex)
  assert.equal(cold, getResourceChartStyle('cold_water'))
  assert.ok(unknown.strokeHex)
})

test('buildApartmentConsumptionResponse aggregates oldest-first periods, replaced meters, gaps, estimates, and negative corrections', () => {
  const periods = [
    { period_code: '2026-11', status: 'OPEN_FOR_RESIDENTS', due_date: '2026-12-04T21:59:59Z' },
    { period_code: '2026-10', status: 'REVIEW_BY_BOARD', due_date: '2026-11-04T21:59:59Z' },
    { period_code: '2026-09', status: 'LOCKED', due_date: '2026-10-04T20:59:59Z' },
    { period_code: '2026-08', status: 'LOCKED', due_date: '2026-09-04T20:59:59Z' },
  ]

  const meters = [
    // Active kitchen & bathroom hot water -> summed together per month
    {
      meter_id: 'hw-1',
      resource_type: 'HOT_WATER',
      unit: 'm3',
      is_active: true,
      readings: [
        { period_code: '2026-11', consumption_delta: '1.125', source: 'RESIDENT' }, // partial open month
        { period_code: '2026-10', consumption_delta: '2.500', source: 'RESIDENT' },
        { period_code: '2026-09', consumption_delta: '-0.350', source: 'BOARD' }, // negative correction
      ],
    },
    {
      meter_id: 'hw-2',
      resource_type: 'HOT_WATER',
      unit: 'm3',
      is_active: true,
      readings: [
        { period_code: '2026-10', consumption_delta: '1.250', source: 'AUTO_ESTIMATED' },
        { period_code: '2026-09', consumption_delta: '0.100', source: 'RESIDENT' },
      ],
    },
    // Active electricity
    {
      meter_id: 'el-1',
      resource_type: 'ELECTRICITY',
      unit: 'kWh',
      is_active: true,
      readings: [{ period_code: '2026-10', consumption_delta: '0.000', source: 'RESIDENT' }],
    },
    // Replaced meter WITH a reading in window -> must be included
    {
      meter_id: 'cw-old-in',
      resource_type: 'COLD_WATER',
      unit: 'm3',
      is_active: false,
      readings: [{ period_code: '2026-09', consumption_delta: '2.000', source: 'RESIDENT' }],
    },
    // Replaced meter with NO readings in window -> excluded
    {
      meter_id: 'gas-old-out',
      resource_type: 'GAS',
      unit: 'm3',
      is_active: false,
      readings: [{ period_code: '2025-01', consumption_delta: '5.000', source: 'RESIDENT' }],
    },
  ]

  const res = buildApartmentConsumptionResponse({
    apartmentId: 'apt-14',
    apartmentNumber: '14',
    periods,
    meters,
    months: 3,
  })

  // Periods ordered oldest first, limited to latest 3
  assert.deepEqual(
    res.periods.map((p: any) => p.period_code),
    ['2026-09', '2026-10', '2026-11'],
  )

  // Resources sorted alphabetically by resource_type (gas excluded since inactive w/o readings in window)
  assert.deepEqual(
    res.resources.map((r: any) => r.resource_type),
    ['COLD_WATER', 'ELECTRICITY', 'HOT_WATER'],
  )

  const cold = res.resources[0]
  assert.deepEqual(cold.months, [
    { period_code: '2026-09', consumption: '2.000', estimated: false },
    { period_code: '2026-10', consumption: null, estimated: false },
    { period_code: '2026-11', consumption: null, estimated: false },
  ])

  const elec = res.resources[1]
  // Exact '0.000' vs null gap distinction
  assert.deepEqual(elec.months, [
    { period_code: '2026-09', consumption: null, estimated: false },
    { period_code: '2026-10', consumption: '0.000', estimated: false },
    { period_code: '2026-11', consumption: null, estimated: false },
  ])

  const hot = res.resources[2]
  assert.deepEqual(hot.months, [
    // -0.350 + 0.100 = -0.250 exact BigInt arithmetic
    { period_code: '2026-09', consumption: '-0.250', estimated: false },
    // 2.500 + 1.250 = 3.750 and one AUTO_ESTIMATED reading flags estimated=true
    { period_code: '2026-10', consumption: '3.750', estimated: true },
    // partial open month with only hw-1 submitted
    { period_code: '2026-11', consumption: '1.125', estimated: false },
  ])
})

test('chart formatting and geometry handle gaps, zeros, open months, and negative bars safely', () => {
  assert.equal(formatShortChartTick(0n), '0')
  assert.equal(formatShortChartTick(4500n), '4.5')
  assert.equal(formatShortChartTick(-1250n), '-1.25')
  assert.equal(formatCompactPeriodTick('2026-11'), '11/26')

  const periods = [
    { period_code: '2026-09', status: 'LOCKED' },
    { period_code: '2026-10', status: 'LOCKED' },
    { period_code: '2026-11', status: 'OPEN_FOR_RESIDENTS' },
  ]
  const months = [
    { period_code: '2026-09', consumption: '-2.500', estimated: false },
    { period_code: '2026-10', consumption: null, estimated: false },
    { period_code: '2026-11', consumption: '5.000', estimated: true },
  ]

  const geo = computeConsumptionChartGeometry(months, periods)
  assert.equal(geo.hasAnyData, true)
  assert.equal(geo.hasNegative, true)
  assert.equal(geo.bars.length, 3)

  // Negative bar extends downward from baselineY
  const negBar = geo.bars[0]
  assert.equal(negBar.isNegative, true)
  assert.equal(negBar.isGap, false)
  assert.ok(negBar.y >= geo.baselineY - 0.001)
  assert.ok(negBar.height > 0)

  // Null month stays flagged as gap (never drawn as 0 value)
  const gapBar = geo.bars[1]
  assert.equal(gapBar.isGap, true)
  assert.equal(gapBar.valueStr, null)

  // Open estimated month extends upward above baselineY
  const openBar = geo.bars[2]
  assert.equal(openBar.isOpen, true)
  assert.equal(openBar.estimated, true)
  assert.ok(openBar.y < geo.baselineY)
})

test('computeConsumptionChartGeometry never shifts misaligned months, tolerates invalid strings, and expands plotLeft for wide ticks', () => {
  const periods = [
    { period_code: '2026-08', status: 'LOCKED' },
    { period_code: '2026-09', status: 'LOCKED' },
    { period_code: '2026-10', status: 'OPEN_FOR_RESIDENTS' },
  ]
  // Only 2026-10 exists in months array (and 2026-09 has corrupted string) -> MUST NOT shift onto 2026-08!
  const months = [
    { period_code: '2026-09', consumption: 'not-a-number', estimated: true },
    { period_code: '2026-10', consumption: '1234.567', estimated: false },
  ]

  const geo = computeConsumptionChartGeometry(months, periods, { plotLeft: 46, plotRight: 526 })
  assert.equal(geo.bars[0].periodCode, '2026-08')
  assert.equal(geo.bars[0].isGap, true)
  assert.equal(geo.bars[0].valueStr, null)

  // Invalid consumption string degrades fail-closed to gap instead of crashing
  assert.equal(geo.bars[1].periodCode, '2026-09')
  assert.equal(geo.bars[1].isGap, true)
  assert.equal(geo.bars[1].estimated, false)

  // Wide value expands plotLeft automatically beyond default 46 so label doesn't clip
  assert.equal(geo.bars[2].valueStr, '1234.567')
  assert.ok(geo.plotLeft > 46, `Expected plotLeft > 46, got ${geo.plotLeft}`)

  // All-null series produces hasAnyData = false and zero crash
  const allNull = computeConsumptionChartGeometry(
    [{ period_code: '2026-10', consumption: null }],
    periods,
  )
  assert.equal(allNull.hasAnyData, false)
  assert.equal(allNull.bars.every((b: any) => b.isGap), true)

  // All-zero and all-negative series
  const allZero = computeConsumptionChartGeometry(
    periods.map((p) => ({ period_code: p.period_code, consumption: '0.000' })),
    periods,
  )
  assert.equal(allZero.hasAnyData, true)
  assert.equal(allZero.hasNegative, false)

  const allNeg = computeConsumptionChartGeometry(
    periods.map((p) => ({ period_code: p.period_code, consumption: '-123.456' })),
    periods,
  )
  assert.equal(allNeg.hasNegative, true)
  assert.ok(allNeg.plotLeft > 46)
})

test('24-month X-axis label culling avoids adjacent label overlap and sorts same-type units alphabetically', () => {
  const periods24 = Array.from({ length: 24 }, (_, idx) => {
    const year = 2025 + Math.floor(idx / 12)
    const month = String((idx % 12) + 1).padStart(2, '0')
    return {
      period_code: `${year}-${month}`,
      status: idx === 22 ? 'OPEN_FOR_RESIDENTS' : 'LOCKED',
    }
  })
  const months24 = periods24.map((p, idx) => ({
    period_code: p.period_code,
    consumption: `${idx + 1}.000`,
    estimated: false,
  }))

  const geo24 = computeConsumptionChartGeometry(months24, periods24, {
    plotLeft: 46,
    plotRight: 626,
  })
  const shown = geo24.bars.filter((b: any) => b.showXLabel)
  assert.ok(shown.some((b: any) => b.isOpen))
  assert.ok(shown.some((b: any) => b.index === 0))
  // Verify every pair of visible X labels has at least 32px separation
  for (let i = 1; i < shown.length; i++) {
    const dist = Math.abs(shown[i].centerX - shown[i - 1].centerX)
    assert.ok(dist >= 32, `Label collision at idx ${shown[i - 1].index} & ${shown[i].index}: ${dist}px`)
  }

  // Unit alphabetical tie-breaker when resource_type matches
  const res = buildApartmentConsumptionResponse({
    apartmentId: 'apt-1',
    apartmentNumber: '01',
    periods: [{ period_code: '2026-10', status: 'LOCKED' }],
    meters: [
      {
        meter_id: 'm2',
        resource_type: 'HEAT',
        unit: 'MWh',
        is_active: true,
        readings: [{ period_code: '2026-10', consumption_delta: '1.000' }],
      },
      {
        meter_id: 'm1',
        resource_type: 'HEAT',
        unit: 'kWh',
        is_active: true,
        readings: [{ period_code: '2026-10', consumption_delta: '500.000' }],
      },
    ],
  })
  assert.deepEqual(
    res.resources.map((r: any) => r.unit),
    ['kWh', 'MWh'],
  )
})

test('roundBigIntHalfUp and formatFixedBigInt compute exact half-up decimals without float errors or -0 (#031)', () => {
  assert.equal(roundBigIntHalfUp(10n, 0n), null)
  assert.equal(roundBigIntHalfUp(5n, 2n), 3n)
  assert.equal(roundBigIntHalfUp(-5n, 2n), -3n)
  assert.equal(roundBigIntHalfUp(-4n, 10n), 0n)

  assert.equal(formatFixedBigInt(0n, 3), '0.000')
  assert.equal(formatFixedBigInt(0n, 4), '0.0000')
  assert.equal(formatFixedBigInt(5379n, 3), '5.379')
  assert.equal(formatFixedBigInt(951n, 4), '0.0951')
  assert.equal(formatFixedBigInt(-503n, 3), '-0.503')

  // Matches API.md example: total 312.000 / 58 apartments = 5.379; 312.000 / 3280.75 m2 = 0.0951
  assert.equal(formatFixedBigInt(roundBigIntHalfUp(312000n, 58n)!, 3), '5.379')
  assert.equal(formatFixedBigInt(roundBigIntHalfUp(312000n * 10000n, 3280750n)!, 4), '0.0951')
})

test('buildBuildingConsumptionResponse counts each apt once, excludes MASTER meters, handles zero area & null gaps (#031)', () => {
  const periods = [
    { period_code: '2026-08', status: 'LOCKED' },
    { period_code: '2026-09', status: 'LOCKED' },
    { period_code: '2026-10', status: 'OPEN_FOR_RESIDENTS' },
  ]
  const resp = buildBuildingConsumptionResponse({
    periods,
    months: 12,
    apartments: [
      {
        apartment_id: 'apt-1',
        area_m2: '50.00',
        meters: [
          {
            meter_id: 'm1-k',
            resource_type: 'COLD_WATER',
            unit: 'm3',
            readings: [
              { period_code: '2026-09', consumption_delta: '2.100', source: 'RESIDENT' },
              { period_code: '2026-10', consumption_delta: '1.500', source: 'RESIDENT' },
            ],
          },
          {
            meter_id: 'm1-b',
            resource_type: 'COLD_WATER',
            unit: 'm3',
            readings: [
              // Apt 1 submits BOTH kitchen and bathroom in 2026-09: counted ONCE with area 50.00
              { period_code: '2026-09', consumption_delta: '3.900', source: 'AUTO_ESTIMATED' },
            ],
          },
        ],
      },
      {
        apartment_id: 'apt-2',
        area_m2: '0.00',
        meters: [
          {
            meter_id: 'm2-b',
            resource_type: 'COLD_WATER',
            unit: 'm3',
            readings: [
              { period_code: '2026-10', consumption_delta: '-0.500', source: 'ADMIN_OVERRIDE' },
            ],
          },
        ],
      },
      {
        apartment_id: 'basement',
        area_m2: '100.00',
        meters: [
          {
            meter_id: 'master-1',
            resource_type: 'COLD_WATER',
            unit: 'm3',
            is_master: true,
            meter_type: 'MASTER',
            readings: [
              { period_code: '2026-08', consumption_delta: '99.000', source: 'ADMIN_OVERRIDE' },
              { period_code: '2026-09', consumption_delta: '99.000', source: 'ADMIN_OVERRIDE' },
            ],
          },
        ],
      },
    ],
  })

  const cold = resp.resources[0]
  assert.equal(cold.resource_type, 'COLD_WATER')
  // 2026-08: only master meter had reading -> must be completely empty (gap)
  assert.deepEqual(cold.months[0], {
    period_code: '2026-08',
    total: null,
    apartments_counted: 0,
    average_per_apartment: null,
    average_per_m2: null,
    estimated_readings: 0,
  })
  // 2026-09: Apt 1 (2.1 + 3.9 = 6.000), 1 apartment, area 50.00 -> 0.1200/m2, 1 estimated reading
  assert.deepEqual(cold.months[1], {
    period_code: '2026-09',
    total: '6.000',
    apartments_counted: 1,
    average_per_apartment: '6.000',
    average_per_m2: '0.1200',
    estimated_readings: 1,
  })
  // 2026-10: Apt 1 (1.500, area 50) + Apt 2 (-0.500, area 0) = 1.000 / 2 apts = 0.500 / 50 = 0.0200
  assert.deepEqual(cold.months[2], {
    period_code: '2026-10',
    total: '1.000',
    apartments_counted: 2,
    average_per_apartment: '0.500',
    average_per_m2: '0.0200',
    estimated_readings: 0,
  })

  // Zero-area-only apartment yields average_per_m2: null
  const zeroAreaResp = buildBuildingConsumptionResponse({
    periods: [{ period_code: '2026-10', status: 'LOCKED' }],
    apartments: [
      {
        apartment_id: 'apt-zero',
        area_m2: '0.00',
        meters: [
          {
            meter_id: 'mz',
            resource_type: 'HEAT',
            unit: 'MWh',
            readings: [{ period_code: '2026-10', consumption_delta: '2.500' }],
          },
        ],
      },
    ],
  })
  assert.equal(zeroAreaResp.resources[0].months[0].average_per_apartment, '2.500')
  assert.equal(zeroAreaResp.resources[0].months[0].average_per_m2, null)

  // Chart geometry preserves building consumption fields (`total`, `apartmentsCounted`, `estimatedReadings`)
  const geo = computeConsumptionChartGeometry(cold.months, periods)
  assert.equal(geo.bars[0].isGap, true)
  assert.equal(geo.bars[1].estimated, true)
  assert.equal(geo.bars[1].estimatedReadings, 1)
  assert.equal(geo.bars[2].valueStr, '1.000')
  assert.equal(geo.bars[2].apartmentsCounted, 2)
})

test('parseExactDecimalToScale handles high-precision area_m2, huge 13+ digit totals, and non-overlapping open SVG labels (#031)', () => {
  assert.equal(parseExactDecimalToScale('54.3000', 6), 54_300_000n)
  assert.equal(parseExactDecimalToScale('1000000000000.000', 3), 1_000_000_000_000_000n)
  assert.equal(parseExactDecimalToScale('-0.0001', 3), 0n)

  const hugePeriods = [
    { period_code: '2026-09', status: 'OPEN_FOR_RESIDENTS' },
    { period_code: '2026-10', status: 'OPEN_FOR_RESIDENTS' },
    { period_code: '2026-11', status: 'OPEN_FOR_RESIDENTS' },
  ]
  const resp = buildBuildingConsumptionResponse({
    periods: hugePeriods,
    apartments: [
      {
        apartment_id: 'a1',
        area_m2: '54.3000',
        meters: [
          {
            meter_id: 'm1',
            resource_type: 'ELECTRICITY',
            unit: 'kWh',
            readings: [
              { period_code: '2026-09', consumption_delta: '1000000000000.000' },
              { period_code: '2026-10', consumption_delta: '100.000' },
              { period_code: '2026-11', consumption_delta: '50.000' },
            ],
          },
        ],
      },
    ],
  })
  // 54.3000 does not zero out to null, and 10^12+ delta does not get skipped
  assert.equal(resp.resources[0].months[0].total, '1000000000000.000')
  assert.equal(resp.resources[0].months[1].average_per_m2, '1.8416')

  // Adjacent open months inside 24-month window never enable colliding bottom "In progress" labels
  const manyPeriods = Array.from({ length: 24 }, (_, idx) => ({
    period_code: idx < 12 ? `2025-${String(idx + 1).padStart(2, '0')}` : `2026-${String(idx - 11).padStart(2, '0')}`,
    status: idx >= 22 ? 'OPEN_FOR_RESIDENTS' : 'LOCKED',
  }))
  const geo24 = computeConsumptionChartGeometry(resp.resources[0].months, manyPeriods)
  assert.equal(geo24.bars[23].showOpenText, true)
  assert.equal(geo24.bars[22].showOpenText, false)
  // 13-digit period bar in 24m chart is NOT treated as a gap
  const geoHuge = computeConsumptionChartGeometry(resp.resources[0].months, hugePeriods)
  assert.equal(geoHuge.bars[0].isGap, false)
  assert.equal(geoHuge.bars[0].valueStr, '1000000000000.000')
})


