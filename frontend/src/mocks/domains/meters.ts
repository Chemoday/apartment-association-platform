/**
 * Shared meters domain fixtures & multi-period state generator (#041).
 * Used by both `src/server/apiMiddleware.ts` and `src/api/offlineDemoData.js`.
 */

import type {
  MasterMeterRow,
  MeterUnit,
  ObjectKind,
  PeriodDTO,
  PreviousOrigin,
  ReadingSource,
  ReadingSummary,
  ResourceType,
} from '../../api/schema'
import { subDecimal } from '../../utils/metersMockHelpers.js'

export interface MockInternalMeter {
  meter_id: string
  resource_type: ResourceType
  serial_number: string | null
  location_label: string
  unit: MeterUnit
  previous_value: string | null
  needs_start?: boolean
  starts_in_period?: string
  historical_avg: string | null
  reading: ReadingSummary | null
}

export interface MockInternalApartment {
  apartment_id: string
  apartment_number: string
  apartment_kind: ObjectKind
  entrance: number | null
  floor: number | null
  can_submit_readings: boolean
  meters: MockInternalMeter[]
}

export const MOCK_DEFAULT_PERIODS: PeriodDTO[] = [
  {
    period_code: '2026-11',
    status: 'OPEN_FOR_RESIDENTS',
    due_date: '2026-12-04T21:59:59Z',
  },
  {
    period_code: '2026-10',
    status: 'OPEN_FOR_RESIDENTS',
    due_date: '2026-11-04T21:59:59Z',
  },
  {
    period_code: '2026-09',
    status: 'LOCKED',
    due_date: '2026-10-04T20:59:59Z',
  },
  {
    period_code: '2026-08',
    status: 'LOCKED',
    due_date: '2026-09-04T20:59:59Z',
  },
  {
    period_code: '2026-07',
    status: 'LOCKED',
    due_date: '2026-08-04T20:59:59Z',
  },
]

export const MOCK_MASTER_METERS_2026_10: MasterMeterRow[] = [
  {
    meter_id: '018f0000-0000-7000-8000-000000000991',
    resource_type: 'COLD_WATER',
    location_label: 'Basement Main Cold Water Inlet',
    unit: 'm3',
    previous_value: '4120.000',
    needs_start: false,
    status: 'SUBMITTED',
    reading: {
      reading_id: '018f0000-0000-7000-8000-000000000981',
      value: '4148.500',
      previous_value: '4120.000',
      consumption_delta: '28.500',
      source: 'ADMIN_OVERRIDE',
      is_anomaly_confirmed: false,
      previous_origin: 'HISTORY',
    },
  },
  {
    meter_id: '018f0000-0000-7000-8000-000000000992',
    resource_type: 'HOT_WATER',
    location_label: 'Basement Heat Exchanger Hot Water',
    unit: 'm3',
    previous_value: '2050.000',
    needs_start: false,
    status: 'SUBMITTED',
    reading: {
      reading_id: '018f0000-0000-7000-8000-000000000982',
      value: '2065.400',
      previous_value: '2050.000',
      consumption_delta: '15.400',
      source: 'ADMIN_OVERRIDE',
      is_anomaly_confirmed: false,
      previous_origin: 'HISTORY',
    },
  },
  {
    meter_id: '018f0000-0000-7000-8000-000000000993',
    resource_type: 'HOT_WATER',
    location_label: 'Stairwell B Hot Water Branch',
    unit: 'm3',
    previous_value: null,
    needs_start: true,
    status: 'MISSING',
    reading: null,
  },
]

export const MOCK_BASE_APARTMENTS_2026_10: MockInternalApartment[] = [
  {
    apartment_id: '018f0000-0000-7000-8000-000000000301',
    apartment_number: '01',
    apartment_kind: 'APARTMENT',
    entrance: 1,
    floor: 1,
    can_submit_readings: true,
    meters: [
      {
        meter_id: '018f0000-0000-7000-8000-000000000501',
        resource_type: 'COLD_WATER',
        serial_number: 'CW-0101-K',
        location_label: 'Kitchen Cold Water',
        unit: 'm3',
        previous_value: '110.200',
        needs_start: false,
        historical_avg: '2.100',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000801',
          value: '112.400',
          previous_value: '110.200',
          consumption_delta: '2.200',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'HISTORY',
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000502',
        resource_type: 'HOT_WATER',
        serial_number: 'HW-0101-B',
        location_label: 'Bathroom Hot Water',
        unit: 'm3',
        previous_value: '78.400',
        needs_start: false,
        historical_avg: '1.800',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000802',
          value: '80.250',
          previous_value: '78.400',
          consumption_delta: '1.850',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'HISTORY',
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000520',
        resource_type: 'COLD_WATER',
        serial_number: null,
        location_label: 'Utility Room Cold Water',
        unit: 'm3',
        previous_value: '45.000',
        needs_start: true,
        historical_avg: null,
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000820',
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
    apartment_id: '018f0000-0000-7000-8000-000000000302',
    apartment_number: '02',
    apartment_kind: 'APARTMENT',
    entrance: 1,
    floor: 1,
    can_submit_readings: true,
    meters: [
      {
        meter_id: '018f0000-0000-7000-8000-000000000503',
        resource_type: 'COLD_WATER',
        serial_number: 'CW-0201-B',
        location_label: 'Bathroom Cold Water',
        unit: 'm3',
        previous_value: '184.000',
        needs_start: false,
        historical_avg: '3.900',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000803',
          value: '187.850',
          previous_value: '184.000',
          consumption_delta: '3.850',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'HISTORY',
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000504',
        resource_type: 'HOT_WATER',
        serial_number: 'HW-0201-B',
        location_label: 'Bathroom Hot Water',
        unit: 'm3',
        previous_value: '95.500',
        needs_start: true,
        historical_avg: null,
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000804',
          value: '97.950',
          previous_value: '95.500',
          consumption_delta: '2.450',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'SUBMITTED',
        },
      },
    ],
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000305',
    apartment_number: '05',
    apartment_kind: 'APARTMENT',
    entrance: 1,
    floor: 2,
    can_submit_readings: true,
    meters: [
      {
        meter_id: '018f0000-0000-7000-8000-000000000505',
        resource_type: 'COLD_WATER',
        serial_number: 'CW-0501-B',
        location_label: 'Bathroom Cold Water',
        unit: 'm3',
        previous_value: '302.150',
        needs_start: false,
        historical_avg: '4.500',
        reading: null,
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000506',
        resource_type: 'HOT_WATER',
        serial_number: 'HW-0501-B',
        location_label: 'Bathroom Hot Water',
        unit: 'm3',
        previous_value: '140.200',
        needs_start: false,
        historical_avg: '3.100',
        reading: null,
      },
    ],
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000309',
    apartment_number: '09',
    apartment_kind: 'APARTMENT',
    entrance: 2,
    floor: 3,
    can_submit_readings: true,
    meters: [
      {
        meter_id: '018f0000-0000-7000-8000-000000000509',
        resource_type: 'COLD_WATER',
        serial_number: 'CW-0901-B',
        location_label: 'Bathroom Cold Water',
        unit: 'm3',
        previous_value: '165.000',
        needs_start: false,
        historical_avg: '3.600',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000809',
          value: '179.400',
          previous_value: '165.000',
          consumption_delta: '14.400',
          source: 'RESIDENT',
          is_anomaly_confirmed: true,
          previous_origin: 'HISTORY',
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000510',
        resource_type: 'HOT_WATER',
        serial_number: 'HW-0901-B',
        location_label: 'Bathroom Hot Water',
        unit: 'm3',
        previous_value: '88.300',
        needs_start: false,
        historical_avg: '2.200',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000810',
          value: '90.500',
          previous_value: '88.300',
          consumption_delta: '2.200',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'HISTORY',
        },
      },
    ],
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000314',
    apartment_number: '14',
    apartment_kind: 'APARTMENT',
    entrance: 2,
    floor: 4,
    can_submit_readings: true,
    meters: [
      {
        meter_id: '018f0000-0000-7000-8000-000000000514',
        resource_type: 'COLD_WATER',
        serial_number: 'CW-1429-K',
        location_label: 'Kitchen Cold Water',
        unit: 'm3',
        previous_value: '84.100',
        needs_start: false,
        historical_avg: '2.100',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000901',
          value: '86.200',
          previous_value: '84.100',
          consumption_delta: '2.100',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'HISTORY',
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000515',
        resource_type: 'HOT_WATER',
        serial_number: 'HW-1429-K',
        location_label: 'Kitchen Hot Water',
        unit: 'm3',
        previous_value: '52.400',
        needs_start: false,
        historical_avg: '1.300',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000902',
          value: '53.750',
          previous_value: '52.400',
          consumption_delta: '1.350',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'HISTORY',
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000516',
        resource_type: 'COLD_WATER',
        serial_number: 'CW-1429-B',
        location_label: 'Bathroom Cold Water',
        unit: 'm3',
        previous_value: '142.350',
        needs_start: false,
        historical_avg: '3.200',
        reading: null,
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000517',
        resource_type: 'HOT_WATER',
        serial_number: 'HW-1429-B',
        location_label: 'Bathroom Hot Water',
        unit: 'm3',
        previous_value: '88.120',
        needs_start: false,
        historical_avg: '2.100',
        reading: null,
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000518',
        resource_type: 'ELECTRICITY',
        serial_number: 'EL-1429-EV',
        location_label: 'Basement Storage & EV Charger',
        unit: 'kWh',
        previous_value: '1240.000',
        needs_start: false,
        historical_avg: '65.000',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000905',
          value: '1304.500',
          previous_value: '1240.000',
          consumption_delta: '64.500',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'HISTORY',
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000519',
        resource_type: 'HOT_WATER',
        serial_number: null,
        location_label: 'Laundry Hot Water',
        unit: 'm3',
        previous_value: null,
        needs_start: true,
        starts_in_period: '2026-11',
        historical_avg: null,
        reading: null,
      },
    ],
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000412',
    apartment_number: '12',
    apartment_kind: 'GARAGE',
    entrance: null,
    floor: 0,
    can_submit_readings: true,
    meters: [
      {
        meter_id: '018f0000-0000-7000-8000-000000000531',
        resource_type: 'ELECTRICITY',
        serial_number: 'EL-G12-01',
        location_label: 'Garage 12 Power Outlet',
        unit: 'kWh',
        previous_value: '310.000',
        needs_start: false,
        historical_avg: '18.000',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000931',
          value: '328.500',
          previous_value: '310.000',
          consumption_delta: '18.500',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
          previous_origin: 'HISTORY',
        },
      },
    ],
  },
]

export function normalizeSeededMockMeter(m: MockInternalMeter): MockInternalMeter {
  const needsStart = Boolean(m.needs_start)
  return {
    ...m,
    needs_start: needsStart,
    reading: m.reading
      ? {
          ...m.reading,
          previous_value: m.reading.previous_value ?? m.previous_value ?? m.reading.value,
          previous_origin: m.reading.previous_origin || 'HISTORY',
        }
      : null,
  }
}

export function createMockMasterMetersByPeriod(): Record<string, MasterMeterRow[]> {
  const oct: MasterMeterRow[] = JSON.parse(JSON.stringify(MOCK_MASTER_METERS_2026_10))
  const nov: MasterMeterRow[] = JSON.parse(JSON.stringify(MOCK_MASTER_METERS_2026_10)).map(
    (mm: MasterMeterRow) => ({
      ...mm,
      previous_value: mm.reading ? mm.reading.value : mm.previous_value,
      needs_start: mm.reading ? false : Boolean(mm.needs_start),
      status: 'MISSING',
      reading: null,
    }),
  )
  const map: Record<string, MasterMeterRow[]> = {
    '2026-10': oct,
    '2026-11': nov,
  }
  for (const histCode of ['2026-09', '2026-08', '2026-07']) {
    map[histCode] = JSON.parse(JSON.stringify(MOCK_MASTER_METERS_2026_10))
  }
  return map
}

export function createMockApartmentsByPeriod(): Record<string, MockInternalApartment[]> {
  const oct: MockInternalApartment[] = JSON.parse(JSON.stringify(MOCK_BASE_APARTMENTS_2026_10)).map(
    (apt: MockInternalApartment) => ({
      ...apt,
      meters: apt.meters.map((m) => normalizeSeededMockMeter(m)),
    }),
  )
  const nov: MockInternalApartment[] = JSON.parse(JSON.stringify(MOCK_BASE_APARTMENTS_2026_10)).map(
    (apt: MockInternalApartment) => ({
      ...apt,
      can_submit_readings: true,
      meters: apt.meters.map((raw) => {
        const m = normalizeSeededMockMeter(raw)
        return {
          ...m,
          previous_value: m.reading ? m.reading.value : m.previous_value,
          needs_start: m.reading ? false : Boolean(m.needs_start),
          reading: null,
        }
      }),
    }),
  )

  const periodsMap: Record<string, MockInternalApartment[]> = {
    '2026-10': oct,
    '2026-11': nov,
  }

  for (const histCode of ['2026-09', '2026-08', '2026-07']) {
    periodsMap[histCode] = JSON.parse(JSON.stringify(MOCK_BASE_APARTMENTS_2026_10)).map(
      (apt: MockInternalApartment) => ({
        ...apt,
        can_submit_readings: false,
        meters: apt.meters.map((raw) => {
          const m = normalizeSeededMockMeter(raw)
          if (m.needs_start || m.previous_value === null || m.historical_avg === null) {
            return {
              ...m,
              previous_value: null,
              needs_start: true,
              reading: null,
            }
          }
          const prevHist = subDecimal(m.previous_value, m.historical_avg)
          return {
            ...m,
            previous_value: prevHist,
            needs_start: false,
            reading: {
              reading_id: `${m.meter_id}-${histCode}`,
              value: m.previous_value,
              previous_value: prevHist,
              consumption_delta: m.historical_avg,
              source: 'RESIDENT' as ReadingSource,
              is_anomaly_confirmed: false,
              previous_origin: 'HISTORY' as PreviousOrigin,
            },
          }
        }),
      }),
    )
  }

  return periodsMap
}
