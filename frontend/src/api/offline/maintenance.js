import {
  UNHANDLED,
  OFFLINE_POSTS,
  makeOfflineError,
  dispatchMaintenanceAndNoticeNotifications,
  offlineStore,
} from './state.js'
import {
  readSettingFromStore,
} from '../../utils/issues.js'
import {
  applyLogEditInStore,
  applyTaskDoneInStore,
  applyTaskSkipInStore,
  buildMaintenanceYearCsv,
  buildMaintenanceYearReport,
  computeOccurrenceState,
  getTodayDateInTallinn,
  maxAllowedLeadDays,
  publishMaintenanceTasksInStore,
  queryMaintenanceLogStore,
  queryTasksStore,
  toTaskView,
  validateTaskDraft,
} from '../../utils/maintenance.js'

export async function handleOfflineMaintenance(ctx) {
  const { urlObj, pathname, method, body, user, headers } = ctx

  if (pathname === '/maintenance/tasks' || pathname.startsWith('/maintenance/tasks/')) {
    if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
      throw makeOfflineError(403, 'FORBIDDEN', 'Only the chairman and board members can access maintenance tasks.')
    }

    const today = getTodayDateInTallinn()

    // GET /maintenance/tasks
    if (pathname === '/maintenance/tasks' && method === 'GET') {
      const overdueReminderDays = Number(
        readSettingFromStore(offlineStore.offlineSettings, 'maintenance.overdue_reminder_days', 7),
      )
      publishMaintenanceTasksInStore({
        tasksStore: offlineStore.offlineMaintenance,
        postsStore: OFFLINE_POSTS,
        today,
        overdueReminderDays,
        onNotification: dispatchMaintenanceAndNoticeNotifications,
      })

      const statusParam = urlObj.searchParams.get('status') || undefined
      const stateParam = urlObj.searchParams.get('state') || undefined
      const limitParam = urlObj.searchParams.get('limit') ? Number(urlObj.searchParams.get('limit')) : 50
      const offsetParam = urlObj.searchParams.get('offset') ? Number(urlObj.searchParams.get('offset')) : 0

      return queryTasksStore(
        offlineStore.offlineMaintenance,
        { status: statusParam, state: stateParam, limit: limitParam, offset: offsetParam },
        today,
      )
    }

    // POST /maintenance/tasks
    if (pathname === '/maintenance/tasks' && method === 'POST') {
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const validated = validateTaskDraft(reqBody, { today })
      if (!validated.valid) {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'Validation failed for maintenance task.', {
          errors: validated.errors,
        })
      }

      const p = validated.payload
      const taskId = `task-${Date.now()}`
      const occId = `occ-${Date.now()}`
      const lead = p.lead_days
      const dueDate = p.first_due_date
      const occState = computeOccurrenceState(dueDate, lead, 'ACTIVE', today)

      const newTask = {
        id: taskId,
        title: p.title,
        instructions: p.instructions || '',
        period_unit: p.period_unit,
        period_count: p.period_count,
        lead_days: lead,
        anchor_date: dueDate,
        status: 'ACTIVE',
        notice: p.notice,
        current: {
          occurrence_id: occId,
          due_date: dueDate,
          publish_on: occState.publish_on,
          state: occState.state,
          published_at: null,
          board_post_id: null,
          notice_post_id: null,
          notice_failed: false,
          reminder_count: 0,
        },
        last_closed_on: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        archived_at: null,
      }

      offlineStore.offlineMaintenance.push(newTask)
      return toTaskView(newTask, today)
    }

    // POST /maintenance/tasks/:taskId/pause
    const pauseMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)\/pause$/)
    if (pauseMatch && method === 'POST') {
      const taskId = pauseMatch[1]
      const found = offlineStore.offlineMaintenance.find((t) => t.id === taskId)
      if (!found) {
        throw makeOfflineError(404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.')
      }
      if (found.status === 'ARCHIVED') {
        throw makeOfflineError(409, 'TASK_ARCHIVED', 'Task is archived.')
      }
      if (found.status !== 'ACTIVE') {
        throw makeOfflineError(409, 'INVALID_TASK_TRANSITION', 'Task must be ACTIVE to pause.', {
          status: found.status,
        })
      }
      found.status = 'PAUSED'
      found.updated_at = new Date().toISOString()
      return toTaskView(found, today)
    }

    // POST /maintenance/tasks/:taskId/resume
    const resumeMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)\/resume$/)
    if (resumeMatch && method === 'POST') {
      const taskId = resumeMatch[1]
      const found = offlineStore.offlineMaintenance.find((t) => t.id === taskId)
      if (!found) {
        throw makeOfflineError(404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.')
      }
      if (found.status === 'ARCHIVED') {
        throw makeOfflineError(409, 'TASK_ARCHIVED', 'Task is archived.')
      }
      if (found.status !== 'PAUSED') {
        throw makeOfflineError(409, 'INVALID_TASK_TRANSITION', 'Task must be PAUSED to resume.', {
          status: found.status,
        })
      }

      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      if (reqBody.next_due_date) {
        if (reqBody.occurrence_id && found.current?.occurrence_id && reqBody.occurrence_id !== found.current.occurrence_id) {
          throw makeOfflineError(409, 'OCCURRENCE_CLOSED', 'Occurrence has already been closed.', {
            current_occurrence_id: found.current.occurrence_id,
          })
        }
        found.current.due_date = reqBody.next_due_date
        found.anchor_date = reqBody.next_due_date
      }

      found.status = 'ACTIVE'
      found.updated_at = new Date().toISOString()
      return toTaskView(found, today)
    }

    // POST /maintenance/tasks/:taskId/archive
    const archiveMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)\/archive$/)
    if (archiveMatch && method === 'POST') {
      const taskId = archiveMatch[1]
      const found = offlineStore.offlineMaintenance.find((t) => t.id === taskId)
      if (!found) {
        throw makeOfflineError(404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.')
      }
      if (found.status === 'ARCHIVED') {
        throw makeOfflineError(409, 'TASK_ARCHIVED', 'Task is already archived.')
      }

      found.status = 'ARCHIVED'
      found.current = null
      found.archived_at = new Date().toISOString()
      found.updated_at = found.archived_at
      return toTaskView(found, today)
    }

    // GET & PATCH /maintenance/tasks/:taskId
    const detailMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)$/)
    if (detailMatch && method === 'GET') {
      const overdueReminderDays = Number(
        readSettingFromStore(offlineStore.offlineSettings, 'maintenance.overdue_reminder_days', 7),
      )
      publishMaintenanceTasksInStore({
        tasksStore: offlineStore.offlineMaintenance,
        postsStore: OFFLINE_POSTS,
        today,
        overdueReminderDays,
        onNotification: dispatchMaintenanceAndNoticeNotifications,
      })

      const taskId = detailMatch[1]
      const found = offlineStore.offlineMaintenance.find((t) => t.id === taskId)
      if (!found) {
        throw makeOfflineError(404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.')
      }
      return toTaskView(found, today)
    }

    if (detailMatch && method === 'PATCH') {
      const taskId = detailMatch[1]
      const found = offlineStore.offlineMaintenance.find((t) => t.id === taskId)
      if (!found) {
        throw makeOfflineError(404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.')
      }
      if (found.status === 'ARCHIVED') {
        throw makeOfflineError(409, 'TASK_ARCHIVED', 'Task is archived and cannot be edited.')
      }

      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}

      if (reqBody.occurrence_id && found.current?.occurrence_id && reqBody.occurrence_id !== found.current.occurrence_id) {
        throw makeOfflineError(409, 'OCCURRENCE_CLOSED', 'Occurrence has already been closed.', {
          current_occurrence_id: found.current.occurrence_id,
        })
      }

      // Check required pairing of period_unit and period_count
      if (('period_unit' in reqBody && !('period_count' in reqBody)) || ('period_count' in reqBody && !('period_unit' in reqBody))) {
        throw makeOfflineError(422, 'VALIDATION_ERROR', 'period_unit and period_count must be updated together.')
      }

      const unit = reqBody.period_unit || found.period_unit
      const count = reqBody.period_count !== undefined ? reqBody.period_count : found.period_count
      const lead = reqBody.lead_days !== undefined ? reqBody.lead_days : found.lead_days

      if (reqBody.title !== undefined) {
        if (!reqBody.title || typeof reqBody.title !== 'string') {
          throw makeOfflineError(422, 'VALIDATION_ERROR', 'Title cannot be empty.')
        }
        found.title = reqBody.title.trim()
        for (const entry of offlineStore.offlineMaintenanceLog) {
          if (entry.task_id === found.id) {
            entry.task_title = found.title
          }
        }
      }

      if (reqBody.instructions !== undefined) {
        found.instructions = reqBody.instructions || ''
      }

      if (reqBody.period_unit !== undefined && reqBody.period_count !== undefined) {
        found.period_unit = unit
        found.period_count = count
      }

      if (reqBody.lead_days !== undefined) {
        const maxLead = maxAllowedLeadDays(unit, count)
        if (lead < 0 || lead > maxLead) {
          throw makeOfflineError(422, 'VALIDATION_ERROR', `lead_days must be between 0 and ${maxLead}.`)
        }
        found.lead_days = lead
      }

      if (reqBody.notice !== undefined) {
        found.notice = reqBody.notice
      }

      if (reqBody.next_due_date !== undefined) {
        if (found.current) {
          found.current.due_date = reqBody.next_due_date
          found.anchor_date = reqBody.next_due_date
        }
      }

      found.updated_at = new Date().toISOString()
      return toTaskView(found, today)
    }

    // POST /maintenance/tasks/:taskId/done
    const doneMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)\/done$/)
    if (doneMatch && method === 'POST') {
      const taskId = doneMatch[1]
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const outcome = applyTaskDoneInStore({
        tasksStore: offlineStore.offlineMaintenance,
        logStore: offlineStore.offlineMaintenanceLog,
        taskId,
        body: reqBody,
        user,
        today,
      })
      if (!outcome.ok) {
        throw makeOfflineError(
          outcome.status,
          outcome.errorCode,
          outcome.message,
          outcome.extra || {},
        )
      }
      return outcome.result
    }

    // POST /maintenance/tasks/:taskId/skip
    const skipMatch = pathname.match(/^\/maintenance\/tasks\/([^/]+)\/skip$/)
    if (skipMatch && method === 'POST') {
      const taskId = skipMatch[1]
      const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
      const outcome = applyTaskSkipInStore({
        tasksStore: offlineStore.offlineMaintenance,
        logStore: offlineStore.offlineMaintenanceLog,
        taskId,
        body: reqBody,
        user,
        today,
      })
      if (!outcome.ok) {
        throw makeOfflineError(
          outcome.status,
          outcome.errorCode,
          outcome.message,
          outcome.extra || {},
        )
      }
      return outcome.result
    }
  }

  // =========================================================================
  // Maintenance Log (/maintenance/log) - #016 (E10/M1)
  // =========================================================================
  if (pathname === '/maintenance/log' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only the chairman, board members, and accountant can view the maintenance log.',
      )
    }
    const outcome = queryMaintenanceLogStore(offlineStore.offlineMaintenanceLog, {
      task_id: urlObj.searchParams.get('task_id'),
      from: urlObj.searchParams.get('from'),
      to: urlObj.searchParams.get('to'),
      limit: urlObj.searchParams.get('limit'),
      offset: urlObj.searchParams.get('offset'),
    })
    if (!outcome.ok) {
      throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
    }
    return outcome.items
  }

  const logEditMatch = pathname.match(/^\/maintenance\/log\/([^/]+)$/)
  if (logEditMatch && method === 'PATCH') {
    const entryId = logEditMatch[1]
    const reqBody = typeof body === 'string' ? JSON.parse(body || '{}') : body || {}
    const outcome = applyLogEditInStore({
      logStore: offlineStore.offlineMaintenanceLog,
      entryId,
      body: reqBody,
      user,
    })
    if (!outcome.ok) {
      throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
    }
    return outcome.entry
  }

  // =========================================================================
  // Maintenance Yearly Report (/maintenance/report) - #029 (E10/#132)
  // =========================================================================
  if (pathname === '/maintenance/report' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only the chairman, board members, and accountant can view the maintenance yearly report.',
      )
    }
    const outcome = buildMaintenanceYearReport(
      offlineStore.offlineMaintenanceLog,
      urlObj.searchParams.get('year'),
    )
    if (!outcome.ok) {
      throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
    }
    return outcome.report
  }

  if (pathname === '/maintenance/report/export-csv' && method === 'GET') {
    if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
      throw makeOfflineError(
        403,
        'FORBIDDEN',
        'Only the chairman, board members, and accountant can export the maintenance yearly report.',
      )
    }
    const outcome = buildMaintenanceYearCsv(
      offlineStore.offlineMaintenanceLog,
      urlObj.searchParams.get('year'),
    )
    if (!outcome.ok) {
      throw makeOfflineError(outcome.status, outcome.errorCode, outcome.message)
    }
    return new Response(outcome.csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${outcome.filename}"`,
      },
    })
  }

  // =========================================================================
  // Building Chat (/chat) - #033
  // =========================================================================

  return UNHANDLED
}
