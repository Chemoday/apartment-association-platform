/**
 * Pure TypeScript, zero-dependency ISO/IEC 18004 QR Code generator (Byte mode, EC Level M, Versions 1–10).
 * Runs entirely in the browser with no third-party service or external requests (#059).
 */

interface VersionSpec {
  version: number
  dataCodewords: number
  ecPerBlock: number
  blocks: Array<{ count: number; dataCodewords: number }>
  alignment: number[]
}

const VERSION_SPECS: VersionSpec[] = [
  { version: 1, dataCodewords: 16, ecPerBlock: 10, blocks: [{ count: 1, dataCodewords: 16 }], alignment: [] },
  { version: 2, dataCodewords: 28, ecPerBlock: 16, blocks: [{ count: 1, dataCodewords: 28 }], alignment: [6, 18] },
  { version: 3, dataCodewords: 44, ecPerBlock: 26, blocks: [{ count: 1, dataCodewords: 44 }], alignment: [6, 22] },
  { version: 4, dataCodewords: 64, ecPerBlock: 18, blocks: [{ count: 2, dataCodewords: 32 }], alignment: [6, 26] },
  { version: 5, dataCodewords: 86, ecPerBlock: 24, blocks: [{ count: 2, dataCodewords: 43 }], alignment: [6, 30] },
  { version: 6, dataCodewords: 108, ecPerBlock: 16, blocks: [{ count: 4, dataCodewords: 27 }], alignment: [6, 34] },
  { version: 7, dataCodewords: 124, ecPerBlock: 18, blocks: [{ count: 4, dataCodewords: 31 }], alignment: [6, 22, 38] },
  { version: 8, dataCodewords: 154, ecPerBlock: 22, blocks: [{ count: 2, dataCodewords: 38 }, { count: 2, dataCodewords: 39 }], alignment: [6, 24, 42] },
  { version: 9, dataCodewords: 182, ecPerBlock: 22, blocks: [{ count: 3, dataCodewords: 36 }, { count: 2, dataCodewords: 37 }], alignment: [6, 26, 46] },
  { version: 10, dataCodewords: 216, ecPerBlock: 26, blocks: [{ count: 4, dataCodewords: 43 }, { count: 1, dataCodewords: 44 }], alignment: [6, 28, 50] },
]

// GF(256) tables with primitive polynomial 0x11d
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255]
  }
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

function rsGeneratorPoly(degree: number): Uint8Array {
  let poly: Uint8Array = new Uint8Array([1])
  for (let i = 0; i < degree; i += 1) {
    const next = new Uint8Array(poly.length + 1)
    const root = GF_EXP[i]
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j]
      next[j + 1] ^= gfMul(poly[j], root)
    }
    poly = next
  }
  return poly
}

function rsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = rsGeneratorPoly(ecCount)
  const res = new Uint8Array(ecCount)
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ res[0]
    res.copyWithin(0, 1)
    res[ecCount - 1] = 0
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) {
        res[j] ^= gfMul(gen[j + 1], factor)
      }
    }
  }
  return res
}

function selectVersion(byteLength: number): VersionSpec {
  for (const spec of VERSION_SPECS) {
    const countBits = spec.version <= 9 ? 8 : 16
    const overheadBits = 4 + countBits
    const capacityBytes = Math.floor((spec.dataCodewords * 8 - overheadBits) / 8)
    if (byteLength <= capacityBytes) return spec
  }
  throw new Error('QR payload exceeds supported length (max ~213 bytes).')
}

function encodeDataCodewords(bytes: Uint8Array, spec: VersionSpec): Uint8Array {
  const bits: number[] = []
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1)
    }
  }
  // Byte mode indicator (0100)
  pushBits(0b0100, 4)
  pushBits(bytes.length, spec.version <= 9 ? 8 : 16)
  for (const b of bytes) {
    pushBits(b, 8)
  }
  const totalBits = spec.dataCodewords * 8
  const terminator = Math.min(4, totalBits - bits.length)
  pushBits(0, terminator)
  while (bits.length % 8 !== 0) bits.push(0)

  const out = new Uint8Array(spec.dataCodewords)
  const byteCount = bits.length / 8
  for (let i = 0; i < byteCount; i += 1) {
    let v = 0
    for (let b = 0; b < 8; b += 1) {
      v = (v << 1) | bits[i * 8 + b]
    }
    out[i] = v
  }
  const padBytes = [0xec, 0x11]
  let padIdx = 0
  for (let i = byteCount; i < spec.dataCodewords; i += 1) {
    out[i] = padBytes[padIdx]
    padIdx ^= 1
  }
  return out
}

function interleaveBlocks(data: Uint8Array, spec: VersionSpec): Uint8Array {
  const dataBlocks: Uint8Array[] = []
  const ecBlocks: Uint8Array[] = []
  let offset = 0
  for (const group of spec.blocks) {
    for (let c = 0; c < group.count; c += 1) {
      const slice = data.subarray(offset, offset + group.dataCodewords)
      offset += group.dataCodewords
      dataBlocks.push(slice)
      ecBlocks.push(rsRemainder(slice, spec.ecPerBlock))
    }
  }
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length))
  const result: number[] = []
  for (let i = 0; i < maxDataLen; i += 1) {
    for (const blk of dataBlocks) {
      if (i < blk.length) result.push(blk[i])
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i += 1) {
    for (const blk of ecBlocks) {
      result.push(blk[i])
    }
  }
  return new Uint8Array(result)
}

function computeFormatBits(mask: number): number {
  // EC Level M = 00
  const data = (0b00 << 3) | (mask & 0b111)
  let rem = data << 10
  for (let i = 4; i >= 0; i -= 1) {
    if (rem & (1 << (i + 10))) {
      rem ^= 0x537 << i
    }
  }
  return ((data << 10) | rem) ^ 0x5412
}

function computeVersionBits(version: number): number {
  let rem = version << 12
  for (let i = 5; i >= 0; i -= 1) {
    if (rem & (1 << (i + 12))) {
      rem ^= 0x1f25 << i
    }
  }
  return (version << 12) | rem
}

function applyMask(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0
    case 1: return r % 2 === 0
    case 2: return c % 3 === 0
    case 3: return (r + c) % 3 === 0
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  }
}

function computePenaltyScore(modules: boolean[][]): number {
  const size = modules.length
  let penalty = 0

  // Rule 1: 5+ consecutive same-color modules in row or column
  for (let r = 0; r < size; r += 1) {
    let runColor = modules[r][0]
    let runLen = 1
    for (let c = 1; c < size; c += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5)
        runColor = modules[r][c]
        runLen = 1
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5)
  }
  for (let c = 0; c < size; c += 1) {
    let runColor = modules[0][c]
    let runLen = 1
    for (let r = 1; r < size; r += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5)
        runColor = modules[r][c]
        runLen = 1
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5)
  }

  // Rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const v = modules[r][c]
      if (modules[r][c + 1] === v && modules[r + 1][c] === v && modules[r + 1][c + 1] === v) {
        penalty += 3
      }
    }
  }

  // Rule 3: Finder-like 1:1:3:1:1 patterns with 4 light modules on either side
  const isFinderLike = (arr: boolean[], idx: number): boolean => {
    const p1 =
      arr[idx] &&
      !arr[idx + 1] &&
      arr[idx + 2] &&
      arr[idx + 3] &&
      arr[idx + 4] &&
      !arr[idx + 5] &&
      arr[idx + 6] &&
      !arr[idx + 7] &&
      !arr[idx + 8] &&
      !arr[idx + 9] &&
      !arr[idx + 10]
    const p2 =
      !arr[idx] &&
      !arr[idx + 1] &&
      !arr[idx + 2] &&
      !arr[idx + 3] &&
      arr[idx + 4] &&
      !arr[idx + 5] &&
      arr[idx + 6] &&
      arr[idx + 7] &&
      arr[idx + 8] &&
      !arr[idx + 9] &&
      arr[idx + 10]
    return p1 || p2
  }
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c <= size - 11; c += 1) {
      if (isFinderLike(modules[r], c)) penalty += 40
    }
  }
  const colBuf = new Array<boolean>(size)
  for (let c = 0; c < size; c += 1) {
    for (let r = 0; r < size; r += 1) colBuf[r] = modules[r][c]
    for (let r = 0; r <= size - 11; r += 1) {
      if (isFinderLike(colBuf, r)) penalty += 40
    }
  }

  // Rule 4: Dark/light balance
  let darkCount = 0
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) darkCount += 1
    }
  }
  const pct = (darkCount * 100) / (size * size)
  const k = Math.floor(Math.abs(pct - 50) / 5)
  penalty += k * 10

  return penalty
}

function writeFormatInfo(modules: boolean[][], size: number, mask: number) {
  const fmt = computeFormatBits(mask)
  // Top-left copy (around upper-left finder pattern)
  for (let i = 0; i <= 5; i += 1) modules[8][i] = Boolean((fmt >>> (14 - i)) & 1)
  modules[8][7] = Boolean((fmt >>> 8) & 1)
  modules[8][8] = Boolean((fmt >>> 7) & 1)
  modules[7][8] = Boolean((fmt >>> 6) & 1)
  for (let i = 9; i < 15; i += 1) modules[14 - i][8] = Boolean((fmt >>> (14 - i)) & 1)

  // Secondary copies: horizontal top-right (bits 7..0) & vertical bottom-left (bits 14..8 from bottom up)
  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = Boolean((fmt >>> i) & 1)
  for (let i = 0; i < 7; i += 1) modules[size - 1 - i][8] = Boolean((fmt >>> (14 - i)) & 1)
}

export interface QrMatrix {
  size: number
  modules: boolean[][]
}

export function generateQrMatrix(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text)
  const spec = selectVersion(bytes.length)
  const size = 17 + 4 * spec.version
  const codewords = interleaveBlocks(encodeDataCodewords(bytes, spec), spec)

  const baseModules: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false))
  const isFunction: boolean[][] = Array.from({ length: size }, () => Array(size).fill(false))

  const setFn = (r: number, c: number, dark: boolean) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return
    baseModules[r][c] = dark
    isFunction[r][c] = true
  }

  // Finder patterns + separators
  const drawFinder = (top: number, left: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6
        const dark =
          inOuter &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4))
        setFn(top + r, left + c, dark)
      }
    }
  }
  drawFinder(0, 0)
  drawFinder(0, size - 7)
  drawFinder(size - 7, 0)

  // Timing patterns
  for (let i = 8; i < size - 8; i += 1) {
    setFn(6, i, i % 2 === 0)
    setFn(i, 6, i % 2 === 0)
  }

  // Alignment patterns
  for (const r of spec.alignment) {
    for (const c of spec.alignment) {
      if (isFunction[r][c]) continue
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc))
          setFn(r + dr, c + dc, dist !== 1)
        }
      }
    }
  }

  // Reserve format info + dark module
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) {
      setFn(8, i, false)
      setFn(i, 8, false)
    }
  }
  for (let i = 0; i < 8; i += 1) {
    setFn(8, size - 1 - i, false)
  }
  for (let i = 0; i < 7; i += 1) {
    setFn(size - 1 - i, 8, false)
  }
  setFn(size - 8, 8, true)

  // Version info (V7+)
  if (spec.version >= 7) {
    const vBits = computeVersionBits(spec.version)
    for (let i = 0; i < 18; i += 1) {
      const bit = Boolean((vBits >>> i) & 1)
      const a = Math.floor(i / 3)
      const b = size - 11 + (i % 3)
      setFn(a, b, bit)
      setFn(b, a, bit)
    }
  }

  // Place unmasked data bits once
  let bitIndex = 0
  const totalBits = codewords.length * 8
  let upward = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step
      for (let dx = 0; dx < 2; dx += 1) {
        const c = right - dx
        if (isFunction[r][c]) continue
        let dark = false
        if (bitIndex < totalBits) {
          dark = Boolean((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1)
          bitIndex += 1
        }
        baseModules[r][c] = dark
      }
    }
    upward = !upward
  }

  // Evaluate all 8 ISO/IEC 18004 masks and pick lowest penalty score
  let bestMask = 0
  let bestPenalty = Number.POSITIVE_INFINITY
  let bestModules: boolean[][] = baseModules

  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = baseModules.map((row, r) =>
      row.map((val, c) => (!isFunction[r][c] && applyMask(mask, r, c) ? !val : val)),
    )
    writeFormatInfo(candidate, size, mask)
    const score = computePenaltyScore(candidate)
    if (score < bestPenalty) {
      bestPenalty = score
      bestMask = mask
      bestModules = candidate
    }
  }

  // Ensure winning format bits are written
  writeFormatInfo(bestModules, size, bestMask)
  return { size, modules: bestModules }
}

/**
 * Build declarative SVG viewBox and path data with a 4-module quiet zone (XSS-safe for Vue templates).
 */
export function generateQrPath(text: string): { size: number; viewBox: string; path: string } {
  const { size, modules } = generateQrMatrix(text)
  const quiet = 4
  const total = size + quiet * 2
  const parts: string[] = []
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) {
        parts.push(`M${c + quiet},${r + quiet}h1v1h-1z`)
      }
    }
  }
  return {
    size: total,
    viewBox: `0 0 ${total} ${total}`,
    path: parts.join(''),
  }
}

/**
 * Render a QR matrix as a crisp self-contained SVG string with a 4-module quiet zone.
 */
export function generateQrSvg(text: string): string {
  const { size, viewBox, path } = generateQrPath(text)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
}
