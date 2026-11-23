import { computed } from 'vue'
import type { BuildingRole } from '@/api/schema.js'
import { useSessionStore } from '@/stores/session.js'

/**
 * Role and permission checks derived strictly from GET /api/v1/property/me
 * (Section 3 of docs/FRONTEND_GUIDE.md).
 */
export function useRole() {
  const session = useSessionStore()

  const buildingRole = computed<BuildingRole>(
    () => (session.buildingRole || session.me?.building_role || 'USER') as BuildingRole,
  )

  const isChairman = computed<boolean>(() => buildingRole.value === 'CHAIRMAN')
  const isBoard = computed<boolean>(() => buildingRole.value === 'BOARD')
  const isAccountant = computed<boolean>(() => buildingRole.value === 'ACCOUNTANT')
  const isResident = computed<boolean>(() => buildingRole.value === 'USER')

  // Matrix, history, CSV export: BOARD, CHAIRMAN, ACCOUNTANT
  const canViewMatrix = computed<boolean>(() =>
    ['BOARD', 'CHAIRMAN', 'ACCOUNTANT'].includes(buildingRole.value),
  )

  // Period status transitions & estimate missing: CHAIRMAN, ACCOUNTANT
  const canManagePeriods = computed<boolean>(() =>
    ['CHAIRMAN', 'ACCOUNTANT'].includes(buildingRole.value),
  )

  // Submit any meter in matrix (incl. master meters): CHAIRMAN, ACCOUNTANT
  const canSubmitAnyMeter = computed<boolean>(() =>
    ['CHAIRMAN', 'ACCOUNTANT'].includes(buildingRole.value),
  )

  // Publish emergency / official notice & resolve emergency: BOARD, CHAIRMAN
  const canPublishOfficial = computed<boolean>(() =>
    ['BOARD', 'CHAIRMAN'].includes(buildingRole.value),
  )

  // Delete or hide/unhide forum topics & moderate comments: CHAIRMAN and BOARD (#026, #028)
  const canDeleteForumTopic = computed<boolean>(() =>
    ['BOARD', 'CHAIRMAN'].includes(buildingRole.value),
  )
  const canModerateForum = computed<boolean>(() =>
    ['BOARD', 'CHAIRMAN'].includes(buildingRole.value),
  )

  // Association settings: CHAIRMAN (edit) and BOARD (read-only)
  const canViewAssociationSettings = computed<boolean>(() =>
    ['BOARD', 'CHAIRMAN'].includes(buildingRole.value),
  )
  const canEditAssociationSettings = computed<boolean>(() => buildingRole.value === 'CHAIRMAN')

  // Maintenance calendar: CHAIRMAN and BOARD (#015 E10/M1)
  const canManageMaintenance = computed<boolean>(() =>
    ['BOARD', 'CHAIRMAN'].includes(buildingRole.value),
  )

  // Maintenance log view: CHAIRMAN, BOARD, and ACCOUNTANT (#016 E10/M1)
  const canViewMaintenanceLog = computed<boolean>(() =>
    ['BOARD', 'CHAIRMAN', 'ACCOUNTANT'].includes(buildingRole.value),
  )

  // Whether the user has at least one apartment with can_submit_readings
  const canSubmitOwnReadings = computed<boolean>(() =>
    (session.me?.memberships || []).some((m) => m.can_submit_readings),
  )

  // Greet with switcher label or membership preview_badge (never expose real PII unless chosen in preview_badge)
  const greetingName = computed<string>(() => {
    const badgeLabel = session.activeMembership?.preview_badge?.display_label
    if (badgeLabel) return badgeLabel
    if (session.currentDemoUser?.label) return session.currentDemoUser.label
    return buildingRole.value
  })

  return {
    buildingRole,
    isChairman,
    isBoard,
    isAccountant,
    isResident,
    canViewMatrix,
    canManagePeriods,
    canSubmitAnyMeter,
    canPublishOfficial,
    canDeleteForumTopic,
    canModerateForum,
    canViewAssociationSettings,
    canEditAssociationSettings,
    canManageMaintenance,
    canViewMaintenanceLog,
    canSubmitOwnReadings,
    greetingName,
  }
}
