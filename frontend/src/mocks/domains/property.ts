/**
 * Shared identity, building, apartment, and people/invitations mock fixtures & helpers (#041).
 * Used by both `src/server/apiMiddleware.ts` and `src/api/offlineDemoData.js`.
 */

import type {
  ApartmentCard,
  AuthorBadgeDTO,
  DemoUserView,
  DisplayMode,
  MembershipView,
  ObjectKind,
} from '../../api/schema'
import { createDemoEeBuildingFacts } from '../../utils/buildingPassport.js'
import { formatBadgeObjectToken, normalizeObjectKind } from '../../utils/objectName.js'

export const MOCK_BUILDING_ID = '018f0000-0000-7000-8000-000000000001'

export interface MockSeedUser extends DemoUserView {
  full_name: string
  initials: string
  locale?: 'en' | 'et' | 'ru' | null
}

export const MOCK_DEMO_USERS: MockSeedUser[] = [
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

export const MOCK_MEMBERSHIPS_BY_USER: Record<string, MembershipView[]> = {
  '018f0000-0000-7000-8000-000000000102': [
    {
      membership_id: '018f0000-0000-7000-8000-000000000214',
      apartment_id: '018f0000-0000-7000-8000-000000000314',
      apartment_number: '14',
      apartment_kind: 'APARTMENT',
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
}

export const MOCK_KNOWN_APARTMENT_ENTRANCES: Record<string, number | null> = {
  '018f0000-0000-7000-8000-000000000301': 1,
  '018f0000-0000-7000-8000-000000000302': 1,
  '018f0000-0000-7000-8000-000000000305': 1,
  '018f0000-0000-7000-8000-000000000309': 2,
  '018f0000-0000-7000-8000-000000000314': 2,
  '018f0000-0000-7000-8000-000000000315': 2,
  '018f0000-0000-7000-8000-000000000401': null,
  '018f0000-0000-7000-8000-000000000402': null,
  '018f0000-0000-7000-8000-000000000412': null,
}

export const MOCK_APARTMENT_ID_TO_NUMBER: Record<string, string> = {
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
  '018f0000-0000-7000-8000-000000000241': '1',
  '018f0000-0000-7000-8000-000000000401': '1',
  '018f0000-0000-7000-8000-000000000402': 'P-2',
  '018f0000-0000-7000-8000-000000000242': '12',
  '018f0000-0000-7000-8000-000000000412': '12',
}

export const MOCK_APARTMENT_ID_TO_KIND: Record<string, ObjectKind> = {
  '018f0000-0000-7000-8000-000000000201': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000301': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000202': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000302': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000205': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000305': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000209': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000309': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000214': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000314': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000215': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000315': 'APARTMENT',
  '018f0000-0000-7000-8000-000000000241': 'PARKING',
  '018f0000-0000-7000-8000-000000000401': 'PARKING',
  '018f0000-0000-7000-8000-000000000402': 'PARKING',
  '018f0000-0000-7000-8000-000000000242': 'GARAGE',
  '018f0000-0000-7000-8000-000000000412': 'GARAGE',
}

export const MOCK_NUMBER_TO_APARTMENT_ID: Record<string, string> = {
  '01': '018f0000-0000-7000-8000-000000000301',
  '02': '018f0000-0000-7000-8000-000000000302',
  '05': '018f0000-0000-7000-8000-000000000305',
  '09': '018f0000-0000-7000-8000-000000000309',
  '14': '018f0000-0000-7000-8000-000000000314',
  '15': '018f0000-0000-7000-8000-000000000315',
}

export const MOCK_BUILDING = {
  building_id: MOCK_BUILDING_ID,
  name: 'KÜ Sõpruse 12',
  registry_code: '80123456',
  address: 'Sõpruse pst 12, Kristiine, Tallinn',
  country_code: 'EE',
  district: 'Kristiine',
  apartment_count: 6,
  apartments_count: 6,
  total_apartments: 6,
  entrance_count: 2,
  entrances_count: 2,
  total_entrances: 2,
  heated_area_m2: '329.20',
  object_counts: {
    APARTMENT: 6,
    PARKING: 2,
    GARAGE: 1,
  } as Record<ObjectKind, number>,
  registry_facts: createDemoEeBuildingFacts(),
}

export const MOCK_APARTMENT_CARDS: ApartmentCard[] = [
  {
    apartment_id: '018f0000-0000-7000-8000-000000000301',
    apartment_number: '01',
    apartment_kind: 'APARTMENT',
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
    apartment_kind: 'APARTMENT',
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
    apartment_kind: 'APARTMENT',
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
    apartment_kind: 'APARTMENT',
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
    apartment_kind: 'APARTMENT',
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
    apartment_kind: 'APARTMENT',
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
  {
    apartment_id: '018f0000-0000-7000-8000-000000000401',
    apartment_number: '1',
    apartment_kind: 'PARKING',
    entrance: null,
    floor: null,
    area_m2: null,
    owner_count: 1,
    tenant_count: 0,
    resident_count: 0,
    residents: [{ relation_type: 'OWNER', since: '2026-01-12T10:00:00Z' }],
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000402',
    apartment_number: 'P-2',
    apartment_kind: 'PARKING',
    entrance: null,
    floor: -1,
    area_m2: null,
    owner_count: 0,
    tenant_count: 1,
    resident_count: 0,
    residents: [{ relation_type: 'TENANT', since: '2026-02-01T10:00:00Z' }],
  },
  {
    apartment_id: '018f0000-0000-7000-8000-000000000412',
    apartment_number: '12',
    apartment_kind: 'GARAGE',
    entrance: null,
    floor: 0,
    area_m2: '18.50',
    owner_count: 1,
    tenant_count: 0,
    resident_count: 0,
    residents: [{ relation_type: 'OWNER', since: '2026-01-01T09:00:00Z' }],
  },
]

export function findMockApartmentByKindAndNumber(
  apartmentNumber: string,
  apartmentKind: ObjectKind = 'APARTMENT',
): ApartmentCard | undefined {
  const num = String(apartmentNumber || '').trim()
  const kind = normalizeObjectKind(apartmentKind)
  return MOCK_APARTMENT_CARDS.find(
    (a) => normalizeObjectKind(a.apartment_kind) === kind && a.apartment_number === num,
  )
}

export function computeMockSharedAccess(memberships: MembershipView[]): boolean {
  return memberships.some(
    (m) => normalizeObjectKind(m.apartment_kind) === 'APARTMENT' || m.relation_type === 'OWNER',
  )
}

export function computeMockPreviewBadge(
  user: MockSeedUser,
  apartmentNumber: string | null,
  mode: DisplayMode,
  apartmentKind?: ObjectKind | null,
): AuthorBadgeDTO {
  const roleBadge =
    user.building_role === 'CHAIRMAN' || user.building_role === 'BOARD'
      ? 'BOARD'
      : user.building_role === 'ACCOUNTANT'
        ? 'ACCOUNTANT'
        : user.relation_type === 'TENANT' || user.relation_type === 'RESIDENT'
          ? 'RESIDENT'
          : 'OWNER'

  const objToken = apartmentNumber
    ? formatBadgeObjectToken(apartmentKind, apartmentNumber, 'Apt')
    : ''

  if (mode === 'FULL_NAME') {
    return {
      display_label: objToken ? `${user.full_name} (${objToken})` : user.full_name,
      role_badge: roleBadge,
    }
  }
  if (mode === 'INITIALS') {
    return {
      display_label: objToken ? `${user.initials} (${objToken})` : user.initials,
      role_badge: roleBadge,
    }
  }
  return {
    display_label: objToken || user.full_name,
    role_badge: roleBadge,
  }
}

export function maskMockEmail(email: string): string {
  const trimmed = email.trim().toLowerCase()
  const atIdx = trimmed.indexOf('@')
  if (atIdx <= 0) return 'u***@demo.invalid'
  return `${trimmed[0]}***@${trimmed.slice(atIdx + 1)}`
}

export function isValidMockEmailFormat(email: string): boolean {
  const trimmed = String(email || '').trim()
  if (!trimmed || trimmed.length > 254) return false
  const atIndex = trimmed.indexOf('@')
  if (atIndex <= 0) return false
  const domain = trimmed.slice(atIndex + 1)
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.')
}

export function resolveMockEmailToDemoUserId(email: string): string {
  const lower = email.toLowerCase().trim()
  if (
    lower.startsWith('oleg.sidorov') ||
    lower.startsWith('peeter.') ||
    lower.includes('chairman')
  ) {
    return '018f0000-0000-7000-8000-000000000101'
  }
  if (
    lower.startsWith('anna.kask') ||
    lower.startsWith('marika.') ||
    lower.includes('accountant')
  ) {
    return '018f0000-0000-7000-8000-000000000103'
  }
  return '018f0000-0000-7000-8000-000000000102'
}
