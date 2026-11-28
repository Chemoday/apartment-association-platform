import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateQrMatrix, generateQrPath, generateQrSvg } from './qrCode.js'

function readFormatCopyA(modules: boolean[][]): number {
  let bits = 0
  for (let i = 0; i <= 5; i += 1) bits = (bits << 1) | (modules[8][i] ? 1 : 0)
  bits = (bits << 1) | (modules[8][7] ? 1 : 0)
  bits = (bits << 1) | (modules[8][8] ? 1 : 0)
  bits = (bits << 1) | (modules[7][8] ? 1 : 0)
  for (let i = 9; i < 15; i += 1) bits = (bits << 1) | (modules[14 - i][8] ? 1 : 0)
  return bits
}

function readFormatCopyB(modules: boolean[][]): number {
  const size = modules.length
  let bits = 0
  // Bits 14..8 from bottom-left vertical strip (bottom to top: size-1 down to size-7)
  for (let i = 0; i < 7; i += 1) {
    bits = (bits << 1) | (modules[size - 1 - i][8] ? 1 : 0)
  }
  // Bits 7..0 from top-right horizontal strip (left to right: size-8 to size-1)
  for (let i = 7; i >= 0; i -= 1) {
    bits = (bits << 1) | (modules[8][size - 1 - i] ? 1 : 0)
  }
  return bits
}

function bchRemainder15(val: number): number {
  let rem = val
  for (let i = 4; i >= 0; i -= 1) {
    if (rem & (1 << (i + 10))) rem ^= 0x537 << i
  }
  return rem & 0x3ff
}

describe('local QR code generator (#059 + CTO audit P1-1)', () => {
  it('encodes identical, BCH-valid ISO/IEC 18004 format info in both copies with dark module', () => {
    const url = 'https://app.example.ee/join#code=K7QF-M3TX-9R'
    const matrix = generateQrMatrix(url)
    assert.ok(matrix.size >= 29)
    assert.equal(matrix.modules.length, matrix.size)

    // Finder patterns + dark module
    assert.equal(matrix.modules[0][0], true)
    assert.equal(matrix.modules[3][3], true)
    assert.equal(matrix.modules[1][1], false)
    assert.equal(matrix.modules[matrix.size - 8][8], true)

    // Both format info copies must be bit-for-bit identical and have 0 BCH syndrome error
    const fmtA = readFormatCopyA(matrix.modules)
    const fmtB = readFormatCopyB(matrix.modules)
    assert.equal(fmtA, fmtB, 'Primary and secondary ISO/IEC 18004 format strips must match')
    const unmasked = fmtA ^ 0x5412
    assert.equal(bchRemainder15(unmasked), 0, 'Format info BCH(15,5) syndrome must be 0')
    // EC level M = 00 in top 2 bits of 5-bit payload
    const ecBits = (unmasked >>> 13) & 0b11
    assert.equal(ecBits, 0b00)
  })

  it('renders a crisp self-contained SVG and path data with quiet zone', () => {
    const data = generateQrPath('https://app.example.ee/join#code=K7QF-M3TX-9R')
    assert.ok(data.size >= 37)
    assert.ok(data.path.startsWith('M'))

    const svg = generateQrSvg('https://app.example.ee/join#code=K7QF-M3TX-9R')
    assert.ok(svg.startsWith('<svg '))
    assert.ok(svg.endsWith('</svg>'))
  })

  it('throws cleanly on oversized payloads (>213 bytes) so callers can catch and fallback', () => {
    const huge = `https://example.ee/${'a'.repeat(240)}`
    assert.throws(() => generateQrPath(huge), /exceeds supported length/i)
  })
})
