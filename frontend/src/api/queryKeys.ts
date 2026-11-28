/**
 * Structured server-state query keys (`src/api/queryKeys.ts`, #043).
 *
 * Centralizes cache & deduplication keys across all application domains so
 * mutations can invalidate related queries deterministically and session
 * switches wipe all cached data via `clearServerStateCache()`.
 */

export const queryKeys = {
  property: {
    me: () => 'property:me',
    building: () => 'property:building',
    apartments: () => 'property:apartments',
    apartmentCard: (apartmentId: string) => `property:apartment:${apartmentId}`,
    registry: () => 'property:registry',
  },
  meters: {
    periods: () => 'meters:periods',
    myDashboard: (periodCode = 'active') => `meters:my-dashboard:${periodCode}`,
    periodMatrix: (periodCode: string, kind?: string | null) =>
      kind ? `meters:matrix:${periodCode}:${kind}` : `meters:matrix:${periodCode}`,
    apartmentReadings: (apartmentId: string) => `meters:apartment-readings:${apartmentId}`,
    apartmentConsumption: (apartmentId: string, months = 12) =>
      `meters:apartment-consumption:${apartmentId}:${months}`,
    buildingConsumption: (months = 12) => `meters:building-consumption:${months}`,
  },
  communication: {
    emergencies: () => 'communication:emergencies',
    posts: (scope = 'all') => `communication:posts:${scope}`,
    post: (postId: string) => `communication:post:${postId}`,
  },
  governance: {
    polls: (status = 'all') => `governance:polls:${status}`,
    poll: (pollId: string) => `governance:poll:${pollId}`,
    pollResults: (pollId: string) => `governance:poll-results:${pollId}`,
  },
  issues: {
    form: () => 'issues:form',
    list: (filter = 'open') => `issues:list:${filter}`,
    detail: (issueId: string) => `issues:detail:${issueId}`,
  },
  maintenance: {
    tasks: (filter = 'active') => `maintenance:tasks:${filter}`,
    task: (taskId: string) => `maintenance:task:${taskId}`,
    log: (filter = 'all') => `maintenance:log:${filter}`,
    report: (year: string | number) => `maintenance:report:${year}`,
  },
  documents: {
    list: (category = 'all') => `documents:list:${category}`,
    uploadOptions: () => 'documents:upload-options',
  },
  notifications: {
    unreadCount: () => 'notifications:unread-count',
    feed: (filter = 'all') => `notifications:feed:${filter}`,
    preferences: () => 'notifications:preferences',
  },
  settings: {
    all: () => 'settings:all',
  },
  chat: {
    state: () => 'chat:state',
  },
} as const
