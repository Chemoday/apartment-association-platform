import { ref } from 'vue'
import {
  compareCanonicalNumbers,
  computeNumberStats,
  isValidCanonicalDate,
  isValidCanonicalNumber,
  normalizeCanonicalNumber,
} from '../utils/pollValidation.js'
import {
  cloneDefaultAssociationSettings,
  validateAndApplySettingsUpdate,
} from '../utils/associationSettings.js'
import {
  addIssuePhotoInStore,
  buildIssueReportedNotification,
  canUserAccessIssues,
  changeIssueStatusInStore,
  checkIssuePhotoUploadPreflight,
  clearIssueUrgentInStore,
  createDefaultIssuesSeed,
  createIssueInStore,
  deleteIssuePhotoInStore,
  editIssueInStore,
  getIssuePhotoFromStore,
  isIssueVisibleToUser,
  queryIssuesStore,
  readSettingFromStore,
  toIssueView,
  updateIssueFollowInStore,
  withdrawIssueInStore,
} from '../utils/issues.js'
import {
  addDocumentInStore,
  checkDocumentUploadPreflight,
  createDefaultDocumentsSeed,
  deleteDocumentInStore,
  editDocumentInStore,
  getDocumentFileFromStore,
  getDocumentFromStore,
  getUploadOptionsForUser,
  queryDocumentsStore,
} from '../utils/documents.js'
import {
  computeStorageUsage,
  evaluateStorageThresholdNotification,
} from '../utils/storage.js'
import {
  applyLogEditInStore,
  applyTaskDoneInStore,
  applyTaskSkipInStore,
  buildMaintenanceYearCsv,
  buildMaintenanceYearReport,
  computeOccurrenceState,
  createDefaultMaintenanceLogSeed,
  createDefaultMaintenanceSeed,
  getTodayDateInTallinn,
  maxAllowedLeadDays,
  publishMaintenanceTasksInStore,
  queryMaintenanceLogStore,
  queryTasksStore,
  toTaskView,
  validateTaskDraft,
} from '../utils/maintenance.js'
import {
  COMMENT_BODY_MAX_LENGTH,
  POST_BODY_MAX_LENGTH,
  POST_TITLE_MAX_LENGTH,
  canViewerSeePost,
  getEditWindowDeadlineMs,
  hasDisallowedControlChars,
  isCommentHideableOnPost,
  isPostHideable,
  isWithinEditWindow,
  projectCommentForViewer,
  validateCommentEdit,
  validateHideReason,
} from '../utils/communication.js'
import {
  buildApartmentConsumptionResponse,
  buildBuildingConsumptionResponse,
  parseConsumptionMonths,
} from '../utils/consumption.js'

export const isOfflineDemoMode = ref(false)

let offlineNotificationsByUser = {}
let offlinePreferencesByUser = {}
let offlineSettings = cloneDefaultAssociationSettings()
let offlineIssues = createDefaultIssuesSeed()
let offlineIssuePhotoIdempotency = new Map()
let offlineIssuePhotoDailyUploads = []
const activeOfflinePhotoUploads = new Map()
let offlineDocuments = createDefaultDocumentsSeed()
let offlineDocumentIdempotency = new Map()
const activeOfflineDocumentUploads = new Map()
let offlineMaintenance = createDefaultMaintenanceSeed()
let offlineMaintenanceLog = createDefaultMaintenanceLogSeed()
let offlineApartmentsByPeriod = {}
let offlineExtraPendingDeletionBytes = 0
let offlineStorageAlertState = { armed70: true, armed90: true }

export function enableOfflineDemo() {
  isOfflineDemoMode.value = true
  offlineNotificationsByUser = {}
  offlinePreferencesByUser = {}
  offlineSettings = cloneDefaultAssociationSettings()
  offlineIssues = createDefaultIssuesSeed()
  offlineIssuePhotoIdempotency = new Map()
  offlineIssuePhotoDailyUploads = []
  activeOfflinePhotoUploads.clear()
  offlineDocuments = createDefaultDocumentsSeed()
  offlineDocumentIdempotency = new Map()
  activeOfflineDocumentUploads.clear()
  offlineMaintenance = createDefaultMaintenanceSeed()
  offlineMaintenanceLog = createDefaultMaintenanceLogSeed()
  offlineApartmentsByPeriod = {}
  offlineExtraPendingDeletionBytes = 0
  offlineStorageAlertState = { armed70: true, armed90: true }
  OFFLINE_POSTS.splice(0, OFFLINE_POSTS.length, ...createDefaultOfflinePosts())
}

export function disableOfflineDemo() {
  isOfflineDemoMode.value = false
}

const BUILDING_ID = '018f0000-0000-7000-8000-000000000001'

let offlineMagicLinkUsed = false
let offlineSessions = []
let offlineSignedInUserId = ''
let offlineHasPassword = true

const OFFLINE_DEMO_USERS = [
  {
    user_id: '018f0000-0000-7000-8000-000000000102',
    label: 'Owner Apt 14 (Kati Kask)',
    full_name: 'Kati Kask',
    initials: 'K. K.',
    building_role: 'USER',
    apartment_number: '14',
    relation_type: 'OWNER',
  },
  {
    user_id: '018f0000-0000-7000-8000-000000000104',
    label: 'Tenant Apt 02 (Martin Saar)',
    full_name: 'Martin Saar',
    initials: 'M. S.',
    building_role: 'USER',
    apartment_number: '02',
    relation_type: 'TENANT',
  },
  {
    user_id: '018f0000-0000-7000-8000-000000000105',
    label: 'Board Member Apt 09 (Liina Vaher)',
    full_name: 'Liina Vaher',
    initials: 'L. V.',
    building_role: 'BOARD',
    apartment_number: '09',
    relation_type: 'OWNER',
  },
  {
    user_id: '018f0000-0000-7000-8000-000000000101',
    label: 'Board Chairman (Peeter Tamm)',
    full_name: 'Peeter Tamm',
    initials: 'P. T.',
    building_role: 'CHAIRMAN',
    apartment_number: '01',
    relation_type: 'OWNER',
  },
  {
    user_id: '018f0000-0000-7000-8000-000000000103',
    label: 'Accountant (Marika Rebane)',
    full_name: 'Marika Rebane',
    initials: 'M. R.',
    building_role: 'ACCOUNTANT',
    apartment_number: null,
    relation_type: null,
  },
]

const OFFLINE_MEMBERSHIPS_BY_USER = {
  '018f0000-0000-7000-8000-000000000102': [
    {
      membership_id: '018f0000-0000-7000-8000-000000000214',
      apartment_id: '018f0000-0000-7000-8000-000000000314',
      apartment_number: '14',
      entrance: 2,
      floor: 4,
      relation_type: 'OWNER',
      can_submit_readings: true,
      can_view_bills: true,
      can_vote: true,
      privacy_display_mode: 'FULL_NAME',
      since: '2026-01-12T10:00:00Z',
      preview_badge: {
        display_label: 'Kati Kask (Apt 14)',
        role_badge: 'OWNER',
      },
    },
  ],
  '018f0000-0000-7000-8000-000000000104': [
    {
      membership_id: '018f0000-0000-7000-8000-000000000202',
      apartment_id: '018f0000-0000-7000-8000-000000000302',
      apartment_number: '02',
      entrance: 1,
      floor: 1,
      relation_type: 'TENANT',
      can_submit_readings: true,
      can_view_bills: true,
      can_vote: false,
      privacy_display_mode: 'INITIALS',
      since: '2026-06-15T10:00:00Z',
      preview_badge: {
        display_label: 'M. S. (Apt 02)',
        role_badge: 'RESIDENT',
      },
    },
  ],
  '018f0000-0000-7000-8000-000000000105': [
    {
      membership_id: '018f0000-0000-7000-8000-000000000209',
      apartment_id: '018f0000-0000-7000-8000-000000000309',
      apartment_number: '09',
      entrance: 2,
      floor: 3,
      relation_type: 'OWNER',
      can_submit_readings: true,
      can_view_bills: true,
      can_vote: true,
      privacy_display_mode: 'FULL_NAME',
      since: '2023-04-01T09:00:00Z',
      preview_badge: {
        display_label: 'Liina Vaher (Apt 09)',
        role_badge: 'BOARD',
      },
    },
  ],
  '018f0000-0000-7000-8000-000000000101': [
    {
      membership_id: '018f0000-0000-7000-8000-000000000201',
      apartment_id: '018f0000-0000-7000-8000-000000000301',
      apartment_number: '01',
      entrance: 1,
      floor: 1,
      relation_type: 'OWNER',
      can_submit_readings: true,
      can_view_bills: true,
      can_vote: true,
      privacy_display_mode: 'FULL_NAME',
      since: '2026-01-01T09:00:00Z',
      preview_badge: {
        display_label: 'Peeter Tamm (Apt 01)',
        role_badge: 'BOARD',
      },
    },
  ],
  '018f0000-0000-7000-8000-000000000103': [],
}

const OFFLINE_BUILDING = {
  building_id: BUILDING_ID,
  name: 'KÜ Sõpruse 12',
  registry_code: '80123456',
  address: 'Sõpruse pst 12, Kristiine, Tallinn',
  district: 'Kristiine',
  apartment_count: 6,
  apartments_count: 6,
  total_apartments: 6,
  entrance_count: 2,
  entrances_count: 2,
  total_entrances: 2,
  heated_area_m2: '329.20',
}

const OFFLINE_PERIODS = [
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

function toBigInt3(val) {
  const [intPart, fracPart = ''] = String(val || '0').split('.')
  const padded = (fracPart + '000').slice(0, 3)
  return BigInt(intPart) * 1000n + BigInt(padded)
}

function fromBigInt3(scaled) {
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const intPart = abs / 1000n
  const fracPart = (abs % 1000n).toString().padStart(3, '0')
  return `${negative ? '-' : ''}${intPart.toString()}.${fracPart}`
}

function subDecimal(a, b) {
  return fromBigInt3(toBigInt3(a) - toBigInt3(b))
}

const BASE_APARTMENTS_2026_10 = [
  {
    apartment_id: '018f0000-0000-7000-8000-000000000301',
    apartment_number: '01',
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
        historical_avg: '2.100',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000801',
          value: '112.400',
          consumption_delta: '2.200',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000502',
        resource_type: 'HOT_WATER',
        serial_number: 'HW-0101-B',
        location_label: 'Bathroom Hot Water',
        unit: 'm3',
        previous_value: '78.400',
        historical_avg: '1.800',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000802',
          value: '80.250',
          consumption_delta: '1.850',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
        },
      },
    ],
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000302',
    apartment_number: '02',
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
        historical_avg: '3.900',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000803',
          value: '187.850',
          consumption_delta: '3.850',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000504',
        resource_type: 'HOT_WATER',
        serial_number: 'HW-0201-B',
        location_label: 'Bathroom Hot Water',
        unit: 'm3',
        previous_value: '95.500',
        historical_avg: '2.400',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000804',
          value: '97.950',
          consumption_delta: '2.450',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
        },
      },
    ],
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000305',
    apartment_number: '05',
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
        historical_avg: '3.100',
        reading: null,
      },
    ],
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000309',
    apartment_number: '09',
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
        historical_avg: '3.600',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000809',
          value: '179.400',
          consumption_delta: '14.400',
          source: 'RESIDENT',
          is_anomaly_confirmed: true,
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000510',
        resource_type: 'HOT_WATER',
        serial_number: 'HW-0901-B',
        location_label: 'Bathroom Hot Water',
        unit: 'm3',
        previous_value: '88.300',
        historical_avg: '2.200',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000810',
          value: '90.500',
          consumption_delta: '2.200',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
        },
      },
    ],
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000314',
    apartment_number: '14',
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
        historical_avg: '2.100',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000901',
          value: '86.200',
          consumption_delta: '2.100',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000515',
        resource_type: 'HOT_WATER',
        serial_number: 'HW-1429-K',
        location_label: 'Kitchen Hot Water',
        unit: 'm3',
        previous_value: '52.400',
        historical_avg: '1.300',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000902',
          value: '53.750',
          consumption_delta: '1.350',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
        },
      },
      {
        meter_id: '018f0000-0000-7000-8000-000000000516',
        resource_type: 'COLD_WATER',
        serial_number: 'CW-1429-B',
        location_label: 'Bathroom Cold Water',
        unit: 'm3',
        previous_value: '142.350',
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
        historical_avg: '65.000',
        reading: {
          reading_id: '018f0000-0000-7000-8000-000000000905',
          value: '1304.500',
          consumption_delta: '64.500',
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
        },
      },
    ],
  },
]

const MASTER_METERS_2026_10 = [
  {
    meter_id: '018f0000-0000-7000-8000-000000000991',
    resource_type: 'COLD_WATER',
    location_label: 'Basement Main Cold Water Inlet',
    unit: 'm3',
    previous_value: '4120.000',
    status: 'SUBMITTED',
    reading: {
      reading_id: '018f0000-0000-7000-8000-000000000981',
      value: '4148.500',
      consumption_delta: '28.500',
      source: 'ADMIN_OVERRIDE',
      is_anomaly_confirmed: false,
    },
  },
  {
    meter_id: '018f0000-0000-7000-8000-000000000992',
    resource_type: 'HOT_WATER',
    location_label: 'Basement Heat Exchanger Hot Water',
    unit: 'm3',
    previous_value: '2050.000',
    status: 'SUBMITTED',
    reading: {
      reading_id: '018f0000-0000-7000-8000-000000000982',
      value: '2065.400',
      consumption_delta: '15.400',
      source: 'ADMIN_OVERRIDE',
      is_anomaly_confirmed: false,
    },
  },
]

function createOfflineApartmentsByPeriod() {
  const oct = JSON.parse(JSON.stringify(BASE_APARTMENTS_2026_10))
  const nov = JSON.parse(JSON.stringify(BASE_APARTMENTS_2026_10)).map((apt) => ({
    ...apt,
    can_submit_readings: true,
    meters: apt.meters.map((m) => ({
      ...m,
      previous_value: m.reading ? m.reading.value : m.previous_value,
      reading: null,
    })),
  }))

  const periodsMap = {
    '2026-10': oct,
    '2026-11': nov,
  }

  for (const histCode of ['2026-09', '2026-08', '2026-07']) {
    periodsMap[histCode] = JSON.parse(JSON.stringify(BASE_APARTMENTS_2026_10)).map((apt) => ({
      ...apt,
      can_submit_readings: false,
      meters: apt.meters.map((m) => ({
        ...m,
        previous_value: subDecimal(m.previous_value, m.historical_avg),
        reading: {
          reading_id: `${m.meter_id}-${histCode}`,
          value: m.previous_value,
          consumption_delta: m.historical_avg,
          source: 'RESIDENT',
          is_anomaly_confirmed: false,
        },
      })),
    }))
  }

  return periodsMap
}

function getPeriodApartments(periodCode) {
  if (!offlineApartmentsByPeriod['2026-10']) {
    offlineApartmentsByPeriod = createOfflineApartmentsByPeriod()
  }
  const code = periodCode || '2026-10'
  return offlineApartmentsByPeriod[code] || offlineApartmentsByPeriod['2026-10']
}

function findOfflineMeterInPeriod(periodCode, meterId) {
  const apts = getPeriodApartments(periodCode)
  for (const apt of apts) {
    const meter = apt.meters.find((item) => item.meter_id === meterId)
    if (meter) return { apt, meter }
  }
  return null
}

function computeOfflineNextSubmission(meterId, aptCanSubmit, membershipCanSubmit) {
  if (!aptCanSubmit || !membershipCanSubmit) return null
  const pPrev = OFFLINE_PERIODS.find((p) => p.period_code === '2026-10')
  const pCurr = OFFLINE_PERIODS.find((p) => p.period_code === '2026-11')
  const mPrev = findOfflineMeterInPeriod('2026-10', meterId)?.meter || null
  const mCurr = findOfflineMeterInPeriod('2026-11', meterId)?.meter || null

  const hasSubmittedPrev = Boolean(mPrev?.reading && mPrev.reading.source !== 'AUTO_ESTIMATED')
  const hasAnyCurr = Boolean(mCurr?.reading)

  if (pPrev && pPrev.status === 'OPEN_FOR_RESIDENTS' && mPrev && !hasSubmittedPrev && !hasAnyCurr) {
    return {
      period_code: pPrev.period_code,
      due_date: pPrev.due_date,
      final: true,
      previous_value: mPrev.previous_value,
      average_delta: mPrev.historical_avg,
      reading: null,
    }
  }

  if (pCurr && pCurr.status === 'OPEN_FOR_RESIDENTS' && mCurr) {
    return {
      period_code: pCurr.period_code,
      due_date: pCurr.due_date,
      final: false,
      previous_value: mCurr.previous_value,
      average_delta: mCurr.historical_avg,
      reading: mCurr.reading ? { ...mCurr.reading } : null,
    }
  }

  return null
}

function createDefaultOfflinePosts() {
  const nowMs = Date.now()
  const twoHoursAgoIso = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString()
  const ninetyMinAgoIso = new Date(nowMs - 90 * 60 * 1000).toISOString()
  const fortyFiveMinAgoIso = new Date(nowMs - 45 * 60 * 1000).toISOString()
  return [
  {
    id: '018f0000-0000-7000-8000-000000000606',
    post_type: 'FORUM_TOPIC',
    category: 'GENERAL',
    title: 'Weekend courtyard bench repainting helpers',
    body: 'We have two cans of weatherproof timber oil left in the shed. Anyone free on Sunday at 11:00 to help coat the courtyard benches before the rain?',
    author_user_id: '018f0000-0000-7000-8000-000000000102',
    author_badge: {
      display_label: 'Kati Kask (Apt 14)',
      role_badge: 'OWNER',
    },
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: twoHoursAgoIso,
    edited_at: null,
    hidden_at: null,
    hidden_reason: null,
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000655',
        post_id: '018f0000-0000-7000-8000-000000000606',
        body: 'I can bring sandpaper and extra brushes from the utility room.',
        author_user_id: '018f0000-0000-7000-8000-000000000101',
        author_badge: {
          display_label: 'Peeter Tamm (Apt 01)',
          role_badge: 'BOARD',
        },
        created_at: ninetyMinAgoIso,
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
      },
      {
        id: '018f0000-0000-7000-8000-000000000656',
        post_id: '018f0000-0000-7000-8000-000000000606',
        body: 'Thank you Peeter! I will also pick up masking tape tomorrow morning.',
        author_user_id: '018f0000-0000-7000-8000-000000000102',
        author_badge: {
          display_label: 'Kati Kask (Apt 14)',
          role_badge: 'OWNER',
        },
        created_at: fortyFiveMinAgoIso,
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
      },
    ],
  },
  {
    id: '018f0000-0000-7000-8000-000000000701',
    post_type: 'EMERGENCY',
    category: 'WATER_SHUTOFF',
    title: 'Basement Heating Valve Pressure Drop (Stairwell B)',
    body: 'Pressure sensor in Stairwell B heat exchanger dropped from 2.4 bar to 1.6 bar. Technician is on site inspecting the expansion vessel.',
    author_user_id: '018f0000-0000-7000-8000-000000000101',
    author_badge: {
      display_label: 'Peeter Tamm (Apt 01)',
      role_badge: 'BOARD',
    },
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-25T08:15:00Z',
    edited_at: null,
    hidden_at: null,
    hidden_reason: null,
    acknowledged_at: null,
    comments: [],
  },
  {
    id: '018f0000-0000-7000-8000-000000000601',
    post_type: 'OFFICIAL_NOTICE',
    category: 'GENERAL',
    title: 'October 2026 Utility Meter Submission & Courtyard Maintenance',
    body: 'Dear residents of Sõpruse pst 12,\n\nPlease submit all October 2026 cold and hot water readings by November 4 at 23:59. Unsubmitted meters will be automatically estimated from your 3-month rolling average.\n\nAdditionally, autumn courtyard leaf clearing and underground garage drain flushing will take place on Saturday, November 7 from 09:00 to 14:00.',
    author_user_id: '018f0000-0000-7000-8000-000000000101',
    author_badge: {
      display_label: 'Peeter Tamm (Apt 01)',
      role_badge: 'BOARD',
    },
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-23T11:00:00Z',
    edited_at: null,
    hidden_at: null,
    hidden_reason: null,
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000651',
        post_id: '018f0000-0000-7000-8000-000000000601',
        body: 'Thank you Peeter! Should cars be moved out of the courtyard parking spots before 08:45 on Saturday?',
        author_user_id: '018f0000-0000-7000-8000-000000000102',
        author_badge: {
          display_label: 'Kati Kask (Apt 14)',
          role_badge: 'OWNER',
        },
        created_at: '2026-10-23T13:20:00Z',
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
      },
      {
        id: '018f0000-0000-7000-8000-000000000652',
        post_id: '018f0000-0000-7000-8000-000000000601',
        body: 'Yes, please clear the courtyard bays by 08:45 so the maintenance vehicle can access all corners.',
        author_user_id: '018f0000-0000-7000-8000-000000000101',
        author_badge: {
          display_label: 'Peeter Tamm (Apt 01)',
          role_badge: 'BOARD',
        },
        created_at: '2026-10-23T14:05:00Z',
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
      },
    ],
  },
  {
    id: '018f0000-0000-7000-8000-000000000605',
    post_type: 'FORUM_TOPIC',
    category: 'MARKETPLACE',
    title: 'Commercial courier discount code spam',
    body: 'Use my referral link every day for commercial deliveries and promotional flyers in every mailbox.',
    author_user_id: '018f0000-0000-7000-8000-000000000104',
    author_badge: {
      display_label: 'M. S. (Apt 02)',
      role_badge: 'RESIDENT',
    },
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-22T15:00:00Z',
    edited_at: null,
    hidden_at: '2026-10-22T16:15:00Z',
    hidden_reason: 'Commercial advertising is not allowed in the building forum.',
    comments: [],
  },
  {
    id: '018f0000-0000-7000-8000-000000000602',
    post_type: 'FORUM_TOPIC',
    category: 'MAINTENANCE',
    title: 'Bicycle Storage Rack Expansion in Ground Floor Room #2',
    body: 'Several families on the 3rd and 4th floors proposed installing vertical wall-mounted bike hooks in the secondary storage room. Total quote for 12 heavy-duty hooks is 480 EUR from the maintenance fund.',
    author_user_id: '018f0000-0000-7000-8000-000000000102',
    author_badge: {
      display_label: 'Kati Kask (Apt 14)',
      role_badge: 'OWNER',
    },
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-20T17:30:00Z',
    edited_at: '2026-10-20T18:05:00Z',
    hidden_at: null,
    hidden_reason: null,
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000653',
        post_id: '018f0000-0000-7000-8000-000000000602',
        body: 'We have sufficient allocation in the Q4 minor improvements budget line to cover 480 EUR without affecting the reserve fund.',
        author_user_id: '018f0000-0000-7000-8000-000000000103',
        author_badge: {
          display_label: 'Marika Rebane',
          role_badge: 'ACCOUNTANT',
        },
        created_at: '2026-10-21T09:15:00Z',
        edited_at: '2026-10-21T09:22:00Z',
        hidden_at: null,
        hidden_reason: null,
      },
      {
        id: '018f0000-0000-7000-8000-000000000654',
        post_id: '018f0000-0000-7000-8000-000000000602',
        body: 'Why are ground floor residents paying for upper floor bikes?! Keep them in your own flats!',
        author_user_id: '018f0000-0000-7000-8000-000000000104',
        author_badge: {
          display_label: 'M. S. (Apt 02)',
          role_badge: 'RESIDENT',
        },
        created_at: '2026-10-21T11:40:00Z',
        edited_at: null,
        hidden_at: '2026-10-21T12:10:00Z',
        hidden_reason: 'Personal attacks against neighbors violate house rules.',
      },
    ],
  },
  {
    id: '018f0000-0000-7000-8000-000000000603',
    post_type: 'OFFICIAL_NOTICE',
    category: 'MAINTENANCE',
    title: 'District Heating Substation Winter Calibration Completed',
    body: 'Utilitas Tallinn completed the scheduled diagnostic check of our primary heating substation. Efficiency is within 99.1% of nominal specification and night-time setback curve has been calibrated.',
    author_user_id: '018f0000-0000-7000-8000-000000000101',
    author_badge: {
      display_label: 'Peeter Tamm (Apt 01)',
      role_badge: 'BOARD',
    },
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-15T10:00:00Z',
    edited_at: null,
    hidden_at: null,
    hidden_reason: null,
    comments: [],
  },
  {
    id: '018f0000-0000-7000-8000-000000000751',
    post_type: 'APARTMENT_THREAD',
    category: 'MAINTENANCE',
    title: 'Access to the cold water meter in apartment 14',
    body: 'Hello! Could we arrange a 10-minute inspection of the bathroom cold water meter seal this Thursday between 17:00 and 19:00?',
    author_user_id: '018f0000-0000-7000-8000-000000000101',
    author_badge: {
      display_label: 'Chairman',
      role_badge: 'BOARD',
    },
    target_scope: 'APARTMENT_LIST',
    target_entrance: null,
    target_apartment_ids: ['018f0000-0000-7000-8000-000000000314'],
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-24T10:15:00Z',
    edited_at: null,
    hidden_at: null,
    hidden_reason: null,
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000752',
        post_id: '018f0000-0000-7000-8000-000000000751',
        body: 'Thursday at 18:00 works well for us. See you then!',
        author_user_id: '018f0000-0000-7000-8000-000000000102',
        author_badge: {
          display_label: 'Kati Kask (Apt 14)',
          role_badge: 'OWNER',
        },
        created_at: '2026-10-24T12:40:00Z',
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
      },
    ],
  },
  {
    id: '018f0000-0000-7000-8000-000000000761',
    post_type: 'BOARD_TOPIC',
    category: 'GENERAL',
    title: 'Where the keys to the basement and the roof are',
    body: 'The spare set of keys to the basement technical room, district heating node, and roof hatch is stored in the locked fire-rated cabinet in Entrance 1 utility room. The combination was shared at the October board meeting.',
    author_user_id: '018f0000-0000-7000-8000-000000000101',
    author_badge: {
      display_label: 'Oleg Sidorov',
      role_badge: 'BOARD',
    },
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-25T11:30:00Z',
    edited_at: null,
    hidden_at: null,
    hidden_reason: null,
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000762',
        post_id: '018f0000-0000-7000-8000-000000000761',
        body: 'Confirmed — I also labelled the roof hatch key and the main water shut-off valve key on the yellow tag.',
        author_user_id: '018f0000-0000-7000-8000-000000000105',
        author_badge: {
          display_label: 'Peeter Saar',
          role_badge: 'BOARD',
        },
        created_at: '2026-10-25T14:20:00Z',
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
      },
    ],
  },
  {
    id: '018f0000-0000-7000-8000-000000000604',
    post_type: 'OFFICIAL_NOTICE',
    origin: 'MAINTENANCE',
    category: 'MAINTENANCE',
    title: 'Annual Fire Extinguisher Inspection',
    body: 'Inspector will check all stairwell and common area fire safety equipment. No access to individual flats needed.\n\nPlanned date: 2026-11-05',
    author_user_id: '018f0000-0000-7000-8000-000000000101',
    author_badge: {
      display_label: 'Peeter Tamm (Apt 01)',
      role_badge: 'BOARD',
    },
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: false,
    created_at: '2026-10-25T09:00:00Z',
    edited_at: null,
    hidden_at: null,
    hidden_reason: null,
    comments: [],
  },
  {
    id: '018f0000-0000-7000-8000-000000000763',
    post_type: 'BOARD_TOPIC',
    origin: 'MAINTENANCE',
    category: 'MAINTENANCE',
    title: 'Maintenance: Inspect fire extinguishers, overdue since 05.11.2026',
    body: 'Basement, technical rooms, and all 4 landings in both entrances. Certified technician needed.',
    author_user_id: '018f0000-0000-7000-8000-000000000101',
    author_badge: {
      display_label: 'Oleg Sidorov',
      role_badge: 'BOARD',
    },
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-25T09:00:00Z',
    edited_at: null,
    hidden_at: null,
    hidden_reason: null,
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000764',
        post_id: '018f0000-0000-7000-8000-000000000763',
        body: 'Still not done: overdue since 05.11.2026 (reminder 1)',
        author_user_id: '018f0000-0000-7000-8000-000000000101',
        author_badge: {
          display_label: 'Oleg Sidorov',
          role_badge: 'BOARD',
        },
        created_at: '2026-11-06T09:00:00Z',
        edited_at: null,
        hidden_at: null,
        hidden_reason: null,
      },
    ],
  },
  ]
}

const OFFLINE_POSTS = createDefaultOfflinePosts()

function getActingUser(actingUserId) {
  const effectiveId = actingUserId || offlineSignedInUserId
  return (
    OFFLINE_DEMO_USERS.find((u) => u.user_id === effectiveId) || OFFLINE_DEMO_USERS[0]
  )
}

function makeOfflineError(status, errorCode, message, extra = {}) {
  const err = new Error(message)
  err.status = status
  err.errorCode = errorCode
  err.payload = { error_code: errorCode, message, ...extra }
  err.fieldErrors = extra.errors || []
  return err
}

/**
 * Resolves API requests locally from seeded read-only demo fixtures when offlineDemoMode is enabled.
 * @param {string} path
 * @param {{ method?: string, body?: any, raw?: boolean, actingUserId?: string, contentType?: string, headers?: Record<string, string>, signal?: AbortSignal }} [options]
 */
export async function resolveOfflineDemoRequest(
  path,
  { method = 'GET', body = null, raw = false, actingUserId = '', contentType = '', headers = {}, signal } = {},
) {
  const urlObj = new URL(path, 'http://localhost')
  const pathname = urlObj.pathname
  const user = getActingUser(actingUserId)

  // 1. GET /demo/users
  if (pathname === '/demo/users' && method === 'GET') {
    return OFFLINE_DEMO_USERS.map((u) => ({
      user_id: u.user_id,
      label: u.label,
      building_role: u.building_role,
      apartment_number: u.apartment_number,
      relation_type: u.relation_type,
    }))
  }

  // 2. GET /property/me
  if (pathname === '/property/me' && method === 'GET') {
    const memberships = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    return {
      user_id: user.user_id,
      building_id: BUILDING_ID,
      building_role: user.building_role,
      privacy_display_mode: memberships[0]?.privacy_display_mode || 'FULL_NAME',
      locale: user.locale ?? null,
      memberships: JSON.parse(JSON.stringify(memberships)),
    }
  }

  // 2a. PATCH /property/me/locale
  if (pathname === '/property/me/locale' && method === 'PATCH') {
    const nextLocale =
      body && typeof body.locale === 'string' && ['en', 'et', 'ru'].includes(body.locale)
        ? body.locale
        : null
    user.locale = nextLocale
    return { locale: nextLocale }
  }

  // 3. GET /property/building
  if (pathname === '/property/building' && method === 'GET') {
    return { ...OFFLINE_BUILDING }
  }

  // 3b. GET /property/apartments & GET /property/apartments/:id (E8/P1)
  const OFFLINE_APARTMENT_CARDS = [
    {
      apartment_id: '018f0000-0000-7000-8000-000000000301',
      apartment_number: '01',
      entrance: 1,
      floor: 1,
      area_m2: '48.50',
      owner_count: 1,
      tenant_count: 0,
      resident_count: 0,
      residents: [{ relation_type: 'OWNER', since: '2021-03-10T10:00:00Z' }],
    },
    {
      apartment_id: '018f0000-0000-7000-8000-000000000302',
      apartment_number: '02',
      entrance: 1,
      floor: 1,
      area_m2: '54.30',
      owner_count: 0,
      tenant_count: 1,
      resident_count: 0,
      residents: [{ relation_type: 'TENANT', since: '2026-06-15T10:00:00Z' }],
    },
    {
      apartment_id: '018f0000-0000-7000-8000-000000000305',
      apartment_number: '05',
      entrance: 1,
      floor: 2,
      area_m2: '62.10',
      owner_count: 0,
      tenant_count: 0,
      resident_count: 0,
      residents: [],
    },
    {
      apartment_id: '018f0000-0000-7000-8000-000000000309',
      apartment_number: '09',
      entrance: 2,
      floor: 3,
      area_m2: '51.00',
      owner_count: 1,
      tenant_count: 0,
      resident_count: 1,
      residents: [
        { relation_type: 'OWNER', since: '2023-04-01T09:00:00Z' },
        { relation_type: 'RESIDENT', since: '2024-09-01T12:00:00Z' },
      ],
    },
    {
      apartment_id: '018f0000-0000-7000-8000-000000000314',
      apartment_number: '14',
      entrance: 2,
      floor: 4,
      area_m2: '54.30',
      owner_count: 1,
      tenant_count: 1,
      resident_count: 0,
      residents: [
        { relation_type: 'OWNER', since: '2022-01-12T10:00:00Z' },
        { relation_type: 'TENANT', since: '2025-09-03T10:00:00Z' },
      ],
    },
    {
      apartment_id: '018f0000-0000-7000-8000-000000000315',
      apartment_number: '15',
      entrance: 2,
      floor: 4,
      area_m2: '59.00',
      owner_count: 1,
      tenant_count: 1,
      resident_count: 0,
      residents: [
        { relation_type: 'OWNER', since: '2022-05-18T10:00:00Z' },
        { relation_type: 'TENANT', since: '2025-05-01T10:00:00Z' },
      ],
    },
  ]

  if (pathname === '/property/apartments' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      const err = new Error('Forbidden')
      err.status = 403
      err.errorCode = 'FORBIDDEN'
      err.payload = { error_code: 'FORBIDDEN' }
      throw err
    }
    return {
      apartments: OFFLINE_APARTMENT_CARDS.map(({ residents, ...rest }) => rest),
    }
  }

  const offlineAptCardMatch = pathname.match(/^\/property\/apartments\/([^/]+)$/)
  if (offlineAptCardMatch && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      const err = new Error('Forbidden')
      err.status = 403
      err.errorCode = 'FORBIDDEN'
      err.payload = { error_code: 'FORBIDDEN' }
      throw err
    }
    const found = OFFLINE_APARTMENT_CARDS.find((a) => a.apartment_id === offlineAptCardMatch[1])
    if (!found) {
      const err = new Error('Apartment not found')
      err.status = 404
      err.errorCode = 'APARTMENT_NOT_FOUND'
      err.payload = { error_code: 'APARTMENT_NOT_FOUND' }
      throw err
    }
    return JSON.parse(JSON.stringify(found))
  }

  // 4. GET /meters/periods
  if (pathname === '/meters/periods' && method === 'GET') {
    return { periods: JSON.parse(JSON.stringify(OFFLINE_PERIODS)) }
  }

  // Helper shared by /readings and /consumption so histories stay 100% consistent
  function buildOfflineApartmentMeters(cardMeta) {
    const baseApt =
      BASE_APARTMENTS_2026_10.find((a) => a.apartment_id === cardMeta.apartment_id) ||
      BASE_APARTMENTS_2026_10[0]
    const meters = baseApt.meters.map((baseMeter, mIdx) => {
      const readings = []
      for (const p of OFFLINE_PERIODS) {
        const periodApt = getPeriodApartments(p.period_code).find(
          (a) => a.apartment_id === baseApt.apartment_id,
        )
        const periodMeter = periodApt?.meters.find((m) => m.meter_id === baseMeter.meter_id)
        if (periodMeter?.reading) {
          readings.push({
            period_code: p.period_code,
            reading_id: periodMeter.reading.reading_id,
            value: periodMeter.reading.value,
            consumption_delta: periodMeter.reading.consumption_delta,
            source: p.period_code === '2026-08' && mIdx === 0 ? 'AUTO_ESTIMATED' : periodMeter.reading.source,
            is_anomaly_confirmed: Boolean(periodMeter.reading.is_anomaly_confirmed),
          })
        }
      }
      return {
        meter_id: baseMeter.meter_id,
        resource_type: baseMeter.resource_type,
        serial_number: baseMeter.serial_number,
        location_label: baseMeter.location_label,
        unit: baseMeter.unit,
        is_active: true,
        readings,
      }
    })
    if (cardMeta.apartment_number === '14') {
      meters.push({
        meter_id: '018f0000-0000-7000-8000-000000000599',
        resource_type: 'COLD_WATER',
        serial_number: 'CW-1429-OLD',
        location_label: 'Kitchen Cold Water (Old)',
        unit: 'm3',
        is_active: false,
        readings: [
          {
            period_code: '2026-07',
            reading_id: '018f0000-0000-7000-8000-000000000999',
            value: '79.900',
            consumption_delta: '2.000',
            source: 'RESIDENT',
            is_anomaly_confirmed: false,
          },
        ],
      })
    }
    return meters
  }

  function safeDecodePathSegment(raw) {
    try {
      return decodeURIComponent(raw)
    } catch {
      return ''
    }
  }

  // 4b. GET /meters/apartments/:id/readings (E8/P1)
  const offlineAptReadingsMatch = pathname.match(/^\/meters\/apartments\/([^/]+)\/readings$/)
  if (offlineAptReadingsMatch && method === 'GET') {
    const aptId = safeDecodePathSegment(offlineAptReadingsMatch[1])
    const cardMeta = aptId ? OFFLINE_APARTMENT_CARDS.find((a) => a.apartment_id === aptId) : null
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const isStaff = ['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)
    const isOwn = Boolean(aptId) && userMems.some((m) => m.apartment_id === aptId)
    if (!cardMeta || (!isStaff && !isOwn)) {
      const err = new Error('Apartment not found')
      err.status = 404
      err.errorCode = 'APARTMENT_NOT_FOUND'
      err.payload = { error_code: 'APARTMENT_NOT_FOUND' }
      throw err
    }
    return {
      apartment_id: cardMeta.apartment_id,
      apartment_number: cardMeta.apartment_number,
      periods: JSON.parse(JSON.stringify(OFFLINE_PERIODS)),
      meters: buildOfflineApartmentMeters(cardMeta),
    }
  }

  // 4c. GET /meters/apartments/:id/consumption (#030)
  const offlineAptConsumptionMatch = pathname.match(/^\/meters\/apartments\/([^/]+)\/consumption$/)
  if (offlineAptConsumptionMatch && method === 'GET') {
    const aptId = safeDecodePathSegment(offlineAptConsumptionMatch[1])
    const cardMeta = aptId ? OFFLINE_APARTMENT_CARDS.find((a) => a.apartment_id === aptId) : null
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const isStaff = ['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)
    const isOwn = Boolean(aptId) && userMems.some((m) => m.apartment_id === aptId)
    if (!cardMeta || (!isStaff && !isOwn)) {
      const err = new Error('Apartment not found')
      err.status = 404
      err.errorCode = 'APARTMENT_NOT_FOUND'
      err.payload = { error_code: 'APARTMENT_NOT_FOUND' }
      throw err
    }
    const parsedMonths = parseConsumptionMonths(urlObj.searchParams.get('months'))
    if (!parsedMonths.ok) {
      const err = new Error(parsedMonths.message || 'Invalid months parameter')
      err.status = 422
      err.errorCode = 'VALIDATION_ERROR'
      err.payload = { error_code: 'VALIDATION_ERROR', message: parsedMonths.message }
      throw err
    }
    return buildApartmentConsumptionResponse({
      apartmentId: cardMeta.apartment_id,
      apartmentNumber: cardMeta.apartment_number,
      periods: OFFLINE_PERIODS,
      meters: buildOfflineApartmentMeters(cardMeta),
      months: parsedMonths.months,
    })
  }

  // 4d. GET /meters/consumption (#031) - staff only (CHAIRMAN, BOARD, ACCOUNTANT)
  if (pathname === '/meters/consumption' && method === 'GET') {
    const isStaff = ['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)
    if (!isStaff) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Chairman, Board, or Accountant role required.')
    }
    const parsedMonths = parseConsumptionMonths(urlObj.searchParams.get('months'))
    if (!parsedMonths.ok) {
      const msg = parsedMonths.message || 'Invalid months parameter'
      throw makeOfflineError(422, 'VALIDATION_ERROR', msg, {
        errors: [{ field: 'months', message: msg }],
      })
    }
    const apartmentsPayload = BASE_APARTMENTS_2026_10.map((baseApt) => {
      const cardMeta = OFFLINE_APARTMENT_CARDS.find((a) => a.apartment_id === baseApt.apartment_id)
      return {
        apartment_id: baseApt.apartment_id,
        area_m2: cardMeta?.area_m2 || '0',
        meters: buildOfflineApartmentMeters(cardMeta || baseApt),
      }
    })
    return buildBuildingConsumptionResponse({
      periods: OFFLINE_PERIODS,
      apartments: apartmentsPayload,
      months: parsedMonths.months,
    })
  }

  // 5. GET /meters/my-dashboard
  if (pathname === '/meters/my-dashboard' && method === 'GET') {
    const requestedPeriodCode = urlObj.searchParams.get('period_code')
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const userAptIds = new Set(userMems.map((m) => m.apartment_id))
    const memByAptId = new Map(userMems.map((m) => [m.apartment_id, m]))

    let periodCode = requestedPeriodCode
    if (!periodCode) {
      const refApts = getPeriodApartments('2026-10')
      let hasPendingPrev = false
      for (const a of refApts) {
        if (!userAptIds.has(a.apartment_id)) continue
        const memCanSubmit = Boolean(memByAptId.get(a.apartment_id)?.can_submit_readings)
        for (const m of a.meters) {
          const sub = computeOfflineNextSubmission(m.meter_id, a.can_submit_readings, memCanSubmit)
          if (sub?.period_code === '2026-10') {
            hasPendingPrev = true
            break
          }
        }
        if (hasPendingPrev) break
      }
      periodCode = hasPendingPrev ? '2026-10' : '2026-11'
    }

    const period =
      OFFLINE_PERIODS.find((p) => p.period_code === periodCode) || OFFLINE_PERIODS[0]
    const periodApts = getPeriodApartments(period.period_code)

    const baseCanSubmitByAptId = new Map(
      BASE_APARTMENTS_2026_10.map((a) => [a.apartment_id, Boolean(a.can_submit_readings)]),
    )

    const apartments = periodApts
      .filter((a) => userAptIds.has(a.apartment_id))
      .map((a) => {
        const memCanSubmit = Boolean(memByAptId.get(a.apartment_id)?.can_submit_readings)
        const baseAptCanSubmit = baseCanSubmitByAptId.get(a.apartment_id) ?? false
        return {
          apartment_id: a.apartment_id,
          apartment_number: a.apartment_number,
          can_submit_readings: baseAptCanSubmit && memCanSubmit,
          meters: a.meters.map((m) => ({
            meter_id: m.meter_id,
            resource_type: m.resource_type,
            serial_number: m.serial_number,
            location_label: m.location_label,
            unit: m.unit,
            previous_value: m.previous_value,
            previous_delta: m.historical_avg,
            average_delta: m.historical_avg,
            reading: m.reading ? { ...m.reading } : null,
            next_submission: computeOfflineNextSubmission(
              m.meter_id,
              baseAptCanSubmit,
              memCanSubmit,
            ),
          })),
        }
      })

    return {
      period: { ...period },
      apartments,
    }
  }

  // 5b. POST /meters/readings
  if (pathname === '/meters/readings' && method === 'POST') {
    const payload = body || {}
    const {
      meter_id,
      period_code = '2026-10',
      value,
      confirmation_level = 0,
      reason = null,
    } = payload

    const period = OFFLINE_PERIODS.find((p) => p.period_code === period_code)
    if (!period) {
      throw makeOfflineError(404, 'PERIOD_NOT_FOUND', 'The requested billing period was not found.')
    }
    if (period.status === 'LOCKED') {
      throw makeOfflineError(409, 'PERIOD_LOCKED', 'This billing period is locked.')
    }

    const match = findOfflineMeterInPeriod(period_code, meter_id)
    if (!match) {
      throw makeOfflineError(404, 'METER_NOT_FOUND', 'Meter not found.')
    }
    const { apt: foundApt, meter: foundMeter } = match

    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const matchingMem = userMems.find((m) => m.apartment_id === foundApt.apartment_id) || null
    const isOwnUnit = Boolean(matchingMem)
    const isPrivilegedRole = user.building_role === 'CHAIRMAN' || user.building_role === 'ACCOUNTANT'

    if (!isOwnUnit && !isPrivilegedRole) {
      throw makeOfflineError(404, 'METER_NOT_FOUND', 'Meter not found.')
    }

    if (typeof value !== 'string' || !/^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(value)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid decimal meter reading.')
    }

    const normalizedVal = fromBigInt3(toBigInt3(value))
    const existingReading = foundMeter.reading
    const nextSub = computeOfflineNextSubmission(
      meter_id,
      foundApt.can_submit_readings,
      Boolean(matchingMem?.can_submit_readings),
    )

    const actingAsResident =
      !isPrivilegedRole || (isOwnUnit && nextSub?.period_code === period_code)

    if (actingAsResident) {
      if (!matchingMem?.can_submit_readings || !foundApt.can_submit_readings) {
        throw makeOfflineError(403, 'FORBIDDEN', 'You cannot submit readings for this apartment.')
      }

      if (
        existingReading &&
        existingReading.source === 'RESIDENT' &&
        existingReading.value === normalizedVal &&
        period.status === 'OPEN_FOR_RESIDENTS'
      ) {
        return {
          reading_id: existingReading.reading_id,
          meter_id,
          period_code,
          value: existingReading.value,
          consumption_delta: existingReading.consumption_delta,
          source: existingReading.source,
          is_anomaly_confirmed: existingReading.is_anomaly_confirmed,
        }
      }

      if (period.status !== 'OPEN_FOR_RESIDENTS' || !nextSub) {
        throw makeOfflineError(409, 'PERIOD_CLOSED', 'Period is closed for residents.')
      }

      if (period_code !== nextSub.period_code) {
        throw makeOfflineError(
          409,
          'WRONG_PERIOD',
          `Reading belongs to period ${nextSub.period_code}.`,
          { target_period_code: nextSub.period_code },
        )
      }

      if (existingReading?.source === 'ADMIN_OVERRIDE') {
        throw makeOfflineError(
          409,
          'READING_SET_BY_BOARD',
          'This reading was set by the board and cannot be overwritten by a resident.',
        )
      }
    } else if (period.status !== 'OPEN_FOR_RESIDENTS' && !isPrivilegedRole) {
      throw makeOfflineError(409, 'PERIOD_CLOSED', 'Period is closed for residents.')
    }

    const sortedCodes = OFFLINE_PERIODS.map((p) => p.period_code).sort()
    const targetIdx = sortedCodes.indexOf(period_code)
    if (targetIdx >= 0) {
      for (let i = targetIdx + 1; i < sortedCodes.length; i++) {
        const newerMatch = findOfflineMeterInPeriod(sortedCodes[i], meter_id)
        if (newerMatch?.meter?.reading) {
          throw makeOfflineError(
            409,
            'LATER_READING_EXISTS',
            'A newer period already has a reading for this meter.',
          )
        }
      }
    }

    const prevScaled = toBigInt3(foundMeter.previous_value)
    const currScaled = toBigInt3(normalizedVal)
    if (currScaled < prevScaled) {
      throw makeOfflineError(
        422,
        'READING_BELOW_PREVIOUS',
        `Value (${normalizedVal}) cannot be lower than previous reading (${foundMeter.previous_value}).`,
        { previous_value: foundMeter.previous_value },
      )
    }

    if (existingReading && !actingAsResident && isPrivilegedRole && (!reason || !String(reason).trim())) {
      throw makeOfflineError(
        422,
        'REASON_REQUIRED',
        'A reason is required when overriding an existing meter reading.',
      )
    }

    const deltaScaled = currScaled - prevScaled
    const deltaStr = fromBigInt3(deltaScaled)
    const avgStr = foundMeter.historical_avg
    const avgScaled = toBigInt3(avgStr)
    const thresholdScaled = avgScaled * 3n > 10000n ? avgScaled * 3n : 10000n
    const isAnomaly = deltaScaled > thresholdScaled

    if (isAnomaly && confirmation_level === 0) {
      throw makeOfflineError(
        409,
        'ANOMALY_CONFIRMATION_STEP_1',
        `Unusually high consumption (${deltaStr} ${foundMeter.unit}).`,
        {
          submitted_value: normalizedVal,
          previous_value: foundMeter.previous_value,
          consumption_delta: deltaStr,
          average_delta: avgStr,
          max_reasonable_delta: fromBigInt3(thresholdScaled),
          required_confirmation_level: 1,
        },
      )
    }

    if (isAnomaly && confirmation_level === 1) {
      throw makeOfflineError(
        409,
        'ANOMALY_CONFIRMATION_STEP_2',
        `Final confirmation required: ${deltaStr} ${foundMeter.unit}.`,
        {
          submitted_value: normalizedVal,
          previous_value: foundMeter.previous_value,
          consumption_delta: deltaStr,
          historical_average: avgStr,
          required_confirmation_level: 2,
        },
      )
    }

    const readingId =
      existingReading?.reading_id ||
      `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`
    const source = actingAsResident ? 'RESIDENT' : 'ADMIN_OVERRIDE'

    foundMeter.reading = {
      reading_id: readingId,
      value: normalizedVal,
      consumption_delta: deltaStr,
      source,
      is_anomaly_confirmed: isAnomaly,
    }

    if (targetIdx >= 0 && targetIdx + 1 < sortedCodes.length) {
      const nextMatch = findOfflineMeterInPeriod(sortedCodes[targetIdx + 1], meter_id)
      if (nextMatch?.meter && !nextMatch.meter.reading) {
        nextMatch.meter.previous_value = normalizedVal
      }
    }

    return {
      reading_id: readingId,
      meter_id,
      period_code,
      value: normalizedVal,
      consumption_delta: deltaStr,
      source,
      is_anomaly_confirmed: isAnomaly,
    }
  }

  // 6. GET /meters/readings/:id/history
  const historyMatch = pathname.match(/^\/meters\/readings\/([^/]+)\/history$/)
  if (historyMatch && method === 'GET') {
    const readingId = historyMatch[1]
    return {
      reading_id: readingId,
      meter_id: '018f0000-0000-7000-8000-000000000514',
      period_code: '2026-10',
      entries: [
        {
          changed_at: '2026-10-25T14:20:00Z',
          old_value: null,
          new_value: '86.200',
          source: 'RESIDENT',
          reason: null,
          changed_by: {
            display_label: 'Kati Kask (Apt 14)',
            role_badge: 'OWNER',
          },
        },
      ],
    }
  }

  // 7. GET /meters/periods/:code/matrix
  const matrixMatch = pathname.match(/^\/meters\/periods\/([^/]+)\/matrix$/)
  if (matrixMatch && method === 'GET') {
    const periodCode = matrixMatch[1]
    const period =
      OFFLINE_PERIODS.find((p) => p.period_code === periodCode) || OFFLINE_PERIODS[0]
    const periodApts = getPeriodApartments(period.period_code)

    let coldSum = 0n
    let hotSum = 0n

    const apartments = periodApts.map((a) => {
      const hasMissing = a.meters.some((m) => !m.reading)
      const hasAnomaly = a.meters.some((m) => m.reading?.is_anomaly_confirmed)
      const hasEstimated = a.meters.some((m) => m.reading?.source === 'AUTO_ESTIMATED')

      let aptStatus = 'SUBMITTED'
      if (hasMissing) aptStatus = 'MISSING'
      else if (hasAnomaly) aptStatus = 'ANOMALY_CONFIRMED'
      else if (hasEstimated) aptStatus = 'AUTO_ESTIMATED'

      const meters = a.meters.map((m) => {
        if (m.reading) {
          if (m.resource_type === 'COLD_WATER') coldSum += toBigInt3(m.reading.consumption_delta)
          if (m.resource_type === 'HOT_WATER') hotSum += toBigInt3(m.reading.consumption_delta)
        }
        let mStatus = 'MISSING'
        if (m.reading) {
          if (m.reading.is_anomaly_confirmed) mStatus = 'ANOMALY_CONFIRMED'
          else if (m.reading.source === 'AUTO_ESTIMATED') mStatus = 'AUTO_ESTIMATED'
          else mStatus = 'SUBMITTED'
        }
        return {
          meter_id: m.meter_id,
          resource_type: m.resource_type,
          location_label: m.location_label,
          unit: m.unit,
          previous_value: m.previous_value,
          status: mStatus,
          reading: m.reading ? { ...m.reading } : null,
        }
      })

      return {
        apartment_id: a.apartment_id,
        apartment_number: a.apartment_number,
        entrance: a.entrance,
        floor: a.floor,
        status: aptStatus,
        meters,
      }
    })

    const coldMaster = '28.500'
    const hotMaster = '15.400'
    const coldAptStr = fromBigInt3(coldSum)
    const hotAptStr = fromBigInt3(hotSum)

    return {
      period: { ...period },
      balances: [
        {
          resource_type: 'COLD_WATER',
          unit: 'm3',
          master_total: coldMaster,
          apartments_sum: coldAptStr,
          unallocated_loss: subDecimal(coldMaster, coldAptStr),
        },
        {
          resource_type: 'HOT_WATER',
          unit: 'm3',
          master_total: hotMaster,
          apartments_sum: hotAptStr,
          unallocated_loss: subDecimal(hotMaster, hotAptStr),
        },
      ],
      master_meters: JSON.parse(JSON.stringify(MASTER_METERS_2026_10)),
      apartments,
    }
  }

  // 8. GET /meters/periods/:code/export-csv
  const csvMatch = pathname.match(/^\/meters\/periods\/([^/]+)\/export-csv$/)
  if (csvMatch && method === 'GET' && raw) {
    const periodCode = csvMatch[1]
    const periodApts = getPeriodApartments(periodCode)
    const lines = [
      'period_code,apartment_number,serial_number,resource_type,previous_value,current_value,consumption_delta,unit,source',
    ]
    for (const apt of periodApts) {
      for (const m of apt.meters) {
        lines.push(
          [
            periodCode,
            apt.apartment_number,
            m.serial_number,
            m.resource_type,
            m.previous_value,
            m.reading?.value ?? '',
            m.reading?.consumption_delta ?? '',
            m.unit,
            m.reading?.source ?? 'MISSING',
          ].join(','),
        )
      }
    }
    return new Response(lines.join('\n'), {
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
    })
  }

  // 9. GET /communication/emergencies/active
  if (pathname === '/communication/emergencies/active' && method === 'GET') {
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    return OFFLINE_POSTS.filter(
      (p) =>
        p.post_type === 'EMERGENCY' &&
        p.is_active &&
        canViewerSeePost(p, {
          viewerUserId: user.user_id,
          viewerRole: user.building_role,
          memberships: userMems,
        }),
    ).map((p) => ({
      id: p.id,
      post_type: p.post_type,
      category: p.category,
      title: p.title,
      body: p.body,
      author_badge: { ...p.author_badge },
      is_mine: p.author_user_id === user.user_id,
      target_scope: p.target_scope,
      target_entrance: p.target_entrance,
      target_apartment_ids: p.target_apartment_ids,
      is_active: p.is_active,
      comments_enabled: p.comments_enabled,
      comments_count: p.comments.length,
      created_at: p.created_at,
      last_activity_at:
        p.comments.length > 0 ? p.comments[p.comments.length - 1].created_at : p.created_at,
      acknowledged_at: p.acknowledged_at,
      origin: p.origin || null,
      edited_at: p.edited_at || null,
      hidden_at: p.hidden_at || null,
      hidden_reason: p.hidden_at ? p.hidden_reason || null : null,
    }))
  }

  // 10. GET & POST /communication/posts
  if (pathname === '/communication/posts' && method === 'GET') {
    const postType = urlObj.searchParams.get('post_type')
    const apartmentId = urlObj.searchParams.get('apartment_id')
    const category = urlObj.searchParams.get('category')
    const limit = Number(urlObj.searchParams.get('limit') || '20')
    const offset = Number(urlObj.searchParams.get('offset') || '0')
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const visibilityCtx = {
      viewerUserId: user.user_id,
      viewerRole: user.building_role,
      memberships: userMems,
    }

    if (apartmentId && postType !== 'APARTMENT_THREAD') {
      throw makeOfflineError(
        422,
        'VALIDATION_ERROR',
        'apartment_id filter is only valid with post_type=APARTMENT_THREAD.',
      )
    }

    let filtered = OFFLINE_POSTS.filter(
      (p) =>
        p.post_type !== 'EMERGENCY' &&
        p.post_type !== 'APARTMENT_THREAD' &&
        p.post_type !== 'BOARD_TOPIC' &&
        canViewerSeePost(p, visibilityCtx),
    )

    if (postType === 'APARTMENT_THREAD') {
      filtered = OFFLINE_POSTS.filter((p) => {
        if (p.post_type !== 'APARTMENT_THREAD') return false
        if (apartmentId && !p.target_apartment_ids?.includes(apartmentId)) return false
        return canViewerSeePost(p, visibilityCtx)
      })
      filtered.sort((a, b) => {
        const aLast =
          a.comments.length > 0 ? a.comments[a.comments.length - 1].created_at : a.created_at
        const bLast =
          b.comments.length > 0 ? b.comments[b.comments.length - 1].created_at : b.created_at
        return new Date(bLast).getTime() - new Date(aLast).getTime() || b.id.localeCompare(a.id)
      })
    } else if (postType === 'BOARD_TOPIC') {
      if (!isBoardUser) {
        throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
      }
      filtered = OFFLINE_POSTS.filter(
        (p) => p.post_type === 'BOARD_TOPIC' && canViewerSeePost(p, visibilityCtx),
      )
      filtered.sort((a, b) => {
        const aLast =
          a.comments.length > 0 ? a.comments[a.comments.length - 1].created_at : a.created_at
        const bLast =
          b.comments.length > 0 ? b.comments[b.comments.length - 1].created_at : b.created_at
        return new Date(bLast).getTime() - new Date(aLast).getTime() || b.id.localeCompare(a.id)
      })
    } else if (postType) {
      filtered = OFFLINE_POSTS.filter(
        (p) => p.post_type === postType && canViewerSeePost(p, visibilityCtx),
      )
      filtered.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
          b.id.localeCompare(a.id),
      )
    } else {
      filtered.sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime() ||
          b.id.localeCompare(a.id),
      )
    }
    if (category) {
      filtered = filtered.filter((p) => p.category === category)
    }

    return filtered.slice(offset, offset + limit).map((p) => ({
      id: p.id,
      post_type: p.post_type,
      category: p.category,
      title: p.title,
      body: p.body,
      author_badge: { ...p.author_badge },
      is_mine: p.author_user_id === user.user_id,
      target_scope: p.target_scope,
      target_entrance: p.target_entrance,
      target_apartment_ids: p.target_apartment_ids,
      is_active: p.is_active,
      comments_enabled: p.comments_enabled,
      comments_count: p.comments.length,
      created_at: p.created_at,
      last_activity_at:
        p.comments.length > 0 ? p.comments[p.comments.length - 1].created_at : p.created_at,
      origin: p.origin || null,
      edited_at: p.edited_at || null,
      hidden_at: p.hidden_at || null,
      hidden_reason: p.hidden_at ? p.hidden_reason || null : null,
    }))
  }

  if (pathname === '/communication/posts' && method === 'POST') {
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const postType = reqBody.post_type || 'FORUM_TOPIC'
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    const hasControlChars = (str) => {
      for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i)
        if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
          return true
        }
      }
      return false
    }
    const cleanTitle = typeof reqBody.title === 'string' ? reqBody.title.trim() : ''
    const cleanBody = typeof reqBody.body === 'string' ? reqBody.body.trim() : ''
    if (!cleanTitle || !cleanBody || hasControlChars(cleanTitle) || hasControlChars(cleanBody)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Title and body must be non-empty plain text.')
    }
    if (postType === 'APARTMENT_THREAD') {
      if (reqBody.author_apartment_id !== undefined && reqBody.author_apartment_id !== null) {
        throw makeOfflineError(
          422,
          'INVALID_AUTHOR_APARTMENT',
          'author_apartment_id is not allowed on APARTMENT_THREAD.',
        )
      }
      const targetAptId = reqBody.target_apartment_ids?.[0]
      if (targetAptId === '018f0000-0000-7000-8000-000000000305') {
        throw makeOfflineError(
          422,
          'APARTMENT_HAS_NO_RESIDENTS',
          'This apartment has no registered residents yet.',
        )
      }
    }
    if (postType === 'BOARD_TOPIC') {
      if (!isBoardUser) {
        throw makeOfflineError(403, 'FORBIDDEN', 'Only Board members can publish board topics.')
      }
      if (reqBody.author_apartment_id !== undefined && reqBody.author_apartment_id !== null) {
        throw makeOfflineError(
          422,
          'INVALID_AUTHOR_APARTMENT',
          'author_apartment_id is not allowed on BOARD_TOPIC.',
        )
      }
    }
    const nowIso = new Date().toISOString()
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const boardFullNames = {
      '018f0000-0000-7000-8000-000000000101': 'Oleg Sidorov',
      '018f0000-0000-7000-8000-000000000105': 'Peeter Saar',
    }
    const authorBadge =
      postType === 'BOARD_TOPIC'
        ? {
            display_label: boardFullNames[user.user_id] || user.full_name,
            role_badge: 'BOARD',
          }
        : postType === 'APARTMENT_THREAD' && isBoardUser
          ? {
              display_label: user.building_role === 'CHAIRMAN' ? 'Chairman' : 'Board',
              role_badge: 'BOARD',
            }
          : userMems[0]?.preview_badge || {
              display_label: user.label,
              role_badge: isBoardUser ? 'BOARD' : 'OWNER',
            }
    const created = {
      id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      post_type: postType,
      category: reqBody.category || 'GENERAL',
      title: cleanTitle,
      body: cleanBody,
      author_user_id: user.user_id,
      author_apartment_id:
        postType === 'BOARD_TOPIC'
          ? null
          : postType === 'APARTMENT_THREAD'
            ? isBoardUser
              ? null
              : reqBody.target_apartment_ids?.[0] || null
            : reqBody.author_apartment_id || null,
      author_badge: authorBadge,
      target_scope: reqBody.target_scope || 'ALL_BUILDING',
      target_entrance: reqBody.target_entrance || null,
      target_apartment_ids: reqBody.target_apartment_ids || null,
      is_active: true,
      comments_enabled: reqBody.comments_enabled !== false,
      created_at: nowIso,
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
      origin: null,
      comments: [],
    }
    OFFLINE_POSTS.unshift(created)
    if (created.post_type === 'OFFICIAL_NOTICE') {
      dispatchMaintenanceAndNoticeNotifications({
        event_type: 'NOTICE_PUBLISHED',
        subject_type: 'post',
        subject_id: created.id,
        target_scope: created.target_scope,
        target_entrance: created.target_entrance,
        target_apartment_ids: created.target_apartment_ids,
        author_user_id: user.user_id,
        created_at: nowIso,
      })
    }
    return {
      id: created.id,
      post_type: created.post_type,
      category: created.category,
      title: created.title,
      body: created.body,
      author_badge: { ...created.author_badge },
      is_mine: true,
      target_scope: created.target_scope,
      target_entrance: created.target_entrance,
      target_apartment_ids: created.target_apartment_ids,
      is_active: created.is_active,
      comments_enabled: created.comments_enabled,
      comments_count: 0,
      created_at: nowIso,
      last_activity_at: nowIso,
      origin: null,
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
    }
  }

  // 11. GET /communication/posts/:id & POST /communication/posts/:id/comments
  const postDetailMatch = pathname.match(/^\/communication\/posts\/([^/]+)$/)
  if (postDetailMatch && method === 'GET') {
    const post = OFFLINE_POSTS.find((p) => p.id === postDetailMatch[1])
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (
      !post ||
      !canViewerSeePost(post, {
        viewerUserId: user.user_id,
        viewerRole: user.building_role,
        memberships: userMems,
      })
    ) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    const rawLimit = Number(urlObj.searchParams.get('comments_limit') || '200')
    const commentsLimit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 500) : 200
    const rawOffset = Number(urlObj.searchParams.get('comments_offset') || '0')
    const commentsOffset = Number.isFinite(rawOffset) ? Math.max(Math.trunc(rawOffset), 0) : 0
    const pagedComments = post.comments.slice(commentsOffset, commentsOffset + commentsLimit)
    return {
      id: post.id,
      post_type: post.post_type,
      category: post.category,
      title: post.title,
      body: post.body,
      author_badge: { ...post.author_badge },
      is_mine: post.author_user_id === user.user_id,
      target_scope: post.target_scope,
      target_entrance: post.target_entrance,
      target_apartment_ids: post.target_apartment_ids,
      is_active: post.is_active,
      comments_enabled: post.comments_enabled,
      comments_count: post.comments.length,
      created_at: post.created_at,
      last_activity_at:
        post.comments.length > 0
          ? post.comments[post.comments.length - 1].created_at
          : post.created_at,
      origin: post.origin || null,
      edited_at: post.edited_at || null,
      hidden_at: post.hidden_at || null,
      hidden_reason: post.hidden_at ? post.hidden_reason || null : null,
      comments: pagedComments.map((c) =>
        projectCommentForViewer(c, {
          postId: post.id,
          viewerUserId: user.user_id,
          viewerRole: user.building_role,
          authorBadge: { ...c.author_badge },
        }),
      ),
    }
  }

  if (postDetailMatch && method === 'DELETE') {
    const idx = OFFLINE_POSTS.findIndex((p) => p.id === postDetailMatch[1])
    if (idx === -1) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    const targetPost = OFFLINE_POSTS[idx]
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    if (!isBoardUser) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only Board members can delete topics.')
    }
    if (targetPost.post_type !== 'FORUM_TOPIC' && targetPost.post_type !== 'BOARD_TOPIC') {
      throw makeOfflineError(409, 'POST_NOT_DELETABLE', 'This post cannot be deleted.', {
        post_type: targetPost.post_type,
      })
    }
    OFFLINE_POSTS.splice(idx, 1)
    return null
  }

  const commentPostMatch = pathname.match(/^\/communication\/posts\/([^/]+)\/comments$/)
  if (commentPostMatch && method === 'POST') {
    const post = OFFLINE_POSTS.find((p) => p.id === commentPostMatch[1])
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (
      !post ||
      !canViewerSeePost(post, {
        viewerUserId: user.user_id,
        viewerRole: user.building_role,
        memberships: userMems,
      })
    ) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    if (post.hidden_at) {
      throw makeOfflineError(409, 'POST_HIDDEN', 'Cannot comment on a hidden post.')
    }
    if (!post.comments_enabled) {
      throw makeOfflineError(409, 'COMMENTS_DISABLED', 'Comments are disabled on this post.')
    }
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const hasControlChars = (str) => {
      for (let i = 0; i < str.length; i += 1) {
        const code = str.charCodeAt(i)
        if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
          return true
        }
      }
      return false
    }
    const cleanCommentBody = typeof reqBody.body === 'string' ? reqBody.body.trim() : ''
    if (!cleanCommentBody || hasControlChars(cleanCommentBody)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Comment body must be non-empty plain text.')
    }
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    if (post.post_type === 'APARTMENT_THREAD' || post.post_type === 'BOARD_TOPIC') {
      if (reqBody.author_apartment_id !== undefined && reqBody.author_apartment_id !== null) {
        throw makeOfflineError(
          422,
          'INVALID_AUTHOR_APARTMENT',
          'author_apartment_id is not allowed on this thread.',
        )
      }
    }
    const boardFullNames = {
      '018f0000-0000-7000-8000-000000000101': 'Oleg Sidorov',
      '018f0000-0000-7000-8000-000000000105': 'Peeter Saar',
    }
    const authorBadge =
      post.post_type === 'BOARD_TOPIC'
        ? {
            display_label: boardFullNames[user.user_id] || user.full_name,
            role_badge: 'BOARD',
          }
        : post.post_type === 'APARTMENT_THREAD' && isBoardUser
          ? {
              display_label: user.building_role === 'CHAIRMAN' ? 'Chairman' : 'Board',
              role_badge: 'BOARD',
            }
          : userMems[0]?.preview_badge || {
              display_label: user.label,
              role_badge: isBoardUser ? 'BOARD' : 'OWNER',
            }
    const newComment = {
      id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      post_id: post.id,
      body: cleanCommentBody,
      author_user_id: user.user_id,
      author_apartment_id:
        post.post_type === 'BOARD_TOPIC'
          ? null
          : post.post_type === 'APARTMENT_THREAD'
            ? isBoardUser
              ? null
              : post.target_apartment_ids?.[0] || null
            : reqBody.author_apartment_id || null,
      author_badge: authorBadge,
      created_at: new Date().toISOString(),
      edited_at: null,
      hidden_at: null,
      hidden_reason: null,
    }
    post.comments.push(newComment)
    return projectCommentForViewer(newComment, {
      postId: post.id,
      viewerUserId: user.user_id,
      viewerRole: user.building_role,
      authorBadge: { ...authorBadge },
    })
  }

  // 11b. POST /communication/posts/:id/hide & /unhide (#028)
  const safeDecodePathParam = (raw) => {
    try {
      return decodeURIComponent(raw)
    } catch {
      return null
    }
  }
  const postHideMatch = pathname.match(/^\/communication\/posts\/([^/]+)\/(hide|unhide)$/)
  if (postHideMatch && method === 'POST') {
    const postId = safeDecodePathParam(postHideMatch[1])
    const action = postHideMatch[2]
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    if (!isBoardUser) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only Board members can moderate forum topics.')
    }
    const post = postId ? OFFLINE_POSTS.find((p) => p.id === postId) : null
    if (!post) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    if (!isPostHideable(post)) {
      throw makeOfflineError(409, 'POST_NOT_HIDEABLE', 'This post cannot be hidden.', {
        post_type: post.post_type,
      })
    }
    if (action === 'hide') {
      let reqBody = {}
      if (typeof body === 'string') {
        try {
          reqBody = JSON.parse(body || '{}')
        } catch {
          throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid request payload.')
        }
      } else if (body && typeof body === 'object') {
        reqBody = body
      }
      const check = validateHideReason(reqBody?.reason)
      if (!check.valid) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          'Hide reason must be 1 to 500 plain-text characters.',
        )
      }
      if (!post.hidden_at) {
        post.hidden_at = new Date().toISOString()
        post.hidden_reason = check.reason
        post.hidden_by_user_id = user.user_id
      }
    } else {
      post.hidden_at = null
      post.hidden_reason = null
      post.hidden_by_user_id = null
    }
    return {
      id: post.id,
      post_type: post.post_type,
      category: post.category,
      title: post.title,
      body: post.body,
      author_badge: { ...post.author_badge },
      is_mine: post.author_user_id === user.user_id,
      target_scope: post.target_scope,
      target_entrance: post.target_entrance,
      target_apartment_ids: post.target_apartment_ids,
      is_active: post.is_active,
      comments_enabled: post.comments_enabled,
      comments_count: post.comments.length,
      created_at: post.created_at,
      last_activity_at:
        post.comments.length > 0
          ? post.comments[post.comments.length - 1].created_at
          : post.created_at,
      origin: post.origin || null,
      edited_at: post.edited_at || null,
      hidden_at: post.hidden_at || null,
      hidden_reason: post.hidden_at ? post.hidden_reason || null : null,
    }
  }

  // 11c. POST /communication/posts/:id/comments/:commentId/hide & /unhide (#028)
  const commentHideMatch = pathname.match(
    /^\/communication\/posts\/([^/]+)\/comments\/([^/]+)\/(hide|unhide)$/,
  )
  if (commentHideMatch && method === 'POST') {
    const postId = safeDecodePathParam(commentHideMatch[1])
    const commentId = safeDecodePathParam(commentHideMatch[2])
    const action = commentHideMatch[3]
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    if (!isBoardUser) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only Board members can moderate comments.')
    }
    const post = postId ? OFFLINE_POSTS.find((p) => p.id === postId) : null
    if (!post) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    if (!isCommentHideableOnPost(post)) {
      throw makeOfflineError(
        409,
        'COMMENT_NOT_HIDEABLE',
        'Comments on this post cannot be hidden.',
        { post_type: post.post_type },
      )
    }
    const comment = commentId ? post.comments.find((c) => c.id === commentId) : null
    if (!comment) {
      throw makeOfflineError(404, 'COMMENT_NOT_FOUND', 'Comment not found.')
    }
    if (action === 'hide') {
      let reqBody = {}
      if (typeof body === 'string') {
        try {
          reqBody = JSON.parse(body || '{}')
        } catch {
          throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid request payload.')
        }
      } else if (body && typeof body === 'object') {
        reqBody = body
      }
      const check = validateHideReason(reqBody?.reason)
      if (!check.valid) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          'Hide reason must be 1 to 500 plain-text characters.',
        )
      }
      if (!comment.hidden_at) {
        comment.hidden_at = new Date().toISOString()
        comment.hidden_reason = check.reason
        comment.hidden_by_user_id = user.user_id
      }
    } else {
      comment.hidden_at = null
      comment.hidden_reason = null
      comment.hidden_by_user_id = null
    }
    return projectCommentForViewer(comment, {
      postId: post.id,
      viewerUserId: user.user_id,
      viewerRole: user.building_role,
      authorBadge: { ...comment.author_badge },
    })
  }

  // 11d. PATCH /communication/posts/:id & /communication/posts/:id/comments/:commentId (#027)
  const postEditMatch = pathname.match(/^\/communication\/posts\/([^/]+)$/)
  if (postEditMatch && method === 'PATCH') {
    const postId = safeDecodePathParam(postEditMatch[1])
    const post = postId ? OFFLINE_POSTS.find((p) => p.id === postId) : null
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (
      !post ||
      !canViewerSeePost(post, {
        viewerUserId: user.user_id,
        viewerRole: user.building_role,
        memberships: userMems,
      })
    ) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    if (post.author_user_id !== user.user_id) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only the author can edit this post.')
    }
    if (
      (post.post_type !== 'FORUM_TOPIC' && post.post_type !== 'BOARD_TOPIC') ||
      post.origin != null ||
      post.hidden_at
    ) {
      throw makeOfflineError(409, 'POST_NOT_EDITABLE', 'This post cannot be edited.', {
        post_type: post.post_type,
      })
    }
    if (post.post_type === 'FORUM_TOPIC') {
      const now = Date.now()
      if (!isWithinEditWindow(post.created_at, now)) {
        const deadlineMs = getEditWindowDeadlineMs(post.created_at)
        throw makeOfflineError(409, 'EDIT_WINDOW_CLOSED', 'The 24-hour edit window has closed.', {
          editable_until:
            deadlineMs !== null ? new Date(deadlineMs).toISOString() : post.created_at,
        })
      }
    }
    let reqBody = null
    if (typeof body === 'string') {
      try {
        reqBody = JSON.parse(body || 'null')
      } catch {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid request payload.')
      }
    } else if (body && typeof body === 'object' && !Array.isArray(body)) {
      reqBody = body
    }
    if (!reqBody || typeof reqBody !== 'object' || Array.isArray(reqBody)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Request body must be a JSON object.')
    }
    const keys = Object.keys(reqBody)
    if (keys.length === 0 || keys.some((k) => k !== 'title' && k !== 'body')) {
      throw makeOfflineError(
        422,
        'VALIDATION_ERROR',
        'Provide title and/or body without unknown fields.',
      )
    }
    let nextTitle = post.title
    let nextBody = post.body
    if ('title' in reqBody) {
      if (typeof reqBody.title !== 'string') {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Title must be a string.')
      }
      const trimmedTitle = reqBody.title.trim()
      if (
        !trimmedTitle ||
        trimmedTitle.length > POST_TITLE_MAX_LENGTH ||
        hasDisallowedControlChars(trimmedTitle)
      ) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          `Title must be 1 to ${POST_TITLE_MAX_LENGTH} plain-text characters.`,
        )
      }
      nextTitle = trimmedTitle
    }
    if ('body' in reqBody) {
      if (typeof reqBody.body !== 'string') {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Body must be a string.')
      }
      const trimmedBody = reqBody.body.trim()
      if (
        !trimmedBody ||
        trimmedBody.length > POST_BODY_MAX_LENGTH ||
        hasDisallowedControlChars(trimmedBody)
      ) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          `Body must be 1 to ${POST_BODY_MAX_LENGTH} plain-text characters.`,
        )
      }
      nextBody = trimmedBody
    }
    if (nextTitle !== post.title || nextBody !== post.body) {
      post.title = nextTitle
      post.body = nextBody
      post.edited_at = new Date().toISOString()
    }
    return {
      id: post.id,
      post_type: post.post_type,
      category: post.category,
      title: post.title,
      body: post.body,
      author_badge: { ...post.author_badge },
      is_mine: post.author_user_id === user.user_id,
      target_scope: post.target_scope,
      target_entrance: post.target_entrance,
      target_apartment_ids: post.target_apartment_ids,
      is_active: post.is_active,
      comments_enabled: post.comments_enabled,
      comments_count: post.comments.length,
      created_at: post.created_at,
      last_activity_at:
        post.comments.length > 0
          ? post.comments[post.comments.length - 1].created_at
          : post.created_at,
      origin: post.origin || null,
      edited_at: post.edited_at || null,
      hidden_at: post.hidden_at || null,
      hidden_reason: post.hidden_at ? post.hidden_reason || null : null,
    }
  }

  const commentEditMatch = pathname.match(
    /^\/communication\/posts\/([^/]+)\/comments\/([^/]+)$/,
  )
  if (commentEditMatch && method === 'PATCH') {
    const postId = safeDecodePathParam(commentEditMatch[1])
    const commentId = safeDecodePathParam(commentEditMatch[2])
    const post = postId ? OFFLINE_POSTS.find((p) => p.id === postId) : null
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (
      !post ||
      !canViewerSeePost(post, {
        viewerUserId: user.user_id,
        viewerRole: user.building_role,
        memberships: userMems,
      })
    ) {
      throw makeOfflineError(404, 'POST_NOT_FOUND', 'Post not found.')
    }
    const comment = commentId ? post.comments.find((c) => c.id === commentId) : null
    if (!comment) {
      throw makeOfflineError(404, 'COMMENT_NOT_FOUND', 'Comment not found.')
    }
    if (comment.author_user_id !== user.user_id) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only the author can edit this comment.')
    }
    const editablePostType =
      post.post_type === 'FORUM_TOPIC' ||
      post.post_type === 'BOARD_TOPIC' ||
      post.post_type === 'OFFICIAL_NOTICE' ||
      post.post_type === 'EMERGENCY'
    if (!editablePostType || post.origin != null || post.hidden_at || comment.hidden_at) {
      throw makeOfflineError(409, 'COMMENT_NOT_EDITABLE', 'This comment cannot be edited.')
    }
    const now = Date.now()
    if (!isWithinEditWindow(comment.created_at, now)) {
      const deadlineMs = getEditWindowDeadlineMs(comment.created_at)
      throw makeOfflineError(409, 'EDIT_WINDOW_CLOSED', 'The 24-hour edit window has closed.', {
        editable_until:
          deadlineMs !== null ? new Date(deadlineMs).toISOString() : comment.created_at,
      })
    }
    let reqBody = null
    if (typeof body === 'string') {
      try {
        reqBody = JSON.parse(body || 'null')
      } catch {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid request payload.')
      }
    } else if (body && typeof body === 'object' && !Array.isArray(body)) {
      reqBody = body
    }
    if (!reqBody || typeof reqBody !== 'object' || Array.isArray(reqBody)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Request body must be a JSON object.')
    }
    const keys = Object.keys(reqBody)
    if (keys.length !== 1 || keys[0] !== 'body' || typeof reqBody.body !== 'string') {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Comment body is required without unknown fields.')
    }
    const check = validateCommentEdit(reqBody.body)
    if (!check.valid) {
      throw makeOfflineError(
        422,
        'VALIDATION_ERROR',
        `Comment body must be 1 to ${COMMENT_BODY_MAX_LENGTH} plain-text characters.`,
      )
    }
    if (check.body !== comment.body) {
      comment.body = check.body
      comment.edited_at = new Date().toISOString()
    }
    return projectCommentForViewer(comment, {
      postId: post.id,
      viewerUserId: user.user_id,
      viewerRole: user.building_role,
      authorBadge: { ...comment.author_badge },
    })
  }

  // Read-only fallback for non-GET actions in offline demo mode
  const privacyMatch = pathname.match(/^\/property\/memberships\/([^/]+)\/privacy$/)
  if (privacyMatch && method === 'PATCH') {
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const current = userMems[0] || {
      membership_id: privacyMatch[1],
      privacy_display_mode: 'FULL_NAME',
      preview_badge: { display_label: user.label, role_badge: 'OWNER' },
    }
    return {
      membership_id: current.membership_id,
      privacy_display_mode: current.privacy_display_mode,
      preview_badge: current.preview_badge,
    }
  }

  const ackMatch = pathname.match(/^\/communication\/emergencies\/([^/]+)\/acknowledge$/)
  if (ackMatch && method === 'POST') {
    return {
      post_id: ackMatch[1],
      acknowledged_at: new Date().toISOString(),
    }
  }

  // 12. Notifications & Auth in offline demo mode
  if (pathname === '/notifications/unread-count' && method === 'GET') {
    const items = getOfflineUserNotifications(user.user_id)
    return { unread: items.filter((i) => !i.read_at).length }
  }

  if (pathname === '/notifications/feed' && method === 'GET') {
    const unreadOnly = urlObj.searchParams.get('unread_only') === 'true'
    const limit = Number(urlObj.searchParams.get('limit') || '50')
    const offset = Number(urlObj.searchParams.get('offset') || '0')
    const items = getOfflineUserNotifications(user.user_id)
    const filtered = unreadOnly ? items.filter((i) => !i.read_at) : items
    return JSON.parse(JSON.stringify(filtered.slice(offset, offset + limit)))
  }

  if (pathname === '/notifications/feed/read-all' && method === 'POST') {
    const items = getOfflineUserNotifications(user.user_id)
    const nowIso = new Date().toISOString()
    let updated = 0
    for (const item of items) {
      if (!item.read_at) {
        item.read_at = nowIso
        updated += 1
      }
    }
    return { updated }
  }

  const readOneMatch = pathname.match(/^\/notifications\/feed\/([^/]+)\/read$/)
  if (readOneMatch && method === 'POST') {
    const items = getOfflineUserNotifications(user.user_id)
    const found = items.find((i) => i.id === readOneMatch[1])
    if (!found) {
      throw makeOfflineError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.')
    }
    if (!found.read_at) {
      found.read_at = new Date().toISOString()
    }
    return { id: found.id, read_at: found.read_at }
  }

  if (pathname === '/notifications/preferences') {
    const preferences = getOfflineUserPreferences(user.user_id)
    if (method === 'PUT') {
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const changes = Array.isArray(reqBody.preferences) ? reqBody.preferences : []
      if (changes.length < 1 || changes.length > 52) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          'Provide between 1 and 52 preference changes.',
        )
      }
      for (const chg of changes) {
        const match = preferences.find(
          (p) => p.event_type === chg.event_type && p.channel === chg.channel,
        )
        if (match?.mandatory && chg.enabled === false) {
          throw makeOfflineError(
            422,
            'PREFERENCE_MANDATORY',
            'Mandatory notifications cannot be switched off.',
          )
        }
      }
      for (const chg of changes) {
        const match = preferences.find(
          (p) => p.event_type === chg.event_type && p.channel === chg.channel,
        )
        if (match && !match.mandatory) {
          match.enabled = Boolean(chg.enabled)
        }
      }
    }
    return {
      channels: [
        { channel: 'in_app', available: true, reason: null },
        { channel: 'email', available: false, reason: 'DEMO_MODE' },
        { channel: 'telegram', available: false, reason: 'DEMO_MODE' },
        { channel: 'webpush', available: false, reason: 'DEMO_MODE' },
      ],
      preferences: JSON.parse(JSON.stringify(preferences)),
    }
  }

  if (pathname === '/notifications/bindings' && method === 'GET') {
    return []
  }

  if (pathname === '/notifications/unsubscribe' && method === 'POST') {
    const token = urlObj.searchParams.get('token') || ''
    if (!token || token.length > 128) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Validation error')
    }
    if (token.startsWith('demo-')) {
      const lower = token.toLowerCase()
      const eventType = lower.includes('emergency')
        ? 'EMERGENCY_RESOLVED'
        : lower.includes('review')
          ? 'PERIOD_REVIEW'
          : lower.includes('poll')
            ? 'POLL_OPENED'
            : lower.includes('issue-reported')
              ? 'ISSUE_REPORTED'
              : lower.includes('issue')
                ? 'ISSUE_STATUS_CHANGED'
                : lower.includes('storage')
                  ? 'STORAGE_ALMOST_FULL'
                  : lower.includes('board')
                    ? 'APARTMENT_MESSAGE_TO_BOARD'
                    : lower.includes('message')
                      ? 'APARTMENT_MESSAGE'
                      : 'READING_DEADLINE'
      const prefs = getOfflineUserPreferences(user.user_id)
      const match = prefs.find((p) => p.event_type === eventType && p.channel === 'email')
      if (match && !match.mandatory) {
        match.enabled = false
      }
      return {
        event_type: eventType,
        channel: 'email',
      }
    }
    throw makeOfflineError(400, 'INVALID_LINK', 'Invalid link')
  }

  if (pathname === '/auth/magic-link' && method === 'POST') {
    offlineMagicLinkUsed = false
    return { accepted: true }
  }

  if (pathname === '/auth/magic-link/redeem' && method === 'POST') {
    const tokenStr = String(body?.token || '')

    if (tokenStr.startsWith('demo-register-')) {
      const parts = tokenStr.split('-')
      const kindRaw = (parts[2] || 'owner').toUpperCase()
      const targetVal = parts[3] || '14'
      const invitation =
        kindRaw === 'STAFF'
          ? {
              kind: 'STAFF',
              apartment_number: null,
              building_role: ['BOARD', 'ACCOUNTANT', 'CHAIRMAN'].includes(targetVal)
                ? targetVal
                : 'BOARD',
            }
          : {
              kind: kindRaw === 'TENANT' ? 'TENANT' : 'OWNER',
              apartment_number: targetVal,
              building_role: null,
            }
      return {
        status: 'REGISTRATION_REQUIRED',
        registration_token: `reg-${Date.now()}`,
        expires_in: 1800,
        invitation,
      }
    }

    if (tokenStr.startsWith('demo-accept-')) {
      const parts = tokenStr.split('-')
      const kindRaw = (parts[2] || 'tenant').toUpperCase()
      const targetVal = parts[3] || '14'
      return {
        status: 'SIGN_IN_TO_ACCEPT',
        invitation: {
          kind: kindRaw === 'OWNER' ? 'OWNER' : 'TENANT',
          apartment_number: targetVal,
          building_role: null,
        },
      }
    }

    if (
      (tokenStr === 'demo-valid-token' && !offlineMagicLinkUsed) ||
      tokenStr.startsWith('demo-user-')
    ) {
      if (tokenStr === 'demo-valid-token') {
        offlineMagicLinkUsed = true
        offlineSignedInUserId = OFFLINE_DEMO_USERS[0].user_id
      } else {
        offlineSignedInUserId = tokenStr.replace('demo-user-', '')
      }
      const nowIso = new Date().toISOString()
      offlineSessions = [
        {
          session_id: '018f0000-0000-7000-8000-000000009901',
          device_kind: 'DESKTOP_BROWSER',
          auth_method: 'MAGIC_LINK',
          authenticated_at: nowIso,
          last_used_at: nowIso,
          current: true,
        },
        {
          session_id: '018f0000-0000-7000-8000-000000009902',
          device_kind: 'MOBILE_BROWSER',
          auth_method: 'MAGIC_LINK',
          authenticated_at: '2026-10-28T18:30:00Z',
          last_used_at: '2026-10-30T11:20:00Z',
          current: false,
        },
      ]
      return {
        status: 'SIGNED_IN',
        session: {
          access_token: `offline-demo-jwt-${offlineSignedInUserId}`,
          token_type: 'Bearer',
          expires_in: 900,
          session_id: '018f0000-0000-7000-8000-000000009901',
        },
      }
    }
    const err = new Error('Invalid link')
    err.status = 400
    err.errorCode = 'INVALID_LINK'
    err.payload = { error_code: 'INVALID_LINK' }
    throw err
  }

  if (pathname === '/auth/password/login' && method === 'POST') {
    const email = String(body?.email || '').trim()
    const rawPassword = typeof body?.password === 'string' ? body.password : ''
    if (email.length < 3 || email.length > 320 || !email.includes('@') || !rawPassword || rawPassword.length > 1024) {
      const err = new Error('Validation error')
      err.status = 422
      err.errorCode = 'VALIDATION_ERROR'
      err.payload = { error_code: 'VALIDATION_ERROR' }
      throw err
    }
    const password = rawPassword.normalize('NFKC')
    if (password !== 'demo-password-ok') {
      const err = new Error('Invalid credentials')
      err.status = 401
      err.errorCode = 'INVALID_CREDENTIALS'
      err.payload = { error_code: 'INVALID_CREDENTIALS' }
      throw err
    }
    offlineSignedInUserId = email.toLowerCase().includes('peeter')
      ? '018f0000-0000-7000-8000-000000000101'
      : '018f0000-0000-7000-8000-000000000102'
    const nowIso = new Date().toISOString()
    offlineSessions = [
      {
        session_id: '018f0000-0000-7000-8000-000000009901',
        device_kind: 'DESKTOP_BROWSER',
        auth_method: 'PASSWORD',
        authenticated_at: nowIso,
        last_used_at: nowIso,
        current: true,
      },
    ]
    return {
      access_token: `offline-demo-jwt-${offlineSignedInUserId}`,
      token_type: 'Bearer',
      expires_in: 900,
      session_id: '018f0000-0000-7000-8000-000000009901',
    }
  }

  if (pathname === '/auth/password') {
    if (method === 'GET') {
      return { is_set: offlineHasPassword }
    }
    if (method === 'PUT') {
      const np = String(body?.new_password || '').normalize('NFKC')
      const cp = String(body?.current_password || '').normalize('NFKC')
      if (cp === 'wrong' || np.includes('reauth')) {
        const err = new Error('Reauthentication required')
        err.status = 403
        err.errorCode = 'REAUTHENTICATION_REQUIRED'
        err.payload = { error_code: 'REAUTHENTICATION_REQUIRED' }
        throw err
      }
      const len = [...np].length
      if (len < 15) {
        const err = new Error('Password too weak')
        err.status = 422
        err.errorCode = 'PASSWORD_TOO_WEAK'
        err.payload = { error_code: 'PASSWORD_TOO_WEAK', reason: 'TOO_SHORT' }
        throw err
      }
      if (len > 128) {
        const err = new Error('Password too weak')
        err.status = 422
        err.errorCode = 'PASSWORD_TOO_WEAK'
        err.payload = { error_code: 'PASSWORD_TOO_WEAK', reason: 'TOO_LONG' }
        throw err
      }
      if (np.toLowerCase().replace(/\s+/g, '') === 'password123password' || new Set([...np]).size < 5) {
        const err = new Error('Password too weak')
        err.status = 422
        err.errorCode = 'PASSWORD_TOO_WEAK'
        err.payload = { error_code: 'PASSWORD_TOO_WEAK', reason: 'TOO_COMMON' }
        throw err
      }
      offlineHasPassword = true
      offlineSessions = offlineSessions.filter((s) => s.current)
      return null
    }
    if (method === 'DELETE') {
      if (!offlineHasPassword) {
        return null
      }
      const cp = String(body?.current_password || '').normalize('NFKC')
      if (cp === 'wrong') {
        const err = new Error('Reauthentication required')
        err.status = 403
        err.errorCode = 'REAUTHENTICATION_REQUIRED'
        err.payload = { error_code: 'REAUTHENTICATION_REQUIRED' }
        throw err
      }
      offlineHasPassword = false
      offlineSessions = offlineSessions.filter((s) => s.current)
      return null
    }
  }

  const offlineResidentsMatch = pathname.match(/^\/auth\/apartments\/([^/]+)\/residents$/)
  if (offlineResidentsMatch && method === 'GET') {
    const aptId = offlineResidentsMatch[1]
    return {
      residents: [
        {
          user_id: '018f0000-0000-7000-8000-000000000102',
          membership_id: '018f0000-0000-7000-8000-000000000214',
          relation_type: 'OWNER',
          display_label: 'Kati Kask (Apt 14)',
          since: '2022-01-12T10:00:00Z',
          invited_email: null,
        },
        {
          user_id: '018f0000-0000-7000-8000-000000000104',
          membership_id: '018f0000-0000-7000-8000-000000000399',
          relation_type: 'TENANT',
          display_label: 'M. T. (Apt 14)',
          since: '2025-09-03T10:00:00Z',
          invited_email: 'martin.tenant@demo.invalid',
        },
      ],
      pending_invitations: [
        {
          invitation_id: '018f0000-0000-7000-8000-000000008301',
          kind: 'TENANT',
          email: 'new.tenant@demo.invalid',
          apartment_id: aptId,
          apartment_number: '14',
          building_role: null,
          status: 'PENDING',
          mine: true,
          created_at: '2026-10-30T10:00:00Z',
          expires_at: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
        },
      ],
    }
  }

  if (pathname === '/auth/users' && method === 'GET') {
    return {
      people: [
        {
          user_id: '018f0000-0000-7000-8000-000000000101',
          is_me: true,
          display_label: 'Peeter Tamm (Apt 01)',
          building_role: 'CHAIRMAN',
          invited_email: null,
          memberships: [
            {
              membership_id: '018f0000-0000-7000-8000-000000000201',
              apartment_id: '018f0000-0000-7000-8000-000000000301',
              apartment_number: '01',
              relation_type: 'OWNER',
              display_label: 'Peeter Tamm (Apt 01)',
              since: '2021-03-10T10:00:00Z',
              invited_email: null,
            },
          ],
        },
        {
          user_id: '018f0000-0000-7000-8000-000000000102',
          is_me: false,
          display_label: 'Kati Kask (Apt 14)',
          building_role: 'USER',
          invited_email: null,
          memberships: [
            {
              membership_id: '018f0000-0000-7000-8000-000000000214',
              apartment_id: '018f0000-0000-7000-8000-000000000314',
              apartment_number: '14',
              relation_type: 'OWNER',
              display_label: 'Kati Kask (Apt 14)',
              since: '2022-01-12T10:00:00Z',
              invited_email: 'ivan.petrov@demo.invalid',
            },
          ],
        },
        {
          user_id: '018f0000-0000-7000-8000-000000000103',
          is_me: false,
          display_label: 'Marika Rebane (Accountant)',
          building_role: 'ACCOUNTANT',
          invited_email: 'anna.kask@demo.invalid',
          memberships: [],
        },
      ],
    }
  }

  if (pathname === '/auth/invitations' && method === 'GET') {
    return [
      {
        invitation_id: '018f0000-0000-7000-8000-000000008301',
        kind: 'TENANT',
        email: 'n***@demo.invalid',
        apartment_id: '018f0000-0000-7000-8000-000000000314',
        apartment_number: '14',
        building_role: null,
        status: 'PENDING',
        mine: false,
        created_at: '2026-10-30T10:00:00Z',
        expires_at: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
      },
      {
        invitation_id: '018f0000-0000-7000-8000-000000008302',
        kind: 'OWNER',
        email: 'tonu.owner@demo.invalid',
        apartment_id: '018f0000-0000-7000-8000-000000000305',
        apartment_number: '05',
        building_role: null,
        status: 'PENDING',
        mine: true,
        created_at: '2026-10-29T12:00:00Z',
        expires_at: new Date(Date.now() + 6 * 86400 * 1000).toISOString(),
      },
    ]
  }

  if (pathname === '/auth/registration' && method === 'POST') {
    const nowIso = new Date().toISOString()
    offlineSessions = [
      {
        session_id: '018f0000-0000-7000-8000-000000009901',
        device_kind: 'DESKTOP_BROWSER',
        auth_method: 'INVITATION',
        authenticated_at: nowIso,
        last_used_at: nowIso,
        current: true,
      },
    ]
    return {
      status: 'SIGNED_IN',
      session: {
        access_token: 'offline-demo-jwt-token',
        token_type: 'Bearer',
        expires_in: 900,
        session_id: '018f0000-0000-7000-8000-000000009901',
      },
    }
  }

  if (pathname === '/auth/invitations/accept' && method === 'POST') {
    return { applied: true }
  }

  if (pathname === '/auth/sessions' && method === 'GET') {
    return offlineSessions
  }

  if (pathname === '/auth/sessions' && method === 'DELETE') {
    offlineSessions = []
    return null
  }

  const offlineSessionDel = pathname.match(/^\/auth\/sessions\/([^/]+)$/)
  if (offlineSessionDel && method === 'DELETE') {
    offlineSessions = offlineSessions.filter((s) => s.session_id !== offlineSessionDel[1])
    return null
  }

  if (pathname === '/auth/logout' && method === 'POST') {
    offlineSignedInUserId = ''
    offlineSessions = []
    return null
  }

  // =========================================================================
  // Governance Polls (/governance/polls)
  // =========================================================================
  if (pathname === '/governance/polls' && method === 'GET') {
    const statusFilter = urlObj.searchParams.get('status')
    const limit = Math.min(Math.max(Number(urlObj.searchParams.get('limit') || '50'), 1), 100)
    const offset = Math.max(Number(urlObj.searchParams.get('offset') || '0'), 0)

    if (statusFilter && !['DRAFT', 'OPEN', 'CLOSED', 'CANCELLED'].includes(statusFilter)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid poll status filter.')
    }

    const visible = OFFLINE_POLLS.filter((p) => {
      if (!isOfflinePollVisibleToUser(p, user)) return false
      if (statusFilter && p.status !== statusFilter) return false
      return true
    })

    visible.sort(compareOfflinePollsOrder)
    return visible.slice(offset, offset + limit).map((p) => toOfflinePollSummary(p, user))
  }

  if (pathname === '/governance/polls' && method === 'POST') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only board members can create polls.')
    }
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const parsed = validateOfflinePollDraft(reqBody)
    const nowIso = new Date().toISOString()
    const created = {
      id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      ...parsed,
      status: 'DRAFT',
      opened_at: null,
      closed_at: null,
      cancelled_at: null,
      created_at: nowIso,
      ballots: [],
    }
    OFFLINE_POLLS.unshift(created)
    return toOfflinePollView(created, user)
  }

  const offlinePollActionMatch = pathname.match(
    /^\/governance\/polls\/([^/]+)\/(open|close|cancel)$/,
  )
  if (offlinePollActionMatch && method === 'POST') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only board members can manage polls.')
    }
    const [, pollId, action] = offlinePollActionMatch
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }

    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const maxFutureMs = nowMs + 366 * 86400 * 1000

    if (action === 'open') {
      if (found.status !== 'DRAFT') {
        throw makeOfflineError(409, 'POLL_NOT_DRAFT', 'Only a draft poll can be opened.')
      }
      const closesMs = new Date(found.closes_at).getTime()
      if (Number.isNaN(closesMs) || closesMs <= nowMs || closesMs > maxFutureMs) {
        throw makeOfflineError(
          422,
          'INVALID_DEADLINE',
          'The closing time must be in the future (at most one year ahead).',
        )
      }
      if (computeOfflinePollElectorateCount(found) < 1) {
        throw makeOfflineError(
          422,
          'POLL_HAS_NO_ELECTORATE',
          'Nobody in the target scope can answer this poll.',
        )
      }
      found.status = 'OPEN'
      found.opened_at = nowIso
      emitOfflinePollOpenedNotifications(found, user, nowIso)
      return toOfflinePollView(found, user)
    }

    if (action === 'close') {
      if (found.status !== 'OPEN') {
        throw makeOfflineError(409, 'POLL_NOT_OPEN', 'Only an open poll can be closed.')
      }
      found.status = 'CLOSED'
      found.closed_at = nowIso
      return toOfflinePollView(found, user)
    }

    if (action === 'cancel') {
      if (found.status !== 'OPEN') {
        throw makeOfflineError(409, 'POLL_NOT_OPEN', 'Only an open poll can be cancelled.')
      }
      found.status = 'CANCELLED'
      found.cancelled_at = nowIso
      return toOfflinePollView(found, user)
    }
  }

  const offlinePollDetailMatch = pathname.match(/^\/governance\/polls\/([^/]+)$/)
  if (offlinePollDetailMatch && method === 'GET') {
    const pollId = offlinePollDetailMatch[1]
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found || !isOfflinePollVisibleToUser(found, user)) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    return toOfflinePollView(found, user)
  }

  if (offlinePollDetailMatch && method === 'PUT') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only board members can edit poll drafts.')
    }
    const pollId = offlinePollDetailMatch[1]
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    if (found.status !== 'DRAFT') {
      throw makeOfflineError(409, 'POLL_NOT_DRAFT', 'Only a draft poll can be edited.')
    }
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const parsed = validateOfflinePollDraft(reqBody)
    Object.assign(found, parsed)
    return toOfflinePollView(found, user)
  }

  if (offlinePollDetailMatch && method === 'DELETE') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only board members can delete poll drafts.')
    }
    const pollId = offlinePollDetailMatch[1]
    const idx = OFFLINE_POLLS.findIndex((p) => p.id === pollId)
    if (idx === -1) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    if (OFFLINE_POLLS[idx].status !== 'DRAFT') {
      throw makeOfflineError(409, 'POLL_NOT_DRAFT', 'Only a draft poll can be deleted.')
    }
    OFFLINE_POLLS.splice(idx, 1)
    return null
  }

  if (offlinePollDetailMatch && method === 'PATCH') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only board members can extend poll deadlines.')
    }
    const pollId = offlinePollDetailMatch[1]
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    if (found.status !== 'OPEN') {
      throw makeOfflineError(409, 'POLL_NOT_OPEN', 'Only an open poll deadline can be extended.')
    }
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const nextClosesAt = typeof reqBody?.closes_at === 'string' ? reqBody.closes_at.trim() : ''
    const nextMs = new Date(nextClosesAt).getTime()
    const currentMs = new Date(found.closes_at).getTime()
    const maxFutureMs = Date.now() + 366 * 86400 * 1000
    if (!nextClosesAt || Number.isNaN(nextMs) || nextMs <= currentMs || nextMs > maxFutureMs) {
      throw makeOfflineError(
        422,
        'INVALID_DEADLINE',
        'The new deadline must be later than the current deadline (and at most one year from now).',
      )
    }
    found.closes_at = nextClosesAt
    return toOfflinePollView(found, user)
  }

  const offlinePollBallotMatch = pathname.match(/^\/governance\/polls\/([^/]+)\/ballot$/)
  if (offlinePollBallotMatch && method === 'PUT') {
    const pollId = offlinePollBallotMatch[1]
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found || !isOfflinePollVisibleToUser(found, user)) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    if (found.status !== 'OPEN' || new Date(found.closes_at).getTime() <= Date.now()) {
      throw makeOfflineError(409, 'POLL_NOT_OPEN', 'This poll has closed.')
    }

    const { canAnswer, answerableApartmentIds } = computeOfflinePollAnswerability(found, user)
    if (!canAnswer) {
      throw makeOfflineError(403, 'NOT_ELIGIBLE', 'You cannot answer this poll.')
    }

    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    let targetApartmentId = null
    if (found.unit === 'PERSON') {
      if (reqBody.apartment_id !== undefined && reqBody.apartment_id !== null) {
        throw makeOfflineError(
          422,
          'VALIDATION_ERROR',
          'apartment_id must not be sent for a PERSON poll.',
        )
      }
    } else {
      if (reqBody.apartment_id !== undefined && reqBody.apartment_id !== null) {
        if (!answerableApartmentIds.includes(String(reqBody.apartment_id))) {
          throw makeOfflineError(403, 'NOT_ELIGIBLE', 'You cannot answer for this apartment.')
        }
        targetApartmentId = String(reqBody.apartment_id)
      } else if (answerableApartmentIds.length === 1) {
        targetApartmentId = answerableApartmentIds[0]
      } else {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Select which apartment is answering.')
      }
    }

    if (!Array.isArray(reqBody.answers)) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'answers must be an array.')
    }

    const validation = validateOfflineBallotAnswers(found.questions, reqBody.answers)
    if (!validation.valid) {
      throw makeOfflineError(422, 'INVALID_ANSWER', 'Invalid answer.', {
        question_id: validation.questionId,
        reason: validation.reason,
      })
    }

    const nowIso = new Date().toISOString()
    const normalizedAnswers = validation.normalizedAnswers

    const existingIdx = found.ballots.findIndex((b) =>
      found.unit === 'APARTMENT'
        ? b.apartment_id === targetApartmentId
        : b.user_id === user.user_id,
    )

    if (existingIdx >= 0) {
      found.ballots[existingIdx] = {
        ...found.ballots[existingIdx],
        updated_at: nowIso,
        answers: normalizedAnswers,
      }
    } else {
      found.ballots.push({
        apartment_id: found.unit === 'APARTMENT' ? targetApartmentId : null,
        user_id: found.unit === 'PERSON' ? user.user_id : null,
        submitted_at: nowIso,
        updated_at: nowIso,
        answers: normalizedAnswers,
      })
    }

    return toOfflinePollView(found, user)
  }

  const offlinePollResultsMatch = pathname.match(/^\/governance\/polls\/([^/]+)\/results$/)
  if (offlinePollResultsMatch && method === 'GET') {
    const pollId = offlinePollResultsMatch[1]
    const found = OFFLINE_POLLS.find((p) => p.id === pollId)
    if (!found || !isOfflinePollVisibleToUser(found, user)) {
      throw makeOfflineError(404, 'POLL_NOT_FOUND', 'This poll is not available.')
    }
    const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
    const resultsAvailable =
      found.status === 'CLOSED' || (found.status === 'OPEN' && isBoardUser)
    if (!resultsAvailable) {
      throw makeOfflineError(
        409,
        'RESULTS_NOT_AVAILABLE',
        'Results are not available for this poll.',
        { status: found.status },
      )
    }
    return computeOfflinePollResults(found, isBoardUser)
  }

  if (pathname === '/settings' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only board members and the chairman can view association settings.',
      )
    }
    const ordered = [...offlineSettings]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((s) => ({ ...s }))
    return { settings: ordered }
  }

  if (pathname === '/settings' && method === 'PUT') {
    if (user.building_role !== 'CHAIRMAN') {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only the chairman can update association settings.',
      )
    }
    const outcome = validateAndApplySettingsUpdate(offlineSettings, body)
    if (!outcome.ok) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid association settings update.', {
        errors: outcome.errors,
      })
    }
    offlineSettings = outcome.settings
    return { settings: offlineSettings.map((s) => ({ ...s })) }
  }

  // =========================================================================
  // Issue Tracker (/issues) - #012 (E9/I1)
  // =========================================================================
  if (pathname === '/issues' || pathname.startsWith('/issues/')) {
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    if (!canUserAccessIssues(user, userMems)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only residents with an apartment and board members can access the issue tracker.',
      )
    }

    let simulatedUploadsDisabled = false
    try {
      simulatedUploadsDisabled =
        urlObj.searchParams.get('simulate_uploads_disabled') === '1' ||
        headers?.['X-Simulate-Uploads-Disabled'] === '1' ||
        headers?.['x-simulate-uploads-disabled'] === '1' ||
        (typeof window !== 'undefined' &&
          new URLSearchParams(window.location.search).get('simulate_uploads_disabled') === '1') ||
        (typeof localStorage !== 'undefined' &&
          localStorage.getItem('simulate_uploads_disabled') === '1')
    } catch {
      /* ignore */
    }

    if (pathname === '/issues/form' && method === 'GET') {
      const urgentEnabled = Boolean(
        readSettingFromStore(offlineSettings, 'issues.urgent_enabled', false),
      )
      const apartmentIds = userMems
        .slice()
        .sort((a, b) => a.apartment_number.localeCompare(b.apartment_number))
        .map((m) => m.apartment_id)
      return {
        urgent_enabled: urgentEnabled,
        uploads_enabled: !simulatedUploadsDisabled,
        apartment_ids: apartmentIds,
        entrances: [1, 2],
      }
    }

    if (pathname === '/issues' && method === 'GET') {
      const result = queryIssuesStore(
        offlineIssues,
        user,
        {
          status: urlObj.searchParams.get('status'),
          category: urlObj.searchParams.get('category'),
          entrance: urlObj.searchParams.get('entrance'),
          include_old: urlObj.searchParams.get('include_old'),
          limit: urlObj.searchParams.get('limit'),
          offset: urlObj.searchParams.get('offset'),
        },
        Date.now(),
        { uploadsDisabled: simulatedUploadsDisabled },
      )
      if (!result.ok) {
        throw makeOfflineError(result.status, result.errorCode, result.message)
      }
      return result.items
    }

    if (pathname === '/issues' && method === 'POST') {
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const requestedAptId =
        reqBody?.apartment_id != null && reqBody?.apartment_id !== ''
          ? String(reqBody.apartment_id)
          : userMems[0]?.apartment_id
      const matchedMem =
        userMems.find((m) => m.apartment_id === requestedAptId) || userMems[0]
      const reporterBadge = matchedMem?.preview_badge || {
        display_label: user.label || 'Resident',
        role_badge:
          user.building_role === 'CHAIRMAN' || user.building_role === 'BOARD'
            ? 'BOARD'
            : 'OWNER',
      }

      const outcome = createIssueInStore({
        issuesStore: offlineIssues,
        settingsStore: offlineSettings,
        user,
        userMemberships: userMems,
        reporterBadge,
        body: reqBody,
        buildingEntrances: [1, 2],
      })
      if (!outcome.ok) {
        throw makeOfflineError(
          outcome.status,
          outcome.errorCode,
          outcome.message,
          outcome.extra || {},
        )
      }
      if (outcome.rawIssue) {
        const notifBatch = buildIssueReportedNotification(
          outcome.rawIssue,
          OFFLINE_DEMO_USERS,
          user,
        )
        emitOfflineIssueNotificationBatch(notifBatch)
      }
      return toIssueView(outcome.rawIssue, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    const offlineIssueStatusMatch = pathname.match(/^\/issues\/([^/]+)\/status$/)
    if (offlineIssueStatusMatch && method === 'POST') {
      const issueId = offlineIssueStatusMatch[1]
      const found = offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const outcome = changeIssueStatusInStore({
        issuesStore: offlineIssues,
        issue: found,
        user,
        body: reqBody,
      })
      if (!outcome.ok) {
        throw makeOfflineError(
          outcome.status,
          outcome.errorCode,
          outcome.message,
          outcome.extra || {},
        )
      }
      for (const notifBatch of outcome.notifications || []) {
        emitOfflineIssueNotificationBatch(notifBatch)
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    const offlineIssueUrgentClearMatch = pathname.match(/^\/issues\/([^/]+)\/urgent\/clear$/)
    if (offlineIssueUrgentClearMatch && method === 'POST') {
      const issueId = offlineIssueUrgentClearMatch[1]
      const found = offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const outcome = clearIssueUrgentInStore({
        issue: found,
        user,
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    const offlineIssueWithdrawMatch = pathname.match(/^\/issues\/([^/]+)\/withdraw$/)
    if (offlineIssueWithdrawMatch && method === 'POST') {
      const issueId = offlineIssueWithdrawMatch[1]
      const found = offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const outcome = withdrawIssueInStore({ issue: found, user })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    const offlineIssueFollowMatch = pathname.match(/^\/issues\/([^/]+)\/follow$/)
    if (offlineIssueFollowMatch && (method === 'PUT' || method === 'DELETE')) {
      const issueId = offlineIssueFollowMatch[1]
      const found = offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const outcome = updateIssueFollowInStore({
        issue: found,
        user,
        follow: method === 'PUT',
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    // POST /issues/:issueId/photos
    const offlineIssuePhotosMatch = pathname.match(/^\/issues\/([^/]+)\/photos$/)
    if (offlineIssuePhotosMatch && method === 'POST') {
      const issueId = offlineIssuePhotosMatch[1]
      const found = offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }

      const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user?.building_role)
      const simAnswer = String(
        urlObj.searchParams.get('simulate_upload_answer') ||
          headers?.['X-Simulate-Upload-Answer'] ||
          headers?.['x-simulate-upload-answer'] ||
          '',
      ).toUpperCase()
      const effectiveContentType =
        contentType ||
        (body && typeof body.type === 'string' && body.type) ||
        headers?.['Content-Type'] ||
        headers?.['content-type'] ||
        ''
      const idempotencyKey =
        headers?.['Idempotency-Key'] || headers?.['idempotency-key'] || ''
      const rawLengthHeader = headers?.['Content-Length'] ?? headers?.['content-length']
      let declaredLength = null
      if (rawLengthHeader !== undefined && rawLengthHeader !== '') {
        declaredLength = Number(rawLengthHeader)
      } else if (body != null && typeof body.size === 'number') {
        declaredLength = body.size
      } else if (body != null && typeof body.byteLength === 'number') {
        declaredLength = body.byteLength
      }

      const preflight = checkIssuePhotoUploadPreflight({
        issue: found,
        user,
        contentType: effectiveContentType,
        contentLength: declaredLength,
        idempotencyKey,
        idempotencyStore: offlineIssuePhotoIdempotency,
        dailyUploadsStore: offlineIssuePhotoDailyUploads,
        uploadsDisabled: simulatedUploadsDisabled,
        quotaExceededReason:
          simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
        lowDisk: simAnswer === 'LOW_DISK',
      })
      if (!preflight.ok) {
        throw makeOfflineError(
          preflight.status,
          preflight.errorCode,
          preflight.message,
          preflight.extra || {},
        )
      }
      if (preflight.replay) {
        return preflight.photo
      }

      if (simAnswer === 'DAILY_LIMIT' && !isBoardUser) {
        throw makeOfflineError(
          429,
          'RATE_LIMITED',
          'You have stored the photos allowed for today.',
          { reason: 'DAILY_LIMIT', retry_after_seconds: 3600 },
        )
      }

      const uid = user?.user_id || 'anon'
      const activeCount = activeOfflinePhotoUploads.get(uid) || 0
      if (activeCount >= 2 || simAnswer === 'BUSY') {
        throw makeOfflineError(429, 'RATE_LIMITED', 'Server is busy.', {
          reason: 'BUSY',
          retry_after_seconds: simAnswer === 'BUSY' ? 15 : 5,
        })
      }

      activeOfflinePhotoUploads.set(uid, activeCount + 1)
      try {
        if (simAnswer === 'UPLOAD_TIMEOUT') {
          throw makeOfflineError(408, 'UPLOAD_TIMEOUT', 'Upload body timed out.')
        }
        let bytes
        if (body && typeof body.arrayBuffer === 'function') {
          bytes = new Uint8Array(await body.arrayBuffer())
        } else if (body instanceof Uint8Array) {
          bytes = body
        } else if (body instanceof ArrayBuffer) {
          bytes = new Uint8Array(body)
        } else {
          bytes = new Uint8Array(0)
        }
        if (signal?.aborted) {
          throw makeOfflineError(0, 'UPLOAD_ABORTED', 'Upload aborted')
        }
        const outcome = addIssuePhotoInStore({
          issue: found,
          user,
          bytes,
          contentType: effectiveContentType,
          contentLength: declaredLength,
          idempotencyKey,
          idempotencyStore: offlineIssuePhotoIdempotency,
          dailyUploadsStore: offlineIssuePhotoDailyUploads,
          uploadsDisabled: simulatedUploadsDisabled,
          quotaExceededReason:
            simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
          lowDisk: simAnswer === 'LOW_DISK',
        })
        if (!outcome.ok) {
          throw makeOfflineError(
            outcome.status,
            outcome.errorCode,
            outcome.message,
            outcome.extra || {},
          )
        }
        checkAndEmitOfflineStorageAlert()
        return outcome.photo
      } finally {
        const remaining = (activeOfflinePhotoUploads.get(uid) || 1) - 1
        if (remaining <= 0) {
          activeOfflinePhotoUploads.delete(uid)
        } else {
          activeOfflinePhotoUploads.set(uid, remaining)
        }
      }
    }

    // GET / DELETE /issues/:issueId/photos/:photoId
    const offlineIssuePhotoItemMatch = pathname.match(/^\/issues\/([^/]+)\/photos\/([^/]+)$/)
    if (offlineIssuePhotoItemMatch && method === 'GET') {
      const issueId = offlineIssuePhotoItemMatch[1]
      const photoId = offlineIssuePhotoItemMatch[2]
      const found = offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const variant = urlObj.searchParams.get('variant') || 'display'
      const outcome = getIssuePhotoFromStore({ issue: found, photoId, variant })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      const resBlob = new Blob([outcome.bytes], { type: outcome.mime || 'image/webp' })
      if (raw) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Content-Type': outcome.mime || 'image/webp' }),
          blob: async () => resBlob,
        }
      }
      return resBlob
    }

    if (offlineIssuePhotoItemMatch && method === 'DELETE') {
      const issueId = offlineIssuePhotoItemMatch[1]
      const photoId = offlineIssuePhotoItemMatch[2]
      const found = offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const outcome = deleteIssuePhotoInStore({
        issue: found,
        user,
        photoId,
        idempotencyStore: offlineIssuePhotoIdempotency,
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return null
    }

    const offlineIssueDetailMatch = pathname.match(/^\/issues\/([^/]+)$/)
    if (offlineIssueDetailMatch && method === 'GET') {
      const issueId = offlineIssueDetailMatch[1]
      const found = offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }

    if (offlineIssueDetailMatch && method === 'PATCH') {
      const issueId = offlineIssueDetailMatch[1]
      const found = offlineIssues.find((item) => item.id === issueId)
      if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
        throw makeOfflineError(404, 'ISSUE_NOT_FOUND', 'This issue is not available.')
      }
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const outcome = editIssueInStore({
        issue: found,
        user,
        body: reqBody,
        buildingEntrances: [1, 2],
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return toIssueView(found, user, { uploadsDisabled: simulatedUploadsDisabled })
    }
  }

  // =========================================================================
  // Association Documents (/documents) - #022 & #023 (E11/F3)
  // =========================================================================
  if (pathname === '/documents' || pathname.startsWith('/documents/')) {
    const userMems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
    const resolveOfflineDocBadge = (uid) => {
      const u = OFFLINE_DEMO_USERS.find((item) => item.user_id === uid)
      if (u?.building_role === 'CHAIRMAN') {
        return { display_label: 'Board Chairman', role_badge: 'BOARD' }
      }
      if (u?.building_role === 'ACCOUNTANT') {
        return { display_label: 'Accountant', role_badge: 'ACCOUNTANT' }
      }
      return { display_label: 'Board Member', role_badge: 'BOARD' }
    }
    const simulatedDocUploadsDisabled =
      urlObj.searchParams.get('simulate_uploads_disabled') === '1' ||
      headers?.['X-Simulate-Uploads-Disabled'] === '1' ||
      headers?.['x-simulate-uploads-disabled'] === '1'

    if (pathname === '/documents/upload-options' && method === 'GET') {
      if (
        !['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role) &&
        userMems.length === 0
      ) {
        throw makeOfflineError(403, 'FORBIDDEN', 'Only active members and staff can access documents.')
      }
      return getUploadOptionsForUser(user, { uploadsDisabled: simulatedDocUploadsDisabled })
    }

    if (pathname === '/documents' && method === 'GET') {
      const result = queryDocumentsStore(
        offlineDocuments,
        user,
        userMems,
        {
          category: urlObj.searchParams.get('category') || '',
          limit: urlObj.searchParams.get('limit') ?? undefined,
          offset: urlObj.searchParams.get('offset') ?? undefined,
        },
        { resolveBadgeFn: resolveOfflineDocBadge },
      )
      if (!result.ok) {
        throw makeOfflineError(result.status, result.errorCode, result.message)
      }
      return result.items
    }

    if (pathname === '/documents' && method === 'POST') {
      const simAnswer = String(
        urlObj.searchParams.get('simulate_upload_answer') ||
          headers?.['X-Simulate-Upload-Answer'] ||
          headers?.['x-simulate-upload-answer'] ||
          '',
      ).toUpperCase()
      const effectiveContentType =
        contentType ||
        (body && typeof body.type === 'string' && body.type) ||
        headers?.['Content-Type'] ||
        headers?.['content-type'] ||
        ''
      const idempotencyKey =
        headers?.['Idempotency-Key'] || headers?.['idempotency-key'] || ''
      const rawLengthHeader = headers?.['Content-Length'] ?? headers?.['content-length']
      let declaredLength = null
      if (rawLengthHeader !== undefined && rawLengthHeader !== '') {
        declaredLength = Number(rawLengthHeader)
      } else if (body != null && typeof body.size === 'number') {
        declaredLength = body.size
      } else if (body != null && typeof body.byteLength === 'number') {
        declaredLength = body.byteLength
      }

      const preflight = checkDocumentUploadPreflight({
        store: offlineDocuments,
        user,
        userMemberships: userMems,
        query: {
          title: urlObj.searchParams.get('title'),
          category: urlObj.searchParams.get('category'),
          audience: urlObj.searchParams.get('audience'),
          document_date: urlObj.searchParams.get('document_date'),
        },
        contentType: effectiveContentType,
        contentLength: declaredLength,
        idempotencyKey,
        idempotencyStore: offlineDocumentIdempotency,
        uploadsDisabled: simulatedDocUploadsDisabled,
        quotaExceededReason:
          simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
        lowDisk: simAnswer === 'LOW_DISK',
        resolveBadgeFn: resolveOfflineDocBadge,
      })
      if (!preflight.ok) {
        throw makeOfflineError(
          preflight.status,
          preflight.errorCode,
          preflight.message,
          preflight.extra || {},
        )
      }
      if (preflight.replay) {
        if (simAnswer === 'UPLOAD_REMOVED') {
          throw makeOfflineError(409, 'UPLOAD_REMOVED', 'This document was removed meanwhile.')
        }
        return preflight.document
      }
      if (simAnswer === 'UPLOAD_REMOVED') {
        throw makeOfflineError(409, 'UPLOAD_REMOVED', 'This document was removed meanwhile.')
      }

      const uid = user?.user_id || 'anon'
      const activeCount = activeOfflineDocumentUploads.get(uid) || 0
      if (activeCount >= 2 || simAnswer === 'BUSY') {
        throw makeOfflineError(429, 'RATE_LIMITED', 'Server is busy.', {
          reason: 'BUSY',
          retry_after_seconds: simAnswer === 'BUSY' ? 15 : 5,
        })
      }

      activeOfflineDocumentUploads.set(uid, activeCount + 1)
      try {
        if (simAnswer === 'UPLOAD_TIMEOUT') {
          throw makeOfflineError(408, 'UPLOAD_TIMEOUT', 'Upload body timed out.')
        }
        let bytes
        if (body && typeof body.arrayBuffer === 'function') {
          bytes = new Uint8Array(await body.arrayBuffer())
        } else if (body instanceof Uint8Array) {
          bytes = body
        } else if (body instanceof ArrayBuffer) {
          bytes = new Uint8Array(body)
        } else {
          bytes = new Uint8Array(0)
        }
        if (signal?.aborted) {
          throw makeOfflineError(0, 'UPLOAD_ABORTED', 'Upload aborted')
        }
        const outcome = addDocumentInStore({
          store: offlineDocuments,
          user,
          userMemberships: userMems,
          bytes,
          query: {
            title: urlObj.searchParams.get('title'),
            category: urlObj.searchParams.get('category'),
            audience: urlObj.searchParams.get('audience'),
            document_date: urlObj.searchParams.get('document_date'),
          },
          contentType: effectiveContentType,
          contentLength: declaredLength,
          idempotencyKey,
          idempotencyStore: offlineDocumentIdempotency,
          uploadsDisabled: simulatedDocUploadsDisabled,
          quotaExceededReason:
            simAnswer === 'QUOTA' || simAnswer === 'DELETIONS_PENDING' ? simAnswer : '',
          lowDisk: simAnswer === 'LOW_DISK',
          resolveBadgeFn: resolveOfflineDocBadge,
        })
        if (!outcome.ok) {
          throw makeOfflineError(
            outcome.status,
            outcome.errorCode,
            outcome.message,
            outcome.extra || {},
          )
        }
        checkAndEmitOfflineStorageAlert()
        return outcome.document
      } finally {
        const remaining = (activeOfflineDocumentUploads.get(uid) || 1) - 1
        if (remaining <= 0) {
          activeOfflineDocumentUploads.delete(uid)
        } else {
          activeOfflineDocumentUploads.set(uid, remaining)
        }
      }
    }

    const offlineDocFileMatch = pathname.match(/^\/documents\/([^/]+)\/file$/)
    if (offlineDocFileMatch && method === 'GET') {
      const docId = decodeURIComponent(offlineDocFileMatch[1])
      const outcome = getDocumentFileFromStore(offlineDocuments, docId, user, userMems)
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      const pdfBlob = new Blob([outcome.bytes], { type: 'application/pdf' })
      if (raw) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'Content-Type': outcome.contentType,
            'Content-Disposition': outcome.contentDisposition,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, no-store',
          }),
          blob: async () => pdfBlob,
        }
      }
      return pdfBlob
    }

    const offlineDocItemMatch = pathname.match(/^\/documents\/([^/]+)$/)
    if (offlineDocItemMatch && method === 'GET') {
      const docId = decodeURIComponent(offlineDocItemMatch[1])
      const outcome = getDocumentFromStore(offlineDocuments, docId, user, userMems, {
        resolveBadgeFn: resolveOfflineDocBadge,
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return outcome.document
    }

    if (offlineDocItemMatch && method === 'PATCH') {
      const docId = decodeURIComponent(offlineDocItemMatch[1])
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const outcome = editDocumentInStore({
        store: offlineDocuments,
        documentId: docId,
        user,
        userMemberships: userMems,
        body: reqBody,
        resolveBadgeFn: resolveOfflineDocBadge,
      })
      if (!outcome.ok) {
        throw makeOfflineError(
          outcome.status,
          outcome.errorCode,
          outcome.message,
          outcome.extra || {},
        )
      }
      return outcome.document
    }

    if (offlineDocItemMatch && method === 'DELETE') {
      const docId = decodeURIComponent(offlineDocItemMatch[1])
      const outcome = deleteDocumentInStore({
        store: offlineDocuments,
        documentId: docId,
        user,
        userMemberships: userMems,
      })
      if (!outcome.ok) {
        throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
      }
      return null
    }
  }

  // =========================================================================
  // Storage Usage (/files/usage) - #024 (E11/F4)
  // =========================================================================
  if (pathname === '/files/usage' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only the chairman and board members can view storage usage.')
    }
    const currentUsage = computeStorageUsage({
      issuesStore: offlineIssues,
      documentsStore: offlineDocuments,
      extraPendingDeletionBytes: offlineExtraPendingDeletionBytes,
    })
    return currentUsage
  }

  // =========================================================================
  // Maintenance Calendar (/maintenance) - #015 (E10/M1)
  // =========================================================================
  if (pathname === '/maintenance/tasks' || pathname.startsWith('/maintenance/tasks/')) {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only the chairman and board members can access maintenance tasks.')
    }

    const today = getTodayDateInTallinn()

    // GET /maintenance/tasks
    if (pathname === '/maintenance/tasks' && method === 'GET') {
      const overdueReminderDays = Number(
        readSettingFromStore(offlineSettings, 'maintenance.overdue_reminder_days', 7),
      )
      publishMaintenanceTasksInStore({
        tasksStore: offlineMaintenance,
        postsStore: OFFLINE_POSTS,
        today,
        overdueReminderDays,
        onNotification: dispatchMaintenanceAndNoticeNotifications,
      })

      const statusParam = urlObj.searchParams.get('status') || undefined
      const stateParam = urlObj.searchParams.get('state') || undefined
      const limitParam = urlObj.searchParams.get('limit') ? Number(urlObj.searchParams.get('limit')) : 50
      const offsetParam = urlObj.searchParams.get('offset') ? Number(urlObj.searchParams.get('offset')) : 0

      return queryTasksStore(
        offlineMaintenance,
        { status: statusParam, state: stateParam, limit: limitParam, offset: offsetParam },
        today,
      )
    }

    // POST /maintenance/tasks
    if (pathname === '/maintenance/tasks' && method === 'POST') {
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const validated = validateTaskDraft(reqBody, { today })
      if (!validated.valid) {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Validation failed for maintenance task.', {
          errors: validated.errors,
        })
      }

      const p = validated.payload
      const taskId = `task-${Date.now()}`
      const occId = `occ-${Date.now()}`
      const lead = p.lead_days
      const dueDate = p.first_due_date
      const occState = computeOccurrenceState(dueDate, lead, 'ACTIVE', today)

      const newTask = {
        id: taskId,
        title: p.title,
        instructions: p.instructions || '',
        period_unit: p.period_unit,
        period_count: p.period_count,
        lead_days: lead,
        anchor_date: dueDate,
        status: 'ACTIVE',
        notice: p.notice,
        current: {
          occurrence_id: occId,
          due_date: dueDate,
          publish_on: occState.publish_on,
          state: occState.state,
          published_at: null,
          board_post_id: null,
          notice_post_id: null,
          notice_failed: false,
          reminder_count: 0,
        },
        last_closed_on: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        archived_at: null,
      }

      offlineMaintenance.push(newTask)
      return toTaskView(newTask, today)
    }

    // POST /maintenance/tasks/:taskId/pause
    const pauseMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)\/pause$/)
    if (pauseMatch && method === 'POST') {
      const taskId = pauseMatch[1]
      const found = offlineMaintenance.find((t) => t.id === taskId)
      if (!found) {
        throw makeOfflineError(404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.')
      }
      if (found.status === 'ARCHIVED') {
        throw makeOfflineError(409, 'TASK_ARCHIVED', 'Task is archived.')
      }
      if (found.status !== 'ACTIVE') {
        throw makeOfflineError(409, 'INVALID_TASK_TRANSITION', 'Task must be ACTIVE to pause.', {
          status: found.status,
        })
      }
      found.status = 'PAUSED'
      found.updated_at = new Date().toISOString()
      return toTaskView(found, today)
    }

    // POST /maintenance/tasks/:taskId/resume
    const resumeMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)\/resume$/)
    if (resumeMatch && method === 'POST') {
      const taskId = resumeMatch[1]
      const found = offlineMaintenance.find((t) => t.id === taskId)
      if (!found) {
        throw makeOfflineError(404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.')
      }
      if (found.status === 'ARCHIVED') {
        throw makeOfflineError(409, 'TASK_ARCHIVED', 'Task is archived.')
      }
      if (found.status !== 'PAUSED') {
        throw makeOfflineError(409, 'INVALID_TASK_TRANSITION', 'Task must be PAUSED to resume.', {
          status: found.status,
        })
      }

      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      if (reqBody.next_due_date) {
        if (reqBody.occurrence_id && found.current?.occurrence_id && reqBody.occurrence_id !== found.current.occurrence_id) {
          throw makeOfflineError(409, 'OCCURRENCE_CLOSED', 'Occurrence has already been closed.', {
            current_occurrence_id: found.current.occurrence_id,
          })
        }
        found.current.due_date = reqBody.next_due_date
        found.anchor_date = reqBody.next_due_date
      }

      found.status = 'ACTIVE'
      found.updated_at = new Date().toISOString()
      return toTaskView(found, today)
    }

    // POST /maintenance/tasks/:taskId/archive
    const archiveMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)\/archive$/)
    if (archiveMatch && method === 'POST') {
      const taskId = archiveMatch[1]
      const found = offlineMaintenance.find((t) => t.id === taskId)
      if (!found) {
        throw makeOfflineError(404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.')
      }
      if (found.status === 'ARCHIVED') {
        throw makeOfflineError(409, 'TASK_ARCHIVED', 'Task is already archived.')
      }

      found.status = 'ARCHIVED'
      found.current = null
      found.archived_at = new Date().toISOString()
      found.updated_at = found.archived_at
      return toTaskView(found, today)
    }

    // GET & PATCH /maintenance/tasks/:taskId
    const detailMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)$/)
    if (detailMatch && method === 'GET') {
      const overdueReminderDays = Number(
        readSettingFromStore(offlineSettings, 'maintenance.overdue_reminder_days', 7),
      )
      publishMaintenanceTasksInStore({
        tasksStore: offlineMaintenance,
        postsStore: OFFLINE_POSTS,
        today,
        overdueReminderDays,
        onNotification: dispatchMaintenanceAndNoticeNotifications,
      })

      const taskId = detailMatch[1]
      const found = offlineMaintenance.find((t) => t.id === taskId)
      if (!found) {
        throw makeOfflineError(404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.')
      }
      return toTaskView(found, today)
    }

    if (detailMatch && method === 'PATCH') {
      const taskId = detailMatch[1]
      const found = offlineMaintenance.find((t) => t.id === taskId)
      if (!found) {
        throw makeOfflineError(404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.')
      }
      if (found.status === 'ARCHIVED') {
        throw makeOfflineError(409, 'TASK_ARCHIVED', 'Task is archived and cannot be edited.')
      }

      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}

      if (reqBody.occurrence_id && found.current?.occurrence_id && reqBody.occurrence_id !== found.current.occurrence_id) {
        throw makeOfflineError(409, 'OCCURRENCE_CLOSED', 'Occurrence has already been closed.', {
          current_occurrence_id: found.current.occurrence_id,
        })
      }

      // Check required pairing of period_unit and period_count
      if (('period_unit' in reqBody && !('period_count' in reqBody)) || ('period_count' in reqBody && !('period_unit' in reqBody))) {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'period_unit and period_count must be updated together.')
      }

      const unit = reqBody.period_unit || found.period_unit
      const count = reqBody.period_count !== undefined ? reqBody.period_count : found.period_count
      const lead = reqBody.lead_days !== undefined ? reqBody.lead_days : found.lead_days

      if (reqBody.title !== undefined) {
        if (!reqBody.title || typeof reqBody.title !== 'string') {
          throw makeOfflineError(422, 'VALIDATION_ERROR', 'Title cannot be empty.')
        }
        found.title = reqBody.title.trim()
        for (const entry of offlineMaintenanceLog) {
          if (entry.task_id === found.id) {
            entry.task_title = found.title
          }
        }
      }

      if (reqBody.instructions !== undefined) {
        found.instructions = reqBody.instructions || ''
      }

      if (reqBody.period_unit !== undefined && reqBody.period_count !== undefined) {
        found.period_unit = unit
        found.period_count = count
      }

      if (reqBody.lead_days !== undefined) {
        const maxLead = maxAllowedLeadDays(unit, count)
        if (lead < 0 || lead > maxLead) {
          throw makeOfflineError(422, 'VALIDATION_ERROR', `lead_days must be between 0 and ${maxLead}.`)
        }
        found.lead_days = lead
      }

      if (reqBody.notice !== undefined) {
        found.notice = reqBody.notice
      }

      if (reqBody.next_due_date !== undefined) {
        if (found.current) {
          found.current.due_date = reqBody.next_due_date
          found.anchor_date = reqBody.next_due_date
        }
      }

      found.updated_at = new Date().toISOString()
      return toTaskView(found, today)
    }

    // POST /maintenance/tasks/:taskId/done
    const doneMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)\/done$/)
    if (doneMatch && method === 'POST') {
      const taskId = doneMatch[1]
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const outcome = applyTaskDoneInStore({
        tasksStore: offlineMaintenance,
        logStore: offlineMaintenanceLog,
        taskId,
        body: reqBody,
        user,
        today,
      })
      if (!outcome.ok) {
        throw makeOfflineError(
          outcome.status,
          outcome.errorCode,
          outcome.message,
          outcome.extra || {},
        )
      }
      return outcome.result
    }

    // POST /maintenance/tasks/:taskId/skip
    const skipMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)\/skip$/)
    if (skipMatch && method === 'POST') {
      const taskId = skipMatch[1]
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const outcome = applyTaskSkipInStore({
        tasksStore: offlineMaintenance,
        logStore: offlineMaintenanceLog,
        taskId,
        body: reqBody,
        user,
        today,
      })
      if (!outcome.ok) {
        throw makeOfflineError(
          outcome.status,
          outcome.errorCode,
          outcome.message,
          outcome.extra || {},
        )
      }
      return outcome.result
    }
  }

  // =========================================================================
  // Maintenance Log (/maintenance/log) - #016 (E10/M1)
  // =========================================================================
  if (pathname === '/maintenance/log' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only the chairman, board members, and accountant can view the maintenance log.',
      )
    }
    const outcome = queryMaintenanceLogStore(offlineMaintenanceLog, {
      task_id: urlObj.searchParams.get('task_id'),
      from: urlObj.searchParams.get('from'),
      to: urlObj.searchParams.get('to'),
      limit: urlObj.searchParams.get('limit'),
      offset: urlObj.searchParams.get('offset'),
    })
    if (!outcome.ok) {
      throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
    }
    return outcome.items
  }

  const logEditMatch = pathname.match(/^\/maintenance\/log\/([^/]+)$/)
  if (logEditMatch && method === 'PATCH') {
    const entryId = logEditMatch[1]
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const outcome = applyLogEditInStore({
      logStore: offlineMaintenanceLog,
      entryId,
      body: reqBody,
      user,
    })
    if (!outcome.ok) {
      throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
    }
    return outcome.entry
  }

  // =========================================================================
  // Maintenance Yearly Report (/maintenance/report) - #029 (E10/#132)
  // =========================================================================
  if (pathname === '/maintenance/report' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only the chairman, board members, and accountant can view the maintenance yearly report.',
      )
    }
    const outcome = buildMaintenanceYearReport(
      offlineMaintenanceLog,
      urlObj.searchParams.get('year'),
    )
    if (!outcome.ok) {
      throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
    }
    return outcome.report
  }

  if (pathname === '/maintenance/report/export-csv' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only the chairman, board members, and accountant can export the maintenance yearly report.',
      )
    }
    const outcome = buildMaintenanceYearCsv(
      offlineMaintenanceLog,
      urlObj.searchParams.get('year'),
    )
    if (!outcome.ok) {
      throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
    }
    return new Response(outcome.csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${outcome.filename}"`,
      },
    })
  }

  return null
}

function getOfflineNextTwoSaturdays() {
  const now = new Date()
  const day = now.getUTCDay()
  const daysToNextSat = (6 - day + 7) % 7 || 7
  const sat1 = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToNextSat),
  )
  const sat2 = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToNextSat + 7),
  )
  return [sat1.toISOString().slice(0, 10), sat2.toISOString().slice(0, 10)]
}

const [OFFLINE_SAT_1, OFFLINE_SAT_2] = getOfflineNextTwoSaturdays()

const OFFLINE_KNOWN_APARTMENT_ENTRANCES = {
  '018f0000-0000-7000-8000-000000000301': 1,
  '018f0000-0000-7000-8000-000000000302': 1,
  '018f0000-0000-7000-8000-000000000305': 1,
  '018f0000-0000-7000-8000-000000000309': 2,
  '018f0000-0000-7000-8000-000000000314': 2,
  '018f0000-0000-7000-8000-000000000315': 2,
}

const OFFLINE_POLLS = [
  {
    id: '018f0000-0000-7000-8000-000000000851',
    kind: 'INFORMATIVE',
    title: 'Spring clean-up in the yard',
    description:
      'We are planning the annual courtyard clean-up, hedge trimming, and bicycle shed tidying. Please let the board know which Saturday works best for your household and whether any tools or supplies are needed.',
    status: 'OPEN',
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    eligibility: 'RESIDENTS',
    unit: 'APARTMENT',
    closes_at: new Date(Date.now() + 14 * 86400 * 1000).toISOString().slice(0, 11) + '21:59:59Z',
    opened_at: '2026-10-24T09:00:00Z',
    closed_at: null,
    cancelled_at: null,
    created_at: '2026-10-24T08:45:00Z',
    questions: [
      {
        id: '018f0000-0000-7000-8000-000000000861',
        position: 1,
        text: 'Which Saturday suits you?',
        prompt: 'Which Saturday suits you?',
        answer_mode: 'MULTIPLE_CHOICE',
        value_type: 'DATE',
        required: true,
        min_choices: 1,
        max_choices: 2,
        min_value: null,
        max_value: null,
        options: [
          {
            id: '018f0000-0000-7000-8000-000000000871',
            position: 1,
            value: OFFLINE_SAT_1,
          },
          {
            id: '018f0000-0000-7000-8000-000000000872',
            position: 2,
            value: OFFLINE_SAT_2,
          },
        ],
      },
      {
        id: '018f0000-0000-7000-8000-000000000862',
        position: 2,
        text: 'Anything the board should know?',
        prompt: 'Anything the board should know?',
        answer_mode: 'OWN_VALUE',
        value_type: 'TEXT',
        required: false,
        min_choices: null,
        max_choices: null,
        min_value: null,
        max_value: null,
        options: [],
      },
    ],
    ballots: [
      {
        apartment_id: '018f0000-0000-7000-8000-000000000301',
        user_id: null,
        submitted_at: '2026-10-24T11:15:00Z',
        updated_at: '2026-10-24T11:15:00Z',
        answers: [
          {
            question_id: '018f0000-0000-7000-8000-000000000861',
            option_ids: ['018f0000-0000-7000-8000-000000000871'],
            value: null,
          },
          {
            question_id: '018f0000-0000-7000-8000-000000000862',
            option_ids: [],
            value: 'We can bring two rakes and heavy-duty garden waste bags.',
          },
        ],
      },
    ],
  },
  {
    id: '018f0000-0000-7000-8000-000000000852',
    kind: 'INFORMATIVE',
    title: 'Courtyard EV charging readiness survey',
    description:
      'Informative survey for apartment owners on preparing electrical conduit capacity in the courtyard parking area before the 2027 budget draft.',
    status: 'OPEN',
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    eligibility: 'OWNERS',
    unit: 'APARTMENT',
    closes_at: new Date(Date.now() + 21 * 86400 * 1000).toISOString().slice(0, 11) + '21:59:59Z',
    opened_at: '2026-10-25T10:00:00Z',
    closed_at: null,
    cancelled_at: null,
    created_at: '2026-10-25T09:30:00Z',
    questions: [
      {
        id: '018f0000-0000-7000-8000-000000000863',
        position: 1,
        text: 'Preferred approach for load-shared EV readiness',
        prompt: 'Preferred approach for load-shared EV readiness',
        answer_mode: 'SINGLE_CHOICE',
        value_type: 'TEXT',
        required: true,
        min_choices: null,
        max_choices: null,
        min_value: null,
        max_value: null,
        options: [
          {
            id: '018f0000-0000-7000-8000-000000000873',
            position: 1,
            value: 'Install shared main cable conduit for all bays in 2027',
          },
          {
            id: '018f0000-0000-7000-8000-000000000874',
            position: 2,
            value: 'Phase installation starting with 4 shared charging bays',
          },
          {
            id: '018f0000-0000-7000-8000-000000000875',
            position: 3,
            value: 'Postpone until 2028 maintenance plan',
          },
        ],
      },
      {
        id: '018f0000-0000-7000-8000-000000000864',
        position: 2,
        text: 'Maximum one-time reserve contribution per apartment (EUR)',
        prompt: 'Maximum one-time reserve contribution per apartment (EUR)',
        answer_mode: 'OWN_VALUE',
        value_type: 'NUMBER',
        required: false,
        min_choices: null,
        max_choices: null,
        min_value: '0',
        max_value: '1500',
        options: [],
      },
    ],
    ballots: [
      {
        apartment_id: '018f0000-0000-7000-8000-000000000301',
        user_id: null,
        submitted_at: '2026-10-25T12:10:00Z',
        updated_at: '2026-10-25T12:10:00Z',
        answers: [
          {
            question_id: '018f0000-0000-7000-8000-000000000863',
            option_ids: ['018f0000-0000-7000-8000-000000000873'],
            value: null,
          },
          {
            question_id: '018f0000-0000-7000-8000-000000000864',
            option_ids: [],
            value: '350',
          },
        ],
      },
    ],
  },
  {
    id: '018f0000-0000-7000-8000-000000000853',
    kind: 'INFORMATIVE',
    title: 'Stairwell LED lighting & motion sensor schedule',
    description: 'Completed resident poll on stairwell lighting warmth and night dimming hours.',
    status: 'CLOSED',
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    eligibility: 'RESIDENTS',
    unit: 'APARTMENT',
    closes_at: '2026-10-15T20:59:59Z',
    opened_at: '2026-10-01T09:00:00Z',
    closed_at: '2026-10-15T21:00:00Z',
    cancelled_at: null,
    created_at: '2026-10-01T08:30:00Z',
    questions: [
      {
        id: '018f0000-0000-7000-8000-000000000865',
        position: 1,
        text: 'Preferred stairwell colour temperature',
        prompt: 'Preferred stairwell colour temperature',
        answer_mode: 'SINGLE_CHOICE',
        value_type: 'TEXT',
        required: true,
        min_choices: null,
        max_choices: null,
        min_value: null,
        max_value: null,
        options: [
          {
            id: '018f0000-0000-7000-8000-000000000876',
            position: 1,
            value: 'Warm white (3000K)',
          },
          {
            id: '018f0000-0000-7000-8000-000000000877',
            position: 2,
            value: 'Neutral white (4000K)',
          },
        ],
      },
    ],
    ballots: [
      {
        apartment_id: '018f0000-0000-7000-8000-000000000314',
        user_id: null,
        submitted_at: '2026-10-04T18:20:00Z',
        updated_at: '2026-10-04T18:20:00Z',
        answers: [
          {
            question_id: '018f0000-0000-7000-8000-000000000865',
            option_ids: ['018f0000-0000-7000-8000-000000000876'],
            value: null,
          },
        ],
      },
      {
        apartment_id: '018f0000-0000-7000-8000-000000000301',
        user_id: null,
        submitted_at: '2026-10-03T10:00:00Z',
        updated_at: '2026-10-03T10:00:00Z',
        answers: [
          {
            question_id: '018f0000-0000-7000-8000-000000000865',
            option_ids: ['018f0000-0000-7000-8000-000000000876'],
            value: null,
          },
        ],
      },
    ],
  },
  {
    id: '018f0000-0000-7000-8000-000000000854',
    kind: 'INFORMATIVE',
    title: 'August courtyard movie evening date',
    description: 'Cancelled due to scheduled facade inspection scaffolding in the courtyard.',
    status: 'CANCELLED',
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    eligibility: 'RESIDENTS',
    unit: 'PERSON',
    closes_at: '2026-08-20T20:59:59Z',
    opened_at: '2026-08-10T09:00:00Z',
    closed_at: null,
    cancelled_at: '2026-08-12T15:00:00Z',
    created_at: '2026-08-10T08:30:00Z',
    questions: [
      {
        id: '018f0000-0000-7000-8000-000000000866',
        position: 1,
        text: 'Preferred evening date',
        prompt: 'Preferred evening date',
        answer_mode: 'SINGLE_CHOICE',
        value_type: 'DATE',
        required: true,
        min_choices: null,
        max_choices: null,
        min_value: null,
        max_value: null,
        options: [
          {
            id: '018f0000-0000-7000-8000-000000000878',
            position: 1,
            value: '2026-08-22',
          },
        ],
      },
    ],
    ballots: [],
  },
  {
    id: '018f0000-0000-7000-8000-000000000855',
    kind: 'INFORMATIVE',
    title: 'Courtyard playground bench replacement',
    description:
      'Draft survey on replacing the two wooden benches next to the courtyard sandbox before spring.',
    status: 'DRAFT',
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    eligibility: 'RESIDENTS',
    unit: 'APARTMENT',
    closes_at: new Date(Date.now() + 28 * 86400 * 1000).toISOString().slice(0, 11) + '21:59:59Z',
    opened_at: null,
    closed_at: null,
    cancelled_at: null,
    created_at: '2026-10-26T10:00:00Z',
    questions: [
      {
        id: '018f0000-0000-7000-8000-000000000867',
        position: 1,
        text: 'Which bench material do you prefer?',
        prompt: 'Which bench material do you prefer?',
        answer_mode: 'SINGLE_CHOICE',
        value_type: 'TEXT',
        required: true,
        min_choices: null,
        max_choices: null,
        min_value: null,
        max_value: null,
        options: [
          {
            id: '018f0000-0000-7000-8000-000000000879',
            position: 1,
            value: 'Oiled larch timber with backrest',
          },
          {
            id: '018f0000-0000-7000-8000-000000000880',
            position: 2,
            value: 'Recycled composite slats with steel frame',
          },
        ],
      },
    ],
    ballots: [],
  },
]

function isOfflineApartmentTargeted(poll, aptId, entrance) {
  if (poll.target_scope === 'ALL_BUILDING') return true
  if (poll.target_scope === 'ENTRANCE') return poll.target_entrance === entrance
  if (poll.target_scope === 'APARTMENT_LIST') {
    return Array.isArray(poll.target_apartment_ids) && poll.target_apartment_ids.includes(aptId)
  }
  return true
}

function isOfflinePollVisibleToUser(poll, user) {
  const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
  if (poll.status === 'DRAFT') return isBoardUser
  if (isBoardUser || user.building_role === 'ACCOUNTANT') return true
  const mems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
  return mems.some((m) => isOfflineApartmentTargeted(poll, m.apartment_id, m.entrance))
}

function computeOfflinePollAnswerability(poll, user) {
  if (poll.status !== 'OPEN' || new Date(poll.closes_at).getTime() <= Date.now()) {
    return { canAnswer: false, answerableApartmentIds: [] }
  }
  const mems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
  const qualifying = mems.filter((m) => {
    if (!isOfflineApartmentTargeted(poll, m.apartment_id, m.entrance)) return false
    if (poll.eligibility === 'OWNERS' && m.relation_type !== 'OWNER') return false
    return true
  })

  if (poll.unit === 'PERSON') {
    return { canAnswer: qualifying.length > 0, answerableApartmentIds: [] }
  }
  const sortedIds = qualifying
    .slice()
    .sort((a, b) => a.apartment_number.localeCompare(b.apartment_number))
    .map((m) => m.apartment_id)
  return { canAnswer: sortedIds.length > 0, answerableApartmentIds: sortedIds }
}

function computeOfflineMyBallots(poll, user) {
  if (poll.status === 'CANCELLED') return []
  if (poll.unit === 'PERSON') {
    return poll.ballots
      .filter((b) => b.user_id === user.user_id)
      .map((b) => ({
        apartment_id: null,
        submitted_at: b.submitted_at,
        updated_at: b.updated_at,
        answers: b.answers.map((a) => ({
          question_id: a.question_id,
          option_ids: [...a.option_ids],
          value: a.value,
        })),
      }))
  }
  const mems = OFFLINE_MEMBERSHIPS_BY_USER[user.user_id] || []
  const visibleAptIds = mems
    .filter((m) => {
      if (!isOfflineApartmentTargeted(poll, m.apartment_id, m.entrance)) return false
      if (poll.eligibility === 'OWNERS' && m.relation_type !== 'OWNER') return false
      return true
    })
    .map((m) => m.apartment_id)

  return poll.ballots
    .filter((b) => b.apartment_id && visibleAptIds.includes(b.apartment_id))
    .map((b) => ({
      apartment_id: b.apartment_id,
      submitted_at: b.submitted_at,
      updated_at: b.updated_at,
      answers: b.answers.map((a) => ({
        question_id: a.question_id,
        option_ids: [...a.option_ids],
        value: a.value,
      })),
    }))
}

function compareOfflinePollsOrder(a, b) {
  const aOpen = a.status === 'OPEN' ? 0 : 1
  const bOpen = b.status === 'OPEN' ? 0 : 1
  if (aOpen !== bOpen) return aOpen - bOpen
  if (a.status === 'OPEN' && b.status === 'OPEN') {
    return new Date(a.closes_at).getTime() - new Date(b.closes_at).getTime()
  }
  const aRef = a.opened_at || a.created_at
  const bRef = b.opened_at || b.created_at
  return new Date(bRef).getTime() - new Date(aRef).getTime()
}

function toOfflinePollSummary(poll, user) {
  const { canAnswer, answerableApartmentIds } = computeOfflinePollAnswerability(poll, user)
  const myBallots = computeOfflineMyBallots(poll, user)
  const answered =
    poll.status === 'CANCELLED'
      ? false
      : poll.unit === 'APARTMENT' && answerableApartmentIds.length > 0
        ? answerableApartmentIds.every((id) => myBallots.some((b) => b.apartment_id === id))
        : myBallots.length > 0
  const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role)
  const resultsAvailable =
    poll.status === 'CLOSED' || (poll.status === 'OPEN' && isBoardUser)

  return {
    id: poll.id,
    kind: poll.kind,
    title: poll.title,
    description: poll.description,
    status: poll.status,
    target_scope: poll.target_scope,
    target_entrance: poll.target_entrance,
    target_apartment_ids: poll.target_apartment_ids,
    eligibility: poll.eligibility,
    unit: poll.unit,
    closes_at: poll.closes_at,
    opened_at: poll.opened_at,
    closed_at: poll.closed_at,
    cancelled_at: poll.cancelled_at,
    created_at: poll.created_at,
    results_available: resultsAvailable,
    can_answer: canAnswer,
    answerable_apartment_ids: answerableApartmentIds,
    answered,
  }
}

function toOfflinePollView(poll, user) {
  const summary = toOfflinePollSummary(poll, user)
  const { answered, ...rest } = summary
  return {
    ...rest,
    questions: poll.questions.map((q) => ({
      ...q,
      text: q.text || q.prompt,
      prompt: q.text || q.prompt,
      options: q.options.map((o) => ({ ...o })),
    })),
    my_ballots: computeOfflineMyBallots(poll, user),
  }
}

function computeOfflinePollElectorateCount(poll) {
  const targetedAptIds = Object.entries(OFFLINE_KNOWN_APARTMENT_ENTRANCES)
    .filter(([aptId, ent]) => isOfflineApartmentTargeted(poll, aptId, ent))
    .map(([aptId]) => aptId)

  if (poll.unit === 'APARTMENT') {
    let eligible = 0
    for (const aptId of targetedAptIds) {
      if (aptId === '018f0000-0000-7000-8000-000000000305') continue
      if (aptId === '018f0000-0000-7000-8000-000000000302') {
        if (poll.eligibility !== 'OWNERS') eligible += 1
        continue
      }
      eligible += 1
    }
    return eligible
  }

  const eligibleUsers = new Set()
  for (const [uid, mems] of Object.entries(OFFLINE_MEMBERSHIPS_BY_USER)) {
    const qualifies = mems.some((m) => {
      if (!targetedAptIds.includes(m.apartment_id)) return false
      if (poll.eligibility === 'OWNERS' && m.relation_type !== 'OWNER') return false
      return true
    })
    if (qualifies) eligibleUsers.add(uid)
  }
  return eligibleUsers.size
}

function computeOfflinePollResults(poll, isBoardUser) {
  const electorate = computeOfflinePollElectorateCount(poll)
  const answeredUnits = poll.ballots.length

  const questions = poll.questions.map((q) => {
    let qAnswered = 0

    if (q.answer_mode === 'SINGLE_CHOICE' || q.answer_mode === 'MULTIPLE_CHOICE') {
      const countsByOption = new Map()
      for (const opt of q.options) {
        countsByOption.set(opt.id, 0)
      }
      for (const ballot of poll.ballots) {
        const ans = ballot.answers.find((a) => a.question_id === q.id)
        if (ans && Array.isArray(ans.option_ids) && ans.option_ids.length > 0) {
          qAnswered += 1
          for (const oid of ans.option_ids) {
            if (countsByOption.has(oid)) {
              countsByOption.set(oid, (countsByOption.get(oid) || 0) + 1)
            }
          }
        }
      }
      return {
        question_id: q.id,
        answered: qAnswered,
        options: q.options.map((opt) => ({
          option_id: opt.id,
          count: countsByOption.get(opt.id) || 0,
        })),
        number: null,
        dates: null,
        texts: null,
      }
    }

    const rawValues = []
    for (const ballot of poll.ballots) {
      const ans = ballot.answers.find((a) => a.question_id === q.id)
      const val = ans?.value != null ? String(ans.value).trim() : ''
      if (val !== '') {
        qAnswered += 1
        rawValues.push(val)
      }
    }

    if (q.value_type === 'NUMBER') {
      return {
        question_id: q.id,
        answered: qAnswered,
        options: null,
        number: computeNumberStats(rawValues),
        dates: null,
        texts: null,
      }
    }

    if (q.value_type === 'DATE') {
      const dateCounts = new Map()
      for (const v of rawValues) {
        dateCounts.set(v, (dateCounts.get(v) || 0) + 1)
      }
      const dates = Array.from(dateCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }))
      return {
        question_id: q.id,
        answered: qAnswered,
        options: null,
        number: null,
        dates,
        texts: null,
      }
    }

    let texts = null
    if (isBoardUser) {
      const textCounts = new Map()
      for (const v of rawValues) {
        textCounts.set(v, (textCounts.get(v) || 0) + 1)
      }
      texts = Array.from(textCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }))
    }

    return {
      question_id: q.id,
      answered: qAnswered,
      options: null,
      number: null,
      dates: null,
      texts,
    }
  })

  return {
    poll_id: poll.id,
    status: poll.status,
    unit: poll.unit,
    participation: {
      answered: answeredUnits,
      electorate,
    },
    questions,
  }
}

function validateOfflinePollDraft(body) {
  const title = typeof body?.title === 'string' ? body.title.trim() : ''
  if (!title || title.length > 255) {
    throw makeOfflineError(422, 'VALIDATION_ERROR', 'Title is required.')
  }
  const description = typeof body?.description === 'string' ? body.description.trim() : ''
  const targetScope = body?.target_scope
  if (!['ALL_BUILDING', 'ENTRANCE', 'APARTMENT_LIST'].includes(targetScope)) {
    throw makeOfflineError(422, 'INVALID_TARGET', 'Invalid target_scope.')
  }
  let targetEntrance = null
  let targetApartmentIds = null
  if (targetScope === 'ALL_BUILDING') {
    if (
      body.target_entrance != null ||
      (Array.isArray(body.target_apartment_ids) && body.target_apartment_ids.length > 0)
    ) {
      throw makeOfflineError(422, 'INVALID_TARGET', 'Invalid target fields for ALL_BUILDING.')
    }
  } else if (targetScope === 'ENTRANCE') {
    const ent = Number(body.target_entrance)
    if (!Number.isInteger(ent) || ![1, 2].includes(ent) || body.target_apartment_ids != null) {
      throw makeOfflineError(422, 'INVALID_TARGET', 'Invalid target_entrance.')
    }
    targetEntrance = ent
  } else if (targetScope === 'APARTMENT_LIST') {
    if (
      body.target_entrance != null ||
      !Array.isArray(body.target_apartment_ids) ||
      body.target_apartment_ids.length === 0
    ) {
      throw makeOfflineError(422, 'INVALID_TARGET', 'Invalid target_apartment_ids.')
    }
    const deduped = Array.from(new Set(body.target_apartment_ids.map((id) => String(id))))
    for (const aptId of deduped) {
      if (!OFFLINE_KNOWN_APARTMENT_ENTRANCES[aptId]) {
        throw makeOfflineError(422, 'INVALID_TARGET', 'Unknown apartment.')
      }
    }
    targetApartmentIds = deduped
  }

  const eligibility = body?.eligibility
  const unit = body?.unit
  const closesAt = typeof body?.closes_at === 'string' ? body.closes_at.trim() : ''
  if (
    !['RESIDENTS', 'OWNERS'].includes(eligibility) ||
    !['APARTMENT', 'PERSON'].includes(unit) ||
    !closesAt ||
    Number.isNaN(new Date(closesAt).getTime())
  ) {
    throw makeOfflineError(422, 'VALIDATION_ERROR', 'Invalid poll settings.')
  }

  const rawQuestions = Array.isArray(body?.questions) ? body.questions : []
  if (rawQuestions.length < 1 || rawQuestions.length > 20) {
    throw makeOfflineError(422, 'VALIDATION_ERROR', '1..20 questions required.')
  }

  const questions = rawQuestions.map((rq, idx) => {
    const qText = String(rq?.text ?? rq?.prompt ?? '').trim()
    if (!qText || qText.length > 500) {
      throw makeOfflineError(422, 'VALIDATION_ERROR', 'Question text is required.')
    }
    const mode = rq?.answer_mode
    const vType = rq?.value_type
    const rawOpts = Array.isArray(rq?.options) ? rq.options : []
    const options =
      mode === 'OWN_VALUE'
        ? []
        : rawOpts.map((o, oi) => ({
            id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
            position: oi + 1,
            value: String(typeof o === 'object' && o !== null ? o.value ?? '' : o ?? '').trim(),
          }))
    return {
      id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      position: idx + 1,
      text: qText,
      prompt: qText,
      answer_mode: mode,
      value_type: vType,
      required: rq?.required !== false,
      min_choices: mode === 'MULTIPLE_CHOICE' ? (rq?.min_choices ?? 1) : null,
      max_choices: mode === 'MULTIPLE_CHOICE' ? (rq?.max_choices ?? options.length) : null,
      min_value: mode === 'OWN_VALUE' && vType !== 'TEXT' ? (rq?.min_value ?? null) : null,
      max_value: mode === 'OWN_VALUE' && vType !== 'TEXT' ? (rq?.max_value ?? null) : null,
      options,
    }
  })

  return {
    kind: 'INFORMATIVE',
    title,
    description,
    target_scope: targetScope,
    target_entrance: targetEntrance,
    target_apartment_ids: targetApartmentIds,
    eligibility,
    unit,
    closes_at: closesAt,
    questions,
  }
}

const OFFLINE_NOTIFICATION_EVENTS = [
  'EMERGENCY_PUBLISHED',
  'EMERGENCY_RESOLVED',
  'READING_DEADLINE',
  'PERIOD_REVIEW',
  'APARTMENT_MESSAGE',
  'APARTMENT_MESSAGE_TO_BOARD',
  'POLL_OPENED',
  'ISSUE_REPORTED',
  'ISSUE_URGENT',
  'ISSUE_STATUS_CHANGED',
  'MAINTENANCE_DUE',
  'NOTICE_PUBLISHED',
  'STORAGE_ALMOST_FULL',
]
const OFFLINE_NOTIFICATION_CHANNELS = ['in_app', 'email', 'telegram', 'webpush']

function getOfflineUserPreferences(userId) {
  if (!offlinePreferencesByUser[userId]) {
    const list = []
    for (const event_type of OFFLINE_NOTIFICATION_EVENTS) {
      for (const channel of OFFLINE_NOTIFICATION_CHANNELS) {
        const mandatory = event_type === 'EMERGENCY_PUBLISHED' || event_type === 'ISSUE_URGENT'
        const enabled =
          event_type === 'APARTMENT_MESSAGE_TO_BOARD' ||
          event_type === 'ISSUE_REPORTED' ||
          event_type === 'MAINTENANCE_DUE'
            ? channel === 'in_app'
            : event_type === 'STORAGE_ALMOST_FULL'
              ? channel === 'in_app' || channel === 'email'
              : true
        list.push({
          event_type,
          channel,
          enabled,
          mandatory,
        })
      }
    }
    offlinePreferencesByUser[userId] = list
  }
  return offlinePreferencesByUser[userId]
}

function getOfflineUserNotifications(userId) {
  if (!offlineNotificationsByUser[userId]) {
    const isBoardUser = ['018f0000-0000-7000-8000-000000000101', '018f0000-0000-7000-8000-000000000105'].includes(
      userId,
    )
    const base = [
      {
        id: '018f0000-0000-7000-8000-000000009101',
        event_type: 'EMERGENCY_PUBLISHED',
        subject_type: 'post',
        subject_id: '018f0000-0000-7000-8000-000000000701',
        params: {
          category: 'WATER_SHUTOFF',
          target_scope: 'ENTRANCE',
          target_entrance: 2,
        },
        created_at: '2026-10-25T10:00:00Z',
        read_at: null,
      },
      isBoardUser
        ? {
            id: '018f0000-0000-7000-8000-000000009105',
            event_type: 'APARTMENT_MESSAGE_TO_BOARD',
            subject_type: 'post',
            subject_id: '018f0000-0000-7000-8000-000000000751',
            params: {
              apartment_id: '018f0000-0000-7000-8000-000000000314',
              apartment_number: '14',
              from_board: false,
            },
            created_at: '2026-10-24T12:40:00Z',
            read_at: null,
          }
        : {
            id: '018f0000-0000-7000-8000-000000009104',
            event_type: 'APARTMENT_MESSAGE',
            subject_type: 'post',
            subject_id: '018f0000-0000-7000-8000-000000000751',
            params: {
              apartment_id: '018f0000-0000-7000-8000-000000000314',
              apartment_number: '14',
              from_board: true,
            },
            created_at: '2026-10-24T10:15:00Z',
            read_at: null,
          },
      {
        id: '018f0000-0000-7000-8000-000000009102',
        event_type: 'READING_DEADLINE',
        subject_type: 'period',
        subject_id: '018f0000-0000-7000-8000-000000000010',
        params: {
          period_code: '2026-10',
          due_date: '2026-11-04',
        },
        created_at: '2026-10-24T09:00:00Z',
        read_at: null,
      },
      {
        id: '018f0000-0000-7000-8000-000000009103',
        event_type: 'PERIOD_REVIEW',
        subject_type: 'period',
        subject_id: '018f0000-0000-7000-8000-000000000009',
        params: {
          period_code: '2026-09',
        },
        created_at: '2026-10-05T12:00:00Z',
        read_at: '2026-10-05T14:30:00Z',
      },
    ]

    if (
      userId !== '018f0000-0000-7000-8000-000000000101' &&
      userId !== '018f0000-0000-7000-8000-000000000103'
    ) {
      base.splice(1, 0, {
        id: '018f0000-0000-7000-8000-000000009106',
        event_type: 'POLL_OPENED',
        subject_type: 'poll',
        subject_id: '018f0000-0000-7000-8000-000000000851',
        params: {
          closes_at:
            new Date(Date.now() + 14 * 86400 * 1000).toISOString().slice(0, 11) + '21:59:59Z',
        },
        created_at: '2026-10-24T09:05:00Z',
        read_at: null,
      })
    }

    if (isBoardUser) {
      base.splice(1, 0, {
        id: '018f0000-0000-7000-8000-000000009109',
        event_type: 'MAINTENANCE_DUE',
        subject_type: 'maintenance_task',
        subject_id: 'task-fire-extinguishers',
        params: {
          occurrence_id: 'occ-ext-2026',
          due_date: '2026-11-08',
          overdue: true,
          reminder_number: 1,
        },
        created_at: '2026-11-09T09:00:00Z',
        read_at: null,
      })
      base.splice(1, 0, {
        id: '018f0000-0000-7000-8000-000000009107',
        event_type: 'ISSUE_REPORTED',
        subject_type: 'issue',
        subject_id: '018f0000-0000-7000-8000-000000000901',
        params: {
          category: 'LIGHTING',
          entrance: 1,
        },
        created_at: '2026-10-25T08:15:00Z',
        read_at: null,
      })
    } else if (userId !== '018f0000-0000-7000-8000-000000000103') {
      base.splice(1, 0, {
        id: '018f0000-0000-7000-8000-000000009108',
        event_type: 'ISSUE_STATUS_CHANGED',
        subject_type: 'issue',
        subject_id: '018f0000-0000-7000-8000-000000000902',
        params: {
          category: 'DOORS_AND_LOCKS',
          entrance: 2,
          status: 'IN_PROGRESS',
          merged: false,
        },
        created_at: '2026-10-25T09:30:00Z',
        read_at: null,
      })
    }

    if (userId !== '018f0000-0000-7000-8000-000000000103') {
      base.splice(1, 0, {
        id: '018f0000-0000-7000-8000-000000009110',
        event_type: 'NOTICE_PUBLISHED',
        subject_type: 'post',
        subject_id: '018f0000-0000-7000-8000-000000000604',
        params: {},
        created_at: '2026-11-06T09:00:00Z',
        read_at: null,
      })
    }

    offlineNotificationsByUser[userId] = base
  }
  return offlineNotificationsByUser[userId]
}

function getNoticeRecipientUserIds(notice, authorUserId) {
  const recipients = new Set(['018f0000-0000-7000-8000-000000000101', '018f0000-0000-7000-8000-000000000105'])
  const userApts = [
    { userId: '018f0000-0000-7000-8000-000000000101', entrance: 1, aptId: '018f0000-0000-7000-8000-000000000301' },
    { userId: '018f0000-0000-7000-8000-000000000105', entrance: 1, aptId: '018f0000-0000-7000-8000-000000000302' },
    { userId: '018f0000-0000-7000-8000-000000000104', entrance: 1, aptId: '018f0000-0000-7000-8000-000000000302' },
    { userId: '018f0000-0000-7000-8000-000000000102', entrance: 2, aptId: '018f0000-0000-7000-8000-000000000314' },
  ]
  for (const u of userApts) {
    if (!notice.target_scope || notice.target_scope === 'ALL_BUILDING') {
      recipients.add(u.userId)
    } else if (notice.target_scope === 'ENTRANCE' && Number(notice.target_entrance) === u.entrance) {
      recipients.add(u.userId)
    } else if (
      notice.target_scope === 'APARTMENT_LIST' &&
      Array.isArray(notice.target_apartment_ids) &&
      notice.target_apartment_ids.includes(u.aptId)
    ) {
      recipients.add(u.userId)
    }
  }
  if (authorUserId) {
    recipients.delete(authorUserId)
  }
  return Array.from(recipients)
}

function dispatchMaintenanceAndNoticeNotifications(notif) {
  if (notif.event_type === 'MAINTENANCE_DUE') {
    const recipientUserIds = ['018f0000-0000-7000-8000-000000000101', '018f0000-0000-7000-8000-000000000105']
    emitOfflineIssueNotificationBatch({
      recipientUserIds,
      event_type: 'MAINTENANCE_DUE',
      subject_type: 'maintenance_task',
      subject_id: notif.subject_id,
      params: notif.params,
      created_at: notif.created_at || new Date().toISOString(),
    })
  } else if (notif.event_type === 'NOTICE_PUBLISHED') {
    const recipientUserIds = getNoticeRecipientUserIds(notif, notif.author_user_id)
    emitOfflineIssueNotificationBatch({
      recipientUserIds,
      event_type: 'NOTICE_PUBLISHED',
      subject_type: 'post',
      subject_id: notif.subject_id,
      params: {},
      created_at: notif.created_at || new Date().toISOString(),
    })
  }
}

function checkAndEmitOfflineStorageAlert() {
  const currentUsage = computeStorageUsage({
    issuesStore: offlineIssues,
    documentsStore: offlineDocuments,
    extraPendingDeletionBytes: offlineExtraPendingDeletionBytes,
  })
  const triggered = evaluateStorageThresholdNotification(currentUsage, offlineStorageAlertState)
  if (triggered) {
    const boardUserIds = ['018f0000-0000-7000-8000-000000000101', '018f0000-0000-7000-8000-000000000105']
    emitOfflineIssueNotificationBatch({
      recipientUserIds: boardUserIds,
      event_type: 'STORAGE_ALMOST_FULL',
      subject_type: 'storage',
      subject_id: 'storage',
      params: {
        threshold: triggered.threshold,
        used_percent: triggered.used_percent,
      },
      created_at: new Date().toISOString(),
    })
  }
}

function emitOfflineIssueNotificationBatch(batch) {
  for (const uid of batch.recipientUserIds || []) {
    const prefs = getOfflineUserPreferences(uid)
    const inAppPref = prefs.find(
      (p) => p.event_type === batch.event_type && p.channel === 'in_app',
    )
    if (batch.event_type === 'ISSUE_URGENT' || !inAppPref || inAppPref.enabled) {
      getOfflineUserNotifications(uid).unshift({
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        event_type: batch.event_type,
        subject_type: batch.subject_type,
        subject_id: batch.subject_id,
        params: { ...batch.params },
        created_at: batch.created_at,
        read_at: null,
      })
    }
  }
}

function emitOfflinePollOpenedNotifications(poll, openerUser, createdAtIso) {
  for (const demoUser of OFFLINE_DEMO_USERS) {
    if (demoUser.user_id === openerUser.user_id) continue
    const { canAnswer } = computeOfflinePollAnswerability(poll, demoUser)
    if (!canAnswer) continue

    const prefs = getOfflineUserPreferences(demoUser.user_id)
    const inAppPref = prefs.find(
      (p) => p.event_type === 'POLL_OPENED' && p.channel === 'in_app',
    )
    if (!inAppPref || inAppPref.enabled) {
      getOfflineUserNotifications(demoUser.user_id).unshift({
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        event_type: 'POLL_OPENED',
        subject_type: 'poll',
        subject_id: poll.id,
        params: {
          closes_at: poll.closes_at,
        },
        created_at: createdAtIso,
        read_at: null,
      })
    }
  }
}

function validateOfflineBallotAnswers(questions, rawAnswers) {
  const seenQuestions = new Set()
  const byQuestionId = new Map()

  for (const item of rawAnswers) {
    const qId = String(item?.question_id || '')
    if (seenQuestions.has(qId)) {
      return { valid: false, questionId: qId, reason: 'DUPLICATE', normalizedAnswers: [] }
    }
    const qDef = questions.find((q) => q.id === qId)
    if (!qDef) {
      return { valid: false, questionId: qId, reason: 'UNKNOWN_QUESTION', normalizedAnswers: [] }
    }
    seenQuestions.add(qId)
    byQuestionId.set(qId, item)
  }

  const normalizedAnswers = []

  for (const q of questions) {
    const item = byQuestionId.get(q.id)
    const optIds = Array.isArray(item?.option_ids)
      ? item.option_ids.map((id) => String(id))
      : []
    const rawValue = item?.value != null ? String(item.value) : ''

    if (q.answer_mode === 'SINGLE_CHOICE') {
      if (rawValue !== '') {
        return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] }
      }
      if (optIds.length === 0) {
        if (q.required) {
          return { valid: false, questionId: q.id, reason: 'REQUIRED', normalizedAnswers: [] }
        }
        continue
      }
      if (optIds.length !== 1) {
        return { valid: false, questionId: q.id, reason: 'CHOICES', normalizedAnswers: [] }
      }
      const validIds = new Set(q.options.map((o) => o.id))
      if (!validIds.has(optIds[0])) {
        return { valid: false, questionId: q.id, reason: 'UNKNOWN_OPTION', normalizedAnswers: [] }
      }
      normalizedAnswers.push({
        question_id: q.id,
        option_ids: [optIds[0]],
        value: null,
      })
    } else if (q.answer_mode === 'MULTIPLE_CHOICE') {
      if (rawValue !== '') {
        return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] }
      }
      if (optIds.length === 0) {
        if (q.required) {
          return { valid: false, questionId: q.id, reason: 'REQUIRED', normalizedAnswers: [] }
        }
        continue
      }
      const uniqueOpts = new Set(optIds)
      if (uniqueOpts.size !== optIds.length) {
        return { valid: false, questionId: q.id, reason: 'DUPLICATE', normalizedAnswers: [] }
      }
      const validIds = new Set(q.options.map((o) => o.id))
      for (const id of optIds) {
        if (!validIds.has(id)) {
          return { valid: false, questionId: q.id, reason: 'UNKNOWN_OPTION', normalizedAnswers: [] }
        }
      }
      const minC = q.min_choices ?? 1
      const maxC = q.max_choices ?? q.options.length
      if (optIds.length < minC || optIds.length > maxC) {
        return { valid: false, questionId: q.id, reason: 'CHOICES', normalizedAnswers: [] }
      }
      normalizedAnswers.push({
        question_id: q.id,
        option_ids: [...optIds],
        value: null,
      })
    } else if (q.answer_mode === 'OWN_VALUE') {
      if (optIds.length > 0) {
        return { valid: false, questionId: q.id, reason: 'CHOICES', normalizedAnswers: [] }
      }
      const trimmed = rawValue.trim()
      if (trimmed === '') {
        if (q.required) {
          return { valid: false, questionId: q.id, reason: 'REQUIRED', normalizedAnswers: [] }
        }
        continue
      }
      if (q.value_type === 'TEXT') {
        if (trimmed.length > 2000) {
          return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] }
        }
        normalizedAnswers.push({
          question_id: q.id,
          option_ids: [],
          value: trimmed,
        })
      } else if (q.value_type === 'NUMBER') {
        const canonical = normalizeCanonicalNumber(trimmed)
        if (!canonical || !isValidCanonicalNumber(canonical)) {
          return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] }
        }
        if (q.min_value != null && compareCanonicalNumbers(canonical, q.min_value) < 0) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] }
        }
        if (q.max_value != null && compareCanonicalNumbers(canonical, q.max_value) > 0) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] }
        }
        normalizedAnswers.push({
          question_id: q.id,
          option_ids: [],
          value: canonical,
        })
      } else if (q.value_type === 'DATE') {
        if (!isValidCanonicalDate(trimmed)) {
          return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] }
        }
        if (q.min_value != null && trimmed < q.min_value) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] }
        }
        if (q.max_value != null && trimmed > q.max_value) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] }
        }
        normalizedAnswers.push({
          question_id: q.id,
          option_ids: [],
          value: trimmed,
        })
      }
    }
  }

  return { valid: true, normalizedAnswers }
}
