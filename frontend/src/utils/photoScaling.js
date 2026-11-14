/**
 * Client-side photo scaling & JPEG conversion (#020 / FRONTEND_GUIDE section 17).
 * - Scales images inside a Web Worker using `createImageBitmap(..., { imageOrientation: 'from-image' })`
 *   and `OffscreenCanvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })`, dropping EXIF/location metadata.
 * - Falls back to a hidden `<canvas>` + `toBlob` when Worker / OffscreenCanvas is unavailable.
 * - Never enlarges smaller images, never exceeds 2560 px on either edge, and never returns the original file on failure.
 */

export const DEFAULT_PHOTO_MAX_EDGE = 1920
export const HARD_PHOTO_MAX_EDGE = 2560
export const FALLBACK_SMALLER_EDGE = 1280
export const DEFAULT_JPEG_QUALITY = 0.85
export const MAX_ISSUE_PHOTO_BYTES = 4_000_000

/**
 * Pure dimension math for scaling an image to fit inside `maxEdgePx` (strictly capped at 2560).
 * Never enlarges an image that is already smaller than or equal to the target cap.
 * @param {number} width
 * @param {number} height
 * @param {number} [maxEdgePx]
 * @returns {{ width: number, height: number, scaled: boolean } | null}
 */
export function computeTargetPhotoDimensions(width, height, maxEdgePx = DEFAULT_PHOTO_MAX_EDGE) {
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null
  }

  const requestedCap = Number.isFinite(Number(maxEdgePx)) && Number(maxEdgePx) > 0
    ? Math.floor(Number(maxEdgePx))
    : DEFAULT_PHOTO_MAX_EDGE
  const effectiveCap = Math.min(requestedCap, HARD_PHOTO_MAX_EDGE)

  const longEdge = Math.max(width, height)
  if (longEdge <= effectiveCap) {
    return {
      width: Math.min(effectiveCap, Math.max(1, Math.round(width))),
      height: Math.min(effectiveCap, Math.max(1, Math.round(height))),
      scaled: false,
    }
  }

  const ratio = effectiveCap / longEdge
  return {
    width: Math.min(effectiveCap, Math.max(1, Math.round(width * ratio))),
    height: Math.min(effectiveCap, Math.max(1, Math.round(height * ratio))),
    scaled: true,
  }
}

/**
 * Inspects JPEG SOF0..SOF15 segments to extract pixel width & height when available.
 * Returns null if not a valid JPEG or dimensions cannot be parsed.
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number } | null}
 */
export function parseJpegDimensions(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    // Skip JPEG padding/fill bytes (0xFF before marker)
    if (marker === 0xff) {
      offset += 1
      continue
    }
    // Standalone markers (TEM, RST0..7, SOI)
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) {
      // End of Image or Start of Scan reached before SOF
      break
    }
    if (offset + 4 > bytes.length) break
    const segmentLen = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (segmentLen < 2 || offset + 2 + segmentLen > bytes.length) break

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    if (isSof && offset + 9 <= bytes.length) {
      const height = (bytes[offset + 5] << 8) | bytes[offset + 6]
      const width = (bytes[offset + 7] << 8) | bytes[offset + 8]
      if (width > 0 && height > 0) {
        return { width, height }
      }
      return null
    }
    offset += 2 + segmentLen
  }
  return null
}

const DEFAULT_SCALING_TIMEOUT_MS = 20000

const WORKER_SCRIPT = `
function computeDims(w, h, maxEdge) {
  var rawEdge = typeof maxEdge === 'number' && Number.isFinite(maxEdge) && maxEdge > 0 ? Math.floor(maxEdge) : ${DEFAULT_PHOTO_MAX_EDGE};
  var cap = Math.min(Math.max(1, rawEdge), ${HARD_PHOTO_MAX_EDGE});
  if (typeof w !== 'number' || typeof h !== 'number' || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return null;
  }
  if (Math.max(w, h) <= cap) {
    return {
      width: Math.min(cap, Math.max(1, Math.round(w))),
      height: Math.min(cap, Math.max(1, Math.round(h)))
    };
  }
  var ratio = cap / Math.max(w, h);
  return {
    width: Math.min(cap, Math.max(1, Math.round(w * ratio))),
    height: Math.min(cap, Math.max(1, Math.round(h * ratio)))
  };
}
self.onmessage = async function(ev) {
  var msg = ev.data || {};
  var bitmap = null;
  try {
    bitmap = await createImageBitmap(msg.file, { imageOrientation: 'from-image' });
    var dims = computeDims(bitmap.width, bitmap.height, msg.maxEdgePx);
    if (!dims) throw new Error('INVALID_DIMENSIONS');
    var canvas = new OffscreenCanvas(dims.width, dims.height);
    var ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('NO_2D_CONTEXT');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, dims.width, dims.height);
    ctx.drawImage(bitmap, 0, 0, dims.width, dims.height);
    var blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: msg.quality || ${DEFAULT_JPEG_QUALITY} });
    if (!blob || blob.size <= 0 || blob.type !== 'image/jpeg') {
      throw new Error('JPEG_ENCODE_FAILED');
    }
    self.postMessage({ ok: true, blob: blob, width: dims.width, height: dims.height });
  } catch (err) {
    self.postMessage({ ok: false, error: (err && err.message) || 'WORKER_FAILED' });
  } finally {
    if (bitmap && typeof bitmap.close === 'function') {
      try { bitmap.close(); } catch (_) {}
    }
  }
};
`

function canUseOffscreenWorker() {
  return (
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap === 'function' &&
    typeof Blob !== 'undefined' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function'
  )
}

function scaleInWorker(file, maxEdgePx, quality, timeoutMs = DEFAULT_SCALING_TIMEOUT_MS, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('PHOTO_SCALING_ABORTED'))
      return
    }
    let workerUrl = ''
    let worker = null
    let timer = null
    let settled = false
    let onAbort = null
    const cleanup = () => {
      if (signal && onAbort && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort)
        onAbort = null
      }
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (worker) {
        try {
          worker.terminate()
        } catch {
          /* ignore */
        }
        worker = null
      }
      if (workerUrl) {
        try {
          URL.revokeObjectURL(workerUrl)
        } catch {
          /* ignore */
        }
        workerUrl = ''
      }
    }

    onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('PHOTO_SCALING_ABORTED'))
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const scriptBlob = new Blob([WORKER_SCRIPT], { type: 'text/javascript' })
      workerUrl = URL.createObjectURL(scriptBlob)
      worker = new Worker(workerUrl)
    } catch (err) {
      cleanup()
      reject(err)
      return
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('PHOTO_SCALING_TIMEOUT'))
      }, timeoutMs)
    }

    worker.onmessage = (ev) => {
      if (settled) return
      settled = true
      const data = ev?.data
      cleanup()
      if (data?.ok && data.blob instanceof Blob && data.blob.size > 0) {
        resolve({
          blob: data.blob,
          width: data.width,
          height: data.height,
        })
      } else {
        reject(new Error(data?.error || 'PHOTO_SCALING_FAILED'))
      }
    }

    worker.onerror = (ev) => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(ev?.message || 'WORKER_ERROR'))
    }

    try {
      worker.postMessage({
        file,
        maxEdgePx: Math.min(maxEdgePx, HARD_PHOTO_MAX_EDGE),
        quality,
      })
    } catch (err) {
      if (!settled) {
        settled = true
        cleanup()
        reject(err)
      }
    }
  })
}

async function scaleWithHiddenCanvas(
  file,
  maxEdgePx,
  quality,
  timeoutMs = DEFAULT_SCALING_TIMEOUT_MS,
  signal,
) {
  if (signal?.aborted) {
    throw new Error('PHOTO_SCALING_ABORTED')
  }
  if (typeof document === 'undefined') {
    throw new Error('PHOTO_SCALING_FAILED')
  }

  let bitmap = null
  let objectUrl = ''
  let timer = null
  let onAbort = null
  let finished = false

  const workPromise = (async () => {
    let sourceWidth = 0
    let sourceHeight = 0
    let drawable = null

    let imageBitmapDecoded = false
    if (typeof createImageBitmap === 'function') {
      try {
        const decodedBitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
        if (finished || signal?.aborted) {
          if (decodedBitmap && typeof decodedBitmap.close === 'function') {
            try {
              decodedBitmap.close()
            } catch {
              /* ignore */
            }
          }
          throw new Error(signal?.aborted ? 'PHOTO_SCALING_ABORTED' : 'PHOTO_SCALING_FAILED')
        }
        bitmap = decodedBitmap
        sourceWidth = bitmap.width
        sourceHeight = bitmap.height
        drawable = bitmap
        imageBitmapDecoded = true
      } catch (bitmapErr) {
        if (finished || signal?.aborted || bitmapErr?.message === 'PHOTO_SCALING_ABORTED') {
          throw bitmapErr
        }
        // Fall through to <img> decoding if createImageBitmap or imageOrientation throws on this engine
      }
    }

    if (!imageBitmapDecoded) {
      objectUrl = URL.createObjectURL(file)
      const img = await new Promise((resolve, reject) => {
        const image = new Image()
        image.onload = () => resolve(image)
        image.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'))
        image.src = objectUrl
      })
      if (finished || signal?.aborted) {
        throw new Error(signal?.aborted ? 'PHOTO_SCALING_ABORTED' : 'PHOTO_SCALING_FAILED')
      }
      sourceWidth = img.naturalWidth || img.width
      sourceHeight = img.naturalHeight || img.height
      drawable = img
    }

    const dims = computeTargetPhotoDimensions(sourceWidth, sourceHeight, maxEdgePx)
    if (!dims) {
      throw new Error('INVALID_DIMENSIONS')
    }

    const canvas = document.createElement('canvas')
    canvas.width = dims.width
    canvas.height = dims.height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      throw new Error('NO_2D_CONTEXT')
    }

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, dims.width, dims.height)
    ctx.drawImage(drawable, 0, 0, dims.width, dims.height)

    const blob = await new Promise((resolve, reject) => {
      if (typeof canvas.toBlob !== 'function') {
        reject(new Error('CANVAS_TO_BLOB_UNSUPPORTED'))
        return
      }
      canvas.toBlob(
        (result) => {
          if (result && result.size > 0 && result.type === 'image/jpeg') {
            resolve(result)
          } else {
            reject(new Error('JPEG_ENCODE_FAILED'))
          }
        },
        'image/jpeg',
        quality,
      )
    })

    return {
      blob,
      width: dims.width,
      height: dims.height,
    }
  })()

  try {
    const racers = [workPromise]
    if (timeoutMs > 0) {
      racers.push(
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('PHOTO_SCALING_TIMEOUT')), timeoutMs)
        }),
      )
    }
    if (signal && typeof signal.addEventListener === 'function') {
      racers.push(
        new Promise((_, reject) => {
          onAbort = () => reject(new Error('PHOTO_SCALING_ABORTED'))
          signal.addEventListener('abort', onAbort, { once: true })
        }),
      )
    }
    return await Promise.race(racers)
  } finally {
    finished = true
    if (signal && onAbort && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort)
      onAbort = null
    }
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (bitmap && typeof bitmap.close === 'function') {
      try {
        bitmap.close()
      } catch {
        /* ignore */
      }
      bitmap = null
    }
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl)
      } catch {
        /* ignore */
      }
      objectUrl = ''
    }
  }
}

/**
 * Scales and converts a user-picked image `File` / `Blob` into a clean EXIF-free JPEG Blob
 * with long edge <= min(maxEdgePx, 2560).
 * Never returns the original unscaled file when scaling fails.
 * @param {Blob} file
 * @param {{ maxEdgePx?: number, quality?: number, timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{ blob: Blob, width: number, height: number }>}
 */
export async function scalePhotoToJpeg(
  file,
  {
    maxEdgePx = DEFAULT_PHOTO_MAX_EDGE,
    quality = DEFAULT_JPEG_QUALITY,
    timeoutMs = DEFAULT_SCALING_TIMEOUT_MS,
    signal,
  } = {},
) {
  if (signal?.aborted) {
    throw new Error('PHOTO_SCALING_ABORTED')
  }
  if (!file || typeof file.size !== 'number' || file.size <= 0) {
    throw new Error('PHOTO_SCALING_FAILED')
  }

  const parsedEdge = Number(maxEdgePx)
  const validEdge =
    Number.isFinite(parsedEdge) && parsedEdge > 0 ? Math.floor(parsedEdge) : DEFAULT_PHOTO_MAX_EDGE
  const cappedEdge = Math.min(validEdge, HARD_PHOTO_MAX_EDGE)
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0

  if (canUseOffscreenWorker()) {
    try {
      return await scaleInWorker(file, cappedEdge, quality, timeoutMs, signal)
    } catch (workerErr) {
      if (
        signal?.aborted ||
        workerErr?.message === 'PHOTO_SCALING_ABORTED' ||
        workerErr?.message === 'PHOTO_SCALING_TIMEOUT' ||
        workerErr?.message === 'INVALID_DIMENSIONS' ||
        workerErr?.message === 'JPEG_ENCODE_FAILED'
      ) {
        throw new Error(
          workerErr?.message === 'PHOTO_SCALING_ABORTED'
            ? 'PHOTO_SCALING_ABORTED'
            : 'PHOTO_SCALING_FAILED',
        )
      }
      // Fall back to hidden <canvas> only for Worker/OffscreenCanvas initialization or platform quirks
    }
  }

  const remainingTimeoutMs = deadline > 0 ? Math.max(1, deadline - Date.now()) : timeoutMs
  try {
    return await scaleWithHiddenCanvas(file, cappedEdge, quality, remainingTimeoutMs, signal)
  } catch (canvasErr) {
    if (signal?.aborted || canvasErr?.message === 'PHOTO_SCALING_ABORTED') {
      throw new Error('PHOTO_SCALING_ABORTED')
    }
    throw new Error('PHOTO_SCALING_FAILED')
  }
}
