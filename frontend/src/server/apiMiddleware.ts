import type { IncomingMessage, ServerResponse } from 'http';
import type {
  AuthorBadgeDTO,
  BuildingRole,
  DemoUserView,
  DisplayMode,
  EmergencyView,
  HistoryEntry,
  MasterMeterRow,
  MatrixApartment,
  MembershipView,
  MeterUnit,
  NotificationEventType,
  PeriodDTO,
  PeriodStatus,
  PostCategory,
  PostOrigin,
  PostType,
  ReadingSource,
  ReadingSummary,
  ResourceType,
  SettingView,
  SubjectType,
  SubmissionStatus,
  TargetScope,
} from '../api/schema';
import {
  cloneDefaultAssociationSettings,
  validateAndApplySettingsUpdate,
} from '../utils/associationSettings.js';
import {
  buildIssueReportedNotification,
  canUserAccessIssues,
  changeIssueStatusInStore,
  clearIssueUrgentInStore,
  createDefaultIssuesSeed,
  createIssueInStore,
  editIssueInStore,
  isIssueVisibleToUser,
  queryIssuesStore,
  readSettingFromStore,
  toIssueView,
  updateIssueFollowInStore,
  withdrawIssueInStore,
} from '../utils/issues.js';
import {
  applyLogEditInStore,
  applyTaskDoneInStore,
  applyTaskSkipInStore,
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
} from '../utils/maintenance.js';

const BUILDING_ID = '018f0000-0000-7000-8000-000000000001';

interface SeedUser extends DemoUserView {
  full_name: string;
  initials: string;
}

const DEMO_USERS: SeedUser[] = [
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
];

function computePreviewBadge(
  user: SeedUser,
  apartmentNumber: string | null,
  mode: DisplayMode
): AuthorBadgeDTO {
  const roleBadge =
    user.building_role === 'CHAIRMAN' || user.building_role === 'BOARD'
      ? 'BOARD'
      : user.building_role === 'ACCOUNTANT'
        ? 'ACCOUNTANT'
        : 'OWNER';

  if (mode === 'FULL_NAME') {
    return {
      display_label: apartmentNumber
        ? `${user.full_name} (Apt ${apartmentNumber})`
        : user.full_name,
      role_badge: roleBadge,
    };
  }
  if (mode === 'INITIALS') {
    return {
      display_label: apartmentNumber
        ? `${user.initials} (Apt ${apartmentNumber})`
        : user.initials,
      role_badge: roleBadge,
    };
  }
  return {
    display_label: apartmentNumber ? `Apt ${apartmentNumber}` : user.full_name,
    role_badge: roleBadge,
  };
}

const membershipsByUser: Record<string, MembershipView[]> = {
  '018f0000-0000-7000-8000-000000000102': [
    {
      membership_id: '018f0000-0000-7000-8000-000000000214',
      apartment_id: '018f0000-0000-7000-8000-000000000314',
      apartment_number: '14',
      entrance: 1,
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
};

function toBigInt3(val: string): bigint {
  const [intPart, fracPart = ''] = val.split('.');
  const padded = (fracPart + '000').slice(0, 3);
  return BigInt(intPart) * 1000n + BigInt(padded);
}

function fromBigInt3(scaled: bigint): string {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = abs / 1000n;
  const fracPart = (abs % 1000n).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${intPart.toString()}.${fracPart}`;
}

function addDecimal(a: string, b: string): string {
  return fromBigInt3(toBigInt3(a) + toBigInt3(b));
}

function subDecimal(a: string, b: string): string {
  return fromBigInt3(toBigInt3(a) - toBigInt3(b));
}

const periodsMap: Record<string, PeriodDTO> = {
  '2026-10': {
    period_code: '2026-10',
    status: 'OPEN_FOR_RESIDENTS',
    due_date: '2026-11-04',
  },
  '2026-09': {
    period_code: '2026-09',
    status: 'LOCKED',
    due_date: '2026-10-04',
  },
  '2026-08': {
    period_code: '2026-08',
    status: 'LOCKED',
    due_date: '2026-09-04',
  },
  '2026-07': {
    period_code: '2026-07',
    status: 'LOCKED',
    due_date: '2026-08-04',
  },
};

interface InternalMeter {
  meter_id: string;
  resource_type: ResourceType;
  serial_number: string;
  location_label: string;
  unit: MeterUnit;
  previous_value: string;
  historical_avg: string;
  reading: ReadingSummary | null;
}

interface InternalApartment {
  apartment_id: string;
  apartment_number: string;
  entrance: number;
  floor: number;
  can_submit_readings: boolean;
  meters: InternalMeter[];
}

const masterMetersByPeriod: Record<string, MasterMeterRow[]> = {
  '2026-10': [
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
  ],
};

const apartmentsByPeriod: Record<string, InternalApartment[]> = {
  '2026-10': [
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
  ],
};

// Populate historical periods 2026-09, 2026-08, 2026-07
for (const histCode of ['2026-09', '2026-08', '2026-07']) {
  apartmentsByPeriod[histCode] = JSON.parse(JSON.stringify(apartmentsByPeriod['2026-10'])).map(
    (apt: InternalApartment) => ({
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
    })
  );
  masterMetersByPeriod[histCode] = JSON.parse(JSON.stringify(masterMetersByPeriod['2026-10']));
}

const historyStore: Record<string, { meter_id: string; period_code: string; entries: HistoryEntry[] }> = {
  '018f0000-0000-7000-8000-000000000901': {
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
  },
};

interface InternalComment {
  id: string;
  post_id: string;
  body: string;
  author_user_id: string;
  author_apartment_id: string | null;
  created_at: string;
}

interface InternalPost {
  id: string;
  post_type: PostType;
  category: PostCategory;
  title: string;
  body: string;
  author_user_id: string;
  author_apartment_id: string | null;
  target_scope: TargetScope;
  target_entrance: number | null;
  target_apartment_ids: string[] | null;
  is_active: boolean;
  comments_enabled: boolean;
  created_at: string;
  acknowledged_by: Record<string, string>;
  comments: InternalComment[];
  origin?: PostOrigin | null;
}

const postsStore: InternalPost[] = [
  {
    id: '018f0000-0000-7000-8000-000000000701',
    post_type: 'EMERGENCY',
    category: 'WATER_SHUTOFF',
    title: 'Basement Heating Valve Pressure Drop (Stairwell B)',
    body: 'Pressure sensor in Stairwell B heat exchanger dropped from 2.4 bar to 1.6 bar. Technician is on site inspecting the expansion vessel.',
    author_user_id: '018f0000-0000-7000-8000-000000000101',
    author_apartment_id: '018f0000-0000-7000-8000-000000000301',
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-25T08:15:00Z',
    acknowledged_by: {},
    comments: [],
  },
  {
    id: '018f0000-0000-7000-8000-000000000601',
    post_type: 'OFFICIAL_NOTICE',
    category: 'GENERAL',
    title: 'October 2026 Utility Meter Submission & Courtyard Maintenance',
    body: 'Dear residents of Sõpruse pst 12,\n\nPlease submit all October 2026 cold and hot water readings by November 4 at 23:59. Unsubmitted meters will be automatically estimated from your 3-month rolling average.\n\nAdditionally, autumn courtyard leaf clearing and underground garage drain flushing will take place on Saturday, November 7 from 09:00 to 14:00.',
    author_user_id: '018f0000-0000-7000-8000-000000000101',
    author_apartment_id: '018f0000-0000-7000-8000-000000000301',
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-23T11:00:00Z',
    acknowledged_by: {},
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000651',
        post_id: '018f0000-0000-7000-8000-000000000601',
        body: 'Thank you Peeter! Should cars be moved out of the courtyard parking spots before 08:45 on Saturday?',
        author_user_id: '018f0000-0000-7000-8000-000000000102',
        author_apartment_id: '018f0000-0000-7000-8000-000000000314',
        created_at: '2026-10-23T13:20:00Z',
      },
      {
        id: '018f0000-0000-7000-8000-000000000652',
        post_id: '018f0000-0000-7000-8000-000000000601',
        body: 'Yes, please clear the courtyard bays by 08:45 so the maintenance vehicle can access all corners.',
        author_user_id: '018f0000-0000-7000-8000-000000000101',
        author_apartment_id: '018f0000-0000-7000-8000-000000000301',
        created_at: '2026-10-23T14:05:00Z',
      },
    ],
  },
  {
    id: '018f0000-0000-7000-8000-000000000602',
    post_type: 'FORUM_TOPIC',
    category: 'MAINTENANCE',
    title: 'Bicycle Storage Rack Expansion in Ground Floor Room #2',
    body: 'Several families on the 3rd and 4th floors proposed installing vertical wall-mounted bike hooks in the secondary storage room. Total quote for 12 heavy-duty hooks is 480 EUR from the maintenance fund.',
    author_user_id: '018f0000-0000-7000-8000-000000000102',
    author_apartment_id: '018f0000-0000-7000-8000-000000000314',
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-20T17:30:00Z',
    acknowledged_by: {},
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000653',
        post_id: '018f0000-0000-7000-8000-000000000602',
        body: 'We have sufficient allocation in the Q4 minor improvements budget line to cover 480 EUR without affecting the reserve fund.',
        author_user_id: '018f0000-0000-7000-8000-000000000103',
        author_apartment_id: null,
        created_at: '2026-10-21T09:15:00Z',
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
    author_apartment_id: '018f0000-0000-7000-8000-000000000301',
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-15T10:00:00Z',
    acknowledged_by: {},
    comments: [],
  },
  {
    id: '018f0000-0000-7000-8000-000000000751',
    post_type: 'APARTMENT_THREAD',
    category: 'MAINTENANCE',
    title: 'Access to the cold water meter in apartment 14',
    body: 'Hello! Could we arrange a 10-minute inspection of the bathroom cold water meter seal this Thursday between 17:00 and 19:00?',
    author_user_id: '018f0000-0000-7000-8000-000000000101',
    author_apartment_id: null,
    target_scope: 'APARTMENT_LIST',
    target_entrance: null,
    target_apartment_ids: ['018f0000-0000-7000-8000-000000000314'],
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-24T10:15:00Z',
    acknowledged_by: {},
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000752',
        post_id: '018f0000-0000-7000-8000-000000000751',
        body: 'Thursday at 18:00 works well for us. See you then!',
        author_user_id: '018f0000-0000-7000-8000-000000000102',
        author_apartment_id: null,
        created_at: '2026-10-24T12:40:00Z',
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
    author_apartment_id: null,
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-25T11:30:00Z',
    acknowledged_by: {},
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000762',
        post_id: '018f0000-0000-7000-8000-000000000761',
        body: 'Confirmed — I also labelled the roof hatch key and the main water shut-off valve key on the yellow tag.',
        author_user_id: '018f0000-0000-7000-8000-000000000105',
        author_apartment_id: null,
        created_at: '2026-10-25T14:20:00Z',
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
    author_apartment_id: '018f0000-0000-7000-8000-000000000301',
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: false,
    created_at: '2026-10-25T09:00:00Z',
    acknowledged_by: {},
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
    author_apartment_id: null,
    target_scope: 'ALL_BUILDING',
    target_entrance: null,
    target_apartment_ids: null,
    is_active: true,
    comments_enabled: true,
    created_at: '2026-10-25T09:00:00Z',
    acknowledged_by: {},
    comments: [
      {
        id: '018f0000-0000-7000-8000-000000000764',
        post_id: '018f0000-0000-7000-8000-000000000763',
        body: 'Still not done: overdue since 05.11.2026 (reminder 1)',
        author_user_id: '018f0000-0000-7000-8000-000000000101',
        author_apartment_id: null,
        created_at: '2026-11-06T09:00:00Z',
      },
    ],
  },
];

const userLocales: Record<string, 'et' | 'ru' | 'en' | null> = {};

interface MockNotification {
  id: string;
  user_id: string;
  event_type: NotificationEventType;
  subject_type: SubjectType;
  subject_id: string;
  params: Record<string, unknown>;
  created_at: string;
  read_at: string | null;
}

const notificationsByUser: Record<string, MockNotification[]> = {};

function getInitialNotificationsForUser(userId: string): MockNotification[] {
  const base: MockNotification[] = [
    {
      id: `018f0000-0000-7000-8000-000000009101`,
      user_id: userId,
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
    {
      id: `018f0000-0000-7000-8000-000000009102`,
      user_id: userId,
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
      id: `018f0000-0000-7000-8000-000000009103`,
      user_id: userId,
      event_type: 'PERIOD_REVIEW',
      subject_type: 'period',
      subject_id: '018f0000-0000-7000-8000-000000000009',
      params: {
        period_code: '2026-09',
      },
      created_at: '2026-10-05T12:00:00Z',
      read_at: '2026-10-05T14:30:00Z',
    },
  ];

  if (userId === '018f0000-0000-7000-8000-000000000102') {
    base.splice(1, 0, {
      id: `018f0000-0000-7000-8000-000000009104`,
      user_id: userId,
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
    });
  } else if (userId === '018f0000-0000-7000-8000-000000000101') {
    base.splice(1, 0, {
      id: `018f0000-0000-7000-8000-000000009105`,
      user_id: userId,
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
    });
  }

  // Eligible residents/board members (except Chairman who opened the poll and Accountant with no apartment)
  if (
    userId !== '018f0000-0000-7000-8000-000000000101' &&
    userId !== '018f0000-0000-7000-8000-000000000103'
  ) {
    base.splice(1, 0, {
      id: `018f0000-0000-7000-8000-000000009106`,
      user_id: userId,
      event_type: 'POLL_OPENED',
      subject_type: 'poll',
      subject_id: '018f0000-0000-7000-8000-000000000851',
      params: {
        closes_at:
          new Date(Date.now() + 14 * 86400 * 1000).toISOString().slice(0, 11) + '21:59:59Z',
      },
      created_at: '2026-10-24T09:05:00Z',
      read_at: null,
    });
  }

  // #014 Seeded issue notifications
  if (
    userId === '018f0000-0000-7000-8000-000000000101' ||
    userId === '018f0000-0000-7000-8000-000000000105'
  ) {
    base.splice(1, 0, {
      id: `018f0000-0000-7000-8000-000000009107`,
      user_id: userId,
      event_type: 'ISSUE_REPORTED',
      subject_type: 'issue',
      subject_id: '018f0000-0000-7000-8000-000000000901',
      params: {
        category: 'LIGHTING',
        entrance: 1,
      },
      created_at: '2026-10-25T08:15:00Z',
      read_at: null,
    });
  } else if (userId !== '018f0000-0000-7000-8000-000000000103') {
    base.splice(1, 0, {
      id: `018f0000-0000-7000-8000-000000009108`,
      user_id: userId,
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
    });
  }

  return base;
}

function getUserNotifications(userId: string): MockNotification[] {
  if (!notificationsByUser[userId]) {
    notificationsByUser[userId] = getInitialNotificationsForUser(userId);
  }
  return notificationsByUser[userId];
}

interface MockPreference {
  event_type: NotificationEventType;
  channel: 'in_app' | 'email' | 'telegram' | 'webpush';
  enabled: boolean;
  mandatory: boolean;
}

const EVENT_TYPES: Array<MockPreference['event_type']> = [
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
];
const CHANNELS: Array<'in_app' | 'email' | 'telegram' | 'webpush'> = [
  'in_app',
  'email',
  'telegram',
  'webpush',
];

const preferencesByUser: Record<string, MockPreference[]> = {};

function getUserPreferences(userId: string): MockPreference[] {
  if (!preferencesByUser[userId]) {
    const list: MockPreference[] = [];
    for (const ev of EVENT_TYPES) {
      for (const ch of CHANNELS) {
        const mandatory = ev === 'EMERGENCY_PUBLISHED' || ev === 'ISSUE_URGENT';
        const enabled =
          ev === 'APARTMENT_MESSAGE_TO_BOARD' ||
          ev === 'ISSUE_REPORTED' ||
          ev === 'MAINTENANCE_DUE'
            ? ch === 'in_app'
            : true;
        list.push({
          event_type: ev,
          channel: ch,
          enabled,
          mandatory,
        });
      }
    }
    preferencesByUser[userId] = list;
  }
  return preferencesByUser[userId];
}

function getServerNoticeRecipientUserIds(
  notice: { target_scope?: string | null; target_entrance?: number | null; target_apartment_ids?: string[] | null },
  authorUserId?: string | null
): string[] {
  const recipients = new Set(['018f0000-0000-7000-8000-000000000101', '018f0000-0000-7000-8000-000000000105']);
  const userApts = [
    { userId: '018f0000-0000-7000-8000-000000000101', entrance: 1, aptId: '018f0000-0000-7000-8000-000000000301' },
    { userId: '018f0000-0000-7000-8000-000000000105', entrance: 1, aptId: '018f0000-0000-7000-8000-000000000302' },
    { userId: '018f0000-0000-7000-8000-000000000104', entrance: 1, aptId: '018f0000-0000-7000-8000-000000000302' },
    { userId: '018f0000-0000-7000-8000-000000000102', entrance: 2, aptId: '018f0000-0000-7000-8000-000000000314' },
  ];
  for (const u of userApts) {
    if (!notice.target_scope || notice.target_scope === 'ALL_BUILDING') {
      recipients.add(u.userId);
    } else if (notice.target_scope === 'ENTRANCE' && Number(notice.target_entrance) === u.entrance) {
      recipients.add(u.userId);
    } else if (
      notice.target_scope === 'APARTMENT_LIST' &&
      Array.isArray(notice.target_apartment_ids) &&
      notice.target_apartment_ids.includes(u.aptId)
    ) {
      recipients.add(u.userId);
    }
  }
  if (authorUserId) {
    recipients.delete(authorUserId);
  }
  return Array.from(recipients);
}

function dispatchServerMaintenanceAndNoticeNotifications(notif: {
  event_type: MockNotification['event_type'];
  subject_type: MockNotification['subject_type'];
  subject_id: string;
  params?: any;
  target_scope?: string | null;
  target_entrance?: number | null;
  target_apartment_ids?: string[] | null;
  author_user_id?: string | null;
  created_at?: string;
}) {
  if (notif.event_type === 'MAINTENANCE_DUE') {
    const recipientUserIds = ['018f0000-0000-7000-8000-000000000101', '018f0000-0000-7000-8000-000000000105'];
    emitServerIssueNotificationBatch({
      recipientUserIds,
      event_type: 'MAINTENANCE_DUE',
      subject_type: 'maintenance_task',
      subject_id: notif.subject_id,
      params: notif.params || {},
      created_at: notif.created_at || new Date().toISOString(),
    });
  } else if (notif.event_type === 'NOTICE_PUBLISHED') {
    const recipientUserIds = getServerNoticeRecipientUserIds(notif, notif.author_user_id);
    emitServerIssueNotificationBatch({
      recipientUserIds,
      event_type: 'NOTICE_PUBLISHED',
      subject_type: 'post',
      subject_id: notif.subject_id,
      params: {},
      created_at: notif.created_at || new Date().toISOString(),
    });
  }
}

function emitServerIssueNotificationBatch(batch: {
  recipientUserIds: string[];
  event_type: MockNotification['event_type'];
  subject_type: MockNotification['subject_type'];
  subject_id: string;
  params: Record<string, unknown>;
  created_at: string;
}) {
  for (const uid of batch.recipientUserIds || []) {
    const prefs = getUserPreferences(uid);
    const inAppPref = prefs.find(
      (p) => p.event_type === batch.event_type && p.channel === 'in_app'
    );
    if (batch.event_type === 'ISSUE_URGENT' || !inAppPref || inAppPref.enabled) {
      getUserNotifications(uid).unshift({
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        user_id: uid,
        event_type: batch.event_type,
        subject_type: batch.subject_type,
        subject_id: batch.subject_id,
        params: { ...batch.params },
        created_at: batch.created_at,
        read_at: null,
      });
    }
  }
}

function emitApartmentThreadNotifications(
  postId: string,
  targetApartmentId: string,
  authorUser: SeedUser,
  createdAtIso: string
) {
  const aptNum = APARTMENT_ID_TO_NUMBER[targetApartmentId] || '14';
  const fromBoard = ['CHAIRMAN', 'BOARD'].includes(authorUser.building_role);

  for (const demoUser of DEMO_USERS) {
    if (demoUser.user_id === authorUser.user_id) continue;
    const userMems = membershipsByUser[demoUser.user_id] || [];
    const isResidentOfTarget = userMems.some((m) => m.apartment_id === targetApartmentId);
    const prefs = getUserPreferences(demoUser.user_id);

    if (isResidentOfTarget) {
      const inAppPref = prefs.find(
        (p) => p.event_type === 'APARTMENT_MESSAGE' && p.channel === 'in_app'
      );
      if (!inAppPref || inAppPref.enabled) {
        getUserNotifications(demoUser.user_id).unshift({
          id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
          user_id: demoUser.user_id,
          event_type: 'APARTMENT_MESSAGE',
          subject_type: 'post',
          subject_id: postId,
          params: {
            apartment_id: targetApartmentId,
            apartment_number: aptNum,
            from_board: fromBoard,
          },
          created_at: createdAtIso,
          read_at: null,
        });
      }
    } else if (!fromBoard && ['CHAIRMAN', 'BOARD'].includes(demoUser.building_role)) {
      const inAppPref = prefs.find(
        (p) => p.event_type === 'APARTMENT_MESSAGE_TO_BOARD' && p.channel === 'in_app'
      );
      if (!inAppPref || inAppPref.enabled) {
        getUserNotifications(demoUser.user_id).unshift({
          id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
          user_id: demoUser.user_id,
          event_type: 'APARTMENT_MESSAGE_TO_BOARD',
          subject_type: 'post',
          subject_id: postId,
          params: {
            apartment_id: targetApartmentId,
            apartment_number: aptNum,
            from_board: false,
          },
          created_at: createdAtIso,
          read_at: null,
        });
      }
    }
  }
}

interface MockBinding {
  binding_id: string;
  channel: 'in_app' | 'email' | 'telegram' | 'webpush';
  label: string | null;
  created_at: string;
}

const bindingsByUser: Record<string, MockBinding[]> = {};

function resolveAuthorBadge(
  userId: string,
  postType?: PostType,
  targetApartmentId?: string | null
): AuthorBadgeDTO {
  const user = DEMO_USERS.find((u) => u.user_id === userId) || DEMO_USERS[0];
  if (postType === 'APARTMENT_THREAD') {
    if (user.building_role === 'CHAIRMAN') {
      return { display_label: 'Chairman', role_badge: 'BOARD' };
    }
    if (user.building_role === 'BOARD') {
      return { display_label: 'Board', role_badge: 'BOARD' };
    }
  }
  if (postType === 'BOARD_TOPIC') {
    const boardFullNames: Record<string, string> = {
      '018f0000-0000-7000-8000-000000000101': 'Oleg Sidorov',
      '018f0000-0000-7000-8000-000000000105': 'Peeter Saar',
    };
    return {
      display_label: boardFullNames[userId] || user.full_name,
      role_badge: 'BOARD',
    };
  }
  const mems = membershipsByUser[userId] || [];
  const matchingMem =
    (targetApartmentId ? mems.find((m) => m.apartment_id === targetApartmentId) : null) ||
    mems[0] ||
    null;
  const mode = matchingMem?.privacy_display_mode || 'FULL_NAME';
  return computePreviewBadge(user, matchingMem?.apartment_number || null, mode);
}

// Stateful demo auth session state for testing Epic E7 scenarios 1-9 & A4/A5
let pendingMagicLinkEmail = 'ivan.petrov@demo.invalid';
let magicLinkTokenUsed = false;
let activeSignedInUserId: string | null = null;
let activeSessionsStore: {
  session_id: string;
  device_kind: 'DESKTOP_BROWSER' | 'MOBILE_BROWSER' | 'UNKNOWN';
  auth_method: 'MAGIC_LINK' | 'PASSWORD' | 'INVITATION' | 'PASSKEY';
  authenticated_at: string;
  last_used_at: string;
  current: boolean;
}[] = [];

// Seeded passwords per user (A5)
const passwordsByUser: Record<string, string | null> = {
  '018f0000-0000-7000-8000-000000000101': 'demo-password-ok',
  '018f0000-0000-7000-8000-000000000102': 'demo-password-ok',
  '018f0000-0000-7000-8000-000000000103': null,
};
let passwordLoginFailures = 0;

interface MockPersonMembership {
  membership_id: string;
  apartment_id: string;
  apartment_number: string;
  relation_type: 'OWNER' | 'TENANT';
  display_label: string;
  invited_email: string | null;
  invited_by_user_id: string | null;
  since: string;
}

interface MockPersonSummary {
  user_id: string;
  display_label: string;
  building_role: 'CHAIRMAN' | 'BOARD' | 'ACCOUNTANT' | 'USER';
  invited_email: string | null;
  invited_by_user_id: string | null;
  memberships: MockPersonMembership[];
}

interface MockInvitation {
  invitation_id: string;
  kind: 'OWNER' | 'TENANT' | 'STAFF';
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'NO_LONGER_VALID';
  masked_email: string;
  raw_email: string;
  invited_by_user_id: string;
  apartment_id: string | null;
  apartment_number: string | null;
  building_role: 'CHAIRMAN' | 'BOARD' | 'ACCOUNTANT' | null;
  created_at: string;
  expires_at: string;
}

const APARTMENT_ID_TO_NUMBER: Record<string, string> = {
  '018f0000-0000-7000-8000-000000000201': '01',
  '018f0000-0000-7000-8000-000000000301': '01',
  '018f0000-0000-7000-8000-000000000202': '02',
  '018f0000-0000-7000-8000-000000000302': '02',
  '018f0000-0000-7000-8000-000000000205': '05',
  '018f0000-0000-7000-8000-000000000305': '05',
  '018f0000-0000-7000-8000-000000000209': '09',
  '018f0000-0000-7000-8000-000000000309': '09',
  '018f0000-0000-7000-8000-000000000214': '14',
  '018f0000-0000-7000-8000-000000000314': '14',
  '018f0000-0000-7000-8000-000000000215': '15',
  '018f0000-0000-7000-8000-000000000315': '15',
};

const NUMBER_TO_APARTMENT_ID: Record<string, string> = {
  '01': '018f0000-0000-7000-8000-000000000301',
  '02': '018f0000-0000-7000-8000-000000000302',
  '05': '018f0000-0000-7000-8000-000000000305',
  '09': '018f0000-0000-7000-8000-000000000309',
  '14': '018f0000-0000-7000-8000-000000000314',
  '15': '018f0000-0000-7000-8000-000000000315',
};

let buildingUsersStore: MockPersonSummary[] = [
  {
    user_id: '018f0000-0000-7000-8000-000000000101',
    display_label: 'Oleg Sidorov (Apt. 01)',
    building_role: 'CHAIRMAN',
    invited_email: null,
    invited_by_user_id: null,
    memberships: [
      {
        membership_id: '018f0000-0000-7000-8000-000000000201',
        apartment_id: '018f0000-0000-7000-8000-000000000301',
        apartment_number: '01',
        relation_type: 'OWNER',
        display_label: 'Oleg Sidorov (Apt. 01)',
        invited_email: null,
        invited_by_user_id: null,
        since: '2021-03-10T10:00:00Z',
      },
    ],
  },
  {
    user_id: '018f0000-0000-7000-8000-000000000102',
    display_label: 'I. P. (Apt. 14)',
    building_role: 'USER',
    invited_email: null,
    invited_by_user_id: '018f0000-0000-7000-8000-000000000101',
    memberships: [
      {
        membership_id: '018f0000-0000-7000-8000-000000000214',
        apartment_id: '018f0000-0000-7000-8000-000000000314',
        apartment_number: '14',
        relation_type: 'OWNER',
        display_label: 'I. P. (Apt. 14)',
        invited_email: 'ivan.petrov@demo.invalid',
        invited_by_user_id: '018f0000-0000-7000-8000-000000000101',
        since: '2022-01-12T10:00:00Z',
      },
      {
        membership_id: '018f0000-0000-7000-8000-000000000215',
        apartment_id: '018f0000-0000-7000-8000-000000000315',
        apartment_number: '15',
        relation_type: 'TENANT',
        display_label: 'Apt. 15',
        invited_email: 'i***@demo.invalid',
        invited_by_user_id: '018f0000-0000-7000-8000-000000000105',
        since: '2025-05-01T10:00:00Z',
      },
    ],
  },
  {
    user_id: '018f0000-0000-7000-8000-000000000104',
    display_label: 'M. T. (Apt. 14)',
    building_role: 'USER',
    invited_email: null,
    invited_by_user_id: '018f0000-0000-7000-8000-000000000102',
    memberships: [
      {
        membership_id: '018f0000-0000-7000-8000-000000000399',
        apartment_id: '018f0000-0000-7000-8000-000000000314',
        apartment_number: '14',
        relation_type: 'TENANT',
        display_label: 'M. T. (Apt. 14)',
        invited_email: 'martin.tenant@demo.invalid',
        invited_by_user_id: '018f0000-0000-7000-8000-000000000102',
        since: '2025-09-03T10:00:00Z',
      },
    ],
  },
  {
    user_id: '018f0000-0000-7000-8000-000000000105',
    display_label: 'P. S. (Apt. 15)',
    building_role: 'BOARD',
    invited_email: 'priit.saar@demo.invalid',
    invited_by_user_id: '018f0000-0000-7000-8000-000000000101',
    memberships: [
      {
        membership_id: '018f0000-0000-7000-8000-000000000388',
        apartment_id: '018f0000-0000-7000-8000-000000000315',
        apartment_number: '15',
        relation_type: 'OWNER',
        display_label: 'P. S. (Apt. 15)',
        invited_email: 'priit.saar@demo.invalid',
        invited_by_user_id: '018f0000-0000-7000-8000-000000000101',
        since: '2022-05-18T10:00:00Z',
      },
    ],
  },
  {
    user_id: '018f0000-0000-7000-8000-000000000103',
    display_label: 'Anna Kask (Accountant)',
    building_role: 'ACCOUNTANT',
    invited_email: 'anna.kask@demo.invalid',
    invited_by_user_id: '018f0000-0000-7000-8000-000000000101',
    memberships: [],
  },
];

let buildingInvitationsStore: MockInvitation[] = [
  {
    invitation_id: '018f0000-0000-7000-8000-000000008301',
    kind: 'TENANT',
    status: 'PENDING',
    masked_email: 'n***@demo.invalid',
    raw_email: 'new.tenant@demo.invalid',
    invited_by_user_id: '018f0000-0000-7000-8000-000000000102',
    apartment_id: '018f0000-0000-7000-8000-000000000314',
    apartment_number: '14',
    building_role: null,
    created_at: '2026-10-30T10:00:00Z',
    expires_at: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
  },
  {
    invitation_id: '018f0000-0000-7000-8000-000000008302',
    kind: 'OWNER',
    status: 'PENDING',
    masked_email: 't***@demo.invalid',
    raw_email: 'tonu.owner@demo.invalid',
    invited_by_user_id: '018f0000-0000-7000-8000-000000000101',
    apartment_id: '018f0000-0000-7000-8000-000000000305',
    apartment_number: '05',
    building_role: null,
    created_at: '2026-10-29T12:00:00Z',
    expires_at: new Date(Date.now() + 6 * 86400 * 1000).toISOString(),
  },
  {
    invitation_id: '018f0000-0000-7000-8000-000000008303',
    kind: 'STAFF',
    status: 'PENDING',
    masked_email: 'j***@demo.invalid',
    raw_email: 'jaan.board@demo.invalid',
    invited_by_user_id: '018f0000-0000-7000-8000-000000000101',
    apartment_id: null,
    apartment_number: null,
    building_role: 'BOARD',
    created_at: '2026-10-28T09:30:00Z',
    expires_at: new Date(Date.now() + 4 * 86400 * 1000).toISOString(),
  },
  {
    invitation_id: '018f0000-0000-7000-8000-000000008304',
    kind: 'TENANT',
    status: 'ACCEPTED',
    masked_email: 'm***@demo.invalid',
    raw_email: 'martin.tenant@demo.invalid',
    invited_by_user_id: '018f0000-0000-7000-8000-000000000102',
    apartment_id: '018f0000-0000-7000-8000-000000000314',
    apartment_number: '14',
    building_role: null,
    created_at: '2025-09-03T10:00:00Z',
    expires_at: '2025-09-10T10:00:00Z',
  },
  {
    invitation_id: '018f0000-0000-7000-8000-000000008305',
    kind: 'OWNER',
    status: 'EXPIRED',
    masked_email: 'r***@demo.invalid',
    raw_email: 'riina.expired@demo.invalid',
    invited_by_user_id: '018f0000-0000-7000-8000-000000000101',
    apartment_id: '018f0000-0000-7000-8000-000000000309',
    apartment_number: '09',
    building_role: null,
    created_at: '2026-08-11T10:00:00Z',
    expires_at: '2026-08-18T10:00:00Z',
  },
  {
    invitation_id: '018f0000-0000-7000-8000-000000008306',
    kind: 'TENANT',
    status: 'NO_LONGER_VALID',
    masked_email: 'v***@demo.invalid',
    raw_email: 'veiko.orphaned@demo.invalid',
    invited_by_user_id: '018f0000-0000-7000-8000-000000000199',
    apartment_id: '018f0000-0000-7000-8000-000000000322',
    apartment_number: '22',
    building_role: null,
    created_at: '2026-07-04T10:00:00Z',
    expires_at: '2026-07-11T10:00:00Z',
  },
];

function maskEmailServerSide(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const atIdx = trimmed.indexOf('@');
  if (atIdx <= 0) return 'u***@demo.invalid';
  return `${trimmed[0]}***@${trimmed.slice(atIdx + 1)}`;
}

function toInvitationView(inv: MockInvitation, viewerUserId?: string) {
  const mine = viewerUserId ? inv.invited_by_user_id === viewerUserId : true;
  return {
    invitation_id: inv.invitation_id,
    kind: inv.kind,
    email: mine ? inv.raw_email : inv.masked_email,
    apartment_id: inv.apartment_id,
    apartment_number: inv.apartment_number,
    building_role: inv.building_role,
    status: inv.status,
    mine,
    created_at: inv.created_at,
    expires_at: inv.expires_at,
  };
}

function isValidEmailFormat(email: string): boolean {
  const trimmed = String(email || '').trim();
  if (!trimmed || trimmed.length > 254) return false;
  const atIndex = trimmed.indexOf('@');
  if (atIndex <= 0) return false;
  const domain = trimmed.slice(atIndex + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

function resolveEmailToDemoUserId(email: string): string {
  const lower = email.toLowerCase().trim();
  if (lower.startsWith('oleg.sidorov') || lower.startsWith('peeter.') || lower.includes('chairman')) {
    return '018f0000-0000-7000-8000-000000000101'; // Chairman / Board
  }
  if (lower.startsWith('anna.kask') || lower.startsWith('marika.') || lower.includes('accountant')) {
    return '018f0000-0000-7000-8000-000000000103'; // Accountant
  }
  return '018f0000-0000-7000-8000-000000000102'; // Owner Apt 14
}

function getBearerAuthenticatedUser(req: IncomingMessage): SeedUser | null {
  const authHeader = String(req.headers['authorization'] || '');
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (token.startsWith('mock-jwt-')) {
    const uid = token.replace('mock-jwt-', '');
    const found = DEMO_USERS.find((u) => u.user_id === uid);
    if (found) return found;
  }
  if (activeSignedInUserId) {
    const signedInUser = DEMO_USERS.find((u) => u.user_id === activeSignedInUserId);
    if (signedInUser) return signedInUser;
  }
  return DEMO_USERS[0];
}

function getActingUser(req: IncomingMessage): SeedUser {
  const bearerUser = getBearerAuthenticatedUser(req);
  if (bearerUser) return bearerUser;
  const headerId = req.headers['x-demo-user-id'] as string | undefined;
  return DEMO_USERS.find((u) => u.user_id === headerId) || DEMO_USERS[0];
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Trace-Id', traceId);
  res.end(JSON.stringify(data));
}

function sendError(
  res: ServerResponse,
  status: number,
  errorCode: string,
  message: string,
  extra: Record<string, unknown> = {}
) {
  const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Trace-Id', traceId);
  res.end(
    JSON.stringify({
      error_code: errorCode,
      message,
      trace_id: traceId,
      ...extra,
    })
  );
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

function getNextTwoSaturdays(): [string, string] {
  const now = new Date();
  const day = now.getUTCDay();
  const daysToNextSat = ((6 - day + 7) % 7) || 7;
  const sat1 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToNextSat));
  const sat2 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToNextSat + 7));
  return [sat1.toISOString().slice(0, 10), sat2.toISOString().slice(0, 10)];
}

const [SEED_SAT_1, SEED_SAT_2] = getNextTwoSaturdays();

interface InternalPollOption {
  id: string;
  position: number;
  value: string;
}

interface InternalPollQuestion {
  id: string;
  position: number;
  text: string;
  prompt: string;
  answer_mode: 'SINGLE_CHOICE' | 'MULTIPLE_CHOICE' | 'OWN_VALUE';
  value_type: 'TEXT' | 'NUMBER' | 'DATE';
  required: boolean;
  min_choices: number | null;
  max_choices: number | null;
  min_value: string | null;
  max_value: string | null;
  options: InternalPollOption[];
}

interface InternalPollAnswer {
  question_id: string;
  option_ids: string[];
  value: string | null;
}

interface InternalPollBallot {
  apartment_id: string | null;
  user_id: string | null;
  submitted_at: string;
  updated_at: string;
  answers: InternalPollAnswer[];
}

interface InternalPoll {
  id: string;
  kind: 'INFORMATIVE';
  title: string;
  description: string;
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'CANCELLED';
  target_scope: TargetScope;
  target_entrance: number | null;
  target_apartment_ids: string[] | null;
  eligibility: 'RESIDENTS' | 'OWNERS';
  unit: 'APARTMENT' | 'PERSON';
  closes_at: string;
  opened_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  questions: InternalPollQuestion[];
  ballots: InternalPollBallot[];
}

const pollsStore: InternalPoll[] = [
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
            value: SEED_SAT_1,
          },
          {
            id: '018f0000-0000-7000-8000-000000000872',
            position: 2,
            value: SEED_SAT_2,
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
    description:
      'Completed resident poll on stairwell lighting warmth and night dimming hours.',
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
    description:
      'Cancelled due to scheduled facade inspection scaffolding in the courtyard.',
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
];

function refreshExpiredPolls() {
  const nowMs = Date.now();
  for (const p of pollsStore) {
    if (p.status === 'OPEN' && new Date(p.closes_at).getTime() <= nowMs) {
      p.status = 'CLOSED';
      p.closed_at = p.closes_at;
    }
  }
}

function isApartmentTargetedByPoll(poll: InternalPoll, aptId: string, entrance: number): boolean {
  if (poll.target_scope === 'ALL_BUILDING') return true;
  if (poll.target_scope === 'ENTRANCE') return poll.target_entrance === entrance;
  if (poll.target_scope === 'APARTMENT_LIST') {
    return Array.isArray(poll.target_apartment_ids) && poll.target_apartment_ids.includes(aptId);
  }
  return true;
}

function isPollVisibleToUser(poll: InternalPoll, user: SeedUser): boolean {
  const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role);
  if (poll.status === 'DRAFT') {
    return isBoardUser;
  }
  if (isBoardUser || user.building_role === 'ACCOUNTANT') {
    return true;
  }
  const mems = membershipsByUser[user.user_id] || [];
  return mems.some((m) => isApartmentTargetedByPoll(poll, m.apartment_id, m.entrance));
}

function computePollAnswerability(poll: InternalPoll, user: SeedUser): {
  canAnswer: boolean;
  answerableApartmentIds: string[];
} {
  if (poll.status !== 'OPEN' || new Date(poll.closes_at).getTime() <= Date.now()) {
    return { canAnswer: false, answerableApartmentIds: [] };
  }
  const mems = membershipsByUser[user.user_id] || [];
  const qualifying = mems.filter((m) => {
    if (!isApartmentTargetedByPoll(poll, m.apartment_id, m.entrance)) return false;
    if (poll.eligibility === 'OWNERS' && m.relation_type !== 'OWNER') return false;
    return true;
  });

  if (poll.unit === 'PERSON') {
    return {
      canAnswer: qualifying.length > 0,
      answerableApartmentIds: [],
    };
  }

  const sortedAptIds = qualifying
    .slice()
    .sort((a, b) => a.apartment_number.localeCompare(b.apartment_number))
    .map((m) => m.apartment_id);

  return {
    canAnswer: sortedAptIds.length > 0,
    answerableApartmentIds: sortedAptIds,
  };
}

function computeMyBallots(poll: InternalPoll, user: SeedUser) {
  if (poll.status === 'CANCELLED') return [];
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
      }));
  }

  const mems = membershipsByUser[user.user_id] || [];
  const visibleAptIds = mems
    .filter((m) => {
      if (!isApartmentTargetedByPoll(poll, m.apartment_id, m.entrance)) return false;
      if (poll.eligibility === 'OWNERS' && m.relation_type !== 'OWNER') return false;
      return true;
    })
    .map((m) => m.apartment_id);

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
    }));
}

function comparePollsOrder(a: InternalPoll, b: InternalPoll): number {
  const aOpen = a.status === 'OPEN' ? 0 : 1;
  const bOpen = b.status === 'OPEN' ? 0 : 1;
  if (aOpen !== bOpen) return aOpen - bOpen;
  if (a.status === 'OPEN' && b.status === 'OPEN') {
    return new Date(a.closes_at).getTime() - new Date(b.closes_at).getTime();
  }
  const aRef = a.opened_at || a.created_at;
  const bRef = b.opened_at || b.created_at;
  return new Date(bRef).getTime() - new Date(aRef).getTime();
}

function toPollSummary(poll: InternalPoll, user: SeedUser) {
  const { canAnswer, answerableApartmentIds } = computePollAnswerability(poll, user);
  const myBallots = computeMyBallots(poll, user);
  const answered =
    poll.status === 'CANCELLED'
      ? false
      : poll.unit === 'APARTMENT' && answerableApartmentIds.length > 0
        ? answerableApartmentIds.every((id) => myBallots.some((b) => b.apartment_id === id))
        : myBallots.length > 0;
  const isBoardUser = ['CHAIRMAN', 'BOARD'].includes(user.building_role);
  const resultsAvailable =
    poll.status === 'CLOSED' || (poll.status === 'OPEN' && isBoardUser);

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
  };
}

function toPollView(poll: InternalPoll, user: SeedUser) {
  const summary = toPollSummary(poll, user);
  const { answered, ...rest } = summary;
  return {
    ...rest,
    questions: poll.questions.map((q) => ({
      id: q.id,
      position: q.position,
      text: q.text || q.prompt,
      prompt: q.text || q.prompt,
      answer_mode: q.answer_mode,
      value_type: q.value_type,
      required: q.required,
      min_choices: q.min_choices,
      max_choices: q.max_choices,
      min_value: q.min_value,
      max_value: q.max_value,
      options: q.options.map((o) => ({ ...o })),
    })),
    my_ballots: computeMyBallots(poll, user),
  };
}

const KNOWN_APARTMENT_ENTRANCES: Record<string, number> = {
  '018f0000-0000-7000-8000-000000000301': 1,
  '018f0000-0000-7000-8000-000000000302': 1,
  '018f0000-0000-7000-8000-000000000305': 1,
  '018f0000-0000-7000-8000-000000000309': 2,
  '018f0000-0000-7000-8000-000000000314': 2,
  '018f0000-0000-7000-8000-000000000315': 2,
};

function computePollElectorateCount(poll: InternalPoll): number {
  const targetedAptIds = Object.entries(KNOWN_APARTMENT_ENTRANCES)
    .filter(([aptId, ent]) => isApartmentTargetedByPoll(poll, aptId, ent))
    .map(([aptId]) => aptId);

  if (poll.unit === 'APARTMENT') {
    let eligibleApartments = 0;
    for (const aptId of targetedAptIds) {
      if (aptId === '018f0000-0000-7000-8000-000000000305') continue; // Empty apartment
      if (aptId === '018f0000-0000-7000-8000-000000000302') {
        if (poll.eligibility !== 'OWNERS') eligibleApartments += 1;
        continue;
      }
      eligibleApartments += 1;
    }
    return eligibleApartments;
  }

  // PERSON unit: count distinct users with a qualifying membership in targeted apartments
  const eligibleUsers = new Set<string>();
  for (const [uid, mems] of Object.entries(membershipsByUser)) {
    const qualifies = mems.some((m) => {
      if (!targetedAptIds.includes(m.apartment_id)) return false;
      if (poll.eligibility === 'OWNERS' && m.relation_type !== 'OWNER') return false;
      return true;
    });
    if (qualifies) eligibleUsers.add(uid);
  }
  return eligibleUsers.size;
}

function computeServerNumberStats(values: string[]) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const SCALE = 1000000n;
  const parsed: { canonical: string; scaled: bigint }[] = [];

  for (const raw of values) {
    const canonical = normalizeServerDecimal(String(raw ?? ''));
    if (!canonical || !/^-?\d+(\.\d+)?$/.test(canonical)) continue;
    const neg = canonical.startsWith('-');
    const unsigned = neg ? canonical.slice(1) : canonical;
    const [intPart, fracPart = ''] = unsigned.split('.');
    const paddedFrac = (fracPart + '000000').slice(0, 6);
    const mag = BigInt(intPart) * SCALE + BigInt(paddedFrac);
    parsed.push({ canonical, scaled: neg ? -mag : mag });
  }

  if (parsed.length === 0) return null;

  let minEntry = parsed[0];
  let maxEntry = parsed[0];
  let sumScaled = 0n;

  for (const item of parsed) {
    if (item.scaled < minEntry.scaled) minEntry = item;
    if (item.scaled > maxEntry.scaled) maxEntry = item;
    sumScaled += item.scaled;
  }

  const count = BigInt(parsed.length);
  const negAvg = sumScaled < 0n;
  const absSum = negAvg ? -sumScaled : sumScaled;
  let quotient = absSum / count;
  const remainder = absSum % count;
  const twiceRemainder = remainder * 2n;

  if (twiceRemainder > count) {
    quotient += 1n;
  } else if (twiceRemainder === count && quotient % 2n === 1n) {
    quotient += 1n;
  }

  const avgSigned = negAvg ? -quotient : quotient;
  const isNegOut = avgSigned < 0n;
  const absOut = isNegOut ? -avgSigned : avgSigned;
  const intOut = absOut / SCALE;
  const fracOut = (absOut % SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  const avgStr =
    intOut === 0n && !fracOut
      ? '0'
      : `${isNegOut ? '-' : ''}${intOut.toString()}${fracOut ? `.${fracOut}` : ''}`;

  return {
    min: minEntry.canonical,
    max: maxEntry.canonical,
    average: avgStr,
  };
}

function computeServerPollResults(poll: InternalPoll, isBoardUser: boolean) {
  const electorate = computePollElectorateCount(poll);
  const answeredUnits = poll.ballots.length;

  const questions = poll.questions.map((q) => {
    let qAnswered = 0;

    if (q.answer_mode === 'SINGLE_CHOICE' || q.answer_mode === 'MULTIPLE_CHOICE') {
      const countsByOption = new Map<string, number>();
      for (const opt of q.options) {
        countsByOption.set(opt.id, 0);
      }
      for (const ballot of poll.ballots) {
        const ans = ballot.answers.find((a) => a.question_id === q.id);
        if (ans && Array.isArray(ans.option_ids) && ans.option_ids.length > 0) {
          qAnswered += 1;
          for (const oid of ans.option_ids) {
            if (countsByOption.has(oid)) {
              countsByOption.set(oid, (countsByOption.get(oid) || 0) + 1);
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
      };
    }

    const rawValues: string[] = [];
    for (const ballot of poll.ballots) {
      const ans = ballot.answers.find((a) => a.question_id === q.id);
      const val = ans?.value != null ? String(ans.value).trim() : '';
      if (val !== '') {
        qAnswered += 1;
        rawValues.push(val);
      }
    }

    if (q.value_type === 'NUMBER') {
      return {
        question_id: q.id,
        answered: qAnswered,
        options: null,
        number: computeServerNumberStats(rawValues),
        dates: null,
        texts: null,
      };
    }

    if (q.value_type === 'DATE') {
      const dateCounts = new Map<string, number>();
      for (const v of rawValues) {
        dateCounts.set(v, (dateCounts.get(v) || 0) + 1);
      }
      const dates = Array.from(dateCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }));
      return {
        question_id: q.id,
        answered: qAnswered,
        options: null,
        number: null,
        dates,
        texts: null,
      };
    }

    // OWN_VALUE TEXT
    let texts: { value: string; count: number }[] | null = null;
    if (isBoardUser) {
      const textCounts = new Map<string, number>();
      for (const v of rawValues) {
        textCounts.set(v, (textCounts.get(v) || 0) + 1);
      }
      texts = Array.from(textCounts.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count }));
    }

    return {
      question_id: q.id,
      answered: qAnswered,
      options: null,
      number: null,
      dates: null,
      texts,
    };
  });

  return {
    poll_id: poll.id,
    status: poll.status,
    unit: poll.unit,
    participation: {
      answered: answeredUnits,
      electorate,
    },
    questions,
  };
}

function validateAndBuildServerPollDraft(body: any): {
  errorStatus?: number;
  errorCode?: string;
  errorMessage?: string;
  errorExtra?: Record<string, unknown>;
  draft?: Omit<
    InternalPoll,
    'id' | 'status' | 'opened_at' | 'closed_at' | 'cancelled_at' | 'created_at' | 'ballots'
  >;
} {
  const title = typeof body?.title === 'string' ? body.title.trim() : '';
  if (!title || title.length > 255) {
    return {
      errorStatus: 422,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'Title is required (1..255 characters).',
      errorExtra: { errors: [{ field: 'title', message: 'Title must be 1..255 characters.' }] },
    };
  }
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  if (description.length > 5000) {
    return {
      errorStatus: 422,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'Description is too long.',
      errorExtra: {
        errors: [{ field: 'description', message: 'Description must be at most 5000 characters.' }],
      },
    };
  }

  const targetScope = body?.target_scope as TargetScope;
  if (!['ALL_BUILDING', 'ENTRANCE', 'APARTMENT_LIST'].includes(targetScope)) {
    return {
      errorStatus: 422,
      errorCode: 'INVALID_TARGET',
      errorMessage: 'Invalid target_scope.',
    };
  }

  let targetEntrance: number | null = null;
  let targetApartmentIds: string[] | null = null;

  if (targetScope === 'ALL_BUILDING') {
    if (body.target_entrance != null || (Array.isArray(body.target_apartment_ids) && body.target_apartment_ids.length > 0)) {
      return {
        errorStatus: 422,
        errorCode: 'INVALID_TARGET',
        errorMessage: 'target_entrance and target_apartment_ids must be null for ALL_BUILDING.',
      };
    }
  } else if (targetScope === 'ENTRANCE') {
    const ent = Number(body.target_entrance);
    if (!Number.isInteger(ent) || ![1, 2].includes(ent) || body.target_apartment_ids != null) {
      return {
        errorStatus: 422,
        errorCode: 'INVALID_TARGET',
        errorMessage: 'Valid target_entrance is required for ENTRANCE scope.',
      };
    }
    targetEntrance = ent;
  } else if (targetScope === 'APARTMENT_LIST') {
    if (
      body.target_entrance != null ||
      !Array.isArray(body.target_apartment_ids) ||
      body.target_apartment_ids.length === 0
    ) {
      return {
        errorStatus: 422,
        errorCode: 'INVALID_TARGET',
        errorMessage: 'Non-empty target_apartment_ids is required for APARTMENT_LIST scope.',
      };
    }
    const deduped: string[] = Array.from(
      new Set<string>(body.target_apartment_ids.map((id: any) => String(id)))
    );
    for (const aptId of deduped) {
      if (!KNOWN_APARTMENT_ENTRANCES[aptId]) {
        return {
          errorStatus: 422,
          errorCode: 'INVALID_TARGET',
          errorMessage: 'Unknown apartment in target_apartment_ids.',
        };
      }
    }
    targetApartmentIds = deduped;
  }

  const eligibility = body?.eligibility;
  if (!['RESIDENTS', 'OWNERS'].includes(eligibility)) {
    return {
      errorStatus: 422,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'Invalid eligibility.',
    };
  }

  const unit = body?.unit;
  if (!['APARTMENT', 'PERSON'].includes(unit)) {
    return {
      errorStatus: 422,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'Invalid unit.',
    };
  }

  const closesAt = typeof body?.closes_at === 'string' ? body.closes_at.trim() : '';
  if (!closesAt || Number.isNaN(new Date(closesAt).getTime())) {
    return {
      errorStatus: 422,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'Valid closes_at timestamp is required.',
    };
  }

  const rawQuestions = Array.isArray(body?.questions) ? body.questions : [];
  if (rawQuestions.length < 1 || rawQuestions.length > 20) {
    return {
      errorStatus: 422,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'A poll must have between 1 and 20 questions.',
      errorExtra: {
        errors: [{ field: 'questions', message: 'Must contain 1..20 questions.' }],
      },
    };
  }

  const builtQuestions: InternalPollQuestion[] = [];
  for (let i = 0; i < rawQuestions.length; i += 1) {
    const rq = rawQuestions[i] || {};
    const qText = String(rq.text ?? rq.prompt ?? '').trim();
    if (!qText || qText.length > 500) {
      return {
        errorStatus: 422,
        errorCode: 'VALIDATION_ERROR',
        errorMessage: `Question ${i + 1} text must be 1..500 characters.`,
        errorExtra: {
          errors: [{ field: `questions.${i}.text`, message: 'Question text is required.' }],
        },
      };
    }
    const mode = rq.answer_mode;
    const vType = rq.value_type;
    if (
      !['SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'OWN_VALUE'].includes(mode) ||
      !['TEXT', 'NUMBER', 'DATE'].includes(vType)
    ) {
      return {
        errorStatus: 422,
        errorCode: 'VALIDATION_ERROR',
        errorMessage: 'Invalid answer_mode or value_type.',
      };
    }

    const builtOptions: InternalPollOption[] = [];
    let minChoices: number | null = null;
    let maxChoices: number | null = null;
    let minValue: string | null = null;
    let maxValue: string | null = null;

    if (mode === 'SINGLE_CHOICE' || mode === 'MULTIPLE_CHOICE') {
      if (rq.min_value != null || rq.max_value != null) {
        return {
          errorStatus: 422,
          errorCode: 'VALIDATION_ERROR',
          errorMessage: 'min_value/max_value are only allowed for OWN_VALUE questions.',
        };
      }
      const rawOpts = Array.isArray(rq.options) ? rq.options : [];
      if (rawOpts.length < 2 || rawOpts.length > 20) {
        return {
          errorStatus: 422,
          errorCode: 'VALIDATION_ERROR',
          errorMessage: 'Choice questions require 2..20 options.',
          errorExtra: {
            errors: [{ field: `questions.${i}.options`, message: 'Provide 2..20 options.' }],
          },
        };
      }
      const canonicalSeen = new Set<string>();
      for (let oi = 0; oi < rawOpts.length; oi += 1) {
        const rawOpt = rawOpts[oi];
        const optStr = String(
          typeof rawOpt === 'object' && rawOpt !== null ? rawOpt.value ?? '' : rawOpt ?? ''
        ).trim();
        if (!optStr || optStr.length > 200) {
          return {
            errorStatus: 422,
            errorCode: 'VALIDATION_ERROR',
            errorMessage: 'Invalid option text.',
          };
        }
        let canonical = optStr;
        if (vType === 'NUMBER') {
          if (!/^-?\d+(\.\d+)?$/.test(optStr)) {
            return {
              errorStatus: 422,
              errorCode: 'VALIDATION_ERROR',
              errorMessage: 'Option must be a valid number.',
            };
          }
          canonical = normalizeServerDecimal(optStr);
        } else if (vType === 'DATE') {
          if (!isValidServerCalendarDate(optStr)) {
            return {
              errorStatus: 422,
              errorCode: 'VALIDATION_ERROR',
              errorMessage: 'Option must be a valid YYYY-MM-DD date.',
            };
          }
        }
        if (canonicalSeen.has(canonical)) {
          return {
            errorStatus: 422,
            errorCode: 'VALIDATION_ERROR',
            errorMessage: 'Options must be distinct.',
          };
        }
        canonicalSeen.add(canonical);
        builtOptions.push({
          id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
          position: oi + 1,
          value: canonical,
        });
      }

      if (mode === 'MULTIPLE_CHOICE') {
        const minC = rq.min_choices != null ? Number(rq.min_choices) : 1;
        const maxC = rq.max_choices != null ? Number(rq.max_choices) : builtOptions.length;
        if (
          !Number.isInteger(minC) ||
          !Number.isInteger(maxC) ||
          minC < 1 ||
          minC > maxC ||
          maxC > builtOptions.length
        ) {
          return {
            errorStatus: 422,
            errorCode: 'VALIDATION_ERROR',
            errorMessage: 'Invalid min_choices/max_choices.',
          };
        }
        minChoices = minC;
        maxChoices = maxC;
      } else if (rq.min_choices != null || rq.max_choices != null) {
        return {
          errorStatus: 422,
          errorCode: 'VALIDATION_ERROR',
          errorMessage: 'min_choices/max_choices are only allowed for MULTIPLE_CHOICE.',
        };
      }
    } else {
      if (Array.isArray(rq.options) && rq.options.length > 0) {
        return {
          errorStatus: 422,
          errorCode: 'VALIDATION_ERROR',
          errorMessage: 'OWN_VALUE questions cannot have options.',
        };
      }
      if (rq.min_choices != null || rq.max_choices != null) {
        return {
          errorStatus: 422,
          errorCode: 'VALIDATION_ERROR',
          errorMessage: 'OWN_VALUE questions cannot have min_choices/max_choices.',
        };
      }
      if (vType === 'TEXT') {
        if (rq.min_value != null || rq.max_value != null) {
          return {
            errorStatus: 422,
            errorCode: 'VALIDATION_ERROR',
            errorMessage: 'TEXT questions cannot have min_value/max_value.',
          };
        }
      } else if (vType === 'NUMBER') {
        if (rq.min_value != null && String(rq.min_value).trim() !== '') {
          const mv = String(rq.min_value).trim();
          if (!/^-?\d+(\.\d+)?$/.test(mv)) {
            return {
              errorStatus: 422,
              errorCode: 'VALIDATION_ERROR',
              errorMessage: 'Invalid min_value.',
            };
          }
          minValue = normalizeServerDecimal(mv);
        }
        if (rq.max_value != null && String(rq.max_value).trim() !== '') {
          const xv = String(rq.max_value).trim();
          if (!/^-?\d+(\.\d+)?$/.test(xv)) {
            return {
              errorStatus: 422,
              errorCode: 'VALIDATION_ERROR',
              errorMessage: 'Invalid max_value.',
            };
          }
          maxValue = normalizeServerDecimal(xv);
        }
        if (minValue != null && maxValue != null && compareServerDecimals(minValue, maxValue) > 0) {
          return {
            errorStatus: 422,
            errorCode: 'VALIDATION_ERROR',
            errorMessage: 'min_value must not exceed max_value.',
          };
        }
      } else if (vType === 'DATE') {
        if (rq.min_value != null && String(rq.min_value).trim() !== '') {
          const mv = String(rq.min_value).trim();
          if (!isValidServerCalendarDate(mv)) {
            return {
              errorStatus: 422,
              errorCode: 'VALIDATION_ERROR',
              errorMessage: 'Invalid min_value date.',
            };
          }
          minValue = mv;
        }
        if (rq.max_value != null && String(rq.max_value).trim() !== '') {
          const xv = String(rq.max_value).trim();
          if (!isValidServerCalendarDate(xv)) {
            return {
              errorStatus: 422,
              errorCode: 'VALIDATION_ERROR',
              errorMessage: 'Invalid max_value date.',
            };
          }
          maxValue = xv;
        }
        if (minValue != null && maxValue != null && minValue > maxValue) {
          return {
            errorStatus: 422,
            errorCode: 'VALIDATION_ERROR',
            errorMessage: 'min_value must not exceed max_value.',
          };
        }
      }
    }

    builtQuestions.push({
      id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
      position: i + 1,
      text: qText,
      prompt: qText,
      answer_mode: mode,
      value_type: vType,
      required: rq.required !== false,
      min_choices: minChoices,
      max_choices: maxChoices,
      min_value: minValue,
      max_value: maxValue,
      options: builtOptions,
    });
  }

  return {
    draft: {
      kind: 'INFORMATIVE',
      title,
      description,
      target_scope: targetScope,
      target_entrance: targetEntrance,
      target_apartment_ids: targetApartmentIds,
      eligibility,
      unit,
      closes_at: closesAt,
      questions: builtQuestions,
    },
  };
}

function compareServerDecimals(a: string, b: string): number {
  const parse = (raw: string) => {
    const t = raw.trim();
    const neg = t.startsWith('-');
    const unsigned = neg ? t.slice(1) : t;
    const [ip, fp = ''] = unsigned.split('.');
    return { neg, intStr: ip.replace(/^0+(?=\d)/, '') || '0', fracStr: fp.replace(/0+$/, '') };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa.intStr === '0' && pa.fracStr === '') pa.neg = false;
  if (pb.intStr === '0' && pb.fracStr === '') pb.neg = false;
  const maxScale = Math.max(pa.fracStr.length, pb.fracStr.length);
  const bigA =
    BigInt(pa.intStr + pa.fracStr.padEnd(maxScale, '0')) * (pa.neg ? -1n : 1n);
  const bigB =
    BigInt(pb.intStr + pb.fracStr.padEnd(maxScale, '0')) * (pb.neg ? -1n : 1n);
  if (bigA < bigB) return -1;
  if (bigA > bigB) return 1;
  return 0;
}

function isValidServerCalendarDate(raw: string): boolean {
  const s = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
  );
}

function emitPollOpenedNotifications(
  poll: InternalPoll,
  openerUser: SeedUser,
  createdAtIso: string
) {
  for (const demoUser of DEMO_USERS) {
    if (demoUser.user_id === openerUser.user_id) continue;
    const { canAnswer } = computePollAnswerability(poll, demoUser);
    if (!canAnswer) continue;

    const prefs = getUserPreferences(demoUser.user_id);
    const inAppPref = prefs.find(
      (p) => p.event_type === 'POLL_OPENED' && p.channel === 'in_app'
    );
    if (!inAppPref || inAppPref.enabled) {
      getUserNotifications(demoUser.user_id).unshift({
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        user_id: demoUser.user_id,
        event_type: 'POLL_OPENED',
        subject_type: 'poll',
        subject_id: poll.id,
        params: {
          closes_at: poll.closes_at,
        },
        created_at: createdAtIso,
        read_at: null,
      });
    }
  }
}

function normalizeServerDecimal(raw: string): string {
  const t = raw.trim();
  const neg = t.startsWith('-');
  const unsigned = neg ? t.slice(1) : t;
  const [ip, fp = ''] = unsigned.split('.');
  const cleanInt = ip.replace(/^0+(?=\d)/, '') || '0';
  const cleanFrac = fp.replace(/0+$/, '');
  if (cleanInt === '0' && cleanFrac === '') return '0';
  return `${neg ? '-' : ''}${cleanInt}${cleanFrac ? `.${cleanFrac}` : ''}`;
}

function validateIncomingBallotAnswers(
  questions: InternalPollQuestion[],
  rawAnswers: any[]
): {
  valid: boolean;
  questionId?: string;
  reason?: string;
  normalizedAnswers: InternalPollAnswer[];
} {
  const seenQuestions = new Set<string>();
  const byQuestionId = new Map<string, any>();

  for (const item of rawAnswers) {
    const qId = String(item?.question_id || '');
    if (seenQuestions.has(qId)) {
      return { valid: false, questionId: qId, reason: 'DUPLICATE', normalizedAnswers: [] };
    }
    const qDef = questions.find((q) => q.id === qId);
    if (!qDef) {
      return { valid: false, questionId: qId, reason: 'UNKNOWN_QUESTION', normalizedAnswers: [] };
    }
    seenQuestions.add(qId);
    byQuestionId.set(qId, item);
  }

  const normalizedAnswers: InternalPollAnswer[] = [];

  for (const q of questions) {
    const item = byQuestionId.get(q.id);
    const optIds: string[] = Array.isArray(item?.option_ids)
      ? item.option_ids.map((id: any) => String(id))
      : [];
    const rawValue = item?.value != null ? String(item.value) : '';

    if (q.answer_mode === 'SINGLE_CHOICE') {
      if (rawValue !== '') {
        return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] };
      }
      if (optIds.length === 0) {
        if (q.required) {
          return { valid: false, questionId: q.id, reason: 'REQUIRED', normalizedAnswers: [] };
        }
        continue;
      }
      if (optIds.length !== 1) {
        return { valid: false, questionId: q.id, reason: 'CHOICES', normalizedAnswers: [] };
      }
      const validIds = new Set(q.options.map((o) => o.id));
      if (!validIds.has(optIds[0])) {
        return { valid: false, questionId: q.id, reason: 'UNKNOWN_OPTION', normalizedAnswers: [] };
      }
      normalizedAnswers.push({
        question_id: q.id,
        option_ids: [optIds[0]],
        value: null,
      });
    } else if (q.answer_mode === 'MULTIPLE_CHOICE') {
      if (rawValue !== '') {
        return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] };
      }
      if (optIds.length === 0) {
        if (q.required) {
          return { valid: false, questionId: q.id, reason: 'REQUIRED', normalizedAnswers: [] };
        }
        continue;
      }
      const uniqueOpts = new Set(optIds);
      if (uniqueOpts.size !== optIds.length) {
        return { valid: false, questionId: q.id, reason: 'DUPLICATE', normalizedAnswers: [] };
      }
      const validIds = new Set(q.options.map((o) => o.id));
      for (const id of optIds) {
        if (!validIds.has(id)) {
          return { valid: false, questionId: q.id, reason: 'UNKNOWN_OPTION', normalizedAnswers: [] };
        }
      }
      const minC = q.min_choices ?? 1;
      const maxC = q.max_choices ?? q.options.length;
      if (optIds.length < minC || optIds.length > maxC) {
        return { valid: false, questionId: q.id, reason: 'CHOICES', normalizedAnswers: [] };
      }
      normalizedAnswers.push({
        question_id: q.id,
        option_ids: [...optIds],
        value: null,
      });
    } else if (q.answer_mode === 'OWN_VALUE') {
      if (optIds.length > 0) {
        return { valid: false, questionId: q.id, reason: 'CHOICES', normalizedAnswers: [] };
      }
      const trimmed = rawValue.trim();
      if (trimmed === '') {
        if (q.required) {
          return { valid: false, questionId: q.id, reason: 'REQUIRED', normalizedAnswers: [] };
        }
        continue;
      }
      if (q.value_type === 'TEXT') {
        if (trimmed.length > 2000) {
          return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] };
        }
        normalizedAnswers.push({
          question_id: q.id,
          option_ids: [],
          value: trimmed,
        });
      } else if (q.value_type === 'NUMBER') {
        if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
          return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] };
        }
        const [ip, fp = ''] = (trimmed.startsWith('-') ? trimmed.slice(1) : trimmed).split('.');
        if (ip.length + fp.length > 24 || fp.length > 6) {
          return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] };
        }
        if (q.min_value != null && compareServerDecimals(trimmed, q.min_value) < 0) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] };
        }
        if (q.max_value != null && compareServerDecimals(trimmed, q.max_value) > 0) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] };
        }
        normalizedAnswers.push({
          question_id: q.id,
          option_ids: [],
          value: normalizeServerDecimal(trimmed),
        });
      } else if (q.value_type === 'DATE') {
        if (!isValidServerCalendarDate(trimmed)) {
          return { valid: false, questionId: q.id, reason: 'VALUE', normalizedAnswers: [] };
        }
        if (q.min_value != null && trimmed < q.min_value) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] };
        }
        if (q.max_value != null && trimmed > q.max_value) {
          return { valid: false, questionId: q.id, reason: 'OUT_OF_RANGE', normalizedAnswers: [] };
        }
        normalizedAnswers.push({
          question_id: q.id,
          option_ids: [],
          value: trimmed,
        });
      }
    }
  }

  return { valid: true, normalizedAnswers };
}

export function createApiMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const rawUrl = req.url || '';
    const urlObj = new URL(rawUrl, 'http://localhost:3000');
    const pathname = urlObj.pathname;
    const method = req.method || 'GET';

    if (pathname === '/health' && method === 'GET') {
      return sendJson(res, 200, { status: 'ok', service: 'apartment-association-backend' });
    }
    if (pathname === '/health/ready' && method === 'GET') {
      return sendJson(res, 200, { status: 'ready', checks: { database: 'ok' } });
    }

    if (!pathname.startsWith('/api/v1/')) {
      return next();
    }

    // 1. GET /api/v1/demo/users
    if (pathname === '/api/v1/demo/users' && method === 'GET') {
      const views: DemoUserView[] = DEMO_USERS.map((u) => ({
        user_id: u.user_id,
        label: u.label,
        building_role: u.building_role,
        apartment_number: u.apartment_number,
        relation_type: u.relation_type,
      }));
      return sendJson(res, 200, views);
    }

    const user = getActingUser(req);
    const isBoardOrAccountant = ['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role);
    const isBoard = ['CHAIRMAN', 'BOARD'].includes(user.building_role);

    // 2. GET /api/v1/property/me
    if (pathname === '/api/v1/property/me' && method === 'GET') {
      const userMems = membershipsByUser[user.user_id] || [];
      return sendJson(res, 200, {
        user_id: user.user_id,
        building_id: BUILDING_ID,
        building_role: user.building_role,
        privacy_display_mode: userMems[0]?.privacy_display_mode || 'FULL_NAME',
        locale: userLocales[user.user_id] ?? null,
        memberships: userMems,
      });
    }

    // 2a. PATCH /api/v1/property/me/locale
    if (pathname === '/api/v1/property/me/locale' && method === 'PATCH') {
      const body = await readBody(req);
      const nextLocale = body.locale ?? null;
      if (nextLocale !== null && !['et', 'ru', 'en'].includes(nextLocale)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid locale.');
      }
      userLocales[user.user_id] = nextLocale;
      return sendJson(res, 200, { locale: nextLocale });
    }

    // 2b. GET /api/v1/property/building (Added in PR #31)
    if (pathname === '/api/v1/property/building' && method === 'GET') {
      return sendJson(res, 200, {
        building_id: BUILDING_ID,
        name: 'KÜ Sõpruse 12',
        registry_code: '80123456',
        address: 'Sõpruse pst 12, Kristiine, Tallinn',
        country_code: 'EE',
        reading_deadline_day: 25,
        district: 'Kristiine',
        apartment_count: 6,
        apartments_count: 6,
        total_apartments: 6,
        entrance_count: 2,
        entrances_count: 2,
        total_entrances: 2,
        heated_area_m2: '329.20',
      });
    }

    // 2c. GET /api/v1/property/apartments & GET /api/v1/property/apartments/{apartment_id} (E8/P1)
    const DEMO_APARTMENT_CARDS = [
      {
        apartment_id: '018f0000-0000-7000-8000-000000000301',
        apartment_number: '01',
        entrance: 1,
        floor: 1,
        area_m2: '48.50',
        owner_count: 1,
        tenant_count: 0,
        resident_count: 0,
        residents: [{ relation_type: 'OWNER' as const, since: '2021-03-10T10:00:00Z' }],
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
        residents: [{ relation_type: 'TENANT' as const, since: '2026-06-15T10:00:00Z' }],
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
          { relation_type: 'OWNER' as const, since: '2023-04-01T09:00:00Z' },
          { relation_type: 'RESIDENT' as const, since: '2024-09-01T12:00:00Z' },
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
          { relation_type: 'OWNER' as const, since: '2022-01-12T10:00:00Z' },
          { relation_type: 'TENANT' as const, since: '2025-09-03T10:00:00Z' },
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
          { relation_type: 'OWNER' as const, since: '2022-05-18T10:00:00Z' },
          { relation_type: 'TENANT' as const, since: '2025-05-01T10:00:00Z' },
        ],
      },
    ];

    if (pathname === '/api/v1/property/apartments' && method === 'GET') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman or Board role required.');
      }
      const summaries = DEMO_APARTMENT_CARDS.map(({ residents, ...rest }) => rest);
      return sendJson(res, 200, { apartments: summaries });
    }

    const aptCardMatch = pathname.match(/^\/api\/v1\/property\/apartments\/([^/]+)$/);
    if (aptCardMatch && method === 'GET') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman or Board role required.');
      }
      const aptId = aptCardMatch[1];
      const found = DEMO_APARTMENT_CARDS.find((a) => a.apartment_id === aptId);
      if (!found) {
        return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'Apartment not found.');
      }
      return sendJson(res, 200, found);
    }

    // 3. PATCH /api/v1/property/memberships/{membership_id}/privacy
    const privacyMatch = pathname.match(/^\/api\/v1\/property\/memberships\/([^/]+)\/privacy$/);
    if (privacyMatch && method === 'PATCH') {
      const membershipId = privacyMatch[1];
      const body = await readBody(req);
      const userMems = membershipsByUser[user.user_id] || [];
      const target = userMems.find((m) => m.membership_id === membershipId);
      if (!target) {
        return sendError(res, 403, 'FORBIDDEN', 'Membership does not belong to current user.');
      }
      const newMode: DisplayMode = body.privacy_display_mode || 'FULL_NAME';
      target.privacy_display_mode = newMode;
      target.preview_badge = computePreviewBadge(user, target.apartment_number, newMode);
      return sendJson(res, 200, {
        membership_id: target.membership_id,
        privacy_display_mode: target.privacy_display_mode,
        preview_badge: target.preview_badge,
      });
    }

    // 3b. GET /api/v1/meters/periods (Added in PR #31: all periods, newest first)
    if (pathname === '/api/v1/meters/periods' && method === 'GET') {
      const sortedPeriods = Object.values(periodsMap).sort((a, b) =>
        b.period_code.localeCompare(a.period_code)
      );
      return sendJson(res, 200, { periods: sortedPeriods });
    }

    // 3c. GET /api/v1/meters/apartments/{apartment_id}/readings (E8/P1)
    const aptReadingsMatch = pathname.match(/^\/api\/v1\/meters\/apartments\/([^/]+)\/readings$/);
    if (aptReadingsMatch && method === 'GET') {
      const aptId = aptReadingsMatch[1];
      const cardMeta = DEMO_APARTMENT_CARDS.find((a) => a.apartment_id === aptId);
      const userMems = membershipsByUser[user.user_id] || [];
      const isOwnApartment = userMems.some((m) => m.apartment_id === aptId);
      if (!cardMeta || (!isBoardOrAccountant && !isOwnApartment)) {
        return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'Apartment not found.');
      }

      const sortedPeriods = Object.values(periodsMap).sort((a, b) =>
        b.period_code.localeCompare(a.period_code)
      );
      const baseApt =
        apartmentsByPeriod['2026-10'].find((a) => a.apartment_id === aptId) ||
        apartmentsByPeriod['2026-10'][0];

      const metersHistory = baseApt.meters.map((baseMeter, mIdx) => {
        const readings: {
          period_code: string;
          reading_id: string;
          value: string;
          consumption_delta: string;
          source: ReadingSource;
          is_anomaly_confirmed: boolean;
        }[] = [];

        for (const p of sortedPeriods) {
          const periodApt = (apartmentsByPeriod[p.period_code] || []).find(
            (a) => a.apartment_id === baseApt.apartment_id
          );
          const periodMeter = periodApt?.meters.find((m) => m.meter_id === baseMeter.meter_id);
          if (periodMeter?.reading) {
            const isEstimatedSample = p.period_code === '2026-08' && mIdx === 0;
            const isAnomalySample =
              periodMeter.reading.is_anomaly_confirmed ||
              (p.period_code === '2026-09' && baseApt.apartment_number === '14' && mIdx === 0);
            readings.push({
              period_code: p.period_code,
              reading_id: periodMeter.reading.reading_id,
              value: periodMeter.reading.value,
              consumption_delta: periodMeter.reading.consumption_delta,
              source: isEstimatedSample ? 'AUTO_ESTIMATED' : periodMeter.reading.source,
              is_anomaly_confirmed: isAnomalySample,
            });
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
        };
      });

      // Add a replaced meter sample on Apt 14 so the replaced-meter label is visible
      if (cardMeta.apartment_number === '14') {
        metersHistory.push({
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
        });
      }

      return sendJson(res, 200, {
        apartment_id: cardMeta.apartment_id,
        apartment_number: cardMeta.apartment_number,
        periods: sortedPeriods,
        meters: metersHistory,
      });
    }

    // 4. GET /api/v1/meters/my-dashboard
    if (pathname === '/api/v1/meters/my-dashboard' && method === 'GET') {
      const periodCode = urlObj.searchParams.get('period_code') || '2026-10';
      const period = periodsMap[periodCode] || periodsMap['2026-10'];
      const periodApts = apartmentsByPeriod[periodCode] || apartmentsByPeriod['2026-10'];
      const userMems = membershipsByUser[user.user_id] || [];
      const userAptIds = new Set(userMems.map((m) => m.apartment_id));

      const apartments = periodApts
        .filter((a) => userAptIds.has(a.apartment_id))
        .map((a) => ({
          apartment_id: a.apartment_id,
          apartment_number: a.apartment_number,
          can_submit_readings: period.status === 'OPEN_FOR_RESIDENTS' && a.can_submit_readings,
          meters: a.meters.map((m) => ({
            meter_id: m.meter_id,
            resource_type: m.resource_type,
            serial_number: m.serial_number,
            location_label: m.location_label,
            unit: m.unit,
            previous_value: m.previous_value,
            previous_delta: m.historical_avg,
            average_delta: m.historical_avg,
            reading: m.reading,
          })),
        }));

      return sendJson(res, 200, {
        period,
        apartments,
      });
    }

    // 5. POST /api/v1/meters/readings
    if (pathname === '/api/v1/meters/readings' && method === 'POST') {
      const body = await readBody(req);
      const {
        meter_id,
        period_code = '2026-10',
        value,
        confirmation_level = 0,
        reason = null,
      } = body;

      const period = periodsMap[period_code] || periodsMap['2026-10'];
      if (period.status === 'LOCKED') {
        return sendError(res, 409, 'PERIOD_LOCKED', 'This billing period is locked.');
      }
      if (period.status !== 'OPEN_FOR_RESIDENTS' && !isBoardOrAccountant) {
        return sendError(res, 409, 'PERIOD_CLOSED', 'Period is closed for residents.');
      }

      const periodApts = apartmentsByPeriod[period_code] || apartmentsByPeriod['2026-10'];
      const masterMeters = masterMetersByPeriod[period_code] || masterMetersByPeriod['2026-10'];

      let foundMeter: InternalMeter | null = null;
      let foundApt: InternalApartment | null = null;
      let foundMaster: MasterMeterRow | null = null;

      for (const apt of periodApts) {
        const m = apt.meters.find((item) => item.meter_id === meter_id);
        if (m) {
          foundMeter = m;
          foundApt = apt;
          break;
        }
      }

      if (!foundMeter) {
        foundMaster = masterMeters.find((m) => m.meter_id === meter_id) || null;
      }

      if (!foundMeter && !foundMaster) {
        return sendError(res, 404, 'METER_NOT_FOUND', 'Meter not found.');
      }

      if (typeof value !== 'string' || !/^[0-9]{1,9}(\.[0-9]{1,3})?$/.test(value)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid decimal meter reading.');
      }

      const normalizedVal = fromBigInt3(toBigInt3(value));
      const previousValue = foundMeter ? foundMeter.previous_value : foundMaster!.previous_value;
      const prevScaled = toBigInt3(previousValue);
      const currScaled = toBigInt3(normalizedVal);

      if (currScaled < prevScaled) {
        return sendError(
          res,
          422,
          'READING_BELOW_PREVIOUS',
          `Value (${normalizedVal}) cannot be lower than previous reading (${previousValue}).`,
          { previous_value: previousValue }
        );
      }

      // Check if Board/Accountant is modifying an existing reading -> require reason
      const existingReading = foundMeter ? foundMeter.reading : foundMaster!.reading;
      const userMems = membershipsByUser[user.user_id] || [];
      const isOwnUnit = foundApt && userMems.some((m) => m.apartment_id === foundApt!.apartment_id);

      if (
        existingReading &&
        isBoardOrAccountant &&
        !isOwnUnit &&
        (!reason || !String(reason).trim())
      ) {
        return sendError(
          res,
          422,
          'REASON_REQUIRED',
          'A reason is required when overriding an existing meter reading.'
        );
      }

      const deltaScaled = currScaled - prevScaled;
      const deltaStr = fromBigInt3(deltaScaled);
      const avgStr = foundMeter ? foundMeter.historical_avg : '25.000';
      const avgScaled = toBigInt3(avgStr);
      const thresholdScaled = avgScaled * 3n > 10000n ? avgScaled * 3n : 10000n;
      const isAnomaly = foundMeter ? deltaScaled > thresholdScaled : false;

      if (isAnomaly && confirmation_level === 0) {
        return sendError(
          res,
          409,
          'ANOMALY_CONFIRMATION_STEP_1',
          `Unusually high consumption (${deltaStr} ${foundMeter!.unit}). Please verify the reading on your meter.`,
          {
            submitted_value: normalizedVal,
            previous_value: previousValue,
            consumption_delta: deltaStr,
            average_delta: avgStr,
            max_reasonable_delta: fromBigInt3(thresholdScaled),
            required_confirmation_level: 1,
          }
        );
      }

      if (isAnomaly && confirmation_level === 1) {
        return sendError(
          res,
          409,
          'ANOMALY_CONFIRMATION_STEP_2',
          `Final confirmation required: ${deltaStr} ${foundMeter!.unit} will be billed to your apartment.`,
          {
            submitted_value: normalizedVal,
            previous_value: previousValue,
            consumption_delta: deltaStr,
            historical_average: avgStr,
            required_confirmation_level: 2,
          }
        );
      }

      const oldVal = existingReading?.value || null;
      const readingId =
        existingReading?.reading_id ||
        `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`;
      const source: ReadingSource = isOwnUnit ? 'RESIDENT' : 'ADMIN_OVERRIDE';

      const newReading: ReadingSummary = {
        reading_id: readingId,
        value: normalizedVal,
        consumption_delta: deltaStr,
        source,
        is_anomaly_confirmed: isAnomaly,
      };

      if (foundMeter) {
        foundMeter.reading = newReading;
      } else if (foundMaster) {
        foundMaster.reading = newReading;
        foundMaster.status = 'SUBMITTED';
      }

      if (!historyStore[readingId]) {
        historyStore[readingId] = {
          meter_id,
          period_code,
          entries: [],
        };
      }
      historyStore[readingId].entries.unshift({
        changed_at: new Date().toISOString(),
        old_value: oldVal,
        new_value: normalizedVal,
        source,
        reason: reason || null,
        changed_by: resolveAuthorBadge(user.user_id),
      });

      return sendJson(res, 200, {
        reading_id: readingId,
        meter_id,
        period_code,
        value: normalizedVal,
        consumption_delta: deltaStr,
        source,
        is_anomaly_confirmed: isAnomaly,
      });
    }

    // 6. GET /api/v1/meters/readings/{reading_id}/history
    const historyMatch = pathname.match(/^\/api\/v1\/meters\/readings\/([^/]+)\/history$/);
    if (historyMatch && method === 'GET') {
      const readingId = historyMatch[1];
      const hist = historyStore[readingId] || {
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
              display_label: 'Apt 14',
              role_badge: 'OWNER',
            },
          },
        ],
      };
      return sendJson(res, 200, {
        reading_id: readingId,
        meter_id: hist.meter_id,
        period_code: hist.period_code,
        entries: hist.entries,
      });
    }

    // 7. GET /api/v1/meters/periods/{period_code}/matrix
    const matrixMatch = pathname.match(/^\/api\/v1\/meters\/periods\/([^/]+)\/matrix$/);
    if (matrixMatch && method === 'GET') {
      if (!isBoardOrAccountant) {
        return sendError(res, 403, 'FORBIDDEN', 'Board or Accountant role required.');
      }
      const periodCode = matrixMatch[1];
      const period = periodsMap[periodCode] || periodsMap['2026-10'];
      const periodApts = apartmentsByPeriod[periodCode] || apartmentsByPeriod['2026-10'];
      const masterMeters = masterMetersByPeriod[periodCode] || masterMetersByPeriod['2026-10'];

      let coldSum = 0n;
      let hotSum = 0n;

      const apartments: MatrixApartment[] = periodApts.map((a) => {
        const hasMissing = a.meters.some((m) => !m.reading);
        const hasAnomaly = a.meters.some((m) => m.reading?.is_anomaly_confirmed);
        const hasEstimated = a.meters.some((m) => m.reading?.source === 'AUTO_ESTIMATED');

        let aptStatus: SubmissionStatus = 'SUBMITTED';
        if (hasMissing) aptStatus = 'MISSING';
        else if (hasAnomaly) aptStatus = 'ANOMALY_CONFIRMED';
        else if (hasEstimated) aptStatus = 'AUTO_ESTIMATED';

        const meters = a.meters.map((m) => {
          if (m.reading) {
            if (m.resource_type === 'COLD_WATER') coldSum += toBigInt3(m.reading.consumption_delta);
            if (m.resource_type === 'HOT_WATER') hotSum += toBigInt3(m.reading.consumption_delta);
          }
          let mStatus: SubmissionStatus = 'MISSING';
          if (m.reading) {
            if (m.reading.is_anomaly_confirmed) mStatus = 'ANOMALY_CONFIRMED';
            else if (m.reading.source === 'AUTO_ESTIMATED') mStatus = 'AUTO_ESTIMATED';
            else mStatus = 'SUBMITTED';
          }
          return {
            meter_id: m.meter_id,
            resource_type: m.resource_type,
            location_label: m.location_label,
            unit: m.unit,
            previous_value: m.previous_value,
            status: mStatus,
            reading: m.reading,
          };
        });

        return {
          apartment_id: a.apartment_id,
          apartment_number: a.apartment_number,
          entrance: a.entrance,
          floor: a.floor,
          status: aptStatus,
          meters,
        };
      });

      const coldMaster =
        masterMeters.find((m) => m.resource_type === 'COLD_WATER')?.reading?.consumption_delta ||
        '28.500';
      const hotMaster =
        masterMeters.find((m) => m.resource_type === 'HOT_WATER')?.reading?.consumption_delta ||
        '15.400';

      const coldAptStr = fromBigInt3(coldSum);
      const hotAptStr = fromBigInt3(hotSum);

      return sendJson(res, 200, {
        period,
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
        master_meters: masterMeters,
        apartments,
      });
    }

    // 8. POST /api/v1/meters/periods/{period_code}/estimate-missing
    const estimateMatch = pathname.match(/^\/api\/v1\/meters\/periods\/([^/]+)\/estimate-missing$/);
    if (estimateMatch && method === 'POST') {
      if (!isBoardOrAccountant) {
        return sendError(res, 403, 'FORBIDDEN', 'Board or Accountant role required.');
      }
      const periodCode = estimateMatch[1];
      const period = periodsMap[periodCode] || periodsMap['2026-10'];
      if (period.status === 'LOCKED') {
        return sendError(res, 409, 'PERIOD_LOCKED', 'Cannot estimate readings on a locked period.');
      }
      const periodApts = apartmentsByPeriod[periodCode] || apartmentsByPeriod['2026-10'];
      const estimated: any[] = [];

      for (const apt of periodApts) {
        for (const m of apt.meters) {
          if (!m.reading) {
            const estVal = addDecimal(m.previous_value, m.historical_avg);
            const readingId = `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`;
            m.reading = {
              reading_id: readingId,
              value: estVal,
              consumption_delta: m.historical_avg,
              source: 'AUTO_ESTIMATED',
              is_anomaly_confirmed: false,
            };
            estimated.push({
              reading_id: readingId,
              meter_id: m.meter_id,
              apartment_id: apt.apartment_id,
              value: estVal,
              consumption_delta: m.historical_avg,
            });
          }
        }
      }

      return sendJson(res, 200, {
        period_code: periodCode,
        estimated_count: estimated.length,
        estimated,
      });
    }

    // 9. PATCH /api/v1/meters/periods/{period_code}/status
    const statusMatch = pathname.match(/^\/api\/v1\/meters\/periods\/([^/]+)\/status$/);
    if (statusMatch && method === 'PATCH') {
      if (!isBoardOrAccountant) {
        return sendError(res, 403, 'FORBIDDEN', 'Board or Accountant role required.');
      }
      const periodCode = statusMatch[1];
      const period = periodsMap[periodCode] || periodsMap['2026-10'];
      const body = await readBody(req);
      const prevStatus = period.status;
      if (['OPEN_FOR_RESIDENTS', 'REVIEW_BY_BOARD', 'LOCKED'].includes(body.status)) {
        period.status = body.status as PeriodStatus;
      }
      return sendJson(res, 200, {
        period_code: periodCode,
        previous_status: prevStatus,
        status: period.status,
      });
    }

    // 10. GET /api/v1/meters/periods/{period_code}/export-csv
    const csvMatch = pathname.match(/^\/api\/v1\/meters\/periods\/([^/]+)\/export-csv$/);
    if (csvMatch && method === 'GET') {
      if (!isBoardOrAccountant) {
        return sendError(res, 403, 'FORBIDDEN', 'Board or Accountant role required.');
      }
      const periodCode = csvMatch[1];
      const periodApts = apartmentsByPeriod[periodCode] || apartmentsByPeriod['2026-10'];
      const lines = [
        'period_code,apartment_number,serial_number,resource_type,previous_value,current_value,consumption_delta,unit,source',
      ];
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
            ].join(',')
          );
        }
      }
      const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="readings_${periodCode}.csv"`);
      res.setHeader('X-Trace-Id', traceId);
      return res.end(lines.join('\n'));
    }

    // 11. GET /api/v1/communication/emergencies/active
    if (pathname === '/api/v1/communication/emergencies/active' && method === 'GET') {
      const activeList: EmergencyView[] = postsStore
        .filter((p) => p.post_type === 'EMERGENCY' && p.is_active)
        .map((p) => ({
          id: p.id,
          post_type: p.post_type,
          category: p.category,
          title: p.title,
          body: p.body,
          author_badge: resolveAuthorBadge(p.author_user_id),
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
          acknowledged_at: p.acknowledged_by[user.user_id] || null,
        }));
      return sendJson(res, 200, activeList);
    }

    // 12. POST /api/v1/communication/emergencies/{id}/acknowledge
    const ackMatch = pathname.match(/^\/api\/v1\/communication\/emergencies\/([^/]+)\/acknowledge$/);
    if (ackMatch && method === 'POST') {
      const post = postsStore.find((p) => p.id === ackMatch[1]);
      if (!post) return sendError(res, 404, 'POST_NOT_FOUND', 'Emergency alert not found.');
      const nowIso = new Date().toISOString();
      post.acknowledged_by[user.user_id] = nowIso;
      return sendJson(res, 200, {
        post_id: post.id,
        acknowledged_at: nowIso,
      });
    }

    // 13. POST /api/v1/communication/emergencies/{id}/resolve
    const resolveMatch = pathname.match(/^\/api\/v1\/communication\/emergencies\/([^/]+)\/resolve$/);
    if (resolveMatch && method === 'POST') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only Board members can resolve emergencies.');
      }
      const post = postsStore.find((p) => p.id === resolveMatch[1]);
      if (!post) return sendError(res, 404, 'POST_NOT_FOUND', 'Emergency alert not found.');
      post.is_active = false;
      // Add EMERGENCY_RESOLVED notification for all other demo users
      for (const demoUser of DEMO_USERS) {
        if (demoUser.user_id !== user.user_id) {
          const list = getUserNotifications(demoUser.user_id);
          list.unshift({
            id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
            user_id: demoUser.user_id,
            event_type: 'EMERGENCY_RESOLVED',
            subject_type: 'post',
            subject_id: post.id,
            params: {
              category: post.category,
              target_scope: post.target_scope,
              target_entrance: post.target_entrance,
            },
            created_at: new Date().toISOString(),
            read_at: null,
          });
        }
      }
      return sendJson(res, 200, {
        post_id: post.id,
        is_active: false,
      });
    }

    // 14. GET & POST /api/v1/communication/posts
    if (pathname === '/api/v1/communication/posts' && method === 'GET') {
      const postType = urlObj.searchParams.get('post_type') as PostType | null;
      const apartmentId = urlObj.searchParams.get('apartment_id');
      const category = urlObj.searchParams.get('category');
      const limit = Number(urlObj.searchParams.get('limit') || '20');
      const offset = Number(urlObj.searchParams.get('offset') || '0');

      if (apartmentId && postType !== 'APARTMENT_THREAD') {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          'apartment_id filter is only valid with post_type=APARTMENT_THREAD.'
        );
      }

      let filtered = postsStore.filter(
        (p) =>
          p.post_type !== 'EMERGENCY' &&
          p.post_type !== 'APARTMENT_THREAD' &&
          p.post_type !== 'BOARD_TOPIC'
      );

      if (postType === 'APARTMENT_THREAD') {
        const userMems = membershipsByUser[user.user_id] || [];
        filtered = postsStore.filter((p) => {
          if (p.post_type !== 'APARTMENT_THREAD') return false;
          if (apartmentId && !p.target_apartment_ids?.includes(apartmentId)) return false;
          if (isBoard) return true;
          return userMems.some(
            (m) =>
              p.target_apartment_ids?.includes(m.apartment_id) &&
              new Date(m.since).getTime() <= new Date(p.created_at).getTime()
          );
        });
        filtered.sort((a, b) => {
          const aLast =
            a.comments.length > 0 ? a.comments[a.comments.length - 1].created_at : a.created_at;
          const bLast =
            b.comments.length > 0 ? b.comments[b.comments.length - 1].created_at : b.created_at;
          return new Date(bLast).getTime() - new Date(aLast).getTime();
        });
      } else if (postType === 'BOARD_TOPIC') {
        if (!isBoard) {
          return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
        }
        filtered = postsStore.filter((p) => p.post_type === 'BOARD_TOPIC');
        filtered.sort((a, b) => {
          const aLast =
            a.comments.length > 0 ? a.comments[a.comments.length - 1].created_at : a.created_at;
          const bLast =
            b.comments.length > 0 ? b.comments[b.comments.length - 1].created_at : b.created_at;
          return new Date(bLast).getTime() - new Date(aLast).getTime();
        });
      } else if (postType) {
        filtered = postsStore.filter((p) => p.post_type === postType);
      }

      if (category) {
        filtered = filtered.filter((p) => p.category === category);
      }

      const paged = filtered.slice(offset, offset + limit).map((p) => ({
        id: p.id,
        post_type: p.post_type,
        category: p.category,
        title: p.title,
        body: p.body,
        author_badge: resolveAuthorBadge(
          p.author_user_id,
          p.post_type,
          p.target_apartment_ids?.[0] || null
        ),
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
      }));
      return sendJson(res, 200, paged);
    }

    if (pathname === '/api/v1/communication/posts' && method === 'POST') {
      const body = await readBody(req);
      const postType: PostType = body.post_type || 'FORUM_TOPIC';
      if ((postType === 'OFFICIAL_NOTICE' || postType === 'EMERGENCY') && !isBoard) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Only Board members can publish notices or emergencies.'
        );
      }

      if (postType === 'APARTMENT_THREAD') {
        if (body.author_apartment_id !== undefined && body.author_apartment_id !== null) {
          return sendError(
            res,
            422,
            'INVALID_AUTHOR_APARTMENT',
            'author_apartment_id is not allowed on APARTMENT_THREAD.'
          );
        }
        if (body.comments_enabled === false) {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            'comments_enabled must be true for APARTMENT_THREAD.'
          );
        }
        if (
          body.target_scope !== 'APARTMENT_LIST' ||
          !Array.isArray(body.target_apartment_ids) ||
          body.target_apartment_ids.length !== 1
        ) {
          return sendError(
            res,
            422,
            'INVALID_TARGET',
            'APARTMENT_THREAD requires target_scope=APARTMENT_LIST with exactly 1 apartment.'
          );
        }
        const targetAptId = body.target_apartment_ids[0];
        const aptCard = DEMO_APARTMENT_CARDS.find((a) => a.apartment_id === targetAptId);
        if (!aptCard) {
          return sendError(res, 422, 'INVALID_TARGET', 'Target apartment not found.');
        }
        if (!isBoard) {
          const userMems = membershipsByUser[user.user_id] || [];
          if (!userMems.some((m) => m.apartment_id === targetAptId)) {
            return sendError(
              res,
              403,
              'FORBIDDEN',
              'You do not have access to this apartment.'
            );
          }
        }
        if (aptCard.residents.length === 0) {
          return sendError(
            res,
            422,
            'APARTMENT_HAS_NO_RESIDENTS',
            'This apartment has no registered residents yet.'
          );
        }
      }

      if (postType === 'BOARD_TOPIC') {
        if (!isBoard) {
          return sendError(res, 403, 'FORBIDDEN', 'Only Board members can publish board topics.');
        }
        if (body.author_apartment_id !== undefined && body.author_apartment_id !== null) {
          return sendError(
            res,
            422,
            'INVALID_AUTHOR_APARTMENT',
            'author_apartment_id is not allowed on BOARD_TOPIC.'
          );
        }
        if (
          (body.target_scope && body.target_scope !== 'ALL_BUILDING') ||
          body.target_entrance ||
          body.target_apartment_ids
        ) {
          return sendError(
            res,
            422,
            'INVALID_TARGET',
            'BOARD_TOPIC does not accept target fields.'
          );
        }
      }

      const created: InternalPost = {
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        post_type: postType,
        category: body.category || 'GENERAL',
        title: body.title || 'Untitled',
        body: body.body || '',
        author_user_id: user.user_id,
        author_apartment_id:
          postType === 'APARTMENT_THREAD' || postType === 'BOARD_TOPIC'
            ? null
            : body.author_apartment_id || null,
        target_scope: body.target_scope || 'ALL_BUILDING',
        target_entrance: body.target_entrance || null,
        target_apartment_ids: body.target_apartment_ids || null,
        is_active: true,
        comments_enabled: body.comments_enabled !== false,
        created_at: new Date().toISOString(),
        acknowledged_by: {},
        comments: [],
      };
      postsStore.unshift(created);

      if (postType === 'OFFICIAL_NOTICE') {
        dispatchServerMaintenanceAndNoticeNotifications({
          event_type: 'NOTICE_PUBLISHED',
          subject_type: 'post',
          subject_id: created.id,
          target_scope: created.target_scope,
          target_entrance: created.target_entrance,
          target_apartment_ids: created.target_apartment_ids,
          author_user_id: user.user_id,
          created_at: created.created_at,
        });
      }

      // If an emergency is published, notify all other demo users (author never gets own alert)
      if (postType === 'EMERGENCY') {
        for (const demoUser of DEMO_USERS) {
          if (demoUser.user_id !== user.user_id) {
            const list = getUserNotifications(demoUser.user_id);
            list.unshift({
              id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
              user_id: demoUser.user_id,
              event_type: 'EMERGENCY_PUBLISHED',
              subject_type: 'post',
              subject_id: created.id,
              params: {
                category: created.category,
                target_scope: created.target_scope,
                target_entrance: created.target_entrance,
              },
              created_at: created.created_at,
              read_at: null,
            });
          }
        }
      }

      if (postType === 'APARTMENT_THREAD' && created.target_apartment_ids?.[0]) {
        emitApartmentThreadNotifications(
          created.id,
          created.target_apartment_ids[0],
          user,
          created.created_at
        );
      }

      return sendJson(res, 201, {
        id: created.id,
        post_type: created.post_type,
        category: created.category,
        title: created.title,
        body: created.body,
        author_badge: resolveAuthorBadge(
          created.author_user_id,
          created.post_type,
          created.target_apartment_ids?.[0] || null
        ),
        is_mine: true,
        target_scope: created.target_scope,
        target_entrance: created.target_entrance,
        target_apartment_ids: created.target_apartment_ids,
        is_active: created.is_active,
        comments_enabled: created.comments_enabled,
        comments_count: 0,
        created_at: created.created_at,
        last_activity_at: created.created_at,
      });
    }

    // 15. GET & DELETE /api/v1/communication/posts/{post_id}
    const postDetailMatch = pathname.match(/^\/api\/v1\/communication\/posts\/([^/]+)$/);
    if (postDetailMatch && method === 'GET') {
      const post = postsStore.find((p) => p.id === postDetailMatch[1]);
      if (!post) return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');

      if (post.post_type === 'APARTMENT_THREAD' && !isBoard) {
        const userMems = membershipsByUser[user.user_id] || [];
        const hasAccess = userMems.some(
          (m) =>
            post.target_apartment_ids?.includes(m.apartment_id) &&
            new Date(m.since).getTime() <= new Date(post.created_at).getTime()
        );
        if (!hasAccess) {
          return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
        }
      }
      if (post.post_type === 'BOARD_TOPIC' && !isBoard) {
        return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      }

      const targetAptId = post.target_apartment_ids?.[0] || null;
      return sendJson(res, 200, {
        id: post.id,
        post_type: post.post_type,
        category: post.category,
        title: post.title,
        body: post.body,
        author_badge: resolveAuthorBadge(post.author_user_id, post.post_type, targetAptId),
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
        comments: post.comments.map((c) => ({
          id: c.id,
          post_id: post.id,
          body: c.body,
          author_badge: resolveAuthorBadge(c.author_user_id, post.post_type, targetAptId),
          is_mine: c.author_user_id === user.user_id,
          created_at: c.created_at,
        })),
      });
    }

    if (postDetailMatch && method === 'DELETE') {
      const idx = postsStore.findIndex((p) => p.id === postDetailMatch[1]);
      if (idx === -1) return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      const targetPost = postsStore[idx];
      if (targetPost.post_type === 'BOARD_TOPIC') {
        if (!isBoard) {
          return sendError(res, 403, 'FORBIDDEN', 'Only Board members can delete board topics.');
        }
        postsStore.splice(idx, 1);
        res.statusCode = 204;
        return res.end();
      }
      if (user.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Only Chairman can delete forum topics.');
      }
      if (targetPost.post_type !== 'FORUM_TOPIC') {
        return sendError(res, 409, 'POST_NOT_DELETABLE', 'This post cannot be deleted.');
      }
      postsStore.splice(idx, 1);
      res.statusCode = 204;
      return res.end();
    }

    // 16. POST /api/v1/communication/posts/{post_id}/comments
    const commentMatch = pathname.match(/^\/api\/v1\/communication\/posts\/([^/]+)\/comments$/);
    if (commentMatch && method === 'POST') {
      const post = postsStore.find((p) => p.id === commentMatch[1]);
      if (!post) return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      if (!post.comments_enabled) {
        return sendError(res, 409, 'COMMENTS_DISABLED', 'Comments are disabled on this post.');
      }
      const body = await readBody(req);
      if (post.post_type === 'APARTMENT_THREAD' || post.post_type === 'BOARD_TOPIC') {
        if (body.author_apartment_id !== undefined && body.author_apartment_id !== null) {
          return sendError(
            res,
            422,
            'INVALID_AUTHOR_APARTMENT',
            'author_apartment_id is not allowed on this thread.'
          );
        }
      }
      if (post.post_type === 'APARTMENT_THREAD' && !isBoard) {
        const userMems = membershipsByUser[user.user_id] || [];
        const hasAccess = userMems.some(
          (m) =>
            post.target_apartment_ids?.includes(m.apartment_id) &&
            new Date(m.since).getTime() <= new Date(post.created_at).getTime()
        );
        if (!hasAccess) {
          return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
        }
      }
      if (post.post_type === 'BOARD_TOPIC' && !isBoard) {
        return sendError(res, 404, 'POST_NOT_FOUND', 'Post not found.');
      }
      const comment: InternalComment = {
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        post_id: post.id,
        body: body.body || '',
        author_user_id: user.user_id,
        author_apartment_id:
          post.post_type === 'APARTMENT_THREAD' || post.post_type === 'BOARD_TOPIC'
            ? null
            : body.author_apartment_id || null,
        created_at: new Date().toISOString(),
      };
      post.comments.push(comment);
      if (post.post_type === 'APARTMENT_THREAD' && post.target_apartment_ids?.[0]) {
        emitApartmentThreadNotifications(
          post.id,
          post.target_apartment_ids[0],
          user,
          comment.created_at
        );
      }
      return sendJson(res, 201, {
        id: comment.id,
        post_id: post.id,
        body: comment.body,
        author_badge: resolveAuthorBadge(
          comment.author_user_id,
          post.post_type,
          post.target_apartment_ids?.[0] || null
        ),
        is_mine: true,
        created_at: comment.created_at,
      });
    }

    // 17. AUTH ENDPOINTS (Epic E7)
    if (pathname === '/api/v1/auth/refresh' && method === 'POST') {
      if (activeSignedInUserId && activeSessionsStore.some((s) => s.current)) {
        return sendJson(res, 200, {
          access_token: `mock-jwt-${activeSignedInUserId}`,
          token_type: 'Bearer',
          expires_in: 900,
          session_id: '018f0000-0000-7000-8000-000000009901',
        });
      }
      return sendError(res, 401, 'SESSION_EXPIRED', 'No active session cookie in demo mode.');
    }

    if (pathname === '/api/v1/auth/logout' && method === 'POST') {
      activeSignedInUserId = null;
      activeSessionsStore = [];
      res.statusCode = 204;
      return res.end();
    }

    if (pathname === '/api/v1/auth/magic-link' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      if (!email || !email.includes('@') || !email.split('@')[1]?.includes('.')) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Enter a valid e-mail address.');
      }
      pendingMagicLinkEmail = email;
      magicLinkTokenUsed = false;
      return sendJson(res, 202, { accepted: true });
    }

    if (pathname === '/api/v1/auth/magic-link/redeem' && method === 'POST') {
      const body = await readBody(req);
      const tokenStr = String(body.token || '');

      if (tokenStr.startsWith('demo-register-')) {
        // Format: demo-register-owner-14 | demo-register-tenant-14 | demo-register-staff-BOARD
        const parts = tokenStr.split('-');
        const kindRaw = (parts[2] || 'owner').toUpperCase();
        const targetVal = parts[3] || '14';
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
              };
        return sendJson(res, 200, {
          status: 'REGISTRATION_REQUIRED',
          registration_token: `reg-${Date.now()}`,
          expires_in: 1800,
          invitation,
        });
      }

      if (tokenStr.startsWith('demo-accept-')) {
        const parts = tokenStr.split('-');
        const kindRaw = (parts[2] || 'tenant').toUpperCase();
        const targetVal = parts[3] || '14';
        return sendJson(res, 200, {
          status: 'SIGN_IN_TO_ACCEPT',
          invitation: {
            kind: kindRaw === 'OWNER' ? 'OWNER' : 'TENANT',
            apartment_number: targetVal,
            building_role: null,
          },
        });
      }

      if (
        (tokenStr === 'demo-valid-token' && !magicLinkTokenUsed) ||
        tokenStr.startsWith('demo-user-')
      ) {
        if (tokenStr === 'demo-valid-token') {
          magicLinkTokenUsed = true;
          activeSignedInUserId = resolveEmailToDemoUserId(pendingMagicLinkEmail);
        } else {
          const requestedId = tokenStr.replace('demo-user-', '');
          const matchedUser = DEMO_USERS.find((u) => u.user_id === requestedId);
          activeSignedInUserId = matchedUser ? matchedUser.user_id : DEMO_USERS[0].user_id;
        }
        const nowIso = new Date().toISOString();
        activeSessionsStore = [
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
        ];
        return sendJson(res, 200, {
          status: 'SIGNED_IN',
          session: {
            access_token: `mock-jwt-${activeSignedInUserId}`,
            token_type: 'Bearer',
            expires_in: 900,
            session_id: '018f0000-0000-7000-8000-000000009901',
          },
        });
      }
      return sendError(
        res,
        400,
        'INVALID_LINK',
        'This link was already used, has expired or is no longer valid.'
      );
    }

    // A5: POST /api/v1/auth/password/login
    if (pathname === '/api/v1/auth/password/login' && method === 'POST') {
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      const rawPassword = typeof body.password === 'string' ? body.password : '';
      if (
        email.length < 3 ||
        email.length > 320 ||
        !isValidEmailFormat(email) ||
        rawPassword.length < 1 ||
        rawPassword.length > 1024
      ) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid email or password format.');
      }
      if (email.toLowerCase().includes('ratelimit')) {
        return sendError(res, 429, 'RATE_LIMITED', 'Too many attempts.', {
          retry_after_seconds: 30,
        });
      }
      const password = rawPassword.normalize('NFKC');
      const resolvedUserId = resolveEmailToDemoUserId(email);
      const expectedPassword = passwordsByUser[resolvedUserId];
      const isPasswordValid =
        password === 'demo-password-ok' ||
        (Boolean(expectedPassword) && password === expectedPassword);

      if (!isPasswordValid) {
        passwordLoginFailures += 1;
        if (passwordLoginFailures >= 6) {
          passwordLoginFailures = 0;
          return sendError(res, 429, 'RATE_LIMITED', 'Too many attempts.', {
            retry_after_seconds: 30,
          });
        }
        return sendError(res, 401, 'INVALID_CREDENTIALS', 'Wrong email or password.');
      }

      passwordLoginFailures = 0;
      activeSignedInUserId = resolvedUserId;
      const nowIso = new Date().toISOString();
      activeSessionsStore = [
        {
          session_id: '018f0000-0000-7000-8000-000000009901',
          device_kind: 'DESKTOP_BROWSER',
          auth_method: 'PASSWORD',
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
      ];
      return sendJson(res, 200, {
        access_token: `mock-jwt-${activeSignedInUserId}`,
        token_type: 'Bearer',
        expires_in: 900,
        session_id: '018f0000-0000-7000-8000-000000009901',
      });
    }

    // A5: GET / PUT / DELETE /api/v1/auth/password
    if (pathname === '/api/v1/auth/password') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (method === 'GET') {
        return sendJson(res, 200, {
          is_set: Boolean(passwordsByUser[authedUser.user_id]),
        });
      }
      if (method === 'PUT') {
        const body = await readBody(req);
        const rawNewPassword = typeof body.new_password === 'string' ? body.new_password : '';
        const rawCurrentPassword =
          typeof body.current_password === 'string' ? body.current_password : '';
        if (
          rawNewPassword.length < 1 ||
          rawNewPassword.length > 1024 ||
          rawCurrentPassword.length > 1024
        ) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid password payload.');
        }

        const newPassword = rawNewPassword.normalize('NFKC');
        const currentPassword = rawCurrentPassword ? rawCurrentPassword.normalize('NFKC') : '';
        const existingPassword = passwordsByUser[authedUser.user_id];

        // 10-minute reauthentication window per docs/API.md section 7
        const currentSession = activeSessionsStore.find((s) => s.current);
        const isFreshSession =
          Boolean(currentSession) &&
          Date.now() - Date.parse(currentSession!.authenticated_at) <= 10 * 60 * 1000 &&
          !newPassword.includes('reauth');

        if (currentPassword) {
          const matchesCurrent =
            existingPassword &&
            (currentPassword === existingPassword || currentPassword === 'demo-password-ok');
          if (!matchesCurrent || currentPassword === 'wrong') {
            passwordLoginFailures += 1;
            if (passwordLoginFailures >= 6) {
              passwordLoginFailures = 0;
              return sendError(res, 429, 'RATE_LIMITED', 'Too many attempts.', {
                retry_after_seconds: 30,
              });
            }
            return sendError(
              res,
              403,
              'REAUTHENTICATION_REQUIRED',
              'Enter your current password or sign in with a link sent to your email.'
            );
          }
        } else if (!isFreshSession) {
          return sendError(
            res,
            403,
            'REAUTHENTICATION_REQUIRED',
            'Enter your current password or sign in with a link sent to your email.'
          );
        }

        const codePointLength = [...newPassword].length;
        if (codePointLength < 15) {
          return sendError(res, 422, 'PASSWORD_TOO_WEAK', 'Password is too short.', {
            reason: 'TOO_SHORT',
          });
        }
        if (codePointLength > 128) {
          return sendError(res, 422, 'PASSWORD_TOO_WEAK', 'Password is too long.', {
            reason: 'TOO_LONG',
          });
        }
        const commonPasswords = [
          'password123password',
          'password1234567',
          '123456789012345',
          'qwertyuiopasdfg',
          'passwordpassword',
        ];
        const strippedLower = newPassword.toLowerCase().replace(/\s+/g, '');
        const distinctChars = new Set([...newPassword]).size;
        if (commonPasswords.includes(strippedLower) || distinctChars < 5) {
          return sendError(res, 422, 'PASSWORD_TOO_WEAK', 'Password is too common.', {
            reason: 'TOO_COMMON',
          });
        }

        passwordsByUser[authedUser.user_id] = newPassword;
        activeSessionsStore = activeSessionsStore.filter((s) => s.current);
        res.statusCode = 204;
        return res.end();
      }
      if (method === 'DELETE') {
        const body = await readBody(req);
        const rawCurrentPassword =
          typeof body.current_password === 'string' ? body.current_password : '';
        if (rawCurrentPassword.length > 1024) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid password payload.');
        }
        const currentPassword = rawCurrentPassword ? rawCurrentPassword.normalize('NFKC') : '';
        const existingPassword = passwordsByUser[authedUser.user_id];

        // Also 204 when no password is set, without any check; then nothing is revoked or sent
        if (!existingPassword) {
          res.statusCode = 204;
          return res.end();
        }

        const currentSession = activeSessionsStore.find((s) => s.current);
        const isFreshSession =
          Boolean(currentSession) &&
          Date.now() - Date.parse(currentSession!.authenticated_at) <= 10 * 60 * 1000;

        if (currentPassword) {
          const matchesCurrent =
            currentPassword === existingPassword || currentPassword === 'demo-password-ok';
          if (!matchesCurrent || currentPassword === 'wrong') {
            passwordLoginFailures += 1;
            if (passwordLoginFailures >= 6) {
              passwordLoginFailures = 0;
              return sendError(res, 429, 'RATE_LIMITED', 'Too many attempts.', {
                retry_after_seconds: 30,
              });
            }
            return sendError(
              res,
              403,
              'REAUTHENTICATION_REQUIRED',
              'Enter your current password or sign in with a link sent to your email.'
            );
          }
        } else if (!isFreshSession) {
          return sendError(
            res,
            403,
            'REAUTHENTICATION_REQUIRED',
            'Enter your current password or sign in with a link sent to your email.'
          );
        }

        passwordsByUser[authedUser.user_id] = null;
        activeSessionsStore = activeSessionsStore.filter((s) => s.current);
        res.statusCode = 204;
        return res.end();
      }
    }

    if (pathname === '/api/v1/auth/registration' && method === 'POST') {
      const body = await readBody(req);
      const fullName = String(body.full_name || '').trim();
      if (!fullName || fullName.length > 255) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Full name is required.');
      }
      activeSignedInUserId = DEMO_USERS[0].user_id;
      const nowIso = new Date().toISOString();
      activeSessionsStore = [
        {
          session_id: '018f0000-0000-7000-8000-000000009901',
          device_kind: 'DESKTOP_BROWSER',
          auth_method: 'INVITATION',
          authenticated_at: nowIso,
          last_used_at: nowIso,
          current: true,
        },
      ];
      return sendJson(res, 200, {
        status: 'SIGNED_IN',
        session: {
          access_token: `mock-jwt-${activeSignedInUserId}`,
          token_type: 'Bearer',
          expires_in: 900,
          session_id: '018f0000-0000-7000-8000-000000009901',
        },
      });
    }

    if (pathname === '/api/v1/auth/invitations/accept' && method === 'POST') {
      return sendJson(res, 200, { applied: true });
    }

    // A4: GET / POST /api/v1/auth/invitations
    if (pathname === '/api/v1/auth/invitations' && method === 'GET') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      return sendJson(
        res,
        200,
        buildingInvitationsStore.map((inv) => toInvitationView(inv, authedUser.user_id))
      );
    }

    if (pathname === '/api/v1/auth/invitations' && method === 'POST') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const body = await readBody(req);
      const kind = body.kind as 'OWNER' | 'TENANT' | 'STAFF';
      const email = String(body.email || '').trim();
      const rawApt = body.apartment_number ? String(body.apartment_number).trim() : null;
      const apartmentIdFromBody = body.apartment_id ? String(body.apartment_id).trim() : null;
      let apartmentNumber = rawApt
        ? rawApt.padStart(2, '0')
        : apartmentIdFromBody
          ? APARTMENT_ID_TO_NUMBER[apartmentIdFromBody] || null
          : null;
      let apartmentId =
        apartmentIdFromBody || (apartmentNumber ? NUMBER_TO_APARTMENT_ID[apartmentNumber] || null : null);
      const buildingRole = (body.building_role || null) as
        | 'CHAIRMAN'
        | 'BOARD'
        | 'ACCOUNTANT'
        | null;

      if (!isValidEmailFormat(email) || !['OWNER', 'TENANT', 'STAFF'].includes(kind)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid invitation parameters.');
      }

      if (email.toLowerCase() === 'ratelimit@demo.invalid') {
        return sendError(res, 429, 'RATE_LIMITED', 'Too many invitations sent.', {
          retry_after_seconds: 600,
        });
      }

      if (kind === 'TENANT') {
        const callerMems = membershipsByUser[authedUser.user_id] || [];
        const ownedMem = callerMems.find(
          (m) =>
            m.relation_type === 'OWNER' &&
            ((apartmentId && m.apartment_id === apartmentId) ||
              (apartmentNumber && m.apartment_number === apartmentNumber))
        );
        if (!apartmentId && !apartmentNumber) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Apartment ID is required.');
        }
        if (!ownedMem) {
          return sendError(res, 403, 'FORBIDDEN', 'Only the apartment owner can invite tenants.');
        }
        apartmentId = ownedMem.apartment_id;
        apartmentNumber = ownedMem.apartment_number;

        const duplicateTenant = buildingInvitationsStore.find(
          (i) =>
            i.status === 'PENDING' &&
            i.kind === 'TENANT' &&
            i.apartment_number === apartmentNumber &&
            (i.raw_email.toLowerCase() === email.toLowerCase() ||
              i.masked_email === maskEmailServerSide(email))
        );
        if (duplicateTenant) {
          return sendError(
            res,
            409,
            'INVITATION_ALREADY_PENDING',
            'This person is already invited. Resend the invitation instead.'
          );
        }

        // Count active tenants + pending tenant invitations for this apartment
        let activeTenants = 0;
        for (const p of buildingUsersStore) {
          for (const m of p.memberships) {
            if (m.apartment_number === apartmentNumber && m.relation_type === 'TENANT') {
              activeTenants += 1;
            }
          }
        }
        const pendingTenants = buildingInvitationsStore.filter(
          (i) =>
            i.kind === 'TENANT' &&
            i.status === 'PENDING' &&
            i.apartment_number === apartmentNumber
        ).length;

        if (activeTenants + pendingTenants >= 3) {
          return sendError(
            res,
            409,
            'TENANT_LIMIT_REACHED',
            'At most 3 tenants per apartment, pending invitations included.'
          );
        }
      } else {
        // OWNER or STAFF requires CHAIRMAN
        if (authedUser.building_role !== 'CHAIRMAN') {
          return sendError(res, 403, 'FORBIDDEN', 'Only the chairman can invite owners or staff.');
        }
        if (kind === 'OWNER') {
          if (!apartmentNumber) {
            return sendError(res, 422, 'VALIDATION_ERROR', 'Apartment number is required.');
          }
          const aptNumInt = Number(apartmentNumber);
          if (!Number.isInteger(aptNumInt) || aptNumInt < 1 || aptNumInt > 36) {
            return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'There is no apartment with this number.');
          }
          apartmentId =
            NUMBER_TO_APARTMENT_ID[apartmentNumber] ||
            `018f0000-0000-7000-8000-0000000003${apartmentNumber.padStart(2, '0')}`;
        }
        if (kind === 'STAFF') {
          if (!buildingRole || !['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(buildingRole)) {
            return sendError(res, 422, 'VALIDATION_ERROR', 'Building role is required.');
          }
          apartmentId = null;
          apartmentNumber = null;
        }
      }

      const duplicate = buildingInvitationsStore.find(
        (i) =>
          i.status === 'PENDING' &&
          i.kind === kind &&
          i.apartment_number === apartmentNumber &&
          (i.raw_email.toLowerCase() === email.toLowerCase() ||
            i.masked_email === maskEmailServerSide(email))
      );
      if (duplicate) {
        return sendError(
          res,
          409,
          'INVITATION_ALREADY_PENDING',
          'This person is already invited. Resend the invitation instead.'
        );
      }

      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      const newInv: MockInvitation = {
        invitation_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        kind,
        status: 'PENDING',
        masked_email: maskEmailServerSide(email),
        raw_email: email.toLowerCase(),
        invited_by_user_id: authedUser.user_id,
        apartment_id: kind === 'STAFF' ? null : apartmentId,
        apartment_number: kind === 'STAFF' ? null : apartmentNumber,
        building_role: kind === 'STAFF' ? buildingRole : null,
        created_at: nowIso,
        expires_at: expiresIso,
      };
      buildingInvitationsStore.unshift(newInv);
      return sendJson(res, 201, toInvitationView(newInv, authedUser.user_id));
    }

    // A4: POST /api/v1/auth/invitations/{id}/resend
    const invResendMatch = pathname.match(/^\/api\/v1\/auth\/invitations\/([^/]+)\/resend$/);
    if (invResendMatch && method === 'POST') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const invId = invResendMatch[1];
      const inv = buildingInvitationsStore.find((i) => i.invitation_id === invId);
      if (!inv) {
        return sendError(res, 404, 'INVITATION_NOT_FOUND', 'Invitation not found.');
      }
      if (inv.status === 'ACCEPTED') {
        return sendError(
          res,
          409,
          'INVITATION_ACCEPTED',
          'The invitation was accepted. To take access away, end the membership.'
        );
      }
      if (inv.status === 'NO_LONGER_VALID') {
        return sendError(
          res,
          409,
          'INVITATION_NO_LONGER_VALID',
          'This invitation no longer applies. Delete it and invite again.'
        );
      }
      if (inv.status === 'EXPIRED' && inv.kind === 'TENANT' && inv.apartment_number) {
        let activeTenants = 0;
        for (const p of buildingUsersStore) {
          for (const m of p.memberships) {
            if (m.apartment_number === inv.apartment_number && m.relation_type === 'TENANT') {
              activeTenants += 1;
            }
          }
        }
        const pendingTenants = buildingInvitationsStore.filter(
          (i) =>
            i.kind === 'TENANT' &&
            i.status === 'PENDING' &&
            i.apartment_number === inv.apartment_number
        ).length;
        if (activeTenants + pendingTenants >= 3) {
          return sendError(
            res,
            409,
            'TENANT_LIMIT_REACHED',
            'At most 3 tenants per apartment, pending invitations included.'
          );
        }
      }
      inv.status = 'PENDING';
      inv.created_at = new Date().toISOString();
      inv.expires_at = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      return sendJson(res, 200, toInvitationView(inv, authedUser.user_id));
    }

    // A4: DELETE /api/v1/auth/invitations/{id}
    const invDeleteMatch = pathname.match(/^\/api\/v1\/auth\/invitations\/([^/]+)$/);
    if (invDeleteMatch && method === 'DELETE') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const invId = invDeleteMatch[1];
      const idx = buildingInvitationsStore.findIndex((i) => i.invitation_id === invId);
      if (idx === -1) {
        return sendError(res, 404, 'INVITATION_NOT_FOUND', 'Invitation not found.');
      }
      if (buildingInvitationsStore[idx].status === 'ACCEPTED') {
        return sendError(
          res,
          409,
          'INVITATION_ACCEPTED',
          'The invitation was accepted. To take access away, end the membership.'
        );
      }
      buildingInvitationsStore.splice(idx, 1);
      res.statusCode = 204;
      return res.end();
    }

    // A4: GET /api/v1/auth/apartments/{apartment_id}/residents
    const aptResidentsMatch = pathname.match(/^\/api\/v1\/auth\/apartments\/([^/]+)\/residents$/);
    if (aptResidentsMatch && method === 'GET') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const aptId = aptResidentsMatch[1];
      const callerMems = membershipsByUser[authedUser.user_id] || [];
      const ownedMem = callerMems.find(
        (m) => m.apartment_id === aptId && m.relation_type === 'OWNER'
      );
      const aptNumber = ownedMem?.apartment_number || APARTMENT_ID_TO_NUMBER[aptId];
      if (!aptNumber) {
        return sendError(res, 404, 'APARTMENT_NOT_FOUND', 'Apartment not found.');
      }
      if (!ownedMem) {
        return sendError(res, 403, 'FORBIDDEN', 'Only an owner of this apartment can view residents.');
      }

      const residents: Array<{
        user_id: string;
        membership_id: string;
        relation_type: 'OWNER' | 'TENANT';
        display_label: string;
        since: string;
        invited_email: string | null;
      }> = [];

      for (const person of buildingUsersStore) {
        for (const m of person.memberships) {
          if (m.apartment_number === aptNumber) {
            const isInvitedByMe = m.invited_by_user_id === authedUser.user_id;
            residents.push({
              user_id: person.user_id,
              membership_id: m.membership_id,
              relation_type: m.relation_type,
              display_label: m.display_label,
              since: m.since,
              invited_email:
                m.relation_type === 'TENANT'
                  ? isInvitedByMe
                    ? m.invited_email
                    : m.invited_email
                      ? maskEmailServerSide(m.invited_email)
                      : null
                  : null,
            });
          }
        }
      }

      const pendingInvitations = buildingInvitationsStore
        .filter(
          (i) =>
            i.kind === 'TENANT' &&
            (i.status === 'PENDING' || i.status === 'EXPIRED') &&
            i.apartment_number === aptNumber
        )
        .map((inv) => toInvitationView(inv, authedUser.user_id));

      return sendJson(res, 200, {
        residents,
        pending_invitations: pendingInvitations,
      });
    }

    // A4: DELETE /api/v1/auth/apartments/{apartment_id}/tenants/{user_id}
    const removeTenantMatch = pathname.match(
      /^\/api\/v1\/auth\/apartments\/([^/]+)\/tenants\/([^/]+)$/
    );
    if (removeTenantMatch && method === 'DELETE') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const [, aptId, targetId] = removeTenantMatch;
      const callerMems = membershipsByUser[authedUser.user_id] || [];
      const ownedMem = callerMems.find(
        (m) => m.apartment_id === aptId && m.relation_type === 'OWNER'
      );
      if (!ownedMem) {
        return sendError(res, 403, 'FORBIDDEN', 'Only an owner can remove tenants.');
      }

      let foundPerson: MockPersonSummary | null = null;
      for (const person of buildingUsersStore) {
        const idx = person.memberships.findIndex(
          (m) =>
            (person.user_id === targetId || m.membership_id === targetId) &&
            m.apartment_number === ownedMem.apartment_number &&
            m.relation_type === 'TENANT'
        );
        if (idx !== -1) {
          person.memberships.splice(idx, 1);
          foundPerson = person;
          break;
        }
      }
      if (!foundPerson) {
        return sendError(res, 404, 'MEMBERSHIP_NOT_FOUND', 'Tenant membership not found.');
      }
      if (foundPerson.memberships.length === 0 && foundPerson.building_role === 'USER') {
        buildingUsersStore = buildingUsersStore.filter((p) => p.user_id !== foundPerson!.user_id);
      }
      res.statusCode = 204;
      return res.end();
    }

    // A4: POST /api/v1/auth/apartments/{apartment_id}/tenants/{user_id}/replace
    const replaceTenantMatch = pathname.match(
      /^\/api\/v1\/auth\/apartments\/([^/]+)\/tenants\/([^/]+)\/replace$/
    );
    if (replaceTenantMatch && method === 'POST') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      const [, aptId, targetId] = replaceTenantMatch;
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      if (!isValidEmailFormat(email)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid email address.');
      }
      const callerMems = membershipsByUser[authedUser.user_id] || [];
      const ownedMem = callerMems.find(
        (m) => m.apartment_id === aptId && m.relation_type === 'OWNER'
      );
      if (!ownedMem) {
        return sendError(res, 403, 'FORBIDDEN', 'Only an owner can replace tenants.');
      }

      const duplicate = buildingInvitationsStore.find(
        (i) =>
          i.status === 'PENDING' &&
          i.kind === 'TENANT' &&
          i.apartment_number === ownedMem.apartment_number &&
          (i.raw_email.toLowerCase() === email.toLowerCase() ||
            i.masked_email === maskEmailServerSide(email))
      );
      if (duplicate) {
        return sendError(
          res,
          409,
          'INVITATION_ALREADY_PENDING',
          'This person is already invited. Resend the invitation instead.'
        );
      }

      let foundPerson: MockPersonSummary | null = null;
      for (const person of buildingUsersStore) {
        const idx = person.memberships.findIndex(
          (m) =>
            (person.user_id === targetId || m.membership_id === targetId) &&
            m.apartment_number === ownedMem.apartment_number &&
            m.relation_type === 'TENANT'
        );
        if (idx !== -1) {
          person.memberships.splice(idx, 1);
          foundPerson = person;
          break;
        }
      }
      if (!foundPerson) {
        return sendError(res, 404, 'MEMBERSHIP_NOT_FOUND', 'Tenant membership not found.');
      }
      if (foundPerson.memberships.length === 0 && foundPerson.building_role === 'USER') {
        buildingUsersStore = buildingUsersStore.filter((p) => p.user_id !== foundPerson!.user_id);
      }

      const nowIso = new Date().toISOString();
      const expiresIso = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
      const newInv: MockInvitation = {
        invitation_id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        kind: 'TENANT',
        status: 'PENDING',
        masked_email: maskEmailServerSide(email),
        raw_email: email.toLowerCase(),
        invited_by_user_id: authedUser.user_id,
        apartment_id: ownedMem.apartment_id,
        apartment_number: ownedMem.apartment_number,
        building_role: null,
        created_at: nowIso,
        expires_at: expiresIso,
      };
      buildingInvitationsStore.unshift(newInv);
      return sendJson(res, 201, toInvitationView(newInv, authedUser.user_id));
    }

    // A4: GET /api/v1/auth/users (Chairman People directory)
    if (pathname === '/api/v1/auth/users' && method === 'GET') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const people = buildingUsersStore.map((p) => ({
        user_id: p.user_id,
        is_me: p.user_id === authedUser.user_id,
        display_label: p.display_label,
        building_role: p.building_role,
        invited_email:
          p.invited_by_user_id === authedUser.user_id ? p.invited_email : null,
        memberships: p.memberships.map((m) => ({
          membership_id: m.membership_id,
          apartment_id: m.apartment_id,
          apartment_number: m.apartment_number,
          relation_type: m.relation_type,
          display_label: m.display_label,
          since: m.since,
          invited_email:
            m.invited_by_user_id === authedUser.user_id ? m.invited_email : null,
        })),
      }));
      return sendJson(res, 200, { people });
    }

    // A4: PUT /api/v1/auth/users/{user_id}/role
    const userRoleMatch = pathname.match(/^\/api\/v1\/auth\/users\/([^/]+)\/role$/);
    if (userRoleMatch && method === 'PUT') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const targetUserId = userRoleMatch[1];
      const body = await readBody(req);
      const nextRole = body.building_role as 'CHAIRMAN' | 'BOARD' | 'ACCOUNTANT' | 'USER';
      if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT', 'USER'].includes(nextRole)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid building role.');
      }
      const person = buildingUsersStore.find((p) => p.user_id === targetUserId);
      if (!person) {
        return sendError(res, 404, 'USER_NOT_FOUND', 'User not found.');
      }
      if (person.building_role === 'CHAIRMAN' && nextRole !== 'CHAIRMAN') {
        const chairmenCount = buildingUsersStore.filter(
          (p) => p.building_role === 'CHAIRMAN'
        ).length;
        if (chairmenCount <= 1) {
          return sendError(
            res,
            409,
            'LAST_CHAIRMAN',
            'The building needs a chairman. Make someone else chairman first.'
          );
        }
      }
      person.building_role = nextRole;
      const seedMatch = DEMO_USERS.find((u) => u.user_id === targetUserId);
      if (seedMatch) {
        seedMatch.building_role = nextRole;
      }

      if (nextRole === 'USER' && person.memberships.length === 0) {
        buildingUsersStore = buildingUsersStore.filter((p) => p.user_id !== targetUserId);
        return sendJson(res, 200, {
          user_id: targetUserId,
          building_role: nextRole,
          account_closed: true,
        });
      }
      return sendJson(res, 200, {
        user_id: targetUserId,
        building_role: nextRole,
        account_closed: false,
      });
    }

    // A4: DELETE /api/v1/auth/users/{user_id}/memberships/{membership_id}
    const endMemMatch = pathname.match(
      /^\/api\/v1\/auth\/users\/([^/]+)\/memberships\/([^/]+)$/
    );
    if (endMemMatch && method === 'DELETE') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const [, targetUserId, membershipId] = endMemMatch;
      const person = buildingUsersStore.find((p) => p.user_id === targetUserId);
      if (!person) {
        return sendError(res, 404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found.');
      }
      const memIdx = person.memberships.findIndex((m) => m.membership_id === membershipId);
      if (memIdx === -1) {
        return sendError(res, 404, 'MEMBERSHIP_NOT_FOUND', 'Membership not found.');
      }
      const [removedMem] = person.memberships.splice(memIdx, 1);

      if (removedMem.relation_type === 'OWNER') {
        const remainingOwners = buildingUsersStore.some((p) =>
          p.memberships.some(
            (m) =>
              m.apartment_number === removedMem.apartment_number &&
              m.relation_type === 'OWNER'
          )
        );
        if (!remainingOwners) {
          for (const inv of buildingInvitationsStore) {
            if (
              inv.kind === 'TENANT' &&
              inv.status === 'PENDING' &&
              inv.apartment_number === removedMem.apartment_number
            ) {
              inv.status = 'NO_LONGER_VALID';
            }
          }
        }
      }

      if (person.memberships.length === 0 && person.building_role === 'USER') {
        buildingUsersStore = buildingUsersStore.filter((p) => p.user_id !== targetUserId);
      }
      res.statusCode = 204;
      return res.end();
    }

    // A4: DELETE /api/v1/auth/users/{user_id}
    const closeUserMatch = pathname.match(/^\/api\/v1\/auth\/users\/([^/]+)$/);
    if (closeUserMatch && method === 'DELETE') {
      const authedUser = getBearerAuthenticatedUser(req);
      if (!authedUser) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      if (authedUser.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Chairman access required.');
      }
      const targetUserId = closeUserMatch[1];
      const person = buildingUsersStore.find((p) => p.user_id === targetUserId);
      if (!person) {
        return sendError(res, 404, 'USER_NOT_FOUND', 'User not found.');
      }
      if (person.building_role === 'CHAIRMAN') {
        const chairmenCount = buildingUsersStore.filter(
          (p) => p.building_role === 'CHAIRMAN'
        ).length;
        if (chairmenCount <= 1) {
          return sendError(
            res,
            409,
            'LAST_CHAIRMAN',
            'The building needs a chairman. Make someone else chairman first.'
          );
        }
      }
      buildingUsersStore = buildingUsersStore.filter((p) => p.user_id !== targetUserId);
      for (const mem of person.memberships) {
        if (mem.relation_type === 'OWNER') {
          const remainingOwners = buildingUsersStore.some((p) =>
            p.memberships.some(
              (m) =>
                m.apartment_number === mem.apartment_number && m.relation_type === 'OWNER'
            )
          );
          if (!remainingOwners) {
            for (const inv of buildingInvitationsStore) {
              if (
                inv.kind === 'TENANT' &&
                inv.status === 'PENDING' &&
                inv.apartment_number === mem.apartment_number
              ) {
                inv.status = 'NO_LONGER_VALID';
              }
            }
          }
        }
      }
      res.statusCode = 204;
      return res.end();
    }

    if (pathname === '/api/v1/auth/sessions' && method === 'GET') {
      const authHeader = req.headers['authorization'] || '';
      if (!String(authHeader).startsWith('Bearer ')) {
        return sendError(res, 401, 'NOT_AUTHENTICATED', 'Sign in required.');
      }
      return sendJson(res, 200, activeSessionsStore);
    }

    if (pathname === '/api/v1/auth/sessions' && method === 'DELETE') {
      activeSignedInUserId = null;
      activeSessionsStore = [];
      res.statusCode = 204;
      return res.end();
    }

    const sessionDeleteMatch = pathname.match(/^\/api\/v1\/auth\/sessions\/([^/]+)$/);
    if (sessionDeleteMatch && method === 'DELETE') {
      const targetId = sessionDeleteMatch[1];
      const idx = activeSessionsStore.findIndex((s) => s.session_id === targetId);
      if (idx === -1) {
        return sendError(res, 404, 'SESSION_NOT_FOUND', 'Session not found.');
      }
      const removed = activeSessionsStore[idx];
      activeSessionsStore.splice(idx, 1);
      if (removed.current) {
        activeSignedInUserId = null;
      }
      res.statusCode = 204;
      return res.end();
    }

    // 18. NOTIFICATIONS ENDPOINTS (Epic E1)
    if (pathname === '/api/v1/notifications/unread-count' && method === 'GET') {
      const list = getUserNotifications(user.user_id);
      const unreadCount = list.filter((n) => n.read_at === null).length;
      return sendJson(res, 200, { unread: unreadCount });
    }

    if (pathname === '/api/v1/notifications/feed' && method === 'GET') {
      const unreadOnly = urlObj.searchParams.get('unread_only') === 'true';
      const limit = Number(urlObj.searchParams.get('limit') || '50');
      const offset = Number(urlObj.searchParams.get('offset') || '0');
      const list = getUserNotifications(user.user_id);
      const filtered = unreadOnly ? list.filter((n) => n.read_at === null) : list;
      const paged = filtered.slice(offset, offset + limit).map(({ user_id, ...rest }) => rest);
      return sendJson(res, 200, paged);
    }

    if (pathname === '/api/v1/notifications/feed/read-all' && method === 'POST') {
      const list = getUserNotifications(user.user_id);
      const nowIso = new Date().toISOString();
      let updated = 0;
      for (const item of list) {
        if (item.read_at === null) {
          item.read_at = nowIso;
          updated += 1;
        }
      }
      return sendJson(res, 200, { updated });
    }

    const readOneMatch = pathname.match(/^\/api\/v1\/notifications\/feed\/([^/]+)\/read$/);
    if (readOneMatch && method === 'POST') {
      const notifId = readOneMatch[1];
      const list = getUserNotifications(user.user_id);
      const item = list.find((n) => n.id === notifId);
      if (!item) {
        return sendError(res, 404, 'NOTIFICATION_NOT_FOUND', 'Notification not found.');
      }
      if (!item.read_at) {
        item.read_at = new Date().toISOString();
      }
      return sendJson(res, 200, { id: item.id, read_at: item.read_at });
    }

    if (pathname === '/api/v1/notifications/preferences' && method === 'GET') {
      const prefs = getUserPreferences(user.user_id);
      return sendJson(res, 200, {
        channels: [
          { channel: 'in_app', available: true, reason: null },
          { channel: 'email', available: false, reason: 'DEMO_MODE' },
          { channel: 'telegram', available: false, reason: 'DEMO_MODE' },
          { channel: 'webpush', available: false, reason: 'DEMO_MODE' },
        ],
        preferences: prefs,
      });
    }

    if (pathname === '/api/v1/notifications/preferences' && method === 'PUT') {
      const body = await readBody(req);
      const changes = Array.isArray(body.preferences) ? body.preferences : [];
      if (changes.length < 1 || changes.length > 48) {
        return sendError(
          res,
          422,
          'VALIDATION_ERROR',
          'Provide between 1 and 48 preference changes.'
        );
      }
      const prefs = getUserPreferences(user.user_id);

      for (const chg of changes) {
        const match = prefs.find(
          (p) => p.event_type === chg.event_type && p.channel === chg.channel
        );
        if (match?.mandatory && chg.enabled === false) {
          return sendError(
            res,
            422,
            'PREFERENCE_MANDATORY',
            'Mandatory notifications cannot be switched off.'
          );
        }
      }

      for (const chg of changes) {
        const match = prefs.find(
          (p) => p.event_type === chg.event_type && p.channel === chg.channel
        );
        if (match && !match.mandatory) {
          match.enabled = Boolean(chg.enabled);
        }
      }

      return sendJson(res, 200, {
        channels: [
          { channel: 'in_app', available: true, reason: null },
          { channel: 'email', available: false, reason: 'DEMO_MODE' },
          { channel: 'telegram', available: false, reason: 'DEMO_MODE' },
          { channel: 'webpush', available: false, reason: 'DEMO_MODE' },
        ],
        preferences: prefs,
      });
    }

    if (pathname === '/api/v1/notifications/bindings' && method === 'GET') {
      return sendJson(res, 200, bindingsByUser[user.user_id] || []);
    }

    const deleteBindingMatch = pathname.match(/^\/api\/v1\/notifications\/bindings\/([^/]+)$/);
    if (deleteBindingMatch && method === 'DELETE') {
      const bId = deleteBindingMatch[1];
      const list = bindingsByUser[user.user_id] || [];
      bindingsByUser[user.user_id] = list.filter((b) => b.binding_id !== bId);
      res.statusCode = 204;
      return res.end();
    }

    if (pathname === '/api/v1/notifications/telegram/link-code' && method === 'POST') {
      return sendError(res, 404, 'CHANNEL_NOT_ENABLED', 'Telegram channel is not enabled in demo mode.');
    }

    if (pathname === '/api/v1/notifications/webpush/vapid-public-key' && method === 'GET') {
      return sendError(res, 404, 'CHANNEL_NOT_ENABLED', 'WebPush channel is not enabled in demo mode.');
    }

    if (pathname === '/api/v1/notifications/webpush/subscriptions' && method === 'POST') {
      return sendError(res, 404, 'CHANNEL_NOT_ENABLED', 'WebPush channel is not enabled in demo mode.');
    }

    if (pathname === '/api/v1/notifications/unsubscribe') {
      if (method !== 'POST') {
        return sendError(res, 405, 'METHOD_NOT_ALLOWED', 'Only POST is allowed.');
      }
      const token = urlObj.searchParams.get('token') || '';
      if (!token || token.length > 128) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Missing or invalid token.');
      }
      if (token.startsWith('demo-')) {
        const lower = token.toLowerCase();
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
                  : lower.includes('board')
                    ? 'APARTMENT_MESSAGE_TO_BOARD'
                    : lower.includes('message')
                      ? 'APARTMENT_MESSAGE'
                      : 'READING_DEADLINE';
        const prefs = getUserPreferences(user.user_id);
        const match = prefs.find((p) => p.event_type === eventType && p.channel === 'email');
        if (match && !match.mandatory) {
          match.enabled = false;
        }
        return sendJson(res, 200, {
          event_type: eventType,
          channel: 'email',
        });
      }
      return sendError(res, 400, 'INVALID_LINK', 'This unsubscribe link is invalid or expired.');
    }

    // =========================================================================
    // Governance Polls (/api/v1/governance/polls)
    // =========================================================================
    if (pathname === '/api/v1/governance/polls' && method === 'GET') {
      const statusFilter = urlObj.searchParams.get('status');
      const limit = Math.min(Math.max(Number(urlObj.searchParams.get('limit') || '50'), 1), 100);
      const offset = Math.max(Number(urlObj.searchParams.get('offset') || '0'), 0);

      if (statusFilter && !['DRAFT', 'OPEN', 'CLOSED', 'CANCELLED'].includes(statusFilter)) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid poll status filter.');
      }

      refreshExpiredPolls();
      const visible = pollsStore.filter((p) => {
        if (!isPollVisibleToUser(p, user)) return false;
        if (statusFilter && p.status !== statusFilter) return false;
        return true;
      });

      visible.sort(comparePollsOrder);
      const paged = visible.slice(offset, offset + limit).map((p) => toPollSummary(p, user));
      return sendJson(res, 200, paged);
    }

    if (pathname === '/api/v1/governance/polls' && method === 'POST') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members can create polls.');
      }
      const body = await readBody(req);
      const parsed = validateAndBuildServerPollDraft(body);
      if (!parsed.draft) {
        return sendError(
          res,
          parsed.errorStatus || 422,
          parsed.errorCode || 'VALIDATION_ERROR',
          parsed.errorMessage || 'Invalid poll draft.',
          parsed.errorExtra || {}
        );
      }
      const nowIso = new Date().toISOString();
      const created: InternalPoll = {
        id: `018f0000-0000-7000-8000-${Math.floor(100000000000 + Math.random() * 899999999999)}`,
        ...parsed.draft,
        status: 'DRAFT',
        opened_at: null,
        closed_at: null,
        cancelled_at: null,
        created_at: nowIso,
        ballots: [],
      };
      pollsStore.unshift(created);
      return sendJson(res, 201, toPollView(created, user));
    }

    const pollActionMatch = pathname.match(
      /^\/api\/v1\/governance\/polls\/([^/]+)\/(open|close|cancel)$/
    );
    if (pollActionMatch && method === 'POST') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members can manage polls.');
      }
      const [, pollId, action] = pollActionMatch;
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }

      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const maxFutureMs = nowMs + 366 * 86400 * 1000;

      if (action === 'open') {
        if (found.status !== 'DRAFT') {
          return sendError(res, 409, 'POLL_NOT_DRAFT', 'Only a draft poll can be opened.');
        }
        const closesMs = new Date(found.closes_at).getTime();
        if (Number.isNaN(closesMs) || closesMs <= nowMs || closesMs > maxFutureMs) {
          return sendError(
            res,
            422,
            'INVALID_DEADLINE',
            'The closing time must be in the future (at most one year ahead).'
          );
        }
        if (computePollElectorateCount(found) < 1) {
          return sendError(
            res,
            422,
            'POLL_HAS_NO_ELECTORATE',
            'Nobody in the target scope can answer this poll.'
          );
        }
        found.status = 'OPEN';
        found.opened_at = nowIso;
        emitPollOpenedNotifications(found, user, nowIso);
        return sendJson(res, 200, toPollView(found, user));
      }

      if (action === 'close') {
        if (found.status !== 'OPEN') {
          return sendError(res, 409, 'POLL_NOT_OPEN', 'Only an open poll can be closed.');
        }
        found.status = 'CLOSED';
        found.closed_at = nowIso;
        return sendJson(res, 200, toPollView(found, user));
      }

      if (action === 'cancel') {
        if (found.status !== 'OPEN') {
          return sendError(res, 409, 'POLL_NOT_OPEN', 'Only an open poll can be cancelled.');
        }
        found.status = 'CANCELLED';
        found.cancelled_at = nowIso;
        return sendJson(res, 200, toPollView(found, user));
      }
    }

    const pollDetailMatch = pathname.match(/^\/api\/v1\/governance\/polls\/([^/]+)$/);
    if (pollDetailMatch && method === 'GET') {
      const pollId = pollDetailMatch[1];
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found || !isPollVisibleToUser(found, user)) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      return sendJson(res, 200, toPollView(found, user));
    }

    if (pollDetailMatch && method === 'PUT') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members can edit poll drafts.');
      }
      const pollId = pollDetailMatch[1];
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      if (found.status !== 'DRAFT') {
        return sendError(res, 409, 'POLL_NOT_DRAFT', 'Only a draft poll can be edited.');
      }
      const body = await readBody(req);
      const parsed = validateAndBuildServerPollDraft(body);
      if (!parsed.draft) {
        return sendError(
          res,
          parsed.errorStatus || 422,
          parsed.errorCode || 'VALIDATION_ERROR',
          parsed.errorMessage || 'Invalid poll draft.',
          parsed.errorExtra || {}
        );
      }
      Object.assign(found, parsed.draft);
      return sendJson(res, 200, toPollView(found, user));
    }

    if (pollDetailMatch && method === 'DELETE') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members can delete poll drafts.');
      }
      const pollId = pollDetailMatch[1];
      refreshExpiredPolls();
      const idx = pollsStore.findIndex((p) => p.id === pollId);
      if (idx === -1) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      if (pollsStore[idx].status !== 'DRAFT') {
        return sendError(res, 409, 'POLL_NOT_DRAFT', 'Only a draft poll can be deleted.');
      }
      pollsStore.splice(idx, 1);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (pollDetailMatch && method === 'PATCH') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members can extend poll deadlines.');
      }
      const pollId = pollDetailMatch[1];
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      if (found.status !== 'OPEN') {
        return sendError(res, 409, 'POLL_NOT_OPEN', 'Only an open poll deadline can be extended.');
      }
      const body = await readBody(req);
      const nextClosesAt = typeof body?.closes_at === 'string' ? body.closes_at.trim() : '';
      const nextMs = new Date(nextClosesAt).getTime();
      const currentMs = new Date(found.closes_at).getTime();
      const maxFutureMs = Date.now() + 366 * 86400 * 1000;
      if (!nextClosesAt || Number.isNaN(nextMs) || nextMs <= currentMs || nextMs > maxFutureMs) {
        return sendError(
          res,
          422,
          'INVALID_DEADLINE',
          'The new deadline must be later than the current deadline (and at most one year from now).'
        );
      }
      found.closes_at = nextClosesAt;
      return sendJson(res, 200, toPollView(found, user));
    }

    const pollBallotMatch = pathname.match(/^\/api\/v1\/governance\/polls\/([^/]+)\/ballot$/);
    if (pollBallotMatch && method === 'PUT') {
      const pollId = pollBallotMatch[1];
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found || !isPollVisibleToUser(found, user)) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      if (found.status !== 'OPEN' || new Date(found.closes_at).getTime() <= Date.now()) {
        if (found.status === 'OPEN') {
          found.status = 'CLOSED';
          found.closed_at = found.closes_at;
        }
        return sendError(res, 409, 'POLL_NOT_OPEN', 'This poll has closed.');
      }

      const { canAnswer, answerableApartmentIds } = computePollAnswerability(found, user);
      if (!canAnswer) {
        return sendError(res, 403, 'NOT_ELIGIBLE', 'You cannot answer this poll.');
      }

      const body = await readBody(req);
      let targetApartmentId: string | null = null;

      if (found.unit === 'PERSON') {
        if (body.apartment_id !== undefined && body.apartment_id !== null) {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            'apartment_id must not be sent for a PERSON poll.'
          );
        }
      } else {
        if (body.apartment_id !== undefined && body.apartment_id !== null) {
          if (!answerableApartmentIds.includes(String(body.apartment_id))) {
            return sendError(res, 403, 'NOT_ELIGIBLE', 'You cannot answer for this apartment.');
          }
          targetApartmentId = String(body.apartment_id);
        } else if (answerableApartmentIds.length === 1) {
          targetApartmentId = answerableApartmentIds[0];
        } else {
          return sendError(
            res,
            422,
            'VALIDATION_ERROR',
            'Select which apartment is answering.'
          );
        }
      }

      const rawAnswers = Array.isArray(body.answers) ? body.answers : null;
      if (!rawAnswers) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'answers must be an array.');
      }

      const validationResult = validateIncomingBallotAnswers(found.questions, rawAnswers);
      if (!validationResult.valid) {
        return sendError(res, 422, 'INVALID_ANSWER', 'Invalid answer.', {
          question_id: validationResult.questionId,
          reason: validationResult.reason,
        });
      }

      const nowIso = new Date().toISOString();
      const existingIdx = found.ballots.findIndex((b) =>
        found.unit === 'APARTMENT'
          ? b.apartment_id === targetApartmentId
          : b.user_id === user.user_id
      );

      if (existingIdx >= 0) {
        found.ballots[existingIdx] = {
          ...found.ballots[existingIdx],
          updated_at: nowIso,
          answers: validationResult.normalizedAnswers,
        };
      } else {
        found.ballots.push({
          apartment_id: found.unit === 'APARTMENT' ? targetApartmentId : null,
          user_id: found.unit === 'PERSON' ? user.user_id : null,
          submitted_at: nowIso,
          updated_at: nowIso,
          answers: validationResult.normalizedAnswers,
        });
      }

      return sendJson(res, 200, toPollView(found, user));
    }

    const pollResultsMatch = pathname.match(/^\/api\/v1\/governance\/polls\/([^/]+)\/results$/);
    if (pollResultsMatch && method === 'GET') {
      const pollId = pollResultsMatch[1];
      refreshExpiredPolls();
      const found = pollsStore.find((p) => p.id === pollId);
      if (!found || !isPollVisibleToUser(found, user)) {
        return sendError(res, 404, 'POLL_NOT_FOUND', 'This poll is not available.');
      }
      const resultsAvailable =
        found.status === 'CLOSED' || (found.status === 'OPEN' && isBoard);
      if (!resultsAvailable) {
        return sendError(
          res,
          409,
          'RESULTS_NOT_AVAILABLE',
          'Results are not available for this poll.',
          { status: found.status }
        );
      }
      return sendJson(res, 200, computeServerPollResults(found, isBoard));
    }

    if (pathname === '/api/v1/settings' && method === 'GET') {
      if (!isBoard) {
        return sendError(res, 403, 'FORBIDDEN', 'Only board members and the chairman can view association settings.');
      }
      const ordered = [...associationSettingsStore].sort((a, b) => a.key.localeCompare(b.key));
      return sendJson(res, 200, { settings: ordered });
    }

    if (pathname === '/api/v1/settings' && method === 'PUT') {
      if (user.building_role !== 'CHAIRMAN') {
        return sendError(res, 403, 'FORBIDDEN', 'Only the chairman can update association settings.');
      }
      const body = await readBody(req);
      const outcome = validateAndApplySettingsUpdate(associationSettingsStore, body);
      if (!outcome.ok) {
        return sendError(res, 422, 'VALIDATION_ERROR', 'Invalid association settings update.', {
          errors: outcome.errors,
        });
      }
      associationSettingsStore = outcome.settings;
      return sendJson(res, 200, { settings: associationSettingsStore });
    }

    // =========================================================================
    // Issue Tracker (/api/v1/issues) - #012 (E9/I1)
    // =========================================================================
    if (pathname === '/api/v1/issues' || pathname.startsWith('/api/v1/issues/')) {
      const userMems = membershipsByUser[user.user_id] || [];
      if (!canUserAccessIssues(user, userMems)) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Only residents with an apartment and board members can access the issue tracker.'
        );
      }

      if (pathname === '/api/v1/issues/form' && method === 'GET') {
        const urgentEnabled = Boolean(
          readSettingFromStore(associationSettingsStore, 'issues.urgent_enabled', false)
        );
        const apartmentIds = userMems
          .slice()
          .sort((a, b) => a.apartment_number.localeCompare(b.apartment_number))
          .map((m) => m.apartment_id);
        return sendJson(res, 200, {
          urgent_enabled: urgentEnabled,
          apartment_ids: apartmentIds,
          entrances: [1, 2],
        });
      }

      if (pathname === '/api/v1/issues' && method === 'GET') {
        const result = queryIssuesStore(issuesStore, user, {
          status: urlObj.searchParams.get('status'),
          category: urlObj.searchParams.get('category'),
          entrance: urlObj.searchParams.get('entrance'),
          include_old: urlObj.searchParams.get('include_old'),
          limit: urlObj.searchParams.get('limit'),
          offset: urlObj.searchParams.get('offset'),
        });
        if (!result.ok) {
          return sendError(
            res,
            result.status || 422,
            result.errorCode || 'VALIDATION_ERROR',
            result.message || 'Invalid query.'
          );
        }
        return sendJson(res, 200, result.items);
      }

      if (pathname === '/api/v1/issues' && method === 'POST') {
        const body = await readBody(req);
        const requestedAptId =
          body?.apartment_id != null && body?.apartment_id !== ''
            ? String(body.apartment_id)
            : userMems[0]?.apartment_id;
        const matchedMem =
          userMems.find((m) => m.apartment_id === requestedAptId) || userMems[0];
        const reporterBadge =
          matchedMem?.preview_badge || resolveAuthorBadge(user.user_id);

        const outcome = createIssueInStore({
          issuesStore,
          settingsStore: associationSettingsStore,
          user,
          userMemberships: userMems,
          reporterBadge,
          body,
          buildingEntrances: [1, 2],
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Validation error.',
            outcome.extra || {}
          );
        }
        if (outcome.rawIssue) {
          const notifBatch = buildIssueReportedNotification(outcome.rawIssue, DEMO_USERS, user);
          emitServerIssueNotificationBatch(notifBatch as any);
        }
        return sendJson(res, 201, outcome.issue);
      }

      const issueStatusMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/status$/);
      if (issueStatusMatch && method === 'POST') {
        const issueId = issueStatusMatch[1];
        const found = issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const body = await readBody(req);
        const outcome = changeIssueStatusInStore({
          issuesStore,
          issue: found,
          user,
          body,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Cannot change issue status.',
            outcome.extra || {}
          );
        }
        for (const notifBatch of outcome.notifications || []) {
          emitServerIssueNotificationBatch(notifBatch as any);
        }
        return sendJson(res, 200, outcome.issue);
      }

      const issueUrgentClearMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/urgent\/clear$/);
      if (issueUrgentClearMatch && method === 'POST') {
        const issueId = issueUrgentClearMatch[1];
        const found = issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const outcome = clearIssueUrgentInStore({
          issue: found,
          user,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 409,
            outcome.errorCode || 'ISSUE_ENDED',
            outcome.message || 'Cannot clear urgent flag.'
          );
        }
        return sendJson(res, 200, outcome.issue);
      }

      const issueWithdrawMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/withdraw$/);
      if (issueWithdrawMatch && method === 'POST') {
        const issueId = issueWithdrawMatch[1];
        const found = issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const outcome = withdrawIssueInStore({ issue: found, user });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 409,
            outcome.errorCode || 'ISSUE_NOT_EDITABLE',
            outcome.message || 'Cannot withdraw issue.'
          );
        }
        return sendJson(res, 200, outcome.issue);
      }

      const issueFollowMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)\/follow$/);
      if (issueFollowMatch && (method === 'PUT' || method === 'DELETE')) {
        const issueId = issueFollowMatch[1];
        const found = issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const outcome = updateIssueFollowInStore({
          issue: found,
          user,
          follow: method === 'PUT',
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 409,
            outcome.errorCode || 'ISSUE_ENDED',
            outcome.message || 'Cannot update follow state.'
          );
        }
        return sendJson(res, 200, outcome.issue);
      }

      const issueDetailMatch = pathname.match(/^\/api\/v1\/issues\/([^/]+)$/);
      if (issueDetailMatch && method === 'GET') {
        const issueId = issueDetailMatch[1];
        const found = issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        return sendJson(res, 200, toIssueView(found, user));
      }

      if (issueDetailMatch && method === 'PATCH') {
        const issueId = issueDetailMatch[1];
        const found = issuesStore.find((item) => item.id === issueId);
        if (!found || !isIssueVisibleToUser(found, user, Date.now(), { byLink: true })) {
          return sendError(res, 404, 'ISSUE_NOT_FOUND', 'This issue is not available.');
        }
        const body = await readBody(req);
        const outcome = editIssueInStore({
          issue: found,
          user,
          body,
          buildingEntrances: [1, 2],
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Cannot edit issue.'
          );
        }
        return sendJson(res, 200, outcome.issue);
      }
    }

    // =========================================================================
    // Maintenance Calendar (/api/v1/maintenance) - #015 (E10/M1)
    // =========================================================================
    if (pathname === '/api/v1/maintenance/tasks' || pathname.startsWith('/api/v1/maintenance/tasks/')) {
      if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
        return sendError(res, 403, 'FORBIDDEN', 'Only the chairman and board members can access maintenance tasks.');
      }

      const today = getTodayDateInTallinn();

      // GET /api/v1/maintenance/tasks
      if (pathname === '/api/v1/maintenance/tasks' && method === 'GET') {
        const overdueReminderDays = Number(
          readSettingFromStore(associationSettingsStore, 'maintenance.overdue_reminder_days', 7)
        );
        publishMaintenanceTasksInStore({
          tasksStore: maintenanceStore,
          postsStore,
          today,
          overdueReminderDays,
          onNotification: dispatchServerMaintenanceAndNoticeNotifications,
        });

        const statusParam = (urlObj.searchParams.get('status') as string) || undefined;
        const stateParam = (urlObj.searchParams.get('state') as string) || undefined;
        const limitParam = urlObj.searchParams.get('limit') ? Number(urlObj.searchParams.get('limit')) : 50;
        const offsetParam = urlObj.searchParams.get('offset') ? Number(urlObj.searchParams.get('offset')) : 0;

        const list = queryTasksStore(
          maintenanceStore,
          { status: statusParam, state: stateParam, limit: limitParam, offset: offsetParam },
          today
        );
        return sendJson(res, 200, list);
      }

      // POST /api/v1/maintenance/tasks
      if (pathname === '/api/v1/maintenance/tasks' && method === 'POST') {
        const body = await readBody(req);
        const validated = validateTaskDraft(body, { today });
        if (!validated.valid) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Validation failed for maintenance task.', {
            errors: validated.errors,
          });
        }

        const p = validated.payload;
        const taskId = `task-${Date.now()}`;
        const occId = `occ-${Date.now()}`;
        const lead = p.lead_days;
        const dueDate = p.first_due_date;
        const occState = computeOccurrenceState(dueDate, lead, 'ACTIVE', today);

        const newTask: any = {
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
        };

        maintenanceStore.push(newTask);
        return sendJson(res, 201, toTaskView(newTask, today));
      }

      // POST /api/v1/maintenance/tasks/:taskId/pause
      const pauseMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)\/pause$/);
      if (pauseMatch && method === 'POST') {
        const taskId = pauseMatch[1];
        const found = maintenanceStore.find((t) => t.id === taskId);
        if (!found) {
          return sendError(res, 404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.');
        }
        if (found.status === 'ARCHIVED') {
          return sendError(res, 409, 'TASK_ARCHIVED', 'Task is archived.');
        }
        if (found.status !== 'ACTIVE') {
          return sendError(res, 409, 'INVALID_TASK_TRANSITION', 'Task must be ACTIVE to pause.', {
            status: found.status,
          });
        }
        found.status = 'PAUSED';
        found.updated_at = new Date().toISOString();
        return sendJson(res, 200, toTaskView(found, today));
      }

      // POST /api/v1/maintenance/tasks/:taskId/resume
      const resumeMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)\/resume$/);
      if (resumeMatch && method === 'POST') {
        const taskId = resumeMatch[1];
        const found = maintenanceStore.find((t) => t.id === taskId);
        if (!found) {
          return sendError(res, 404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.');
        }
        if (found.status === 'ARCHIVED') {
          return sendError(res, 409, 'TASK_ARCHIVED', 'Task is archived.');
        }
        if (found.status !== 'PAUSED') {
          return sendError(res, 409, 'INVALID_TASK_TRANSITION', 'Task must be PAUSED to resume.', {
            status: found.status,
          });
        }

        const body = await readBody(req);
        if (body.next_due_date) {
          if (body.occurrence_id && found.current?.occurrence_id && body.occurrence_id !== found.current.occurrence_id) {
            return sendError(res, 409, 'OCCURRENCE_CLOSED', 'Occurrence has already been closed.', {
              current_occurrence_id: found.current.occurrence_id,
            });
          }
          found.current.due_date = body.next_due_date;
          found.anchor_date = body.next_due_date;
        }

        found.status = 'ACTIVE';
        found.updated_at = new Date().toISOString();
        return sendJson(res, 200, toTaskView(found, today));
      }

      // POST /api/v1/maintenance/tasks/:taskId/archive
      const archiveMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)\/archive$/);
      if (archiveMatch && method === 'POST') {
        const taskId = archiveMatch[1];
        const found = maintenanceStore.find((t) => t.id === taskId);
        if (!found) {
          return sendError(res, 404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.');
        }
        if (found.status === 'ARCHIVED') {
          return sendError(res, 409, 'TASK_ARCHIVED', 'Task is already archived.');
        }

        found.status = 'ARCHIVED';
        found.current = null;
        found.archived_at = new Date().toISOString();
        found.updated_at = found.archived_at;
        return sendJson(res, 200, toTaskView(found, today));
      }

      // GET & PATCH /api/v1/maintenance/tasks/:taskId
      const detailMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)$/);
      if (detailMatch && method === 'GET') {
        const overdueReminderDays = Number(
          readSettingFromStore(associationSettingsStore, 'maintenance.overdue_reminder_days', 7)
        );
        publishMaintenanceTasksInStore({
          tasksStore: maintenanceStore,
          postsStore,
          today,
          overdueReminderDays,
          onNotification: dispatchServerMaintenanceAndNoticeNotifications,
        });

        const taskId = detailMatch[1];
        const found = maintenanceStore.find((t) => t.id === taskId);
        if (!found) {
          return sendError(res, 404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.');
        }
        return sendJson(res, 200, toTaskView(found, today));
      }

      if (detailMatch && method === 'PATCH') {
        const taskId = detailMatch[1];
        const found = maintenanceStore.find((t) => t.id === taskId);
        if (!found) {
          return sendError(res, 404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.');
        }
        if (found.status === 'ARCHIVED') {
          return sendError(res, 409, 'TASK_ARCHIVED', 'Task is archived and cannot be edited.');
        }

        const body = await readBody(req);

        if (body.occurrence_id && found.current?.occurrence_id && body.occurrence_id !== found.current.occurrence_id) {
          return sendError(res, 409, 'OCCURRENCE_CLOSED', 'Occurrence has already been closed.', {
            current_occurrence_id: found.current.occurrence_id,
          });
        }

        if (('period_unit' in body && !('period_count' in body)) || ('period_count' in body && !('period_unit' in body))) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'period_unit and period_count must be updated together.');
        }

        const unit = body.period_unit || found.period_unit;
        const count = body.period_count !== undefined ? body.period_count : found.period_count;
        const lead = body.lead_days !== undefined ? body.lead_days : found.lead_days;

        if (body.title !== undefined) {
          if (!body.title || typeof body.title !== 'string') {
            return sendError(res, 422, 'VALIDATION_ERROR', 'Title cannot be empty.');
          }
          found.title = body.title.trim();
          for (const entry of maintenanceLogStore) {
            if (entry.task_id === found.id) {
              entry.task_title = found.title;
            }
          }
        }

        if (body.instructions !== undefined) {
          found.instructions = body.instructions || '';
        }

        if (body.period_unit !== undefined && body.period_count !== undefined) {
          found.period_unit = unit;
          found.period_count = count;
        }

        if (body.lead_days !== undefined) {
          const maxLead = maxAllowedLeadDays(unit, count);
          if (lead < 0 || lead > maxLead) {
            return sendError(res, 422, 'VALIDATION_ERROR', `lead_days must be between 0 and ${maxLead}.`);
          }
          found.lead_days = lead;
        }

        if (body.notice !== undefined) {
          found.notice = body.notice;
        }

        if (body.next_due_date !== undefined) {
          if (found.current) {
            found.current.due_date = body.next_due_date;
            found.anchor_date = body.next_due_date;
          }
        }

        found.updated_at = new Date().toISOString();
        return sendJson(res, 200, toTaskView(found, today));
      }

      // POST /api/v1/maintenance/tasks/:taskId/done
      const doneMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)\/done$/);
      if (doneMatch && method === 'POST') {
        const taskId = doneMatch[1];
        const body = await readBody(req);
        const outcome = applyTaskDoneInStore({
          tasksStore: maintenanceStore,
          logStore: maintenanceLogStore,
          taskId,
          body,
          user,
          today,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Cannot mark maintenance task done.',
            outcome.extra || {}
          );
        }
        return sendJson(res, 201, outcome.result);
      }

      // POST /api/v1/maintenance/tasks/:taskId/skip
      const skipMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)\/skip$/);
      if (skipMatch && method === 'POST') {
        const taskId = skipMatch[1];
        const body = await readBody(req);
        const outcome = applyTaskSkipInStore({
          tasksStore: maintenanceStore,
          logStore: maintenanceLogStore,
          taskId,
          body,
          user,
          today,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Cannot skip maintenance task.',
            outcome.extra || {}
          );
        }
        return sendJson(res, 201, outcome.result);
      }
    }

    // =========================================================================
    // Maintenance Log (/api/v1/maintenance/log) - #016 (E10/M1)
    // =========================================================================
    if (pathname === '/api/v1/maintenance/log' && method === 'GET') {
      if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Only the chairman, board members, and accountant can view the maintenance log.'
        );
      }
      const outcome = queryMaintenanceLogStore(maintenanceLogStore, {
        task_id: urlObj.searchParams.get('task_id'),
        from: urlObj.searchParams.get('from'),
        to: urlObj.searchParams.get('to'),
        limit: urlObj.searchParams.get('limit'),
        offset: urlObj.searchParams.get('offset'),
      });
      if (!outcome.ok) {
        return sendError(
          res,
          outcome.status || 422,
          outcome.errorCode || 'VALIDATION_ERROR',
          outcome.message || 'Invalid maintenance log query.'
        );
      }
      return sendJson(res, 200, outcome.items);
    }

    const logEditMatch = pathname.match(/^\/api\/v1\/maintenance\/log\/([^/]+)$/);
    if (logEditMatch && method === 'PATCH') {
      const entryId = logEditMatch[1];
      const body = await readBody(req);
      const outcome = applyLogEditInStore({
        logStore: maintenanceLogStore,
        entryId,
        body,
        user,
      });
      if (!outcome.ok) {
        return sendError(
          res,
          outcome.status || 422,
          outcome.errorCode || 'VALIDATION_ERROR',
          outcome.message || 'Cannot edit maintenance log entry.'
        );
      }
      return sendJson(res, 200, outcome.entry);
    }

    return sendError(res, 404, 'NOT_FOUND', `Endpoint ${method} ${pathname} not found.`);
  };
}

let associationSettingsStore: SettingView[] = cloneDefaultAssociationSettings();
let issuesStore: any[] = createDefaultIssuesSeed();
let maintenanceStore: any[] = createDefaultMaintenanceSeed();
let maintenanceLogStore: any[] = createDefaultMaintenanceLogSeed();
