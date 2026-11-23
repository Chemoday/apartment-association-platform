import type { SettingView } from '@/api/schema.js'

/**
 * Pure helper utilities and validation logic for Association Settings (#011, Epic E9/I0).
 */

export const DEFAULT_ASSOCIATION_SETTINGS: SettingView[] = [
  {
    key: 'chat.enabled',
    type: 'BOOLEAN',
    value: false,
    default: false,
    minimum: null,
    maximum: null,
    is_default: true,
    updated_at: null,
  },
  {
    key: 'issues.reports_per_apartment_per_day',
    type: 'INTEGER',
    value: 3,
    default: 3,
    minimum: 1,
    maximum: 20,
    is_default: true,
    updated_at: null,
  },
  {
    key: 'issues.urgent_enabled',
    type: 'BOOLEAN',
    value: false,
    default: false,
    minimum: null,
    maximum: null,
    is_default: true,
    updated_at: null,
  },
  {
    key: 'issues.urgent_per_apartment_per_day',
    type: 'INTEGER',
    value: 1,
    default: 1,
    minimum: 1,
    maximum: 5,
    is_default: true,
    updated_at: null,
  },
  {
    key: 'maintenance.overdue_reminder_days',
    type: 'INTEGER',
    value: 7,
    default: 7,
    minimum: 1,
    maximum: 30,
    is_default: true,
    updated_at: null,
  },
]

export function compareSettingKeys(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * Deep-clone the default association settings list sorted by key.
 */
export function cloneDefaultAssociationSettings(): SettingView[] {
  return DEFAULT_ASSOCIATION_SETTINGS.map((s) => ({ ...s })).sort(compareSettingKeys)
}

/**
 * Group settings by their dot prefix (e.g. "issues.urgent_enabled" -> "issues").
 * Preserves the sorted order of settings within each group.
 */
export function groupSettingsByPrefix(
  settings: SettingView[] | null | undefined,
): Array<{ prefix: string; settings: SettingView[] }> {
  if (!Array.isArray(settings) || settings.length === 0) return []
  const sorted = [...settings].sort(compareSettingKeys)
  const groupsMap = new Map<string, SettingView[]>()
  for (const item of sorted) {
    const dotIdx = item.key.indexOf('.')
    const prefix = dotIdx > 0 ? item.key.slice(0, dotIdx) : 'general'
    let list = groupsMap.get(prefix)
    if (!list) {
      list = []
      groupsMap.set(prefix, list)
    }
    list.push(item)
  }
  return Array.from(groupsMap.entries()).map(([prefix, groupItems]) => ({
    prefix,
    settings: groupItems,
  }))
}

export type SettingDraftValue = number | boolean | string | null | undefined

/**
 * Build initial reactive draft maps from loaded server settings.
 */
export function buildInitialDraftState(
  settings: SettingView[] | null | undefined,
): { values: Record<string, SettingDraftValue>; resets: Record<string, boolean> } {
  const values: Record<string, SettingDraftValue> = {}
  const resets: Record<string, boolean> = {}
  for (const item of settings || []) {
    values[item.key] = item.value
    resets[item.key] = false
  }
  return { values, resets }
}

/**
 * Normalize an integer draft input value so numbers represented as strings in `<input type="number">`
 * are converted to integers when valid, or preserved as raw value so validation can flag them.
 */
export function normalizeIntegerDraftValue(raw: SettingDraftValue): SettingDraftValue {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (/^-?\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10)
    }
    return raw
  }
  return raw
}

/**
 * Compute the minimal `{ values }` diff to send in `PUT /api/v1/settings`.
 * Only keys that actually changed (or are marked for reset to default on a non-default setting) are included.
 */
export function computeSettingsDiff(
  settings: SettingView[] | null | undefined,
  draftValues: Record<string, SettingDraftValue>,
  draftResets: Record<string, boolean> = {},
): Record<string, number | boolean | string | null> {
  const diff: Record<string, number | boolean | string | null> = {}
  for (const item of settings || []) {
    const key = item.key
    if (draftResets[key]) {
      if (!item.is_default) {
        diff[key] = null
      }
      continue
    }
    if (!(key in draftValues)) continue

    if (item.type === 'BOOLEAN') {
      const nextBool = Boolean(draftValues[key])
      if (nextBool !== item.value) {
        diff[key] = nextBool
      }
    } else if (item.type === 'INTEGER') {
      const normalized = normalizeIntegerDraftValue(draftValues[key])
      if (normalized !== item.value && normalized !== undefined) {
        diff[key] = normalized
      }
    } else if (draftValues[key] !== item.value && draftValues[key] !== undefined) {
      diff[key] = draftValues[key]
    }
  }
  return diff
}

/**
 * Returns true if the pending diff will turn off `chat.enabled` when it is currently active (`true`).
 * Covers both explicit `false` and resetting (`null`) back to its default (`false`).
 */
export function isDisablingChatSetting(
  settings: SettingView[] | null | undefined,
  diff: Record<string, number | boolean | string | null> | null | undefined,
): boolean {
  if (!diff || !Object.prototype.hasOwnProperty.call(diff, 'chat.enabled')) {
    return false
  }
  const current = (settings || []).find((s) => s.key === 'chat.enabled')
  if (!current || current.value !== true) {
    return false
  }
  const incoming = diff['chat.enabled']
  if (incoming === false) return true
  if (incoming === null) return current.default === false
  return false
}

/**
 * Extract per-key validation errors from a 422 VALIDATION_ERROR response.
 * Per contract, the setting key is at `errors[].loc[2]` (`["body", "values", "<key>"]`).
 */
export function extractSettingFieldErrors(
  error: unknown,
): Record<string, { type: string; message: string }> {
  const result: Record<string, { type: string; message: string }> = {}
  const errObj =
    error && typeof error === 'object'
      ? (error as {
          fieldErrors?: Array<{ loc?: unknown[]; type?: unknown; message?: unknown }>
          payload?: { errors?: Array<{ loc?: unknown[]; type?: unknown; message?: unknown }> }
        })
      : null
  const list = Array.isArray(errObj?.fieldErrors)
    ? errObj.fieldErrors
    : Array.isArray(errObj?.payload?.errors)
      ? errObj.payload.errors
      : []

  for (const entry of list) {
    const loc = Array.isArray(entry?.loc) ? entry.loc : []
    const key = loc.length >= 3 && loc[0] === 'body' && loc[1] === 'values' ? String(loc[2]) : ''
    if (key && !result[key]) {
      result[key] = {
        type: String(entry?.type || 'validation_error'),
        message: String(entry?.message || 'Invalid value'),
      }
    }
  }
  return result
}

export type SettingsUpdateValidationResult =
  | { ok: true; settings: SettingView[] }
  | { ok: false; errors: Array<{ loc: Array<string | number>; message: string; type: string }> }

/**
 * Validate and apply a `PUT /api/v1/settings` payload all-or-nothing against current settings.
 * Mirrors the backend contract in `docs/API.md` section 9.
 */
export function validateAndApplySettingsUpdate(
  currentSettings: SettingView[] | null | undefined,
  body: unknown,
  nowIso: string = new Date().toISOString(),
): SettingsUpdateValidationResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      errors: [
        {
          loc: ['body'],
          message: 'Request body must be a JSON object.',
          type: 'type_error.dict',
        },
      ],
    }
  }

  const bodyObj = body as Record<string, unknown>
  const bodyKeys = Object.keys(bodyObj)
  const unknownTopKeys = bodyKeys.filter((k) => k !== 'values')
  if (unknownTopKeys.length > 0) {
    return {
      ok: false,
      errors: unknownTopKeys.map((k) => ({
        loc: ['body', k],
        message: 'Extra inputs are not permitted.',
        type: 'extra_forbidden',
      })),
    }
  }

  const rawValues = bodyObj.values as Record<string, unknown> | null | undefined
  if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
    return {
      ok: false,
      errors: [
        {
          loc: ['body', 'values'],
          message: 'values must be an object mapping setting keys to values or null.',
          type: 'type_error.dict',
        },
      ],
    }
  }

  const entries = Object.entries(rawValues)
  if (entries.length < 1 || entries.length > 50) {
    return {
      ok: false,
      errors: [
        {
          loc: ['body', 'values'],
          message: 'values must contain between 1 and 50 setting keys.',
          type: 'value_error.number.not_in_range',
        },
      ],
    }
  }

  const byKey = new Map((currentSettings || []).map((s) => [s.key, s]))
  const errors: Array<{ loc: Array<string | number>; message: string; type: string }> = []

  // Step 1: Request schema check (each value must be integer, boolean, or null, and key <= 64 chars)
  for (const [key, val] of entries) {
    if (!key || key.length > 64) {
      errors.push({
        loc: ['body', 'values', key],
        message: 'Setting key must be between 1 and 64 characters.',
        type: 'value_error.any_str.max_length',
      })
      continue
    }
    const isNull = val === null
    const isBool = typeof val === 'boolean'
    const isInt = typeof val === 'number' && Number.isInteger(val)
    if (!isNull && !isBool && !isInt) {
      errors.push({
        loc: ['body', 'values', key],
        message: 'Value must be an integer, a boolean, or null.',
        type: 'type_error',
      })
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  // Step 2: Domain validation against declared settings (unknown key, wrong type, out of bounds)
  for (const [key, val] of entries) {
    const def = byKey.get(key)
    if (!def) {
      errors.push({
        loc: ['body', 'values', key],
        message: `Unknown setting key: ${key}`,
        type: 'value_error.unknown_setting',
      })
      continue
    }

    if (val === null) continue

    if (def.type === 'BOOLEAN') {
      if (typeof val !== 'boolean') {
        errors.push({
          loc: ['body', 'values', key],
          message: 'Value must be a boolean.',
          type: 'type_error.bool',
        })
      }
    } else if (def.type === 'INTEGER') {
      if (typeof val !== 'number' || !Number.isInteger(val)) {
        errors.push({
          loc: ['body', 'values', key],
          message: 'Value must be an integer.',
          type: 'type_error.integer',
        })
      } else if (
        (def.minimum !== null && def.minimum !== undefined && val < def.minimum) ||
        (def.maximum !== null && def.maximum !== undefined && val > def.maximum)
      ) {
        errors.push({
          loc: ['body', 'values', key],
          message: `Value must be between ${def.minimum} and ${def.maximum}.`,
          type: 'value_error.number.not_in_range',
        })
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  // Step 3: Apply all-or-nothing updates
  const nextSettings: SettingView[] = (currentSettings || []).map((s) => {
    if (!(s.key in rawValues)) {
      return { ...s }
    }
    const incoming = rawValues[s.key]
    if (incoming === null) {
      return {
        ...s,
        value: s.default,
        is_default: true,
        updated_at: null,
      }
    }
    if (incoming === s.value) {
      // Setting the current value again changes nothing
      return { ...s }
    }
    return {
      ...s,
      value: incoming as number | boolean,
      is_default: false,
      updated_at: nowIso,
    }
  })

  nextSettings.sort(compareSettingKeys)
  return { ok: true, settings: nextSettings }
}
