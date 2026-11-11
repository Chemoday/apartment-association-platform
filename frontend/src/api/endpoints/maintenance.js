import { apiRequest } from '../client.js'

/**
 * GET /api/v1/maintenance/tasks
 * Lists building recurring maintenance tasks (active and paused by default; status=ARCHIVED for archived).
 * Ordered by current due date (archived: newest archived_at first).
 * @param {Object} [params]
 * @param {import('../schema.d.ts').TaskStatus} [params.status]
 * @param {import('../schema.d.ts').OccurrenceState} [params.state]
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 * @returns {Promise<import('../schema.d.ts').TaskView[]>}
 */
export function listMaintenanceTasks(params = {}) {
  const search = new URLSearchParams()
  if (params.status) search.set('status', String(params.status))
  if (params.state) search.set('state', String(params.state))
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const qs = search.toString()
  return apiRequest(`/maintenance/tasks${qs ? `?${qs}` : ''}`, { method: 'GET' })
}

/**
 * POST /api/v1/maintenance/tasks
 * Creates a new recurring maintenance task.
 * @param {import('../schema.d.ts').TaskCreate} payload
 * @returns {Promise<import('../schema.d.ts').TaskView>}
 */
export function createMaintenanceTask(payload) {
  return apiRequest('/maintenance/tasks', {
    method: 'POST',
    body: payload,
  })
}

/**
 * GET /api/v1/maintenance/tasks/{task_id}
 * Retrieves full details of a single recurring maintenance task.
 * @param {string} taskId
 * @returns {Promise<import('../schema.d.ts').TaskView>}
 */
export function getMaintenanceTask(taskId) {
  return apiRequest(`/maintenance/tasks/${encodeURIComponent(taskId)}`, { method: 'GET' })
}

/**
 * PATCH /api/v1/maintenance/tasks/{task_id}
 * Edits fields of a maintenance task. Only changed fields should be sent.
 * @param {string} taskId
 * @param {import('../schema.d.ts').TaskEdit} payload
 * @returns {Promise<import('../schema.d.ts').TaskView>}
 */
export function editMaintenanceTask(taskId, payload) {
  return apiRequest(`/maintenance/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: payload,
  })
}

/**
 * POST /api/v1/maintenance/tasks/{task_id}/pause
 * Pauses an ACTIVE task.
 * @param {string} taskId
 * @returns {Promise<import('../schema.d.ts').TaskView>}
 */
export function pauseMaintenanceTask(taskId) {
  return apiRequest(`/maintenance/tasks/${encodeURIComponent(taskId)}/pause`, {
    method: 'POST',
  })
}

/**
 * POST /api/v1/maintenance/tasks/{task_id}/resume
 * Resumes a PAUSED task back to ACTIVE (optionally moving next_due_date).
 * @param {string} taskId
 * @param {import('../schema.d.ts').TaskResume} [payload]
 * @returns {Promise<import('../schema.d.ts').TaskView>}
 */
export function resumeMaintenanceTask(taskId, payload) {
  return apiRequest(`/maintenance/tasks/${encodeURIComponent(taskId)}/resume`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * POST /api/v1/maintenance/tasks/{task_id}/archive
 * Archives an active or paused task permanently.
 * @param {string} taskId
 * @returns {Promise<import('../schema.d.ts').TaskView>}
 */
export function archiveMaintenanceTask(taskId) {
  return apiRequest(`/maintenance/tasks/${encodeURIComponent(taskId)}/archive`, {
    method: 'POST',
  })
}

/**
 * POST /api/v1/maintenance/tasks/{task_id}/done
 * Marks the open occurrence of a task as done and advances to the next occurrence.
 * @param {string} taskId
 * @param {import('../schema.d.ts').DoneRequest} payload
 * @returns {Promise<import('../schema.d.ts').ClosedOccurrence>}
 */
export function markMaintenanceTaskDone(taskId, payload) {
  return apiRequest(`/maintenance/tasks/${encodeURIComponent(taskId)}/done`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * POST /api/v1/maintenance/tasks/{task_id}/skip
 * Skips the open occurrence of a task with a required note and advances to the next occurrence.
 * @param {string} taskId
 * @param {import('../schema.d.ts').SkipRequest} payload
 * @returns {Promise<import('../schema.d.ts').ClosedOccurrence>}
 */
export function skipMaintenanceTask(taskId, payload) {
  return apiRequest(`/maintenance/tasks/${encodeURIComponent(taskId)}/skip`, {
    method: 'POST',
    body: payload,
  })
}

/**
 * GET /api/v1/maintenance/log
 * Lists maintenance log entries newest closed_on first.
 * Accessible by CHAIRMAN, BOARD, and ACCOUNTANT.
 * @param {Object} [params]
 * @param {string} [params.task_id]
 * @param {string} [params.from]
 * @param {string} [params.to]
 * @param {number} [params.limit]
 * @param {number} [params.offset]
 * @returns {Promise<import('../schema.d.ts').LogEntryView[]>}
 */
export function listMaintenanceLog(params = {}) {
  const search = new URLSearchParams()
  if (params.task_id) search.set('task_id', String(params.task_id))
  if (params.from) search.set('from', String(params.from))
  if (params.to) search.set('to', String(params.to))
  if (params.limit !== undefined) search.set('limit', String(params.limit))
  if (params.offset !== undefined) search.set('offset', String(params.offset))
  const qs = search.toString()
  return apiRequest(`/maintenance/log${qs ? `?${qs}` : ''}`, { method: 'GET' })
}

/**
 * PATCH /api/v1/maintenance/log/{entry_id}
 * Edits note and/or cost of a maintenance log entry (CHAIRMAN and BOARD only).
 * @param {string} entryId
 * @param {import('../schema.d.ts').LogEdit} payload
 * @returns {Promise<import('../schema.d.ts').LogEntryView>}
 */
export function editMaintenanceLogEntry(entryId, payload) {
  return apiRequest(`/maintenance/log/${encodeURIComponent(entryId)}`, {
    method: 'PATCH',
    body: payload,
  })
}

