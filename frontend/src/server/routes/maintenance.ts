import type { SeedUser } from '../state.js';
import { type RouteContext, sendJson, sendError, readBody } from '../http.js';
import {
  postsStore,
  dispatchServerMaintenanceAndNoticeNotifications,
  serverStore,
} from '../state.js';
import {
  readSettingFromStore,
} from '../../utils/issues.js';
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
  type MaintenanceTaskRecord,
} from '../../utils/maintenance.js';

export async function handleMaintenanceRoutes(ctx: RouteContext<SeedUser>): Promise<boolean> {
  const { req, res, urlObj, pathname, method, user } = ctx;

    if (pathname === '/api/v1/maintenance/tasks' || pathname.startsWith('/api/v1/maintenance/tasks/')) {
      if (!['CHAIRMAN', 'BOARD'].includes(user.building_role)) {
        return sendError(res, 403, 'FORBIDDEN', 'Only the chairman and board members can access maintenance tasks.');
      }

      const today = getTodayDateInTallinn();

      // GET /api/v1/maintenance/tasks
      if (pathname === '/api/v1/maintenance/tasks' && method === 'GET') {
        const overdueReminderDays = Number(
          readSettingFromStore(serverStore.associationSettingsStore, 'maintenance.overdue_reminder_days', 7)
        );
        publishMaintenanceTasksInStore({
          tasksStore: serverStore.maintenanceStore,
          postsStore,
          today,
          overdueReminderDays,
          onNotification: dispatchServerMaintenanceAndNoticeNotifications,
        });

        const statusParam = (urlObj.searchParams.get('status') as string) || undefined;
        const stateParam = (urlObj.searchParams.get('state') as string) || undefined;
        const limitParam = urlObj.searchParams.get('limit') ? Number(urlObj.searchParams.get('limit')) : 50;
        const offsetParam = urlObj.searchParams.get('offset') ? Number(urlObj.searchParams.get('offset')) : 0;

        const list = queryTasksStore(
          serverStore.maintenanceStore,
          { status: statusParam, state: stateParam, limit: limitParam, offset: offsetParam },
          today
        );
        return sendJson(res, 200, list);
      }

      // POST /api/v1/maintenance/tasks
      if (pathname === '/api/v1/maintenance/tasks' && method === 'POST') {
        const body = await readBody(req);
        const validated = validateTaskDraft(body, { today });
        if (!validated.valid) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'Validation failed for maintenance task.', {
            errors: validated.errors,
          });
        }

        const p = validated.payload;
        const taskId = `task-${Date.now()}`;
        const occId = `occ-${Date.now()}`;
        const lead = p.lead_days;
        const dueDate = p.first_due_date || today;
        const occState = computeOccurrenceState(dueDate, lead, 'ACTIVE', today);

        const newTask: MaintenanceTaskRecord = {
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
        };

        serverStore.maintenanceStore.push(newTask);
        return sendJson(res, 201, toTaskView(newTask, today));
      }

      // POST /api/v1/maintenance/tasks/:taskId/pause
      const pauseMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)\/pause$/);
      if (pauseMatch && method === 'POST') {
        const taskId = pauseMatch[1];
        const found = serverStore.maintenanceStore.find((t) => t.id === taskId);
        if (!found) {
          return sendError(res, 404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.');
        }
        if (found.status === 'ARCHIVED') {
          return sendError(res, 409, 'TASK_ARCHIVED', 'Task is archived.');
        }
        if (found.status !== 'ACTIVE') {
          return sendError(res, 409, 'INVALID_TASK_TRANSITION', 'Task must be ACTIVE to pause.', {
            status: found.status,
          });
        }
        found.status = 'PAUSED';
        found.updated_at = new Date().toISOString();
        return sendJson(res, 200, toTaskView(found, today));
      }

      // POST /api/v1/maintenance/tasks/:taskId/resume
      const resumeMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)\/resume$/);
      if (resumeMatch && method === 'POST') {
        const taskId = resumeMatch[1];
        const found = serverStore.maintenanceStore.find((t) => t.id === taskId);
        if (!found) {
          return sendError(res, 404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.');
        }
        if (found.status === 'ARCHIVED') {
          return sendError(res, 409, 'TASK_ARCHIVED', 'Task is archived.');
        }
        if (found.status !== 'PAUSED') {
          return sendError(res, 409, 'INVALID_TASK_TRANSITION', 'Task must be PAUSED to resume.', {
            status: found.status,
          });
        }

        const body = await readBody(req);
        if (typeof body.next_due_date === 'string' && body.next_due_date) {
          if (body.occurrence_id && found.current?.occurrence_id && body.occurrence_id !== found.current.occurrence_id) {
            return sendError(res, 409, 'OCCURRENCE_CLOSED', 'Occurrence has already been closed.', {
              current_occurrence_id: found.current.occurrence_id,
            });
          }
          if (found.current) {
            found.current.due_date = body.next_due_date;
          }
          found.anchor_date = body.next_due_date;
        }

        found.status = 'ACTIVE';
        found.updated_at = new Date().toISOString();
        return sendJson(res, 200, toTaskView(found, today));
      }

      // POST /api/v1/maintenance/tasks/:taskId/archive
      const archiveMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)\/archive$/);
      if (archiveMatch && method === 'POST') {
        const taskId = archiveMatch[1];
        const found = serverStore.maintenanceStore.find((t) => t.id === taskId);
        if (!found) {
          return sendError(res, 404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.');
        }
        if (found.status === 'ARCHIVED') {
          return sendError(res, 409, 'TASK_ARCHIVED', 'Task is already archived.');
        }

        found.status = 'ARCHIVED';
        found.current = null;
        found.archived_at = new Date().toISOString();
        found.updated_at = found.archived_at;
        return sendJson(res, 200, toTaskView(found, today));
      }

      // GET & PATCH /api/v1/maintenance/tasks/:taskId
      const detailMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)$/);
      if (detailMatch && method === 'GET') {
        const overdueReminderDays = Number(
          readSettingFromStore(serverStore.associationSettingsStore, 'maintenance.overdue_reminder_days', 7)
        );
        publishMaintenanceTasksInStore({
          tasksStore: serverStore.maintenanceStore,
          postsStore,
          today,
          overdueReminderDays,
          onNotification: dispatchServerMaintenanceAndNoticeNotifications,
        });

        const taskId = detailMatch[1];
        const found = serverStore.maintenanceStore.find((t) => t.id === taskId);
        if (!found) {
          return sendError(res, 404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.');
        }
        return sendJson(res, 200, toTaskView(found, today));
      }

      if (detailMatch && method === 'PATCH') {
        const taskId = detailMatch[1];
        const found = serverStore.maintenanceStore.find((t) => t.id === taskId);
        if (!found) {
          return sendError(res, 404, 'MAINTENANCE_TASK_NOT_FOUND', 'Maintenance task not found.');
        }
        if (found.status === 'ARCHIVED') {
          return sendError(res, 409, 'TASK_ARCHIVED', 'Task is archived and cannot be edited.');
        }

        const body = await readBody(req);

        if (body.occurrence_id && found.current?.occurrence_id && body.occurrence_id !== found.current.occurrence_id) {
          return sendError(res, 409, 'OCCURRENCE_CLOSED', 'Occurrence has already been closed.', {
            current_occurrence_id: found.current.occurrence_id,
          });
        }

        if (('period_unit' in body && !('period_count' in body)) || ('period_count' in body && !('period_unit' in body))) {
          return sendError(res, 422, 'VALIDATION_ERROR', 'period_unit and period_count must be updated together.');
        }

        const unit = typeof body.period_unit === 'string' && body.period_unit ? body.period_unit : found.period_unit;
        const count = body.period_count !== undefined ? Number(body.period_count) : found.period_count;
        const lead = body.lead_days !== undefined ? Number(body.lead_days) : found.lead_days;

        if (body.title !== undefined) {
          if (!body.title || typeof body.title !== 'string') {
            return sendError(res, 422, 'VALIDATION_ERROR', 'Title cannot be empty.');
          }
          found.title = body.title.trim();
          for (const entry of serverStore.maintenanceLogStore) {
            if (entry.task_id === found.id) {
              entry.task_title = found.title;
            }
          }
        }

        if (body.instructions !== undefined) {
          found.instructions = typeof body.instructions === 'string' ? body.instructions : '';
        }

        if (body.period_unit !== undefined && body.period_count !== undefined) {
          found.period_unit = unit;
          found.period_count = count;
        }

        if (body.lead_days !== undefined) {
          const maxLead = maxAllowedLeadDays(unit, count);
          if (lead < 0 || lead > maxLead) {
            return sendError(res, 422, 'VALIDATION_ERROR', `lead_days must be between 0 and ${maxLead}.`);
          }
          found.lead_days = lead;
        }

        if (body.notice !== undefined) {
          found.notice = (body.notice ?? null) as MaintenanceTaskRecord['notice'];
        }

        if (typeof body.next_due_date === 'string' && body.next_due_date) {
          if (found.current) {
            found.current.due_date = body.next_due_date;
            found.anchor_date = body.next_due_date;
          }
        }

        found.updated_at = new Date().toISOString();
        return sendJson(res, 200, toTaskView(found, today));
      }

      // POST /api/v1/maintenance/tasks/:taskId/done
      const doneMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)\/done$/);
      if (doneMatch && method === 'POST') {
        const taskId = doneMatch[1];
        const body = await readBody(req);
        const outcome = applyTaskDoneInStore({
          tasksStore: serverStore.maintenanceStore,
          logStore: serverStore.maintenanceLogStore,
          taskId,
          body,
          user,
          today,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Cannot mark maintenance task done.',
            outcome.extra || {}
          );
        }
        return sendJson(res, 201, outcome.result);
      }

      // POST /api/v1/maintenance/tasks/:taskId/skip
      const skipMatch = pathname.match(/^\/api\/v1\/maintenance\/tasks\/([^/]+)\/skip$/);
      if (skipMatch && method === 'POST') {
        const taskId = skipMatch[1];
        const body = await readBody(req);
        const outcome = applyTaskSkipInStore({
          tasksStore: serverStore.maintenanceStore,
          logStore: serverStore.maintenanceLogStore,
          taskId,
          body,
          user,
          today,
        });
        if (!outcome.ok) {
          return sendError(
            res,
            outcome.status || 422,
            outcome.errorCode || 'VALIDATION_ERROR',
            outcome.message || 'Cannot skip maintenance task.',
            outcome.extra || {}
          );
        }
        return sendJson(res, 201, outcome.result);
      }
    }

    // =========================================================================
    // Maintenance Log (/api/v1/maintenance/log) - #016 (E10/M1)
    // =========================================================================
    if (pathname === '/api/v1/maintenance/log' && method === 'GET') {
      if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Only the chairman, board members, and accountant can view the maintenance log.'
        );
      }
      const outcome = queryMaintenanceLogStore(serverStore.maintenanceLogStore, {
        task_id: urlObj.searchParams.get('task_id'),
        from: urlObj.searchParams.get('from'),
        to: urlObj.searchParams.get('to'),
        limit: urlObj.searchParams.get('limit'),
        offset: urlObj.searchParams.get('offset'),
      });
      if (!outcome.ok) {
        return sendError(
          res,
          outcome.status || 422,
          outcome.errorCode || 'VALIDATION_ERROR',
          outcome.message || 'Invalid maintenance log query.'
        );
      }
      return sendJson(res, 200, outcome.items);
    }

    const logEditMatch = pathname.match(/^\/api\/v1\/maintenance\/log\/([^/]+)$/);
    if (logEditMatch && method === 'PATCH') {
      const entryId = logEditMatch[1];
      const body = await readBody(req);
      const outcome = applyLogEditInStore({
        logStore: serverStore.maintenanceLogStore,
        entryId,
        body,
        user,
      });
      if (!outcome.ok) {
        return sendError(
          res,
          outcome.status || 422,
          outcome.errorCode || 'VALIDATION_ERROR',
          outcome.message || 'Cannot edit maintenance log entry.'
        );
      }
      return sendJson(res, 200, outcome.entry);
    }

    // =========================================================================
    // Maintenance Yearly Report (/api/v1/maintenance/report) - #029 (E10/#132)
    // =========================================================================
    if (pathname === '/api/v1/maintenance/report' && method === 'GET') {
      if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Only the chairman, board members, and accountant can view the maintenance yearly report.'
        );
      }
      const outcome = buildMaintenanceYearReport(
        serverStore.maintenanceLogStore,
        urlObj.searchParams.get('year')
      );
      if (!outcome.ok) {
        return sendError(
          res,
          outcome.status || 422,
          outcome.errorCode || 'VALIDATION_ERROR',
          outcome.message || 'Invalid year parameter.'
        );
      }
      return sendJson(res, 200, outcome.report);
    }

    if (pathname === '/api/v1/maintenance/report/export-csv' && method === 'GET') {
      if (!['CHAIRMAN', 'BOARD', 'ACCOUNTANT'].includes(user.building_role)) {
        return sendError(
          res,
          403,
          'FORBIDDEN',
          'Only the chairman, board members, and accountant can export the maintenance yearly report.'
        );
      }
      const outcome = buildMaintenanceYearCsv(
        serverStore.maintenanceLogStore,
        urlObj.searchParams.get('year')
      );
      if (!outcome.ok) {
        return sendError(
          res,
          outcome.status || 422,
          outcome.errorCode || 'VALIDATION_ERROR',
          outcome.message || 'Invalid year parameter.'
        );
      }
      const traceId = `018f-${Math.random().toString(16).slice(2, 10)}`;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${outcome.filename}"`);
      res.setHeader('X-Trace-Id', traceId);
      { res.end(Buffer.from(outcome.csv || '', 'utf8')); return true; }
    }

    // =========================================================================
    // Building Chat (/api/v1/chat) - #033
    // =========================================================================

  return false;
}
