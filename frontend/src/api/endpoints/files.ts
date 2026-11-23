import { apiRequest } from '../client.js'
import type { FileUsage } from '../schema.js'

/**
 * Fetch storage quota & usage breakdown for the association (#024 E11/F4).
 * Available to CHAIRMAN and BOARD only (403 FORBIDDEN otherwise).
 */
export function getFileUsage({ signal }: { signal?: AbortSignal } = {}): Promise<FileUsage> {
  return apiRequest<FileUsage>('/files/usage', { signal })
}
