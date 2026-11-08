import test from 'node:test'
import assert from 'node:assert/strict'
import { stashLinkToken, takeLinkToken } from './linkToken.js'

test('takeLinkToken returns stashed token once and empty string on second call', () => {
  assert.equal(takeLinkToken(), '')
  stashLinkToken('magic-token-abc-123')
  assert.equal(takeLinkToken(), 'magic-token-abc-123')
  assert.equal(takeLinkToken(), '')
})

test('stashLinkToken normalizes both raw #<token> and #token=<token> fragments', () => {
  stashLinkToken('token=demo-valid-token')
  assert.equal(takeLinkToken(), 'demo-valid-token')
  assert.equal(takeLinkToken(), '')
})
