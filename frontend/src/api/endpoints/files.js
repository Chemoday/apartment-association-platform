import { apiRequest } from '../client.js'

/**
 * Fetch storage quota & usage breakdown for the association (#024 E11/F4).
 * Available to CHAIRMAN and BOARD only (403 FORBIDDEN otherwise).
 *
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import('../schema').FileUsage>}
 */
export function getFileUsage({ signal } = {}) {
  return apiRequest('/files/usage', { signal })
}
