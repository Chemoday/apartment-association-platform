import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeTargetPhotoDimensions,
  parseJpegDimensions,
  scalePhotoToJpeg,
  DEFAULT_PHOTO_MAX_EDGE,
  HARD_PHOTO_MAX_EDGE,
} from './photoScaling.js'

describe('photoScaling utilities (#020)', () => {
  it('computes scaled dimensions with 1920px default long edge and preserves aspect ratio', () => {
    const landscape = computeTargetPhotoDimensions(4000, 3000)
    assert.deepEqual(landscape, { width: 1920, height: 1440, scaled: true })

    const portrait = computeTargetPhotoDimensions(3000, 4000)
    assert.deepEqual(portrait, { width: 1440, height: 1920, scaled: true })

    const panorama = computeTargetPhotoDimensions(6000, 1500)
    assert.deepEqual(panorama, { width: 1920, height: 480, scaled: true })
  })

  it('never enlarges smaller images and never exceeds 2560px hard edge cap', () => {
    const small = computeTargetPhotoDimensions(800, 600)
    assert.deepEqual(small, { width: 800, height: 600, scaled: false })

    const exact = computeTargetPhotoDimensions(1920, 1080)
    assert.deepEqual(exact, { width: 1920, height: 1080, scaled: false })

    // Even if caller passes a higher target than 2560, hard cap 2560 applies
    const overlyHighTarget = computeTargetPhotoDimensions(5000, 2500, 4000)
    assert.ok(overlyHighTarget)
    assert.equal(overlyHighTarget.width, HARD_PHOTO_MAX_EDGE)
    assert.equal(overlyHighTarget.height, 1280)
    assert.equal(overlyHighTarget.scaled, true)
    assert.ok(Math.max(overlyHighTarget.width, overlyHighTarget.height) <= HARD_PHOTO_MAX_EDGE)

    // Smaller than requested cap 2560 should not enlarge
    const underHardCap = computeTargetPhotoDimensions(2000, 1500, 3000)
    assert.deepEqual(underHardCap, { width: 2000, height: 1500, scaled: false })
  })

  it('scales down on retry to a smaller edge (e.g. 1280px) cleanly', () => {
    const smaller = computeTargetPhotoDimensions(1920, 1440, 1280)
    assert.deepEqual(smaller, { width: 1280, height: 960, scaled: true })
    assert.equal(DEFAULT_PHOTO_MAX_EDGE, 1920)
  })

  it('rejects zero, negative, or non-numeric dimensions cleanly', () => {
    assert.equal(computeTargetPhotoDimensions(0, 100), null)
    assert.equal(computeTargetPhotoDimensions(100, -5), null)
    assert.equal(computeTargetPhotoDimensions(NaN, 500), null)
  })

  it('parses width and height from a minimal JPEG SOF0 header', () => {
    // Minimal JPEG byte stream: SOI (FF D8), SOF0 (FF C0, len=11, precision=8, H=1440, W=1920, 1 component), EOI (FF D9)
    const minimalJpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08,
      0x05, 0xa0, // height = 1440 (0x05A0)
      0x07, 0x80, // width = 1920 (0x0780)
      0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ])
    assert.deepEqual(parseJpegDimensions(minimalJpeg), { width: 1920, height: 1440 })
    assert.equal(parseJpegDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null)

    // Extra 0xFF fill bytes before SOF0 should still parse, while EOI (FF D9) before SOF returns null
    const fillBytesJpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xff, 0xc0, 0x00, 0x0b, 0x08,
      0x03, 0xc0, // height = 960
      0x05, 0x00, // width = 1280
      0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ])
    assert.deepEqual(parseJpegDimensions(fillBytesJpeg), { width: 1280, height: 960 })

    const eoiBeforeSof = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xd9,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x05, 0xa0, 0x07, 0x80, 0x01, 0x01, 0x11, 0x00,
    ])
    assert.equal(parseJpegDimensions(eoiBeforeSof), null)
  })

  it('never returns original unscaled file when scaling fails (e.g. non-browser / unsupported image)', async () => {
    const fakeHeic = new Blob(['not-a-decodable-image'], { type: 'image/heic' })
    await assert.rejects(() => scalePhotoToJpeg(fakeHeic), /PHOTO_SCALING_FAILED/)
    await assert.rejects(() => scalePhotoToJpeg(fakeHeic, { maxEdgePx: -50 }), /PHOTO_SCALING_FAILED/)

    const preAborted = new AbortController()
    preAborted.abort()
    await assert.rejects(
      () => scalePhotoToJpeg(fakeHeic, { signal: preAborted.signal }),
      /PHOTO_SCALING_ABORTED/,
    )
  })

  it('exercises OffscreenCanvas Worker path: succeeds, terminates cleanly on AbortSignal, and does not double-wait on timeout', async () => {
    const g = globalThis as any
    const origWorker = g.Worker
    const origOffscreen = g.OffscreenCanvas
    const origBitmap = g.createImageBitmap
    const origCreateUrl = URL.createObjectURL
    const origRevokeUrl = URL.revokeObjectURL

    let workerMode: 'succeed' | 'hang' = 'succeed'
    let terminateCount = 0
    let revokeCount = 0

    class MockWorker {
      onmessage: ((ev: any) => void) | null = null
      onerror: ((ev: any) => void) | null = null
      postMessage() {
        if (workerMode === 'succeed') {
          const outBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], {
            type: 'image/jpeg',
          })
          queueMicrotask(() => {
            this.onmessage?.({ data: { ok: true, blob: outBlob, width: 1280, height: 960 } })
          })
        }
      }
      terminate() {
        terminateCount += 1
      }
    }

    g.Worker = MockWorker
    g.OffscreenCanvas = function MockOffscreenCanvas() {}
    g.createImageBitmap = async () => ({ width: 2000, height: 1500, close() {} })
    URL.createObjectURL = () => 'blob:mock-worker-url'
    URL.revokeObjectURL = () => {
      revokeCount += 1
    }

    try {
      const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' })
      const okRes = await scalePhotoToJpeg(input, { maxEdgePx: 1280, timeoutMs: 500 })
      assert.equal(okRes.width, 1280)
      assert.equal(okRes.height, 960)
      assert.equal(okRes.blob.type, 'image/jpeg')
      assert.ok(terminateCount >= 1)
      assert.ok(revokeCount >= 1)

      // Abort mid-flight terminates worker and rejects with PHOTO_SCALING_ABORTED
      workerMode = 'hang'
      const prevTerminates = terminateCount
      const ctrl = new AbortController()
      const abortPromise = scalePhotoToJpeg(input, { timeoutMs: 2000, signal: ctrl.signal })
      queueMicrotask(() => ctrl.abort())
      await assert.rejects(() => abortPromise, /PHOTO_SCALING_ABORTED/)
      assert.equal(terminateCount, prevTerminates + 1)

      // Worker timeout rejects with PHOTO_SCALING_FAILED cleanly without double fallback
      await assert.rejects(
        () => scalePhotoToJpeg(input, { timeoutMs: 15 }),
        /PHOTO_SCALING_FAILED/,
      )
    } finally {
      g.Worker = origWorker
      g.OffscreenCanvas = origOffscreen
      g.createImageBitmap = origBitmap
      URL.createObjectURL = origCreateUrl
      URL.revokeObjectURL = origRevokeUrl
    }
  })

  it('parses SOF2 progressive JPEG and skips EXIF APP1 segments', () => {
    const exifAndSof2 = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66, // APP1 length=6 ("Exif")
      0xff, 0xc2, 0x00, 0x0b, 0x08, // SOF2 progressive
      0x04, 0x38, // height = 1080
      0x07, 0x80, // width = 1920
      0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ])
    assert.deepEqual(parseJpegDimensions(exifAndSof2), { width: 1920, height: 1080 })
  })

  it('falls back from failed createImageBitmap to Image() + hidden canvas and scales to JPEG cleanly', async () => {
    const g = globalThis as any
    const origDocument = g.document
    const origImage = g.Image
    const origBitmap = g.createImageBitmap
    const origCreateUrl = URL.createObjectURL
    const origRevokeUrl = URL.revokeObjectURL

    const outBlob = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' })
    let revokedCount = 0
    let usedImageFallback = false

    g.createImageBitmap = async () => {
      throw new Error('imageOrientation unsupported')
    }
    g.Image = class MockImage {
      naturalWidth = 3840
      naturalHeight = 2160
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      set src(_v: string) {
        usedImageFallback = true
        queueMicrotask(() => this.onload?.())
      }
    }
    g.document = {
      createElement(tag: string) {
        assert.equal(tag, 'canvas')
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              fillStyle: '',
              fillRect() {},
              drawImage() {},
            }
          },
          toBlob(cb: (b: Blob) => void) {
            cb(outBlob)
          },
        }
      },
    }
    URL.createObjectURL = () => 'blob:hidden-canvas-fallback'
    URL.revokeObjectURL = () => {
      revokedCount += 1
    }

    try {
      const input = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
      const res = await scalePhotoToJpeg(input, { maxEdgePx: 1920, timeoutMs: 500 })
      assert.equal(usedImageFallback, true)
      assert.equal(res.width, 1920)
      assert.equal(res.height, 1080)
      assert.equal(res.blob, outBlob)
      assert.equal(revokedCount, 1)

      // When Worker fails with platform error (not decode/abort/timeout), scalePhotoToJpeg falls back to hidden canvas
      const origWorker = g.Worker
      const origOffscreen = g.OffscreenCanvas
      g.OffscreenCanvas = function MockOffscreenCanvas() {}
      g.Worker = class FailingWorker {
        onmessage: ((ev: any) => void) | null = null
        onerror: ((ev: any) => void) | null = null
        postMessage() {
          queueMicrotask(() => this.onmessage?.({ data: { ok: false, error: 'OFFSCREEN_QUIRK' } }))
        }
        terminate() {}
      }
      usedImageFallback = false
      try {
        const resFallback = await scalePhotoToJpeg(input, { maxEdgePx: 1920, timeoutMs: 500 })
        assert.equal(usedImageFallback, true)
        assert.equal(resFallback.width, 1920)
        assert.equal(resFallback.blob, outBlob)
      } finally {
        g.Worker = origWorker
        g.OffscreenCanvas = origOffscreen
      }
    } finally {
      g.document = origDocument
      g.Image = origImage
      g.createImageBitmap = origBitmap
      URL.createObjectURL = origCreateUrl
      URL.revokeObjectURL = origRevokeUrl
    }
  })
})
