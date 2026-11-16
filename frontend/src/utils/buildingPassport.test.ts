import test from 'node:test'
import assert from 'node:assert/strict'
import { i18n } from '../locales/index.js'
import { formatCalendarDate } from './dates.js'
import {
  createDemoEeBuildingFacts,
  createDemoEeBuildingFactsForCode,
  createDemoRegistryCandidates,
  formatRegisterDecimal,
  formatRegisterInt,
  formatRegisterText,
  getPrimaryEnergyClass,
  isSupportedBuildingFacts,
  KNOWN_CLASSIFIED_CODES,
  normalizeRegistrySearchQuery,
  REGISTRY_CODE_PATTERN,
  resolveCertValueTypeLabel,
  resolveClassifiedLabel,
  resolveUnitKindLabel,
  validateRegistrySearchQuery,
} from './buildingPassport.js'

test('isSupportedBuildingFacts accepts EE + ee/1 and rejects null or unknown country/schema', () => {
  const valid = createDemoEeBuildingFacts()
  assert.equal(isSupportedBuildingFacts(valid), true)
  assert.equal(isSupportedBuildingFacts(null), false)
  assert.equal(isSupportedBuildingFacts(undefined), false)
  assert.equal(isSupportedBuildingFacts({ ...valid, country_code: 'LV' }), false)
  assert.equal(isSupportedBuildingFacts({ ...valid, schema: 'ee/2' }), false)
  assert.equal(isSupportedBuildingFacts({ ...valid, building: null }), false)
})

test('formatRegisterDecimal preserves decimal strings verbatim and maps null/empty to "-"', () => {
  assert.equal(formatRegisterDecimal('2001.40', 'm²'), '2001.40 m²')
  assert.equal(formatRegisterDecimal('0.00', 'm³'), '0.00 m³')
  assert.equal(formatRegisterDecimal('16.5', 'm'), '16.5 m')
  assert.equal(formatRegisterDecimal('12345678901234567.890', 'm²'), '12345678901234567.890 m²')
  assert.equal(formatRegisterDecimal(null, 'm²'), '-')
  assert.equal(formatRegisterDecimal(undefined, 'm²'), '-')
  assert.equal(formatRegisterDecimal('   ', 'm²'), '-')
})

test('formatRegisterInt and formatRegisterText handle zero, negatives, and null values', () => {
  assert.equal(formatRegisterInt(0), '0')
  assert.equal(formatRegisterInt(-1), '-1')
  assert.equal(formatRegisterInt(1978), '1978')
  assert.equal(formatRegisterInt(null), '-')
  assert.equal(formatRegisterInt(undefined), '-')
  assert.equal(formatRegisterText('A1'), 'A1')
  assert.equal(formatRegisterText(null), '-')
  assert.equal(formatRegisterText('   '), '-')
})

test('formatCalendarDate formats pure YYYY-MM-DD dates in UTC without timezone shift', () => {
  assert.equal(formatCalendarDate('1976-04-12', 'en'), '12 Apr 1976')
  assert.equal(formatCalendarDate('2024-03-18', 'en'), '18 Mar 2024')
  assert.equal(formatCalendarDate('2034-03-18', 'en'), '18 Mar 2034')
  assert.equal(formatCalendarDate(null, 'en'), '-')
  assert.equal(formatCalendarDate(undefined, 'en'), '-')
  assert.equal(formatCalendarDate('   ', 'en'), '-')
})

test('resolveClassifiedLabel translates known codes across locales and falls back to label_et for unknown codes', () => {
  for (const locale of ['en', 'et', 'ru'] as const) {
    const t = (k: string) => i18n.global.t(k, {}, { locale })
    for (const code of KNOWN_CLASSIFIED_CODES) {
      const resolved = resolveClassifiedLabel({ code, label_et: 'Fallback ET' }, t)
      assert.ok(resolved.length > 0)
      assert.notEqual(resolved, 'Fallback ET', `${locale} should translate known code ${code}`)
    }
    assert.equal(
      resolveClassifiedLabel({ code: 'KAUGKYTE', label_et: 'Kaugküte' }, t),
      'Kaugküte',
    )
    assert.equal(resolveClassifiedLabel(null, t), '-')
    assert.equal(resolveClassifiedLabel({ code: null, label_et: null }, t), '-')
  }
})

test('resolveCertValueTypeLabel translates ETA and KEK distinctly and preserves unknown codes', () => {
  for (const locale of ['en', 'et', 'ru'] as const) {
    const t = (k: string) => i18n.global.t(k, {}, { locale })
    const etaLabel = resolveCertValueTypeLabel('ETA', t)
    const kekLabel = resolveCertValueTypeLabel('KEK', t)
    assert.ok(etaLabel.length > 0)
    assert.ok(kekLabel.length > 0)
    assert.notEqual(etaLabel, kekLabel)
    assert.notEqual(etaLabel, resolveClassifiedLabel({ code: 'ETA', label_et: 'ETA' }, t))
    assert.equal(resolveCertValueTypeLabel('CUSTOM_TYPE', t), 'CUSTOM_TYPE')
    assert.equal(resolveCertValueTypeLabel(null, t), '')
    assert.equal(resolveCertValueTypeLabel('   ', t), '')
  }
})

test('resolveUnitKindLabel translates all EEUnit kinds in en, et, and ru', () => {
  for (const locale of ['en', 'et', 'ru'] as const) {
    const t = (k: string) => i18n.global.t(k, {}, { locale })
    assert.ok(resolveUnitKindLabel('APARTMENT', t).length > 2)
    assert.ok(resolveUnitKindLabel('NON_RESIDENTIAL', t).length > 2)
    assert.ok(resolveUnitKindLabel('COMMON', t).length > 2)
    assert.ok(resolveUnitKindLabel('OTHER', t).length > 2)
    assert.equal(resolveUnitKindLabel('UNEXPECTED_KIND', t), resolveUnitKindLabel('OTHER', t))
  }
})

test('getPrimaryEnergyClass prefers valid certificate and returns null when empty', () => {
  const facts = createDemoEeBuildingFacts()
  assert.equal(getPrimaryEnergyClass(facts), 'C')
  assert.equal(
    getPrimaryEnergyClass({
      ...facts,
      energy_certificates: [
        {
          energy_class: 'D',
          document_number: '1',
          document_kind: null,
          state: { code: 'KEHTETU', label_et: 'Kehtetu' },
          issued_on: null,
          valid_until: null,
          value: null,
          value_type: null,
        },
        {
          energy_class: 'B',
          document_number: '2',
          document_kind: null,
          state: { code: 'KEHTIV', label_et: 'Kehtiv' },
          issued_on: null,
          valid_until: null,
          value: null,
          value_type: null,
        },
      ],
    }),
    'B',
  )
  assert.equal(getPrimaryEnergyClass({ ...facts, energy_certificates: [] }), null)
  assert.equal(getPrimaryEnergyClass(null), null)
})

test('normalizeRegistrySearchQuery and validateRegistrySearchQuery enforce 3..200 collapsed length (#035)', () => {
  assert.equal(normalizeRegistrySearchQuery('  Sõpruse   pst  12 '), 'Sõpruse pst 12')
  assert.equal(normalizeRegistrySearchQuery(null), '')
  assert.equal(validateRegistrySearchQuery(''), 'EMPTY')
  assert.equal(validateRegistrySearchQuery('   \n\t '), 'EMPTY')
  assert.equal(validateRegistrySearchQuery('ab'), 'TOO_SHORT')
  assert.equal(validateRegistrySearchQuery('   ab   '), 'TOO_SHORT')
  assert.equal(validateRegistrySearchQuery(' a  b '), 'VALID')
  assert.equal(validateRegistrySearchQuery('abc'), 'VALID')
  assert.equal(validateRegistrySearchQuery('Sõpruse pst 12'), 'VALID')
  assert.equal(validateRegistrySearchQuery('x'.repeat(200)), 'VALID')
  assert.equal(validateRegistrySearchQuery(`  ${'x'.repeat(200)}   `), 'VALID')
  assert.equal(validateRegistrySearchQuery('x'.repeat(201)), 'TOO_LONG')
})

test('demo register candidates and facts-by-code helpers cover invented codes and unknown fallback (#035)', () => {
  const candidates = createDemoRegistryCandidates()
  assert.ok(candidates.length > 0 && candidates.length <= 10)
  for (const c of candidates) {
    assert.match(c.code, REGISTRY_CODE_PATTERN)
    const facts = createDemoEeBuildingFactsForCode(c.code)
    assert.ok(facts, `Expected demo facts for ${c.code}`)
    assert.equal(isSupportedBuildingFacts(facts), true)
    assert.equal(facts!.source.building_code, c.code)
  }
  assert.equal(createDemoEeBuildingFactsForCode('999999999'), null)
  assert.equal(createDemoEeBuildingFactsForCode('bad'), null)
})
