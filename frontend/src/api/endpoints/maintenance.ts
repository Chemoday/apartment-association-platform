import { apiRequest } from '../client.js'
import type {
  ClosedOccurrence,
  DoneRequest,
  LogEdit,
  LogEntryView,
  OccurrenceState,
  SkipRequest,
  TaskCreate,
  TaskEdit,
  TaskResume,
  TaskStatus,
  TaskView,
  YearReport,
} from '../schema.js'

export interface ListMaintenanceTasksParams {
  status?: TaskStatus | string | null
  state?: OccurrenceState | string | null
  limit?: number
  offset?: number
  signal?: AbortSignal
}

/**
 * GET /api/v1/maintenance/tasks
 * Lists building recurring maintenance tasks (active and paused by default; status=ARCHIVED for archived).
 * Ordered by current due date (archived: newest archived_at first).
 */
export function listMaintenanceTasks(params: ListMaintenanceTasksParams = {}): Promise<TaskView[]> {
  const search = new URLSearchParams()
  if (params.status) search.set('status', String(params.status))
  if (params.state) search.set('state', String(params.state))
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const qs = search.toString()
  return apiRequest<TaskView[]>(`/maintenance/tasks${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    ...(params.signal ? { signal: params.signal } : {}),
  })
}

/**
 * POST /api/v1/maintenance/tasks
 * Creates a new recurring maintenance task.
 */
export function createMaintenanceTask(payload: TaskCreate): Promise<TaskView> {
  return apiRequest<TaskView>('/maintenance/tasks', {
    method: 'POST',
    body: payload,
  })
}

/**
 * GET /api/v1/maintenance/tasks/{task_id}
 * Retrieves full details of a single recurring maintenance task.
 */
export function getMaintenanceTask(
  taskId: string,
  options: { signal?: AbortSignal } = {},
): Promise<TaskView> {
  return apiRequest<TaskView>(`/maintenance/tasks/${encodeURIComponent(taskId)}`, {
    method: 'GET',
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

/**
 * PATCH /api/v1/maintenance/tasks/{task_id}
 * Edits fields of a maintenance task. Only changed fields should be sent.
 */
export function editMaintenanceTask(taskId: string, payload: TaskEdit): Promise<TaskView> {
  return apiRequest<TaskView>(`/maintenance/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: payload,
  })
}

/**
 * POST /api/v1/maintenance/tasks/{task_id}/pause
 * Pauses an ACTIVE task.
 */
export function pauseMaintenanceTask(taskId: string): Promise<TaskView> {
  return apiRequest<TaskView>(`/maintenance/tasks/${encodeURIComponent(taskId)}/pause`, {
    method: 'POST',
  })
}

/**
 * POST /api/v1/maintenance/tasks/{task_id}/resume
 * Resumes a PAUSED task back to ACTIVE (optionally moving next_due_date).
 */
export function resumeMaintenanceTask(taskId: string, payload?: TaskResume): Promise<TaskView> {
  return apiRequest<TaskView>(`/maintenance/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * POST /api/v1/maintenance/tasks/{task_id}/archive
 * Archives an active or paused task permanently.
 */
export function archiveMaintenanceTask(taskId: string): Promise<TaskView> {
  return apiRequest<TaskView>(`/maintenance/tasks/${encodeURIComponent(taskId)}/archive`, {
    method: 'POST',
  })
}

/**
 * POST /api/v1/maintenance/tasks/{task_id}/done
 * Marks the open occurrence of a task as done and advances to the next occurrence.
 */
export function markMaintenanceTaskDone(
  taskId: string,
  payload: DoneRequest,
): Promise<ClosedOccurrence> {
  return apiRequest<ClosedOccurrence>(`/maintenance/tasks/${encodeURIComponent(taskId)}/done`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * POST /api/v1/maintenance/tasks/{task_id}/skip
 * Skips the open occurrence of a task with a required note and advances to the next occurrence.
 */
export function skipMaintenanceTask(
  taskId: string,
  payload: SkipRequest,
): Promise<ClosedOccurrence> {
  return apiRequest<ClosedOccurrence>(`/maintenance/tasks/${encodeURIComponent(taskId)}/skip`, {
    method: 'POST',
    body: payload,
  })
}

export interface ListMaintenanceLogParams {
  task_id?: string | null
  from?: string | null
  to?: string | null
  limit?: number
  offset?: number
}

/**
 * GET /api/v1/maintenance/log
 * Lists maintenance log entries newest closed_on first.
 * Accessible by CHAIRMAN, BOARD, and ACCOUNTANT.
 */
export function listMaintenanceLog(params: ListMaintenanceLogParams = {}): Promise<LogEntryView[]> {
  const search = new URLSearchParams()
  if (params.task_id) search.set('task_id', String(params.task_id))
  if (params.from) search.set('from', String(params.from))
  if (params.to) search.set('to', String(params.to))
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const qs = search.toString()
  return apiRequest<LogEntryView[]>(`/maintenance/log${qs ? `?${qs}` : ''}`, { method: 'GET' })
}

/**
 * PATCH /api/v1/maintenance/log/{entry_id}
 * Edits note and/or cost of a maintenance log entry (CHAIRMAN and BOARD only).
 */
export function editMaintenanceLogEntry(entryId: string, payload: LogEdit): Promise<LogEntryView> {
  return apiRequest<LogEntryView>(`/maintenance/log/${encodeURIComponent(entryId)}`, {
    method: 'PATCH',
    body: payload,
  })
}

/**
 * GET /api/v1/maintenance/report?year=2027
 * Returns the yearly maintenance report grouped by task (by closed_on year).
 * Accessible by CHAIRMAN, BOARD, and ACCOUNTANT.
 */
export function getMaintenanceReport(year: number | string): Promise<YearReport> {
  const search = new URLSearchParams()
  search.set('year', String(year))
  return apiRequest<YearReport>(`/maintenance/report?${search.toString()}`, { method: 'GET' })
}

/**
 * GET /api/v1/maintenance/report/export-csv?year=2027
 * Streams the yearly maintenance log CSV attachment with auth header.
 * Returns raw Response so caller can read Blob and Content-Disposition filename.
 */
export function exportMaintenanceReportCsv(year: number | string): Promise<Response> {
  const search = new URLSearchParams()
  search.set('year', String(year))
  return apiRequest<Response>(`/maintenance/report/export-csv?${search.toString()}`, {
    method: 'GET',
    raw: true,
  })
}
