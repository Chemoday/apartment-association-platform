import { apiRequest } from '../client.js'
import type { SettingsUpdate, SettingsView } from '../schema.js'

/**
 * Fetch all declared association settings ordered by key (CHAIRMAN and BOARD).
 */
export function getSettings(options: { signal?: AbortSignal } = {}): Promise<SettingsView> {
  return apiRequest<SettingsView>('/settings', {
    ...(options?.signal ? { signal: options.signal } : {}),
  })
}

/**
 * Update one or more association settings atomically (CHAIRMAN only).
 * Pass `null` for a key in `values` to reset that setting to its default.
 */
export function updateSettings(
  payload: SettingsUpdate,
  options: { signal?: AbortSignal } = {},
): Promise<SettingsView> {
  return apiRequest<SettingsView>('/settings', {
    method: 'PUT',
    body: payload,
    ...(options?.signal ? { signal: options.signal } : {}),
  })
}
