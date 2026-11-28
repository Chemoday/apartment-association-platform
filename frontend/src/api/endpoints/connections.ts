import { apiRequest } from '../client.js'
import type {
  ConnectionItem,
  ConnectionOverview,
  ConnectionStatus,
  PaperUpdate,
} from '../schema.js'

export interface ConnectionOverviewParams {
  status?: ConnectionStatus | '' | null
  limit?: number
  offset?: number
  signal?: AbortSignal
}

/**
 * Fetch the chairman's connection overview (no names or e-mails; counts, statuses, dates) (#058 + #069).
 */
export function getConnectionOverview(
  params: ConnectionOverviewParams = {},
): Promise<ConnectionOverview> {
  const qs = new URLSearchParams()
  if (params.status) qs.set('status', params.status)
  if (typeof params.limit === 'number') qs.set('limit', String(params.limit))
  if (typeof params.offset === 'number') qs.set('offset', String(params.offset))
  const suffix = qs.toString() ? `?${qs.toString()}` : ''
  return apiRequest<ConnectionOverview>(
    `/auth/connections${suffix}`,
    params.signal ? { signal: params.signal } : {},
  )
}

/**
 * Mark or unmark an object as handled on paper (#058).
 */
export function setApartmentPaperStatus(
  apartmentId: string,
  onPaper: boolean,
): Promise<ConnectionItem> {
  const body: PaperUpdate = { on_paper: onPaper }
  return apiRequest<ConnectionItem>(
    `/auth/connections/${encodeURIComponent(apartmentId)}/paper`,
    {
      method: 'PUT',
      body,
    },
  )
}
