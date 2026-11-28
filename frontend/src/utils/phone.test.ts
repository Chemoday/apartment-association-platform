import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  composePhoneNumber,
  formatPhoneDisplay,
  getSortedPhoneCountries,
  normalizePhoneToE164,
} from './phone.js'

describe('phone helpers (#055 / #060 / #061)', () => {
  it('sorts the default country first', () => {
    const list = getSortedPhoneCountries('FI')
    assert.equal(list[0].code, 'FI')
    assert.equal(list[0].dialCode, '+358')
  })

  it('composes default country, another country, typed +, and empty input', () => {
    assert.equal(composePhoneNumber('EE', '5765 4321'), '+372 5765 4321')
    assert.equal(composePhoneNumber('LV', '21234567'), '+371 21234567')
    assert.equal(composePhoneNumber('EE', '+358 40 1234567'), '+358 40 1234567')
    assert.equal(composePhoneNumber('EE', '   '), null)
  })

  it('normalizes valid phones to E.164 and rejects numbers without +', () => {
    assert.equal(normalizePhoneToE164('+372 5765-4321'), '+37257654321')
    assert.equal(normalizePhoneToE164('57654321'), null)
    assert.equal(normalizePhoneToE164('+123'), null)
  })

  it('formats E.164 numbers for display without altering digits', () => {
    assert.equal(formatPhoneDisplay('+37257654321'), '+372 5765 4321')
  })
})
