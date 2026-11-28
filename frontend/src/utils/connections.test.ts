import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildConnectionOverview, getPresentKindSummaries } from './connections.js'

describe('connections overview builder (#058 + #069)', () => {
  it('computes summary, by_status, by_kind, filtering, and paging across apartment/parking/garage', () => {
    const overview = buildConnectionOverview({
      apartments: [
        { apartment_id: 'a1', apartment_number: '01', apartment_kind: 'APARTMENT', entrance: 1 },
        { apartment_id: 'a2', apartment_number: '02', apartment_kind: 'APARTMENT', entrance: 1 },
        { apartment_id: 'a3', apartment_number: '03', apartment_kind: 'APARTMENT', entrance: 2 },
        { apartment_id: 'p1', apartment_number: '1', apartment_kind: 'PARKING', entrance: null },
        { apartment_id: 'g1', apartment_number: '12', apartment_kind: 'GARAGE', entrance: null },
      ],
      memberships: [
        { apartment_id: 'a1', relation_type: 'OWNER' },
        { apartment_id: 'a2', relation_type: 'TENANT' },
        { apartment_id: 'p1', relation_type: 'OWNER' },
      ],
      invitations: [
        {
          apartment_id: 'a3',
          kind: 'OWNER',
          status: 'PENDING',
          created_at: '2026-11-20T10:00:00Z',
          delivery: 'QUEUED',
        },
      ],
      paperApartmentIds: new Set(['g1']),
    })

    assert.equal(overview.summary.apartments, 5)
    assert.equal(overview.summary.connected, 2)
    assert.equal(overview.summary.by_status.CONNECTED, 2)
    assert.equal(overview.summary.by_status.TENANT_ONLY, 1)
    assert.equal(overview.summary.by_status.INVITED, 1)
    assert.equal(overview.summary.by_status.PAPER, 1)
    assert.deepEqual(overview.summary.by_kind.APARTMENT, { objects: 3, connected: 1 })
    assert.deepEqual(overview.summary.by_kind.PARKING, { objects: 1, connected: 1 })
    assert.deepEqual(overview.summary.by_kind.GARAGE, { objects: 1, connected: 0 })

    const invRow = overview.items.find((i) => i.apartment_id === 'a3')
    assert.equal(invRow?.invitation_delivery, 'QUEUED')
    const garageRow = overview.items.find((i) => i.apartment_id === 'g1')
    assert.equal(garageRow?.entrance, null)
    assert.equal(garageRow?.on_paper, true)

    const presentKinds = getPresentKindSummaries(overview.summary.by_kind)
    assert.equal(presentKinds.length, 3)

    const filtered = buildConnectionOverview({
      apartments: [
        { apartment_id: 'a1', apartment_number: '01', apartment_kind: 'APARTMENT', entrance: 1 },
        { apartment_id: 'g1', apartment_number: '12', apartment_kind: 'GARAGE', entrance: null },
      ],
      memberships: [{ apartment_id: 'a1', relation_type: 'OWNER' }],
      invitations: [],
      paperApartmentIds: new Set(['g1']),
      statusFilter: 'PAPER',
      limit: 1,
      offset: 0,
    })
    assert.equal(filtered.matching, 1)
    assert.equal(filtered.items.length, 1)
    assert.equal(filtered.items[0].apartment_id, 'g1')
  })
})
