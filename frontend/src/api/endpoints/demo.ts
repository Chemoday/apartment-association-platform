import { apiRequest } from '../client.js'
import type { DemoUserView } from '../schema.js'

/**
 * Fetch seeded demo users (no auth required).
 */
export function getDemoUsers(options: { signal?: AbortSignal } = {}): Promise<DemoUserView[]> {
  return apiRequest<DemoUserView[]>('/demo/users', options.signal ? { signal: options.signal } : {})
}
