import type { IncomingMessage } from 'http';
import type {
  AuthorBadgeDTO,
  DemoUserView,
  DisplayMode,
  HistoryEntry,
  MasterMeterRow,
  MembershipView,
  MeterUnit,
  NotificationEventType,
  ObjectKind,
  PeriodDTO,
  PostCategory,
  PostOrigin,
  PostType,
  PreviousOrigin,
  ReadingSource,
  ReadingSummary,
  ResourceType,
  SettingView,
  SubjectType,
  TargetScope,
} from '../api/schema';
import {
  subDecimal,
} from '../utils/metersMockHelpers.js';
import {
  cloneDefaultAssociationSettings,
} from '../utils/associationSettings.js';
import {
  createDefaultIssuesSeed,
  type IssuePhotoIdempotencyEntry,
  type StoredIssueRecord,
} from '../utils/issues.js';
import {
  createDefaultDocumentsSeed,
  type DocumentIdempotencyEntry,
  type StoredDocumentRecord,
} from '../utils/documents.js';
import {
  computeStorageUsage,
  evaluateStorageThresholdNotification,
} from '../utils/storage.js';
import {
  createDefaultMaintenanceLogSeed,
  createDefaultMaintenanceSeed,
  type MaintenanceLogRecord,
  type MaintenanceTaskRecord,
} from '../utils/maintenance.js';
import type { StoredMockChatMessage } from '../utils/chat.js';
import type { RawBallotAnswerInput } from '../mocks/domains/governance.js';
import {
  createDemoEeBuildingFacts,
} from '../utils/buildingPassport.js';
import {
  computeNumberStats,
} from '../utils/pollValidation.js';
import {
  MOCK_APARTMENT_CARDS,
  MOCK_APARTMENT_ID_TO_KIND,
  MOCK_APARTMENT_ID_TO_NUMBER,
  MOCK_BASE_APARTMENTS_2026_10,
  MOCK_BUILDING_ID,
  MOCK_KNOWN_APARTMENT_ENTRANCES,
  MOCK_NUMBER_TO_APARTMENT_ID,
  compareMockPollsOrder,
  computeMockPollAnswerability,
  computeMockPollElectorateCount,
  computeMockPollResults,
  computeMockPreviewBadge,
  createDefaultMockPolls,
  createDefaultMockPosts,
  createDefaultMockUserPreferences,
  createInitialMockNotificationsForUser,
  getMockNoticeRecipientUserIds,
  isMockPollVisibleToUser,
  isValidMockEmailFormat,
  maskMockEmail,
  resolveMockEmailToDemoUserId,
  toMockPollSummary,
  toMockPollView,
  validateMockBallotAnswers,
} from '../mocks/domains/index.js';

export const BUILDING_ID = MOCK_BUILDING_ID;
export const DEMO_APARTMENT_CARDS = MOCK_APARTMENT_CARDS;
export const APARTMENT_ID_TO_KIND = MOCK_APARTMENT_ID_TO_KIND;


export interface SeedUser extends DemoUserView {
  full_name: string;
  initials: string;
}

export const DEMO_USERS: SeedUser[] = [
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

export function computePreviewBadge(
  user: SeedUser,
  apartmentNumber: string | null,
  mode: DisplayMode,
  apartmentKind?: ObjectKind | null
): AuthorBadgeDTO {
  return computeMockPreviewBadge(user, apartmentNumber, mode, apartmentKind);
}

export const membershipsByUser: Record<string, MembershipView[]> = {
  '018f0000-0000-7000-8000-000000000102': [
    {
      membership_id: '018f0000-0000-7000-8000-000000000214',
      apartment_id: '018f0000-0000-7000-8000-000000000314',
      apartment_number: '14',
      apartment_kind: 'APARTMENT',
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
    {
      membership_id: '018f0000-0000-7000-8000-000000000241',
      apartment_id: '018f0000-0000-7000-8000-000000000401',
      apartment_number: '1',
      apartment_kind: 'PARKING',
      entrance: null,
      floor: null,
      relation_type: 'OWNER',
      can_submit_readings: true,
      can_view_bills: true,
      can_vote: true,
      privacy_display_mode: 'FULL_NAME',
      since: '2026-01-12T10:00:00Z',
      preview_badge: {
        display_label: 'Kati Kask (P1)',
        role_badge: 'OWNER',
      },
    },
  ],
  '018f0000-0000-7000-8000-000000000101': [
    {
      membership_id: '018f0000-0000-7000-8000-000000000201',
      apartment_id: '018f0000-0000-7000-8000-000000000301',
      apartment_number: '01',
      apartment_kind: 'APARTMENT',
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
    {
      membership_id: '018f0000-0000-7000-8000-000000000242',
      apartment_id: '018f0000-0000-7000-8000-000000000412',
      apartment_number: '12',
      apartment_kind: 'GARAGE',
      entrance: null,
      floor: 0,
      relation_type: 'OWNER',
      can_submit_readings: true,
      can_view_bills: true,
      can_vote: true,
      privacy_display_mode: 'FULL_NAME',
      since: '2026-01-01T09:00:00Z',
      preview_badge: {
        display_label: 'Peeter Tamm (G12)',
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
      apartment_kind: 'APARTMENT',
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
      apartment_kind: 'APARTMENT',
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

export const periodsMap: Record<string, PeriodDTO> = {
  '2026-10': {
    period_code: '2026-10',
    status: 'OPEN_FOR_RESIDENTS',
    due_date: '2026-11-04T20:59:59Z',
  },
  '2026-09': {
    period_code: '2026-09',
    status: 'LOCKED',
    due_date: '2026-10-04T20:59:59Z',
  },
  '2026-08': {
    period_code: '2026-08',
    status: 'LOCKED',
    due_date: '2026-09-04T20:59:59Z',
  },
  '2026-07': {
    period_code: '2026-07',
    status: 'LOCKED',
    due_date: '2026-08-04T20:59:59Z',
  },
};
const INITIAL_PERIODS_MAP_SNAPSHOT = JSON.stringify(periodsMap);

export interface InternalMeter {
  meter_id: string;
  resource_type: ResourceType;
  serial_number: string | null;
  location_label: string;
  unit: MeterUnit;
  previous_value: string | null;
  needs_start?: boolean;
  historical_avg: string | null;
  reading: ReadingSummary | null;
}

export interface InternalApartment {
  apartment_id: string;
  apartment_number: string;
  apartment_kind: ObjectKind;
  entrance: number | null;
  floor: number | null;
  can_submit_readings: boolean;
  meters: InternalMeter[];
}

export const masterMetersByPeriod: Record<string, MasterMeterRow[]> = {
  '2026-10': [
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
  ],
};

export const apartmentsByPeriod: Record<string, InternalApartment[]> = {
  '2026-10': JSON.parse(JSON.stringify(MOCK_BASE_APARTMENTS_2026_10)),
};

// Populate historical periods 2026-09, 2026-08, 2026-07
for (const histCode of ['2026-09', '2026-08', '2026-07']) {
  apartmentsByPeriod[histCode] = JSON.parse(JSON.stringify(apartmentsByPeriod['2026-10'])).map(
    (apt: InternalApartment) => ({
      ...apt,
      can_submit_readings: false,
      meters: apt.meters.map((m) => {
        if (m.needs_start || m.previous_value === null || m.historical_avg === null) {
          return {
            ...m,
            previous_value: null,
            needs_start: true,
            reading: null,
          };
        }
        const prevHist = subDecimal(m.previous_value, m.historical_avg);
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
        };
      }),
    })
  );
  masterMetersByPeriod[histCode] = JSON.parse(JSON.stringify(masterMetersByPeriod['2026-10']));
}

// Populate current period 2026-11 based on 2026-10 readings (leave reading: null for residents to submit)
apartmentsByPeriod['2026-11'] = JSON.parse(JSON.stringify(apartmentsByPeriod['2026-10'])).map(
  (apt: InternalApartment) => ({
    ...apt,
    can_submit_readings: true,
    meters: apt.meters.map((m) => ({
      ...m,
      previous_value: m.reading ? m.reading.value : m.previous_value,
      needs_start: m.reading ? false : Boolean(m.needs_start),
      reading: null,
    })),
  })
);
masterMetersByPeriod['2026-11'] = JSON.parse(JSON.stringify(masterMetersByPeriod['2026-10'])).map(
  (mm: MasterMeterRow) => ({
    ...mm,
    previous_value: mm.reading ? mm.reading.value : mm.previous_value,
    needs_start: mm.reading ? false : Boolean(mm.needs_start),
    status: 'MISSING',
    reading: null,
  })
);

const INITIAL_APARTMENTS_BY_PERIOD_SNAPSHOT = JSON.stringify(apartmentsByPeriod);
const INITIAL_MASTER_METERS_BY_PERIOD_SNAPSHOT = JSON.stringify(masterMetersByPeriod);

export function findMeterInPeriod(periodCode: string, meterId: string): InternalMeter | null {
  const apts = apartmentsByPeriod[periodCode] || [];
  for (const apt of apts) {
    const m = apt.meters.find((item) => item.meter_id === meterId);
    if (m) return m;
  }
  return null;
}

export function computeMeterNextSubmission(
  meterId: string,
  aptCanSubmit: boolean,
  membershipCanSubmit: boolean
): {
  period_code: string;
  due_date: string;
  final: boolean;
  previous_value: string | null;
  needs_start: boolean;
  average_delta: string | null;
  reading: ReadingSummary | null;
} | null {
  if (!aptCanSubmit || !membershipCanSubmit) return null;
  const pPrev = periodsMap['2026-10'];
  const pCurr = periodsMap['2026-11'];
  const mPrev = findMeterInPeriod('2026-10', meterId);
  const mCurr = findMeterInPeriod('2026-11', meterId);

  const hasSubmittedPrev = Boolean(mPrev?.reading && mPrev.reading.source !== 'AUTO_ESTIMATED');
  const hasAnyCurr = Boolean(mCurr?.reading);

  if (pCurr) {
    if (pPrev && pPrev.status === 'OPEN_FOR_RESIDENTS' && mPrev && !hasSubmittedPrev && !hasAnyCurr) {
      return {
        period_code: pPrev.period_code,
        due_date: pPrev.due_date,
        final: true,
        previous_value: mPrev.previous_value,
        needs_start: Boolean(mPrev.needs_start),
        average_delta: mPrev.historical_avg,
        reading: null,
      };
    }

    if (pCurr.status === 'OPEN_FOR_RESIDENTS' && mCurr) {
      return {
        period_code: pCurr.period_code,
        due_date: pCurr.due_date,
        final: false,
        previous_value: mCurr.previous_value,
        needs_start: Boolean(mCurr.needs_start),
        average_delta: mCurr.historical_avg,
        reading: mCurr.reading ? { ...mCurr.reading } : null,
      };
    }

    return null;
  }

  if (pPrev && pPrev.status === 'OPEN_FOR_RESIDENTS' && mPrev) {
    return {
      period_code: pPrev.period_code,
      due_date: pPrev.due_date,
      final: false,
      previous_value: mPrev.previous_value,
      needs_start: Boolean(mPrev.needs_start),
      average_delta: mPrev.historical_avg,
      reading: mPrev.reading ? { ...mPrev.reading } : null,
    };
  }

  return null;
}

export const historyStore: Record<string, { meter_id: string; period_code: string; entries: HistoryEntry[] }> = {
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

export interface InternalComment {
  id: string;
  post_id: string;
  body: string;
  author_user_id: string;
  author_apartment_id: string | null;
  created_at: string;
  edited_at: string | null;
  hidden_at: string | null;
  hidden_reason: string | null;
  hidden_by_user_id?: string | null;
}

export interface InternalPost {
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
  target_kinds?: ObjectKind[] | null;
  is_active: boolean;
  comments_enabled: boolean;
  created_at: string;
  edited_at: string | null;
  hidden_at: string | null;
  hidden_reason: string | null;
  hidden_by_user_id?: string | null;
  acknowledged_by: Record<string, string>;
  comments: InternalComment[];
  origin?: PostOrigin | null;
}

export function createDefaultServerPosts(): InternalPost[] {
  return createDefaultMockPosts() as unknown as InternalPost[];
}

export const postsStore: InternalPost[] = createDefaultServerPosts();

export const userLocales: Record<string, 'et' | 'ru' | 'en' | null> = {};

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

export const notificationsByUser: Record<string, MockNotification[]> = {};

export function getInitialNotificationsForUser(userId: string): MockNotification[] {
  return createInitialMockNotificationsForUser(userId, {
    includeOfflineMaintenanceSeed: false,
  }) as MockNotification[];
}

export function getUserNotifications(userId: string): MockNotification[] {
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

export const preferencesByUser: Record<string, MockPreference[]> = {};

export function getUserPreferences(userId: string): MockPreference[] {
  if (!preferencesByUser[userId]) {
    preferencesByUser[userId] = createDefaultMockUserPreferences();
  }
  return preferencesByUser[userId];
}

export function getServerNoticeRecipientUserIds(
  notice: {
    target_scope?: string | null;
    target_entrance?: number | null;
    target_apartment_ids?: string[] | null;
    target_kinds?: string[] | null;
  },
  authorUserId?: string | null
): string[] {
  return getMockNoticeRecipientUserIds(notice, authorUserId);
}

export function dispatchServerMaintenanceAndNoticeNotifications(notif: {
  event_type: MockNotification['event_type'];
  subject_type: MockNotification['subject_type'];
  subject_id: string;
  params?: Record<string, unknown>;
  target_scope?: string | null;
  target_entrance?: number | null;
  target_apartment_ids?: string[] | null;
  target_kinds?: string[] | null;
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

export function emitServerIssueNotificationBatch(batch: {
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

export function checkAndEmitServerStorageAlert() {
  const currentUsage = computeStorageUsage({
    issuesStore,
    documentsStore,
    extraPendingDeletionBytes: serverExtraPendingDeletionBytes,
  });
  const triggered = evaluateStorageThresholdNotification(currentUsage, serverStorageAlertState);
  if (triggered) {
    const boardUserIds = ['018f0000-0000-7000-8000-000000000101', '018f0000-0000-7000-8000-000000000105'];
    emitServerIssueNotificationBatch({
      recipientUserIds: boardUserIds,
      event_type: 'STORAGE_ALMOST_FULL',
      subject_type: 'storage',
      subject_id: 'storage',
      params: {
        threshold: triggered.threshold,
        used_percent: triggered.used_percent,
      },
      created_at: new Date().toISOString(),
    });
  }
}

export function emitApartmentThreadNotifications(
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
    const aptKind = APARTMENT_ID_TO_KIND[targetApartmentId] || 'APARTMENT';

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
            apartment_kind: aptKind,
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
            apartment_kind: aptKind,
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

export const bindingsByUser: Record<string, MockBinding[]> = {};

export function resolveAuthorBadge(
  userId: string,
  postType?: PostType,
  targetApartmentId?: string | null,
  strictApartment = false
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
    (strictApartment ? null : mems[0] || null);
  const mode = matchingMem?.privacy_display_mode || 'FULL_NAME';
  return computePreviewBadge(
    user,
    matchingMem?.apartment_number || null,
    mode,
    matchingMem?.apartment_kind,
  );
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
export const passwordsByUser: Record<string, string | null> = {
  '018f0000-0000-7000-8000-000000000101': 'demo-password-ok',
  '018f0000-0000-7000-8000-000000000102': 'demo-password-ok',
  '018f0000-0000-7000-8000-000000000103': null,
};
let passwordLoginFailures = 0;

interface MockPersonMembership {
  membership_id: string;
  apartment_id: string;
  apartment_number: string;
  apartment_kind?: ObjectKind;
  relation_type: 'OWNER' | 'TENANT';
  display_label: string;
  invited_email: string | null;
  invited_by_user_id: string | null;
  since: string;
}

export interface MockPersonSummary {
  user_id: string;
  display_label: string;
  building_role: 'CHAIRMAN' | 'BOARD' | 'ACCOUNTANT' | 'USER';
  invited_email: string | null;
  invited_by_user_id: string | null;
  memberships: MockPersonMembership[];
}

export interface MockInvitation {
  invitation_id: string;
  kind: 'OWNER' | 'TENANT' | 'STAFF';
  status: 'PENDING' | 'ACCEPTED' | 'EXPIRED' | 'NO_LONGER_VALID';
  masked_email: string;
  raw_email: string;
  invited_by_user_id: string;
  apartment_id: string | null;
  apartment_number: string | null;
  apartment_kind?: ObjectKind | null;
  building_role: 'CHAIRMAN' | 'BOARD' | 'ACCOUNTANT' | null;
  created_at: string;
  expires_at: string;
}

export const APARTMENT_ID_TO_NUMBER: Record<string, string> = MOCK_APARTMENT_ID_TO_NUMBER;
export const NUMBER_TO_APARTMENT_ID: Record<string, string> = MOCK_NUMBER_TO_APARTMENT_ID;

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
        apartment_kind: 'APARTMENT',
        relation_type: 'OWNER',
        display_label: 'Oleg Sidorov (Apt. 01)',
        invited_email: null,
        invited_by_user_id: null,
        since: '2021-03-10T10:00:00Z',
      },
      {
        membership_id: '018f0000-0000-7000-8000-000000000242',
        apartment_id: '018f0000-0000-7000-8000-000000000412',
        apartment_number: '12',
        apartment_kind: 'GARAGE',
        relation_type: 'OWNER',
        display_label: 'Oleg Sidorov (G12)',
        invited_email: null,
        invited_by_user_id: null,
        since: '2026-01-01T09:00:00Z',
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
        apartment_kind: 'APARTMENT',
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
        apartment_kind: 'APARTMENT',
        relation_type: 'TENANT',
        display_label: 'Apt. 15',
        invited_email: 'i***@demo.invalid',
        invited_by_user_id: '018f0000-0000-7000-8000-000000000105',
        since: '2025-05-01T10:00:00Z',
      },
      {
        membership_id: '018f0000-0000-7000-8000-000000000241',
        apartment_id: '018f0000-0000-7000-8000-000000000401',
        apartment_number: '1',
        apartment_kind: 'PARKING',
        relation_type: 'OWNER',
        display_label: 'I. P. (P1)',
        invited_email: 'ivan.petrov@demo.invalid',
        invited_by_user_id: '018f0000-0000-7000-8000-000000000101',
        since: '2026-01-12T10:00:00Z',
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
        apartment_kind: 'APARTMENT',
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
        apartment_kind: 'APARTMENT',
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
    apartment_kind: 'APARTMENT',
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
    apartment_kind: 'APARTMENT',
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
    apartment_kind: null,
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
    apartment_kind: 'APARTMENT',
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
    apartment_kind: 'APARTMENT',
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
    apartment_kind: 'APARTMENT',
    building_role: null,
    created_at: '2026-07-04T10:00:00Z',
    expires_at: '2026-07-11T10:00:00Z',
  },
];

export function maskEmailServerSide(email: string): string {
  return maskMockEmail(email);
}

export function toInvitationView(inv: MockInvitation, viewerUserId?: string) {
  const mine = viewerUserId ? inv.invited_by_user_id === viewerUserId : true;
  return {
    invitation_id: inv.invitation_id,
    kind: inv.kind,
    email: mine ? inv.raw_email : inv.masked_email,
    apartment_id: inv.apartment_id,
    apartment_number: inv.apartment_number,
    apartment_kind: inv.kind === 'STAFF' ? null : (inv.apartment_kind ?? 'APARTMENT'),
    building_role: inv.building_role,
    status: inv.status,
    mine,
    created_at: inv.created_at,
    expires_at: inv.expires_at,
  };
}

export function isValidEmailFormat(email: string): boolean {
  return isValidMockEmailFormat(email);
}

export function resolveEmailToDemoUserId(email: string): string {
  return resolveMockEmailToDemoUserId(email);
}

export function getBearerAuthenticatedUser(req: IncomingMessage): SeedUser | null {
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

export function getActingUser(req: IncomingMessage): SeedUser {
  const bearerUser = getBearerAuthenticatedUser(req);
  if (bearerUser) return bearerUser;
  const headerId = req.headers['x-demo-user-id'] as string | undefined;
  return DEMO_USERS.find((u) => u.user_id === headerId) || DEMO_USERS[0];
}


export interface InternalPollOption {
  id: string;
  position: number;
  value: string;
}

export interface InternalPollQuestion {
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

export interface InternalPollAnswer {
  question_id: string;
  option_ids: string[];
  value: string | null;
}

export interface InternalPollBallot {
  apartment_id: string | null;
  user_id: string | null;
  submitted_at: string;
  updated_at: string;
  answers: InternalPollAnswer[];
}

export interface InternalPoll {
  id: string;
  kind: 'INFORMATIVE';
  title: string;
  description: string;
  status: 'DRAFT' | 'OPEN' | 'CLOSED' | 'CANCELLED';
  target_scope: TargetScope;
  target_entrance: number | null;
  target_apartment_ids: string[] | null;
  target_kinds?: ObjectKind[] | null;
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

export const pollsStore: InternalPoll[] = createDefaultMockPolls();

export function refreshExpiredPolls() {
  const nowMs = Date.now();
  for (const p of pollsStore) {
    if (p.status === 'OPEN' && new Date(p.closes_at).getTime() <= nowMs) {
      p.status = 'CLOSED';
      p.closed_at = p.closes_at;
    }
  }
}

export function isPollVisibleToUser(poll: InternalPoll, user: SeedUser): boolean {
  return isMockPollVisibleToUser(poll, user, membershipsByUser);
}

export function computePollAnswerability(poll: InternalPoll, user: SeedUser): {
  canAnswer: boolean;
  answerableApartmentIds: string[];
} {
  return computeMockPollAnswerability(poll, user, membershipsByUser);
}

export function comparePollsOrder(a: InternalPoll, b: InternalPoll): number {
  return compareMockPollsOrder(a, b);
}

export function toPollSummary(poll: InternalPoll, user: SeedUser) {
  return toMockPollSummary(poll, user, membershipsByUser);
}

export function toPollView(poll: InternalPoll, user: SeedUser) {
  return toMockPollView(poll, user, membershipsByUser);
}

export const KNOWN_APARTMENT_ENTRANCES: Record<string, number | null> = MOCK_KNOWN_APARTMENT_ENTRANCES;

export function computePollElectorateCount(poll: InternalPoll): number {
  return computeMockPollElectorateCount(poll, membershipsByUser);
}

export function computeServerNumberStats(values: string[]) {
  return computeNumberStats(values);
}

export function computeServerPollResults(poll: InternalPoll, isBoardUser: boolean) {
  return computeMockPollResults(poll, isBoardUser, membershipsByUser);
}

export function validateAndBuildServerPollDraft(body: Record<string, unknown>): {
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
  if (!['ALL_BUILDING', 'ALL_OBJECTS', 'KINDS', 'ENTRANCE', 'APARTMENT_LIST'].includes(targetScope)) {
    return {
      errorStatus: 422,
      errorCode: 'INVALID_TARGET',
      errorMessage: 'Invalid target_scope.',
    };
  }

  let targetEntrance: number | null = null;
  let targetApartmentIds: string[] | null = null;
  let targetKinds: Array<'APARTMENT' | 'PARKING' | 'GARAGE'> | null = null;

  const hasKindsInput = Array.isArray(body.target_kinds) && body.target_kinds.length > 0;

  if (targetScope === 'ALL_BUILDING' || targetScope === 'ALL_OBJECTS') {
    if (
      body.target_entrance != null ||
      (Array.isArray(body.target_apartment_ids) && body.target_apartment_ids.length > 0) ||
      hasKindsInput
    ) {
      return {
        errorStatus: 422,
        errorCode: 'INVALID_TARGET',
        errorMessage: `target_entrance, target_apartment_ids, and target_kinds must be null for ${targetScope}.`,
      };
    }
  } else if (targetScope === 'KINDS') {
    if (
      body.target_entrance != null ||
      (Array.isArray(body.target_apartment_ids) && body.target_apartment_ids.length > 0) ||
      !Array.isArray(body.target_kinds) ||
      body.target_kinds.length === 0
    ) {
      return {
        errorStatus: 422,
        errorCode: 'INVALID_TARGET',
        errorMessage: 'Non-empty target_kinds is required for KINDS scope.',
      };
    }
    const rawKinds = Array.from(new Set(body.target_kinds.map((k: unknown) => String(k).toUpperCase())));
    const unknownKinds = rawKinds.filter((k) => !['APARTMENT', 'PARKING', 'GARAGE'].includes(k));
    if (unknownKinds.length > 0) {
      return {
        errorStatus: 422,
        errorCode: 'INVALID_TARGET',
        errorMessage: 'Unknown object kind in target_kinds.',
        errorExtra: { unknown_kinds: unknownKinds },
      };
    }
    targetKinds = rawKinds as Array<'APARTMENT' | 'PARKING' | 'GARAGE'>;
  } else if (targetScope === 'ENTRANCE') {
    const ent = Number(body.target_entrance);
    if (!Number.isInteger(ent) || ![1, 2].includes(ent) || body.target_apartment_ids != null || hasKindsInput) {
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
      hasKindsInput ||
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
      new Set<string>(body.target_apartment_ids.map((id: unknown) => String(id)))
    );
    for (const aptId of deduped) {
      if (!(aptId in KNOWN_APARTMENT_ENTRANCES)) {
        return {
          errorStatus: 422,
          errorCode: 'INVALID_TARGET',
          errorMessage: 'Unknown apartment in target_apartment_ids.',
        };
      }
    }
    targetApartmentIds = deduped;
  }

  const eligibility = typeof body?.eligibility === 'string' ? body.eligibility : '';
  if (!['RESIDENTS', 'OWNERS'].includes(eligibility)) {
    return {
      errorStatus: 422,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'Invalid eligibility.',
    };
  }

  const unit = typeof body?.unit === 'string' ? body.unit : '';
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
    const rq = (rawQuestions[i] && typeof rawQuestions[i] === 'object'
      ? rawQuestions[i]
      : {}) as Record<string, unknown>;
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
    const mode = typeof rq.answer_mode === 'string' ? rq.answer_mode : '';
    const vType = typeof rq.value_type === 'string' ? rq.value_type : '';
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
      answer_mode: mode as InternalPollQuestion['answer_mode'],
      value_type: vType as InternalPollQuestion['value_type'],
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
      target_kinds: targetKinds,
      eligibility: eligibility as InternalPoll['eligibility'],
      unit: unit as InternalPoll['unit'],
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

export function emitPollOpenedNotifications(
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

export function normalizeServerDecimal(raw: string): string {
  const t = raw.trim();
  const neg = t.startsWith('-');
  const unsigned = neg ? t.slice(1) : t;
  const [ip, fp = ''] = unsigned.split('.');
  const cleanInt = ip.replace(/^0+(?=\d)/, '') || '0';
  const cleanFrac = fp.replace(/0+$/, '');
  if (cleanInt === '0' && cleanFrac === '') return '0';
  return `${neg ? '-' : ''}${cleanInt}${cleanFrac ? `.${cleanFrac}` : ''}`;
}

export function validateIncomingBallotAnswers(
  questions: InternalPollQuestion[],
  rawAnswers: RawBallotAnswerInput[]
): {
  valid: boolean;
  questionId?: string;
  reason?: string;
  normalizedAnswers: InternalPollAnswer[];
} {
  return validateMockBallotAnswers(questions, rawAnswers);
}

let associationSettingsStore: SettingView[] = cloneDefaultAssociationSettings();
let issuesStore: StoredIssueRecord[] = createDefaultIssuesSeed();
export const issuePhotoIdempotencyStore = new Map<string, IssuePhotoIdempotencyEntry>();
export const issuePhotoDailyUploadsStore: Array<{ userId: string; bytes: number; atMs: number }> = [];
export const activePhotoUploadsByUser = new Map<string, number>();
let documentsStore: StoredDocumentRecord[] = createDefaultDocumentsSeed();
export const documentIdempotencyStore = new Map<string, DocumentIdempotencyEntry>();
export const activeDocumentUploadsByUser = new Map<string, number>();
let maintenanceStore: MaintenanceTaskRecord[] = createDefaultMaintenanceSeed();
let maintenanceLogStore: MaintenanceLogRecord[] = createDefaultMaintenanceLogSeed();
let serverExtraPendingDeletionBytes = 0;
let serverStorageAlertState = { armed70: true, armed90: true };
let chatTurnedOnAt: string | null = null;
let chatMessagesStore: StoredMockChatMessage[] = [];
let chatNextId = 1;
let chatPostTimestampsByUser: Record<string, number[]> = {};

export function createInitialServerRegistryState() {
  return {
    accepted: createDemoEeBuildingFacts('2026-11-15T09:00:00Z') as ReturnType<typeof createDemoEeBuildingFacts> | null,
    accepted_at: '2026-11-15T09:05:00Z' as string | null,
    proposal: null as ReturnType<typeof createDemoEeBuildingFacts> | null,
    proposal_fetched_at: null as string | null,
  };
}

let buildingRegistryState = createInitialServerRegistryState();
export const REGISTRY_CALLS_PER_DAY = 10;
let registryDailyCalls = { date: '', count: 0 };

export function checkAndConsumeRegistryQuota(): { retry_after_seconds: number } | null {
  const nowMs = Date.now();
  const todayUtc = new Date(nowMs).toISOString().slice(0, 10);
  if (registryDailyCalls.date !== todayUtc) {
    registryDailyCalls = { date: todayUtc, count: 0 };
  }
  if (registryDailyCalls.count >= REGISTRY_CALLS_PER_DAY) {
    const now = new Date(nowMs);
    const nextMidnightMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
    );
    return {
      retry_after_seconds: Math.max(1, Math.ceil((nextMidnightMs - nowMs) / 1000)),
    };
  }
  registryDailyCalls.count += 1;
  return null;
}

export function resetApiMiddlewareStateForTest() {
  postsStore.splice(0, postsStore.length, ...createDefaultServerPosts());
  associationSettingsStore = cloneDefaultAssociationSettings();
  issuesStore = createDefaultIssuesSeed();
  issuePhotoIdempotencyStore.clear();
  issuePhotoDailyUploadsStore.length = 0;
  activePhotoUploadsByUser.clear();
  documentsStore = createDefaultDocumentsSeed();
  documentIdempotencyStore.clear();
  activeDocumentUploadsByUser.clear();
  maintenanceStore = createDefaultMaintenanceSeed();
  maintenanceLogStore = createDefaultMaintenanceLogSeed();
  for (const key of Object.keys(periodsMap)) delete periodsMap[key];
  Object.assign(periodsMap, JSON.parse(INITIAL_PERIODS_MAP_SNAPSHOT));
  for (const key of Object.keys(apartmentsByPeriod)) delete apartmentsByPeriod[key];
  Object.assign(apartmentsByPeriod, JSON.parse(INITIAL_APARTMENTS_BY_PERIOD_SNAPSHOT));
  for (const key of Object.keys(masterMetersByPeriod)) delete masterMetersByPeriod[key];
  Object.assign(masterMetersByPeriod, JSON.parse(INITIAL_MASTER_METERS_BY_PERIOD_SNAPSHOT));
  serverExtraPendingDeletionBytes = 0;
  serverStorageAlertState = { armed70: true, armed90: true };
  chatTurnedOnAt = null;
  chatMessagesStore = [];
  chatNextId = 1;
  chatPostTimestampsByUser = {};
  buildingRegistryState = createInitialServerRegistryState();
  registryDailyCalls = { date: '', count: 0 };
}



export const serverStore = {
  get pendingMagicLinkEmail() { return pendingMagicLinkEmail; },
  set pendingMagicLinkEmail(val) { pendingMagicLinkEmail = val; },
  get magicLinkTokenUsed() { return magicLinkTokenUsed; },
  set magicLinkTokenUsed(val) { magicLinkTokenUsed = val; },
  get activeSignedInUserId() { return activeSignedInUserId; },
  set activeSignedInUserId(val) { activeSignedInUserId = val; },
  get activeSessionsStore() { return activeSessionsStore; },
  set activeSessionsStore(val) { activeSessionsStore = val; },
  get passwordLoginFailures() { return passwordLoginFailures; },
  set passwordLoginFailures(val) { passwordLoginFailures = val; },
  get buildingUsersStore() { return buildingUsersStore; },
  set buildingUsersStore(val) { buildingUsersStore = val; },
  get buildingInvitationsStore() { return buildingInvitationsStore; },
  set buildingInvitationsStore(val) { buildingInvitationsStore = val; },
  get associationSettingsStore() { return associationSettingsStore; },
  set associationSettingsStore(val) { associationSettingsStore = val; },
  get issuesStore() { return issuesStore; },
  set issuesStore(val) { issuesStore = val; },
  get documentsStore() { return documentsStore; },
  set documentsStore(val) { documentsStore = val; },
  get maintenanceStore() { return maintenanceStore; },
  set maintenanceStore(val) { maintenanceStore = val; },
  get maintenanceLogStore() { return maintenanceLogStore; },
  set maintenanceLogStore(val) { maintenanceLogStore = val; },
  get serverExtraPendingDeletionBytes() { return serverExtraPendingDeletionBytes; },
  set serverExtraPendingDeletionBytes(val) { serverExtraPendingDeletionBytes = val; },
  get serverStorageAlertState() { return serverStorageAlertState; },
  set serverStorageAlertState(val) { serverStorageAlertState = val; },
  get chatTurnedOnAt() { return chatTurnedOnAt; },
  set chatTurnedOnAt(val) { chatTurnedOnAt = val; },
  get chatMessagesStore() { return chatMessagesStore; },
  set chatMessagesStore(val) { chatMessagesStore = val; },
  get chatNextId() { return chatNextId; },
  set chatNextId(val) { chatNextId = val; },
  get chatPostTimestampsByUser() { return chatPostTimestampsByUser; },
  set chatPostTimestampsByUser(val) { chatPostTimestampsByUser = val; },
  get buildingRegistryState() { return buildingRegistryState; },
  set buildingRegistryState(val) { buildingRegistryState = val; },
  get registryDailyCalls() { return registryDailyCalls; },
  set registryDailyCalls(val) { registryDailyCalls = val; },
  get paperApartmentIds() { return paperApartmentIds; },
  set paperApartmentIds(val) { paperApartmentIds = val; },
  get joinCodesStore() { return joinCodesStore; },
  set joinCodesStore(val) { joinCodesStore = val; },
  get joinRequestsStore() { return joinRequestsStore; },
  set joinRequestsStore(val) { joinRequestsStore = val; },
  get joinDecisionsStore() { return joinDecisionsStore; },
  set joinDecisionsStore(val) { joinDecisionsStore = val; },
};

export interface MockJoinCodeRecord {
  code_id: string;
  apartment_id: string;
  apartment_number: string;
  apartment_kind: 'APARTMENT' | 'PARKING' | 'GARAGE';
  join_code: string;
  created_at: string;
  expires_at: string;
}

export interface MockJoinRequestRecord {
  request_id: string;
  apartment_id: string;
  apartment_number: string;
  apartment_kind: 'APARTMENT' | 'PARKING' | 'GARAGE';
  full_name: string;
  phone: string;
  email: string;
  locale: 'en' | 'et' | 'ru' | null;
  created_at: string;
}

export interface MockJoinDecisionRecord {
  apartment_id: string | null;
  apartment_number: string | null;
  apartment_kind: 'APARTMENT' | 'PARKING' | 'GARAGE' | null;
  outcome: 'CONFIRMED' | 'REJECTED' | 'EXPIRED';
  decided_by_user_id: string | null;
  decided_at: string;
}

let paperApartmentIds = new Set<string>(['018f0000-0000-7000-8000-000000000303']);
let joinCodesStore: MockJoinCodeRecord[] = [
  {
    code_id: '018f0000-0000-7000-8000-000000007101',
    apartment_id: '018f0000-0000-7000-8000-000000000302',
    apartment_number: '02',
    apartment_kind: 'APARTMENT',
    join_code: 'K7QF-M3TX-9R',
    created_at: '2026-11-20T09:00:00Z',
    expires_at: new Date(Date.now() + 25 * 86400 * 1000).toISOString(),
  },
];
let joinRequestsStore: MockJoinRequestRecord[] = [
  {
    request_id: '018f0000-0000-7000-8000-000000007201',
    apartment_id: '018f0000-0000-7000-8000-000000000304',
    apartment_number: '04',
    apartment_kind: 'APARTMENT',
    full_name: 'Liis Mägi',
    phone: '+37255512345',
    email: 'liis.magi@demo.invalid',
    locale: 'et',
    created_at: '2026-11-24T14:20:00Z',
  },
];
let joinDecisionsStore: MockJoinDecisionRecord[] = [
  {
    apartment_id: '018f0000-0000-7000-8000-000000000301',
    apartment_number: '01',
    apartment_kind: 'APARTMENT',
    outcome: 'CONFIRMED',
    decided_by_user_id: '018f0000-0000-7000-8000-000000000101',
    decided_at: '2026-11-18T11:15:00Z',
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000402',
    apartment_number: 'P-2',
    apartment_kind: 'PARKING',
    outcome: 'EXPIRED',
    decided_by_user_id: null,
    decided_at: '2026-11-10T00:00:00Z',
  },
];
