import type { IncomingMessage, ServerResponse } from 'http'
import { MAX_ISSUE_PHOTO_BYTES } from '../utils/issues.js'

export interface RouteContext<TUser = unknown, TState = unknown> {
  req: IncomingMessage
  res: ServerResponse
  urlObj: URL
  pathname: string
  method: string
  user: TUser
  isBoard: boolean
  isBoardOrAccountant: boolean
  state: TState
}

export type RouteHandler<TUser = unknown, TState = unknown> = (
  ctx: RouteContext<TUser, TState>,
) => Promise<boolean> | boolean

export function sendJson(res: ServerResponse, status: number, data: unknown): true {
  const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('X-Trace-Id', traceId)
  res.end(JSON.stringify(data))
  return true
}

export function sendError(
  res: ServerResponse,
  status: number,
  errorCode: string,
  message: string,
  extra: Record<string, unknown> = {},
): true {
  const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('X-Trace-Id', traceId)
  if (status === 429 && typeof extra?.retry_after_seconds === 'number') {
    res.setHeader(
      'Retry-After',
      String(Math.max(1, Math.ceil(extra.retry_after_seconds))),
    )
  }
  res.end(
    JSON.stringify({
      error_code: errorCode,
      message,
      trace_id: traceId,
      ...extra,
    }),
  )
  return true
}

export function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try {
        const parsed: unknown = JSON.parse(body)
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
  })
}

export function readRawBody(
  req: IncomingMessage,
  maxBytes = MAX_ISSUE_PHOTO_BYTES,
  declaredLength: number | null = null,
): Promise<{ interrupted?: boolean; tooLarge?: boolean; buffer: Buffer }> {
  const effectiveCap =
    declaredLength !== null && Number.isFinite(declaredLength) && declaredLength >= 0
      ? Math.min(maxBytes, declaredLength)
      : maxBytes

  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let total = 0
    let settled = false

    const cleanup = () => {
      if (typeof req.off === 'function') {
        req.off('data', onData)
        req.off('aborted', onAborted)
        req.off('close', onClose)
        req.off('error', onError)
        req.off('end', onEnd)
      } else {
        req.removeListener('data', onData)
        req.removeListener('aborted', onAborted)
        req.removeListener('close', onClose)
        req.removeListener('error', onError)
        req.removeListener('end', onEnd)
      }
    }

    const finish = (outcome: { interrupted?: boolean; tooLarge?: boolean; buffer: Buffer }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }

    const onData = (chunk: Buffer | string) => {
      if (settled) return
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buf.byteLength
      if (total > effectiveCap) {
        chunks.length = 0
        finish({ tooLarge: true, buffer: Buffer.alloc(0) })
        if (typeof req.resume === 'function') {
          req.resume()
        }
        return
      }
      chunks.push(buf)
    }

    const onAborted = () => {
      chunks.length = 0
      finish({ interrupted: true, buffer: Buffer.alloc(0) })
    }

    const onClose = () => {
      if (!req.complete) {
        chunks.length = 0
        finish({ interrupted: true, buffer: Buffer.alloc(0) })
      }
    }

    const onError = () => {
      chunks.length = 0
      finish({ interrupted: true, buffer: Buffer.alloc(0) })
    }

    const onEnd = () => {
      finish({ buffer: Buffer.concat(chunks) })
    }

    req.on('data', onData)
    req.on('aborted', onAborted)
    req.on('close', onClose)
    req.on('error', onError)
    req.on('end', onEnd)
  })
}
