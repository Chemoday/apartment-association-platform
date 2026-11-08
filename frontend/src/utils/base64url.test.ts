import test from 'node:test'
import assert from 'node:assert/strict'
import { base64UrlToUint8Array, bufferToBase64Url } from './base64url.js'

test('base64UrlToUint8Array and bufferToBase64Url round-trip 65-byte VAPID key', () => {
  const sampleKey =
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
  const bytes = base64UrlToUint8Array(sampleKey)
  assert.equal(bytes.length, 65)
  assert.equal(bytes[0], 0x04)

  const roundTripped = bufferToBase64Url(bytes)
  assert.equal(roundTripped, sampleKey)

  const fromArrayBuffer = bufferToBase64Url(bytes.buffer as ArrayBuffer)
  assert.equal(fromArrayBuffer, sampleKey)
})
