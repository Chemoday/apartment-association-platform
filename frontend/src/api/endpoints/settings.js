import { apiRequest } from '../client.js'

/**
 * Fetch all declared association settings ordered by key (CHAIRMAN and BOARD).
 * @returns {Promise<import('../schema').SettingsView>}
 */
export function getSettings(options = {}) {
  return apiRequest('/settings', {
    ...(options?.signal ? { signal: options.signal } : {}),
  })
}

/**
 * Update one or more association settings atomically (CHAIRMAN only).
 * Pass `null` for a key in `values` to reset that setting to its default.
 * @param {import('../schema').SettingsUpdate} payload
 * @returns {Promise<import('../schema').SettingsView>}
 */
export function updateSettings(payload, options = {}) {
  return apiRequest('/settings', {
    method: 'PUT',
    body: payload,
    ...(options?.signal ? { signal: options.signal } : {}),
  })
}
