import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSafeHashSelector, safeHttpUrl, safeTelHref } from './safeUrls.js'

describe('safeUrls fail-closed validators (CTO audit P0-1, P1-3, P1-7)', () => {
  it('allows only http/https in safeHttpUrl and rejects javascript:/data:/malformed', () => {
    assert.equal(safeHttpUrl('https://example.ee/privacy'), 'https://example.ee/privacy')
    assert.equal(safeHttpUrl('http://example.ee/privacy?lang=et'), 'http://example.ee/privacy?lang=et')
    const jsProto = 'java' + 'script:'
    assert.equal(safeHttpUrl(`${jsProto}alert(1)`), null)
    assert.equal(safeHttpUrl(`${jsProto.toUpperCase()}alert(1)`), null)
    assert.equal(safeHttpUrl('data:text/html,<script>alert(1)</script>'), null)
    assert.equal(safeHttpUrl('/relative/path'), null)
    assert.equal(safeHttpUrl(''), null)
    assert.equal(safeHttpUrl(null), null)
  })

  it('allows only strict E.164 in safeTelHref and rejects DTMF/USSD/garbage', () => {
    assert.equal(safeTelHref('+37255512345'), 'tel:+37255512345')
    assert.equal(safeTelHref('+37255512345;postd=*123#'), null)
    assert.equal(safeTelHref('*#06#'), null)
    assert.equal(safeTelHref('55512345'), null)
    assert.equal(safeTelHref('+0123456789'), null)
    assert.equal(safeTelHref(null), null)
  })

  it('validates CSS ID hash selectors for scrollBehavior', () => {
    assert.equal(isSafeHashSelector('#building-register'), true)
    assert.equal(isSafeHashSelector('#code=K7QF-M3TX-9R'), false)
    assert.equal(isSafeHashSelector('#token=abc'), false)
    assert.equal(isSafeHashSelector('#123invalid'), false)
    assert.equal(isSafeHashSelector(''), false)
  })
})
