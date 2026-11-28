import type { ObjectKind } from '../api/schema'

export type TranslateFn = (key: string, params?: Record<string, unknown>) => string

export const OBJECT_KINDS: readonly ObjectKind[] = ['APARTMENT', 'PARKING', 'GARAGE']

const KIND_ORDER: Record<ObjectKind, number> = {
  APARTMENT: 0,
  PARKING: 1,
  GARAGE: 2,
}

/**
 * Normalizes an optional/unknown object kind to a valid ObjectKind.
 * Missing or unknown values default to 'APARTMENT' (backwards compatibility with pre-E14 rows).
 */
export function normalizeObjectKind(kind: unknown): ObjectKind {
  if (kind === 'PARKING' || kind === 'GARAGE' || kind === 'APARTMENT') {
    return kind
  }
  return 'APARTMENT'
}

/**
 * Returns the canonical sort rank for an object kind: APARTMENT (0), PARKING (1), GARAGE (2).
 */
export function objectKindOrder(kind: unknown): number {
  return KIND_ORDER[normalizeObjectKind(kind)]
}

/**
 * Localized singular kind label (e.g. "Apartment", "Parking space", "Garage").
 */
export function objectKindLabel(kind: unknown, t: TranslateFn): string {
  const k = normalizeObjectKind(kind)
  return t(`objects.kinds.${k}`)
}

/**
 * Localized plural kind label (e.g. "Apartments", "Parking spaces", "Garages").
 */
export function objectKindPluralLabel(kind: unknown, t: TranslateFn): string {
  const k = normalizeObjectKind(kind)
  return t(`objects.kindsPlural.${k}`)
}

/**
 * Localized full object name combining kind and number (e.g. "Apartment 14", "Parking space 1", "Garage 12").
 * Never prefixes a parking space or garage with "Apartment".
 */
export function objectName(
  kind: unknown,
  number: string | number | null | undefined,
  t: TranslateFn,
): string {
  const k = normalizeObjectKind(kind)
  const num = number === null || number === undefined ? '' : String(number).trim()
  if (!num) {
    return objectKindLabel(k, t)
  }
  return t(`objects.named.${k}`, { number: num })
}

/**
 * Localized compact object name for narrow badges, chips, and table cells
 * (e.g. "Apt 14", "Parking 1", "Garage 12").
 */
export function objectShortName(
  kind: unknown,
  number: string | number | null | undefined,
  t: TranslateFn,
): string {
  const k = normalizeObjectKind(kind)
  const num = number === null || number === undefined ? '' : String(number).trim()
  if (!num) {
    return objectKindLabel(k, t)
  }
  return t(`objects.short.${k}`, { number: num })
}

/**
 * Formats an object's optional floor and entrance cleanly.
 * - Both present: "Floor {floor} • Entrance {entrance}" (or comma-separated)
 * - Only floor present (including 0 or negative floors like -1): "Floor {floor}"
 * - Only entrance present: "Entrance {entrance}"
 * - Neither present: ""
 */
export function formatObjectLocation(
  obj: { entrance?: number | null; floor?: number | null } | null | undefined,
  t: TranslateFn,
  separator: 'dot' | 'comma' = 'dot',
): string {
  const hasFloor = typeof obj?.floor === 'number' && Number.isFinite(obj.floor)
  const hasEntrance = typeof obj?.entrance === 'number' && Number.isFinite(obj.entrance)

  if (hasFloor && hasEntrance) {
    return t(separator === 'comma' ? 'common.floorEntranceComma' : 'common.floorEntrance', {
      floor: obj!.floor,
      entrance: obj!.entrance,
    })
  }
  if (hasFloor) {
    return t('objects.floorOnly', { floor: obj!.floor })
  }
  if (hasEntrance) {
    return t('objects.entranceOnly', { entrance: obj!.entrance })
  }
  return ''
}

/**
 * Formats an object's optional area_m2 without ever producing "NaN m²" or "null m²".
 * Returns empty string when area is null/undefined/empty/invalid.
 */
export function formatObjectArea(areaM2: string | number | null | undefined): string {
  if (areaM2 === null || areaM2 === undefined) return ''
  const str = String(areaM2).trim()
  if (!str) return ''
  const parsed = Number(str)
  if (!Number.isFinite(parsed)) return ''
  return `${str} m²`
}

/**
 * Formats the short English badge object token matching backend rules (docs/API.md §0):
 * - APARTMENT: `Apt ${number}` (existing mock convention) or `Apt. ${number}`
 * - PARKING: `P${number}` unless number already starts with P/p (e.g. "P-2" -> "P-2", "1" -> "P1")
 * - GARAGE: `G${number}` unless number already starts with G/g (e.g. "12" -> "G12", "G12" -> "G12", "1G" -> "G1G")
 */
export function formatBadgeObjectToken(
  kind: unknown,
  number: string | null | undefined,
  apartmentPrefix: string = 'Apt',
): string {
  const num = number ? String(number).trim() : ''
  if (!num) return ''
  const k = normalizeObjectKind(kind)
  if (k === 'PARKING') {
    return /^[Pp]/.test(num) ? num : `P${num}`
  }
  if (k === 'GARAGE') {
    return /^[Gg]/.test(num) ? num : `G${num}`
  }
  return `${apartmentPrefix} ${num}`
}

/**
 * Resolves the single object ID that the backend picks automatically when `apartment_id`
 * is omitted on issue reports (`POST /issues`) or ballots (`PUT /governance/polls/{id}/ballot`).
 * Backend rule (docs/API.md §8, §10): auto-picks when the caller has 1 candidate object,
 * OR several candidates of which exactly 1 is an APARTMENT (picking that apartment).
 * Otherwise returns null (caller must choose explicitly or receives 422).
 */
export function resolveAutoPickedObjectId(
  candidateIds: readonly string[],
  memberships: ReadonlyArray<{ apartment_id: string; apartment_kind?: ObjectKind | string | null }> = [],
): string | null {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) return null
  if (candidateIds.length === 1) return candidateIds[0]
  const kindById = new Map<string, ObjectKind>()
  for (const m of memberships) {
    if (m?.apartment_id) {
      kindById.set(m.apartment_id, normalizeObjectKind(m.apartment_kind))
    }
  }
  const apartments = candidateIds.filter((id) => (kindById.get(id) ?? 'APARTMENT') === 'APARTMENT')
  if (apartments.length === 1) return apartments[0]
  return null
}

/**
 * Formats a list of `ObjectKind` values in canonical order (apartments, parking spaces, garages)
 * using localized plural labels. Safely handles missing/unknown entries for pre-E14 rows.
 */
export function formatTargetKindsList(
  kinds: ReadonlyArray<string> | null | undefined,
  t: TranslateFn,
  { lowercase = false }: { lowercase?: boolean } = {},
): string {
  if (!Array.isArray(kinds) || kinds.length === 0) return ''
  const seen = new Set<ObjectKind>()
  for (const raw of kinds) {
    const upper = String(raw || '').toUpperCase()
    if (upper === 'APARTMENT' || upper === 'PARKING' || upper === 'GARAGE') {
      seen.add(upper)
    }
  }
  const ordered = OBJECT_KINDS.filter((k) => seen.has(k))
  return ordered
    .map((k) => {
      const label = objectKindPluralLabel(k, t)
      return lowercase ? label.toLowerCase() : label
    })
    .join(', ')
}

export interface TargetScopeLike {
  target_scope?: string | null
  target_entrance?: number | null
  target_apartment_ids?: ReadonlyArray<string> | null
  target_kinds?: ReadonlyArray<string> | null
}

/**
 * Formats any target scope (`ALL_BUILDING`, `ALL_OBJECTS`, `KINDS`, `ENTRANCE`, `APARTMENT_LIST`)
 * into a concise localized label for posts, notices, polls, maintenance tasks, and banners.
 */
export function formatTargetScopeLabel(
  target: TargetScopeLike | null | undefined,
  t: TranslateFn,
): string {
  if (!target) return ''
  const scope = target.target_scope || 'ALL_BUILDING'
  if (scope === 'ALL_OBJECTS') {
    return t('forum.targetAllObjects')
  }
  if (scope === 'KINDS') {
    const kindsText = formatTargetKindsList(target.target_kinds, t, { lowercase: true })
    if (kindsText) {
      return t('forum.targetKinds', { kinds: kindsText })
    }
    return t('polls.target.byKind')
  }
  if (scope === 'ENTRANCE' && target.target_entrance != null) {
    return t('forum.targetEntrance', { number: target.target_entrance })
  }
  if (scope === 'APARTMENT_LIST') {
    return t('forum.targetApartments')
  }
  return t('forum.targetAllBuilding')
}

/**
 * Pure E14 targeting predicate: checks whether an object belongs to the given target.
 * - `ALL_BUILDING`: apartments ONLY (`APARTMENT`)
 * - `ALL_OBJECTS`: all objects of any kind
 * - `KINDS`: objects whose kind is in `target_kinds`
 * - `ENTRANCE`: objects whose non-null `entrance` equals `target_entrance`
 * - `APARTMENT_LIST`: objects whose `apartment_id` is in `target_apartment_ids`
 */
/**
 * Fail-closed check for whether a raw `apartment_kind` represents an `APARTMENT`.
 * Null/undefined/empty defaults to `APARTMENT` for pre-E14 compatibility; any unknown
 * non-empty string (e.g. a future non-residential kind like `'STORAGE'`) returns `false`.
 */
export function isApartmentKindStrict(kind: string | null | undefined): boolean {
  if (kind == null || kind === '') return true
  return String(kind).trim().toUpperCase() === 'APARTMENT'
}

export function isObjectInTarget(
  target: TargetScopeLike | null | undefined,
  obj: {
    apartment_id: string
    entrance?: number | null
    apartment_kind?: string | null
  },
): boolean {
  if (!target) return false
  const scope = target.target_scope || 'ALL_BUILDING'
  const rawKind = obj.apartment_kind
  const isKnownKind =
    rawKind == null ||
    rawKind === '' ||
    OBJECT_KINDS.includes(String(rawKind).trim().toUpperCase() as ObjectKind)
  const kind = normalizeObjectKind(rawKind)
  if (scope === 'ALL_BUILDING') {
    return isApartmentKindStrict(rawKind)
  }
  if (scope === 'ALL_OBJECTS') {
    return true
  }
  if (scope === 'KINDS') {
    return isKnownKind && Array.isArray(target.target_kinds) && target.target_kinds.includes(kind)
  }
  if (scope === 'ENTRANCE') {
    return obj.entrance != null && target.target_entrance != null && obj.entrance === target.target_entrance
  }
  if (scope === 'APARTMENT_LIST') {
    return Array.isArray(target.target_apartment_ids) && target.target_apartment_ids.includes(obj.apartment_id)
  }
  return false
}


