import test from 'node:test'
import assert from 'node:assert/strict'
import en from '../locales/en.js'
import et from '../locales/et.js'
import ru from '../locales/ru.js'
import {
  formatBadgeObjectToken,
  formatObjectArea,
  formatObjectLocation,
  formatTargetKindsList,
  formatTargetScopeLabel,
  isObjectInTarget,
  normalizeObjectKind,
  objectKindLabel,
  objectKindOrder,
  objectKindPluralLabel,
  objectName,
  objectShortName,
  resolveAutoPickedObjectId,
} from './objectName.js'

function makeT(messages: Record<string, unknown>) {
  return (key: string, params?: Record<string, unknown>): string => {
    const parts = key.split('.')
    let cur: unknown = messages
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p]
      } else {
        return key
      }
    }
    if (typeof cur !== 'string') return key
    if (!params) return cur
    return cur.replace(/\{(\w+)\}/g, (_, k) =>
      params[k] !== undefined && params[k] !== null ? String(params[k]) : `{${k}}`,
    )
  }
}

test('normalizeObjectKind defaults missing/unknown values to APARTMENT', () => {
  assert.equal(normalizeObjectKind('APARTMENT'), 'APARTMENT')
  assert.equal(normalizeObjectKind('PARKING'), 'PARKING')
  assert.equal(normalizeObjectKind('GARAGE'), 'GARAGE')
  assert.equal(normalizeObjectKind(undefined), 'APARTMENT')
  assert.equal(normalizeObjectKind(null), 'APARTMENT')
  assert.equal(normalizeObjectKind(''), 'APARTMENT')
  assert.equal(normalizeObjectKind('UNKNOWN'), 'APARTMENT')
})

test('objectName and objectShortName distinguish Apt 1, Parking 1, and Garage 12 in en/et/ru', () => {
  const tEn = makeT(en)
  const tEt = makeT(et)
  const tRu = makeT(ru)

  assert.equal(objectName('APARTMENT', '1', tEn), 'Apartment 1')
  assert.equal(objectName('PARKING', '1', tEn), 'Parking space 1')
  assert.equal(objectName('GARAGE', '12', tEn), 'Garage 12')
  assert.equal(objectName(undefined, '14', tEn), 'Apartment 14')

  assert.equal(objectName('APARTMENT', '1', tEt), 'Korter 1')
  assert.equal(objectName('PARKING', '1', tEt), 'Parkimiskoht 1')
  assert.equal(objectName('GARAGE', '12', tEt), 'Garaaž 12')

  assert.equal(objectName('APARTMENT', '1', tRu), 'Квартира 1')
  assert.equal(objectName('PARKING', '1', tRu), 'Парковочное место 1')
  assert.equal(objectName('GARAGE', '12', tRu), 'Гараж 12')

  assert.notEqual(objectName('APARTMENT', '1', tEn), objectName('PARKING', '1', tEn))
  assert.notEqual(objectShortName('APARTMENT', '1', tEn), objectShortName('PARKING', '1', tEn))
  assert.equal(objectShortName('GARAGE', '12', tEn), 'Garage 12')
  assert.equal(objectShortName('PARKING', 'P-2', tEt), 'Park. P-2')
  assert.equal(objectShortName('PARKING', '1', tRu), 'Парк. 1')
})

test('objectKindLabel, objectKindPluralLabel, and objectKindOrder', () => {
  const tEn = makeT(en)
  assert.equal(objectKindLabel('APARTMENT', tEn), 'Apartment')
  assert.equal(objectKindLabel('PARKING', tEn), 'Parking space')
  assert.equal(objectKindLabel('GARAGE', tEn), 'Garage')
  assert.equal(objectKindPluralLabel('PARKING', tEn), 'Parking spaces')
  assert.equal(objectKindPluralLabel('GARAGE', tEn), 'Garages')
  assert.equal(objectKindOrder('APARTMENT'), 0)
  assert.equal(objectKindOrder('PARKING'), 1)
  assert.equal(objectKindOrder('GARAGE'), 2)
})

test('formatObjectLocation handles null entrance/floor and negative/zero floors', () => {
  const tEn = makeT(en)
  assert.equal(formatObjectLocation({ floor: 4, entrance: 2 }, tEn), 'Floor 4 • Entrance 2')
  assert.equal(formatObjectLocation({ floor: 4, entrance: 2 }, tEn, 'comma'), 'Floor 4, Entrance 2')
  assert.equal(formatObjectLocation({ floor: -1, entrance: null }, tEn), 'Floor -1')
  assert.equal(formatObjectLocation({ floor: 0, entrance: null }, tEn), 'Floor 0')
  assert.equal(formatObjectLocation({ floor: null, entrance: 2 }, tEn), 'Entrance 2')
  assert.equal(formatObjectLocation({ floor: null, entrance: null }, tEn), '')
  assert.equal(formatObjectLocation(null, tEn), '')
})

test('formatObjectArea never outputs null or NaN m²', () => {
  assert.equal(formatObjectArea('54.30'), '54.30 m²')
  assert.equal(formatObjectArea('18.50'), '18.50 m²')
  assert.equal(formatObjectArea(null), '')
  assert.equal(formatObjectArea(undefined), '')
  assert.equal(formatObjectArea(''), '')
  assert.equal(formatObjectArea('not-a-number'), '')
})

test('formatBadgeObjectToken matches backend badge rules', () => {
  assert.equal(formatBadgeObjectToken('APARTMENT', '14'), 'Apt 14')
  assert.equal(formatBadgeObjectToken('PARKING', '1'), 'P1')
  assert.equal(formatBadgeObjectToken('PARKING', 'P-2'), 'P-2')
  assert.equal(formatBadgeObjectToken('PARKING', 'p12'), 'p12')
  assert.equal(formatBadgeObjectToken('GARAGE', '12'), 'G12')
  assert.equal(formatBadgeObjectToken('GARAGE', 'G12'), 'G12')
  assert.equal(formatBadgeObjectToken('GARAGE', '1G'), 'G1G')
})

test('resolveAutoPickedObjectId follows E14 auto-pick rules (#064)', () => {
  const mems = [
    { apartment_id: 'apt-14', apartment_kind: 'APARTMENT' as const },
    { apartment_id: 'apt-15', apartment_kind: 'APARTMENT' as const },
    { apartment_id: 'park-1', apartment_kind: 'PARKING' as const },
    { apartment_id: 'gar-12', apartment_kind: 'GARAGE' as const },
  ]
  assert.equal(resolveAutoPickedObjectId([], mems), null)
  assert.equal(resolveAutoPickedObjectId(['gar-12'], mems), 'gar-12')
  assert.equal(resolveAutoPickedObjectId(['apt-14', 'park-1'], mems), 'apt-14')
  assert.equal(resolveAutoPickedObjectId(['apt-14', 'park-1', 'gar-12'], mems), 'apt-14')
  assert.equal(resolveAutoPickedObjectId(['apt-14', 'apt-15'], mems), null)
  assert.equal(resolveAutoPickedObjectId(['park-1', 'gar-12'], mems), null)
})

test('formatTargetKindsList and formatTargetScopeLabel handle ALL_BUILDING, ALL_OBJECTS, KINDS, ENTRANCE, APARTMENT_LIST (#065)', () => {
  const tEn = makeT(en)
  const tEt = makeT(et)
  const tRu = makeT(ru)

  assert.equal(formatTargetKindsList(['GARAGE', 'PARKING'], tEn), 'Parking spaces, Garages')
  assert.equal(formatTargetKindsList(['PARKING'], tEt), 'Parkimiskohad')
  assert.equal(formatTargetKindsList(['GARAGE'], tRu), 'Гаражи')
  assert.equal(formatTargetKindsList([], tEn), '')

  assert.equal(formatTargetScopeLabel({ target_scope: 'ALL_OBJECTS' }, tEn), 'Everyone (all objects)')
  assert.equal(
    formatTargetScopeLabel({ target_scope: 'KINDS', target_kinds: ['GARAGE'] }, tEn),
    'For garages',
  )
  assert.equal(
    formatTargetScopeLabel({ target_scope: 'KINDS', target_kinds: ['PARKING', 'GARAGE'] }, tEn),
    'For parking spaces, garages',
  )
  assert.equal(formatTargetScopeLabel({ target_scope: 'KINDS', target_kinds: null }, tEn), 'By object kind')
  assert.equal(formatTargetScopeLabel({ target_scope: 'ENTRANCE', target_entrance: 2 }, tEn), 'Entrance 2')
  assert.equal(
    formatTargetScopeLabel({ target_scope: 'APARTMENT_LIST', target_apartment_ids: ['a', 'b'] }, tEn),
    'Selected objects',
  )
})

test('isObjectInTarget enforces ALL_BUILDING=apartments-only, ALL_OBJECTS, KINDS, ENTRANCE, APARTMENT_LIST (#065)', () => {
  const apt = { apartment_id: 'apt-1', apartment_kind: 'APARTMENT' as const, entrance: 1 }
  const park = { apartment_id: 'park-1', apartment_kind: 'PARKING' as const, entrance: null }
  const gar = { apartment_id: 'gar-12', apartment_kind: 'GARAGE' as const, entrance: null }

  assert.equal(isObjectInTarget({ target_scope: 'ALL_BUILDING' }, apt), true)
  assert.equal(isObjectInTarget({ target_scope: 'ALL_BUILDING' }, park), false)
  assert.equal(isObjectInTarget({ target_scope: 'ALL_BUILDING' }, gar), false)

  assert.equal(isObjectInTarget({ target_scope: 'ALL_OBJECTS' }, apt), true)
  assert.equal(isObjectInTarget({ target_scope: 'ALL_OBJECTS' }, park), true)
  assert.equal(isObjectInTarget({ target_scope: 'ALL_OBJECTS' }, gar), true)

  assert.equal(isObjectInTarget({ target_scope: 'KINDS', target_kinds: ['PARKING', 'GARAGE'] }, apt), false)
  assert.equal(isObjectInTarget({ target_scope: 'KINDS', target_kinds: ['PARKING', 'GARAGE'] }, park), true)
  assert.equal(isObjectInTarget({ target_scope: 'KINDS', target_kinds: ['PARKING', 'GARAGE'] }, gar), true)

  assert.equal(isObjectInTarget({ target_scope: 'ENTRANCE', target_entrance: 1 }, apt), true)
  assert.equal(isObjectInTarget({ target_scope: 'ENTRANCE', target_entrance: 1 }, park), false)

  assert.equal(isObjectInTarget({ target_scope: 'APARTMENT_LIST', target_apartment_ids: ['gar-12'] }, gar), true)
  assert.equal(isObjectInTarget({ target_scope: 'APARTMENT_LIST', target_apartment_ids: ['gar-12'] }, apt), false)

  // Fail-closed on null target, unknown scope, and unknown future apartment_kind (CTO audit P2-7)
  assert.equal(isObjectInTarget(null, apt), false)
  assert.equal(isObjectInTarget({ target_scope: 'FUTURE_SCOPE' as never }, apt), false)
  const storage = { apartment_id: 'st-1', apartment_kind: 'STORAGE', entrance: null }
  assert.equal(isObjectInTarget({ target_scope: 'ALL_BUILDING' }, storage), false)
  assert.equal(isObjectInTarget({ target_scope: 'KINDS', target_kinds: ['APARTMENT'] }, storage), false)
})


