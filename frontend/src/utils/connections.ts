import type {
  ConnectionItem,
  ConnectionOverview,
  ConnectionStatus,
  InvitationDelivery,
  KindSummary,
  ObjectKind,
} from '@/api/schema.js'
import { OBJECT_KINDS, normalizeObjectKind } from './objectName.js'

export const CONNECTION_STATUSES: readonly ConnectionStatus[] = [
  'CONNECTED',
  'JOIN_REQUEST',
  'INVITED',
  'CODE_ISSUED',
  'TENANT_ONLY',
  'PAPER',
  'EXPIRED',
  'NOT_INVITED',
]

export interface ConnectionApartmentInput {
  apartment_id: string
  apartment_number: string
  apartment_kind?: ObjectKind | string | null
  entrance?: number | null
}

export interface ConnectionMembershipInput {
  apartment_id: string
  relation_type: 'OWNER' | 'TENANT' | string
}

export interface ConnectionInvitationInput {
  apartment_id?: string | null
  kind: string
  status: string
  created_at: string
  delivery?: InvitationDelivery | null
}

export interface BuildConnectionOverviewOptions {
  apartments: ConnectionApartmentInput[]
  memberships: ConnectionMembershipInput[]
  invitations: ConnectionInvitationInput[]
  paperApartmentIds: Set<string>
  activeJoinCodeApartmentIds?: Set<string>
  pendingJoinRequestApartmentIds?: Set<string>
  statusFilter?: string | null
  limit?: number
  offset?: number
}

function createEmptyByStatus(): Record<ConnectionStatus, number> {
  return {
    CONNECTED: 0,
    JOIN_REQUEST: 0,
    INVITED: 0,
    CODE_ISSUED: 0,
    TENANT_ONLY: 0,
    PAPER: 0,
    EXPIRED: 0,
    NOT_INVITED: 0,
  }
}

function createEmptyByKind(): Record<ObjectKind, KindSummary> {
  return {
    APARTMENT: { objects: 0, connected: 0 },
    PARKING: { objects: 0, connected: 0 },
    GARAGE: { objects: 0, connected: 0 },
  }
}

export function buildConnectionItems(
  options: Omit<BuildConnectionOverviewOptions, 'statusFilter' | 'limit' | 'offset'>,
): ConnectionItem[] {
  const ownersByApt = new Map<string, number>()
  const tenantsByApt = new Map<string, number>()
  for (const m of options.memberships) {
    if (m.relation_type === 'OWNER') {
      ownersByApt.set(m.apartment_id, (ownersByApt.get(m.apartment_id) || 0) + 1)
    } else if (m.relation_type === 'TENANT') {
      tenantsByApt.set(m.apartment_id, (tenantsByApt.get(m.apartment_id) || 0) + 1)
    }
  }

  const latestOwnerInvByApt = new Map<string, ConnectionInvitationInput>()
  for (const inv of options.invitations) {
    if (inv.kind !== 'OWNER' || !inv.apartment_id) continue
    const prev = latestOwnerInvByApt.get(inv.apartment_id)
    if (!prev || Date.parse(inv.created_at) > Date.parse(prev.created_at)) {
      latestOwnerInvByApt.set(inv.apartment_id, inv)
    }
  }

  const pendingCodes = options.activeJoinCodeApartmentIds ?? new Set<string>()
  const pendingRequests = options.pendingJoinRequestApartmentIds ?? new Set<string>()

  return options.apartments.map((apt) => {
    const kind = normalizeObjectKind(apt.apartment_kind)
    const owners = ownersByApt.get(apt.apartment_id) || 0
    const tenants = tenantsByApt.get(apt.apartment_id) || 0
    const onPaper = options.paperApartmentIds.has(apt.apartment_id)
    const latestInv = latestOwnerInvByApt.get(apt.apartment_id)

    let status: ConnectionStatus = 'NOT_INVITED'
    if (owners > 0) {
      status = 'CONNECTED'
    } else if (pendingRequests.has(apt.apartment_id)) {
      status = 'JOIN_REQUEST'
    } else if (latestInv && latestInv.status === 'PENDING') {
      status = 'INVITED'
    } else if (pendingCodes.has(apt.apartment_id)) {
      status = 'CODE_ISSUED'
    } else if (tenants > 0) {
      status = 'TENANT_ONLY'
    } else if (onPaper) {
      status = 'PAPER'
    } else if (latestInv && latestInv.status === 'EXPIRED') {
      status = 'EXPIRED'
    }

    return {
      apartment_id: apt.apartment_id,
      apartment_number: apt.apartment_number,
      apartment_kind: kind,
      entrance: apt.entrance ?? null,
      status,
      owners,
      tenants,
      on_paper: onPaper,
      last_invited_at: latestInv ? latestInv.created_at : null,
      invitation_delivery:
        latestInv && latestInv.status === 'PENDING' ? (latestInv.delivery ?? 'SENT') : null,
    }
  })
}

export function buildConnectionOverview(
  options: BuildConnectionOverviewOptions,
): ConnectionOverview {
  const allItems = buildConnectionItems(options)
  const byStatus = createEmptyByStatus()
  const byKind = createEmptyByKind()
  let connected = 0

  for (const item of allItems) {
    byStatus[item.status] += 1
    byKind[item.apartment_kind].objects += 1
    if (item.status === 'CONNECTED') {
      connected += 1
      byKind[item.apartment_kind].connected += 1
    }
  }

  const statusFilter =
    options.statusFilter && CONNECTION_STATUSES.includes(options.statusFilter as ConnectionStatus)
      ? (options.statusFilter as ConnectionStatus)
      : null
  const filtered = statusFilter ? allItems.filter((i) => i.status === statusFilter) : allItems
  const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 500)
  const offset = Math.max(Number(options.offset) || 0, 0)

  return {
    summary: {
      apartments: allItems.length,
      connected,
      by_status: byStatus,
      by_kind: byKind,
    },
    matching: filtered.length,
    items: filtered.slice(offset, offset + limit),
  }
}

export function getPresentKindSummaries(
  byKind: Record<ObjectKind, KindSummary> | null | undefined,
): Array<{ kind: ObjectKind; objects: number; connected: number }> {
  if (!byKind) return []
  return OBJECT_KINDS.map((kind) => ({
    kind,
    objects: Number(byKind[kind]?.objects || 0),
    connected: Number(byKind[kind]?.connected || 0),
  })).filter((entry) => entry.objects > 0)
}
