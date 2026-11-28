import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  evaluateBulkInvitationsText,
  isBulkOutcomeProblem,
  type BulkApartmentCandidate,
} from './bulkInvitations.js'

const SAMPLE_APARTMENTS: BulkApartmentCandidate[] = [
  { apartment_id: 'apt-01', apartment_number: '01', apartment_kind: 'APARTMENT' },
  { apartment_id: 'apt-14', apartment_number: '14', apartment_kind: 'APARTMENT' },
  { apartment_id: 'park-1', apartment_number: '1', apartment_kind: 'PARKING' },
  { apartment_id: 'gar-12', apartment_number: '12', apartment_kind: 'GARAGE' },
]

describe('bulkInvitations evaluator (#057 + #069)', () => {
  it('parses ;, tab, and , separators, skips comments and header, and handles optional 4th kind cell', () => {
    const text = [
      '# Comment line',
      'apartment;email;locale;kind',
      '14; owner14@example.com; et',
      '1\townerp1@example.com\ten\tPARKING',
      '12, ownerg12@example.com, ru, GARAGE',
    ].join('\n')

    const { report } = evaluateBulkInvitationsText(text, {
      apartments: SAMPLE_APARTMENTS,
      existingPending: [],
      limitRemaining: 20,
      mode: 'preview',
    })

    assert.equal(report.rows.length, 3)
    assert.equal(report.counts.READY, 3)
    assert.equal(report.rows[0].apartment_kind, 'APARTMENT')
    assert.equal(report.rows[0].outcome, 'READY')
    assert.equal(report.rows[1].apartment_kind, 'PARKING')
    assert.equal(report.rows[1].outcome, 'READY')
    assert.equal(report.rows[2].apartment_kind, 'GARAGE')
    assert.equal(report.rows[2].outcome, 'READY')
    assert.equal(report.limit_remaining, 20)
  })

  it('classifies all error outcomes including INVALID_KIND, DUPLICATE_IN_LIST, and ALREADY_PENDING', () => {
    const text = [
      'only-one-cell',
      '14; not-an-email; et',
      '14; badlocale@example.com; de',
      '14; badkind@example.com; et; STORAGE',
      '99; missing@example.com; en',
      '14; dup@example.com; en',
      '14; dup@example.com; en',
      '01; pending@example.com; et',
    ].join('\n')

    const { report } = evaluateBulkInvitationsText(text, {
      apartments: SAMPLE_APARTMENTS,
      existingPending: [
        { apartment_id: 'apt-01', apartment_number: '01', raw_email: 'pending@example.com' },
      ],
      limitRemaining: 10,
      mode: 'preview',
    })

    assert.equal(report.counts.INVALID_ROW, 1)
    assert.equal(report.counts.INVALID_EMAIL, 1)
    assert.equal(report.counts.INVALID_LOCALE, 1)
    assert.equal(report.counts.INVALID_KIND, 1)
    assert.equal(report.counts.APARTMENT_NOT_FOUND, 1)
    assert.equal(report.counts.READY, 1)
    assert.equal(report.counts.DUPLICATE_IN_LIST, 1)
    assert.equal(report.counts.ALREADY_PENDING, 1)
    assert.equal(isBulkOutcomeProblem('INVALID_KIND'), true)
    assert.equal(isBulkOutcomeProblem('READY'), false)
    assert.equal(isBulkOutcomeProblem('INVITED'), false)
  })

  it('returns INVITED rows and decrements limit_remaining in send mode, and throws 429 when over limit', () => {
    const text = '14; a@example.com; et\n1; b@example.com; en; PARKING'

    const { report, invitedRows } = evaluateBulkInvitationsText(text, {
      apartments: SAMPLE_APARTMENTS,
      existingPending: [],
      limitRemaining: 5,
      mode: 'send',
    })
    assert.equal(report.counts.INVITED, 2)
    assert.equal(report.limit_remaining, 3)
    assert.equal(invitedRows.length, 2)
    assert.equal(invitedRows[1].apartment_id, 'park-1')

    assert.throws(
      () =>
        evaluateBulkInvitationsText(text, {
          apartments: SAMPLE_APARTMENTS,
          existingPending: [],
          limitRemaining: 1,
          mode: 'send',
        }),
      (err: { status?: number; errorCode?: string }) =>
        err.status === 429 && err.errorCode === 'RATE_LIMITED',
    )
  })

  it('throws 422 BULK_LIST_TOO_LONG when rows exceed twice the building objects', () => {
    const lines = Array.from({ length: 9 }, (_, i) => `14; u${i}@example.com; en`).join('\n')
    assert.throws(
      () =>
        evaluateBulkInvitationsText(lines, {
          apartments: SAMPLE_APARTMENTS,
          existingPending: [],
          limitRemaining: 50,
          mode: 'preview',
        }),
      (err: { status?: number; errorCode?: string }) =>
        err.status === 422 && err.errorCode === 'BULK_LIST_TOO_LONG',
    )
  })

  it('strips UTF-8 BOM, drops trailing empty spreadsheet cells, and matches apartment numbers strictly (P2-3)', () => {
    const text = '\uFEFFunit;contact_mail;lang\n14; excel@example.com; ; ;\n014; wrongzero@example.com; en'
    const { report } = evaluateBulkInvitationsText(text, {
      apartments: SAMPLE_APARTMENTS,
      existingPending: [],
      limitRemaining: 10,
      mode: 'preview',
    })
    assert.equal(report.rows.length, 2)
    assert.equal(report.rows[0].outcome, 'READY')
    assert.equal(report.rows[1].outcome, 'APARTMENT_NOT_FOUND')
  })
})
