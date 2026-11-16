/**
 * Pure domain formatting, classified code translation, schema guard,
 * and demo register fixture helpers for Building Passport (#034).
 * Contract: docs/API.md section 1 & docs/FRONTEND_GUIDE.md section 21.
 */

export const SUPPORTED_BUILDING_SCHEMAS = {
  EE: 'ee/1',
}

/**
 * Known EHR classified codes mapped to translation keys under `buildingPassport.codes.*`.
 * Any unknown code safely falls back to `label_et` as provided by the register.
 */
export const KNOWN_CLASSIFIED_CODES = new Set([
  '11222', // apartment building (3+ apts)
  '11221', // two-apartment residential building
  '11101', // single-family dwelling
  'K', // in use / active
  'E', // under construction
  'O', // planned
  'L', // demolished
  'ERA', // private ownership
  'RIIGI', // state ownership
  'KOV', // municipal ownership
  'KEK', // existing building energy certificate
  'ETA', // calculated energy label (design)
  'KEHTIV', // valid
  'KEHTETU', // invalid / expired
  'VUNDAMENT', // foundation type
  'VALISSEIN', // exterior wall material
  'KATUS', // roof material
  'KYTE', // heating system
])

/**
 * Check whether `facts` matches a supported country & schema pair (`EE` + `ee/1`).
 * Unknown countries/schemas return `false` so UI safely renders the empty state.
 * @param {any} facts
 * @returns {facts is import('../api/schema').EEBuildingFacts}
 */
export function isSupportedBuildingFacts(facts) {
  if (!facts || typeof facts !== 'object') return false
  if (facts.country_code !== 'EE' || facts.schema !== 'ee/1') return false
  if (!facts.building || typeof facts.building !== 'object') return false
  return true
}

/**
 * Format a decimal string from the register strictly as-is (NEVER converting to Number),
 * appending optional unit (`m²`, `m³`, `m`). Returns `'-'` for null/undefined/empty.
 * @param {string | null | undefined} value
 * @param {string} [unit]
 * @returns {string}
 */
export function formatRegisterDecimal(value, unit = '') {
  if (typeof value !== 'string') return '-'
  const trimmed = value.trim()
  if (!trimmed) return '-'
  return unit ? `${trimmed} ${unit}` : trimmed
}

/**
 * Format an optional integer count. Returns `'-'` for null/undefined/non-finite.
 * @param {number | null | undefined} value
 * @returns {string}
 */
export function formatRegisterInt(value) {
  if (value === null || value === undefined || typeof value !== 'number' || !Number.isFinite(value)) {
    return '-'
  }
  return String(value)
}

/**
 * Format an optional text/date string. Returns `'-'` for null/undefined/empty.
 * @param {string | null | undefined} value
 * @returns {string}
 */
export function formatRegisterText(value) {
  if (typeof value !== 'string') return '-'
  const trimmed = value.trim()
  return trimmed ? trimmed : '-'
}

/**
 * Resolve a register `Classified` `{ code, label_et }` into a localized string:
 * uses translated known code when available, else falls back to `label_et`, else `code` or `'-'`.
 * @param {import('../api/schema').Classified | null | undefined} classified
 * @param {(key: string) => string} t
 * @returns {string}
 */
export function resolveClassifiedLabel(classified, t) {
  if (!classified || typeof classified !== 'object') return '-'
  const code = typeof classified.code === 'string' ? classified.code.trim() : ''
  if (code && KNOWN_CLASSIFIED_CODES.has(code) && typeof t === 'function') {
    const key = `buildingPassport.codes.${code}`
    const translated = t(key)
    if (translated && translated !== key) {
      return translated
    }
  }
  if (typeof classified.label_et === 'string' && classified.label_et.trim()) {
    return classified.label_et.trim()
  }
  if (code) return code
  return '-'
}

/**
 * Resolve localized label for `EEUnit.kind` (`APARTMENT`, `NON_RESIDENTIAL`, `COMMON`, `OTHER`).
 * @param {string | null | undefined} kind
 * @param {(key: string) => string} t
 * @returns {string}
 */
export function resolveUnitKindLabel(kind, t) {
  const normalized = typeof kind === 'string' ? kind.trim().toUpperCase() : 'OTHER'
  const known = ['APARTMENT', 'NON_RESIDENTIAL', 'COMMON', 'OTHER'].includes(normalized)
    ? normalized
    : 'OTHER'
  if (typeof t === 'function') {
    const key = `buildingPassport.unitKinds.${known}`
    const translated = t(key)
    if (translated && translated !== key) return translated
  }
  return known
}

export const KNOWN_CERT_VALUE_TYPES = new Set(['ETA', 'KEK'])

/**
 * Resolve localized label for `EEEnergyCertificate.value_type` (`ETA`, `KEK`, or raw register code),
 * kept separate from `KNOWN_CLASSIFIED_CODES` (`document_kind` uses the same acronyms with different meanings).
 * @param {string | null | undefined} valueType
 * @param {(key: string) => string} t
 * @returns {string}
 */
export function resolveCertValueTypeLabel(valueType, t) {
  if (typeof valueType !== 'string') return ''
  const trimmed = valueType.trim()
  if (!trimmed) return ''
  const upper = trimmed.toUpperCase()
  if (KNOWN_CERT_VALUE_TYPES.has(upper) && typeof t === 'function') {
    const key = `buildingPassport.certValueTypes.${upper}`
    const translated = t(key)
    if (translated && translated !== key) return translated
  }
  return trimmed
}

/**
 * Pick the primary energy certificate class for summary cards (e.g. `'C'`), or `null`.
 * @param {import('../api/schema').EEBuildingFacts | null | undefined} facts
 * @returns {string | null}
 */
export function getPrimaryEnergyClass(facts) {
  if (!isSupportedBuildingFacts(facts)) return null
  const certs = Array.isArray(facts.energy_certificates) ? facts.energy_certificates : []
  const withClass = certs.filter(
    (c) => c && typeof c.energy_class === 'string' && c.energy_class.trim() !== '',
  )
  if (withClass.length === 0) return null
  const validCert = withClass.find(
    (c) => String(c.state?.code || '').toUpperCase() === 'KEHTIV',
  )
  return (validCert || withClass[0]).energy_class.trim()
}

/**
 * Build invented Estonian `ee/1` demo register facts for KÜ Sõpruse 12 (`building_code: '100000001'`).
 * Never uses real resident/apartment membership data.
 * @param {string} [fetchedAt]
 * @returns {import('../api/schema').EEBuildingFacts}
 */
export function createDemoEeBuildingFacts(fetchedAt = '2026-11-15T09:00:00Z') {
  return {
    country_code: 'EE',
    schema: 'ee/1',
    source: {
      register: 'EHR',
      building_code: '100000001',
      fetched_at: fetchedAt,
      attribution: 'Ehitisregister',
    },
    building: {
      first_use_year: 1978,
      purpose: { code: '11222', label_et: 'Muu kolme või enama korteriga elamu' },
      state: { code: 'K', label_et: 'Kasutusel' },
      ownership: { code: 'ERA', label_et: 'Eraomand' },
      construction_started_on: '1976-04-12',
      floors_max: 5,
      floors_min: -1,
      lifts: 0,
      rooms: 18,
      non_residential_units: 1,
      closed_net_area_m2: '642.5',
      heated_area_m2: '512.0',
      common_area_m2: '98.5',
      auxiliary_area_m2: '32.0',
      footprint_m2: '218.4',
      volume_m3: '1920.0',
      height_m: '16.5',
    },
    units: [
      {
        number: '1',
        kind: 'APARTMENT',
        area_m2: '48.5',
        heated_area_m2: '48.5',
        rooms: 2,
        toilets: 1,
        entrance_floor: 1,
      },
      {
        number: '2',
        kind: 'APARTMENT',
        area_m2: '54.3',
        heated_area_m2: '54.3',
        rooms: 2,
        toilets: 1,
        entrance_floor: 1,
      },
      {
        number: '5',
        kind: 'APARTMENT',
        area_m2: '62.1',
        heated_area_m2: '62.1',
        rooms: 3,
        toilets: 1,
        entrance_floor: 2,
      },
      {
        number: '9',
        kind: 'APARTMENT',
        area_m2: '52.0',
        heated_area_m2: '52.0',
        rooms: 2,
        toilets: 1,
        entrance_floor: 3,
      },
      {
        number: '14',
        kind: 'APARTMENT',
        area_m2: '54.3',
        heated_area_m2: '54.3',
        rooms: 2,
        toilets: 1,
        entrance_floor: 4,
      },
      {
        number: '15',
        kind: 'APARTMENT',
        area_m2: '58.0',
        heated_area_m2: '58.0',
        rooms: 3,
        toilets: 1,
        entrance_floor: 4,
      },
      {
        number: 'A1',
        kind: 'NON_RESIDENTIAL',
        area_m2: '32.0',
        heated_area_m2: '32.0',
        rooms: 1,
        toilets: 1,
        entrance_floor: 1,
      },
      {
        number: null,
        kind: 'COMMON',
        area_m2: '98.5',
        heated_area_m2: null,
        rooms: null,
        toilets: null,
        entrance_floor: null,
      },
    ],
    energy_certificates: [
      {
        energy_class: 'C',
        document_number: '2411552/001',
        document_kind: { code: 'KEK', label_et: 'Olemasoleva hoone energiamärgis' },
        state: { code: 'KEHTIV', label_et: 'Kehtiv' },
        issued_on: '2024-03-18',
        valid_until: '2034-03-18',
        value: 142,
        value_type: 'ETA',
      },
    ],
    technical: [
      {
        group: { code: 'VUNDAMENT', label_et: 'Vundamendi liik' },
        value: { code: 'VAIVUNDAMENT', label_et: 'Madalvundament (betoonplokk)' },
      },
      {
        group: { code: 'VALISSEIN', label_et: 'Välisseina materjal' },
        value: { code: 'RAUDBETOON_PANEEL', label_et: 'Monteeritav raudbetoonpaneel' },
      },
      {
        group: { code: 'KATUS', label_et: 'Katusekatte materjal' },
        value: { code: 'RULLMATERJAL', label_et: 'Bituumenrullmaterjal' },
      },
      {
        group: { code: 'KYTE', label_et: 'Soojusvarustuse liik' },
        value: { code: 'KAUGKYTE', label_et: 'Kaugküte' },
      },
    ],
    cadastral_units: [{ code: '78407:701:0421' }],
  }
}

export const REGISTRY_QUERY_MIN_LENGTH = 3
export const REGISTRY_QUERY_MAX_LENGTH = 200
export const REGISTRY_CODE_PATTERN = /^\d{6,12}$/

/**
 * Collapse consecutive whitespace and trim a register search query string.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeRegistrySearchQuery(raw) {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * Validate search input: returns `'EMPTY'` when blank (triggers default address `{}`),
 * `'TOO_SHORT'` (1..2 chars), `'TOO_LONG'` (>200 chars), or `'VALID'`.
 * @param {unknown} raw
 * @returns {'EMPTY' | 'TOO_SHORT' | 'TOO_LONG' | 'VALID'}
 */
export function validateRegistrySearchQuery(raw) {
  const normalized = normalizeRegistrySearchQuery(raw)
  if (!normalized) return 'EMPTY'
  if (normalized.length < REGISTRY_QUERY_MIN_LENGTH) return 'TOO_SHORT'
  if (normalized.length > REGISTRY_QUERY_MAX_LENGTH) return 'TOO_LONG'
  return 'VALID'
}

/**
 * Build invented public register candidate search results for demo / tests.
 * @returns {import('../api/schema').RegistryCandidateView[]}
 */
export function createDemoRegistryCandidates() {
  return [
    {
      code: '100000001',
      address: 'Harju maakond, Tallinn, Kristiine linnaosa, Sõpruse pst 12',
      kind_label: 'EHITISHOONE',
    },
    {
      code: '100000002',
      address: 'Harju maakond, Tallinn, Kristiine linnaosa, Sõpruse pst 12/2',
      kind_label: 'ABIHOONE',
    },
    {
      code: '100000003',
      address: 'Harju maakond, Tallinn, Kristiine linnaosa, Sõpruse pst 14',
      kind_label: 'EHITISHOONE',
    },
  ]
}

/**
 * Build invented Estonian `ee/1` facts for a known demo building code (`100000001`, `100000002`, `100000003`).
 * Returns `null` when the code does not exist in demo register data.
 * @param {string} code
 * @param {string} [fetchedAt]
 * @returns {import('../api/schema').EEBuildingFacts | null}
 */
export function createDemoEeBuildingFactsForCode(code, fetchedAt = '2026-11-15T10:00:00Z') {
  const normalized = typeof code === 'string' ? code.trim() : ''
  if (normalized === '100000001') {
    return createDemoEeBuildingFacts(fetchedAt)
  }
  if (normalized === '100000002') {
    return {
      country_code: 'EE',
      schema: 'ee/1',
      source: {
        register: 'EHR',
        building_code: '100000002',
        fetched_at: fetchedAt,
        attribution: 'Ehitisregister',
      },
      building: {
        first_use_year: 1984,
        purpose: { code: '11221', label_et: 'Kahe korteriga elamu' },
        state: { code: 'K', label_et: 'Kasutusel' },
        ownership: { code: 'ERA', label_et: 'Eraomand' },
        construction_started_on: '1983-06-01',
        floors_max: 2,
        floors_min: 0,
        lifts: 0,
        rooms: 6,
        non_residential_units: 0,
        closed_net_area_m2: '148.20',
        heated_area_m2: '124.0',
        common_area_m2: '24.20',
        auxiliary_area_m2: '18.0',
        footprint_m2: '82.5',
        volume_m3: '410.0',
        height_m: '7.2',
      },
      units: [
        {
          number: '1',
          kind: 'APARTMENT',
          area_m2: '62.0',
          heated_area_m2: '62.0',
          rooms: 3,
          toilets: 1,
          entrance_floor: 1,
        },
        {
          number: '2',
          kind: 'APARTMENT',
          area_m2: '62.0',
          heated_area_m2: '62.0',
          rooms: 3,
          toilets: 1,
          entrance_floor: 2,
        },
      ],
      energy_certificates: [],
      technical: [
        {
          group: { code: 'VUNDAMENT', label_et: 'Vundamendi liik' },
          value: { code: 'MADALVUNDAMENT', label_et: 'Madalvundament' },
        },
      ],
      cadastral_units: [{ code: '78407:701:0422' }],
    }
  }
  if (normalized === '100000003') {
    const base = createDemoEeBuildingFacts(fetchedAt)
    base.source.building_code = '100000003'
    base.building.first_use_year = 1991
    base.building.floors_max = 6
    base.cadastral_units = [{ code: '78407:701:0423' }]
    return base
  }
  return null
}
