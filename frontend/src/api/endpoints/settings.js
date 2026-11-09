import { apiRequest } from '../client.js'

/**
 * Fetch all declared association settings ordered by key (CHAIRMAN and BOARD).
 * @returns {Promise<import('../schema').SettingsView>}
 */
export function getSettings() {
  return apiRequest('/settings')
}

/**
 * Update one or more association settings atomically (CHAIRMAN only).
 * Pass `null` for a key in `values` to reset that setting to its default.
 * @param {import('../schema').SettingsUpdate} payload
 * @returns {Promise<import('../schema').SettingsView>}
 */
export function updateSettings(payload) {
  return apiRequest('/settings', {
    method: 'PUT',
    body: payload,
  })
}
