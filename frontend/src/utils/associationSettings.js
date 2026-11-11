/**
 * Pure helper utilities and validation logic for Association Settings (#011, Epic E9/I0).
 */

export const DEFAULT_ASSOCIATION_SETTINGS = [
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

/**
 * Deep-clone the default association settings list sorted by key.
 * @returns {Array<import('../api/schema').SettingView>}
 */
export function cloneDefaultAssociationSettings() {
  return DEFAULT_ASSOCIATION_SETTINGS.map((s) => ({ ...s })).sort((a, b) =>
    a.key.localeCompare(b.key),
  )
}

/**
 * Group settings by their dot prefix (e.g. "issues.urgent_enabled" -> "issues").
 * Preserves the sorted order of settings within each group.
 * @param {Array<import('../api/schema').SettingView>} settings
 * @returns {Array<{ prefix: string, settings: Array<import('../api/schema').SettingView> }>}
 */
export function groupSettingsByPrefix(settings) {
  if (!Array.isArray(settings) || settings.length === 0) return []
  const sorted = [...settings].sort((a, b) => a.key.localeCompare(b.key))
  const groupsMap = new Map()
  for (const item of sorted) {
    const dotIdx = item.key.indexOf('.')
    const prefix = dotIdx > 0 ? item.key.slice(0, dotIdx) : 'general'
    if (!groupsMap.has(prefix)) {
      groupsMap.set(prefix, [])
    }
    groupsMap.get(prefix).push(item)
  }
  return Array.from(groupsMap.entries()).map(([prefix, groupItems]) => ({
    prefix,
    settings: groupItems,
  }))
}

/**
 * Build initial reactive draft maps from loaded server settings.
 * @param {Array<import('../api/schema').SettingView>} settings
 * @returns {{ values: Record<string, any>, resets: Record<string, boolean> }}
 */
export function buildInitialDraftState(settings) {
  const values = {}
  const resets = {}
  for (const item of settings || []) {
    values[item.key] = item.value
    resets[item.key] = false
  }
  return { values, resets }
}

/**
 * Normalize an integer draft input value so numbers represented as strings in `<input type="number">`
 * are converted to integers when valid, or preserved as raw value so validation can flag them.
 * @param {any} raw
 * @returns {any}
 */
export function normalizeIntegerDraftValue(raw) {
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
 * @param {Array<import('../api/schema').SettingView>} settings
 * @param {Record<string, any>} draftValues
 * @param {Record<string, boolean>} draftResets
 * @returns {Record<string, number | boolean | null>}
 */
export function computeSettingsDiff(settings, draftValues, draftResets = {}) {
  const diff = {}
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
      if (normalized !== item.value) {
        diff[key] = normalized
      }
    } else if (draftValues[key] !== item.value) {
      diff[key] = draftValues[key]
    }
  }
  return diff
}

/**
 * Extract per-key validation errors from a 422 VALIDATION_ERROR response.
 * Per contract, the setting key is at `errors[].loc[2]` (`["body", "values", "<key>"]`).
 * @param {any} error
 * @returns {Record<string, { type: string, message: string }>}
 */
export function extractSettingFieldErrors(error) {
  const result = {}
  const list = Array.isArray(error?.fieldErrors)
    ? error.fieldErrors
    : Array.isArray(error?.payload?.errors)
      ? error.payload.errors
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

/**
 * Validate and apply a `PUT /api/v1/settings` payload all-or-nothing against current settings.
 * Mirrors the backend contract in `docs/API.md` section 9.
 * @param {Array<import('../api/schema').SettingView>} currentSettings
 * @param {any} body
 * @param {string} [nowIso]
 * @returns {{ ok: true, settings: Array<import('../api/schema').SettingView> } | { ok: false, errors: Array<{ loc: Array<string | number>, message: string, type: string }> }}
 */
export function validateAndApplySettingsUpdate(
  currentSettings,
  body,
  nowIso = new Date().toISOString(),
) {
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

  const bodyKeys = Object.keys(body)
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

  const rawValues = body.values
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
  const errors = []

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
        (def.minimum !== null && val < def.minimum) ||
        (def.maximum !== null && val > def.maximum)
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
  const nextSettings = (currentSettings || []).map((s) => {
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
      value: incoming,
      is_default: false,
      updated_at: nowIso,
    }
  })

  nextSettings.sort((a, b) => a.key.localeCompare(b.key))
  return { ok: true, settings: nextSettings }
}
