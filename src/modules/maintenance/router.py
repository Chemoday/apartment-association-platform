"""Thin HTTP layer of the maintenance calendar (docs/API.md section 11)."""

import uuid
from datetime import date
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from src.core.exceptions import AUTH_ERRORS, error_responses
from src.core.security import get_current_user
from src.modules.maintenance.schemas import (
    TASKS_PAGE_MAX,
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
)
from src.modules.maintenance.service import MaintenanceService, get_maintenance_service
from src.modules.property.schemas import CurrentUserDTO

router = APIRouter(
    prefix="/api/v1/maintenance",
    tags=["maintenance"],
    responses=error_responses(
        {401: AUTH_ERRORS, 403: ["FORBIDDEN"], 500: ["INTERNAL_SERVER_ERROR"]}
    ),
)

Service = Annotated[MaintenanceService, Depends(get_maintenance_service)]
Caller = Annotated[CurrentUserDTO, Depends(get_current_user)]
Limit = Annotated[int, Query(ge=1, le=TASKS_PAGE_MAX)]
Offset = Annotated[int, Query(ge=0, le=100_000)]

_ONE_TASK = {404: ["MAINTENANCE_TASK_NOT_FOUND"], 422: ["VALIDATION_ERROR"]}


@router.get(
    "/tasks", response_model=list[TaskView], responses=error_responses({422: ["VALIDATION_ERROR"]})
)
async def list_tasks(
    user: Caller,
    service: Service,
    status: TaskStatus | None = None,
    state: OccurrenceState | None = None,
    limit: Limit = 50,
    offset: Offset = 0,
) -> list[TaskView]:
    """The building's tasks, by the current due date (the chairman and the board)."""
    return await service.list_tasks(user, status=status, state=state, limit=limit, offset=offset)


@router.post(
    "/tasks",
    response_model=TaskView,
    status_code=201,
    responses=error_responses({422: ["VALIDATION_ERROR", "INVALID_TARGET"]}),
)
async def create_task(body: TaskCreate, user: Caller, service: Service) -> TaskView:
    """A new recurring task with its first occurrence."""
    return await service.create_task(user, body)


@router.get("/tasks/{task_id}", response_model=TaskView, responses=error_responses(_ONE_TASK))
async def get_task(task_id: uuid.UUID, user: Caller, service: Service) -> TaskView:
    return await service.get_task(user, task_id)


@router.patch(
    "/tasks/{task_id}",
    response_model=TaskView,
    responses=error_responses(
        {**_ONE_TASK, 409: ["TASK_ARCHIVED"], 422: ["VALIDATION_ERROR", "INVALID_TARGET"]}
    ),
)
async def edit_task(task_id: uuid.UUID, body: TaskEdit, user: Caller, service: Service) -> TaskView:
    """Change the task; a new period or due date continues the rhythm from that date."""
    return await service.edit_task(user, task_id, body)


_TRANSITION = error_responses({**_ONE_TASK, 409: ["INVALID_TASK_TRANSITION"]})


@router.post("/tasks/{task_id}/pause", response_model=TaskView, responses=_TRANSITION)
async def pause_task(task_id: uuid.UUID, user: Caller, service: Service) -> TaskView:
    return await service.pause(user, task_id)


@router.post("/tasks/{task_id}/resume", response_model=TaskView, responses=_TRANSITION)
async def resume_task(
    task_id: uuid.UUID, user: Caller, service: Service, body: TaskResume | None = None
) -> TaskView:
    return await service.resume(user, task_id, body or TaskResume())


@router.post("/tasks/{task_id}/archive", response_model=TaskView, responses=_TRANSITION)
async def archive_task(task_id: uuid.UUID, user: Caller, service: Service) -> TaskView:
    """For good: the open occurrence is cancelled, the log stays."""
    return await service.archive(user, task_id)


_CLOSE = error_responses({**_ONE_TASK, 409: ["TASK_ARCHIVED", "OCCURRENCE_CLOSED"]})


@router.post(
    "/tasks/{task_id}/done", response_model=ClosedOccurrence, status_code=201, responses=_CLOSE
)
async def mark_done(
    task_id: uuid.UUID, body: DoneRequest, user: Caller, service: Service
) -> ClosedOccurrence:
    """Close the open occurrence as done (with a note and a cost) and open the next one."""
    return await service.mark_done(user, task_id, body)


@router.post(
    "/tasks/{task_id}/skip", response_model=ClosedOccurrence, status_code=201, responses=_CLOSE
)
async def skip_occurrence(
    task_id: uuid.UUID, body: SkipRequest, user: Caller, service: Service
) -> ClosedOccurrence:
    """Skip the open occurrence, with a reason, and open the next one."""
    return await service.skip(user, task_id, body)


@router.get(
    "/log",
    response_model=list[LogEntryView],
    responses=error_responses({422: ["VALIDATION_ERROR"]}),
)
async def list_log(
    user: Caller,
    service: Service,
    task_id: uuid.UUID | None = None,
    date_from: Annotated[date | None, Query(alias="from")] = None,
    date_to: Annotated[date | None, Query(alias="to")] = None,
    limit: Limit = 50,
    offset: Offset = 0,
) -> list[LogEntryView]:
    """The log, newest first (the chairman, the board and the accountant)."""
    return await service.list_log(
        user, task_id=task_id, date_from=date_from, date_to=date_to, limit=limit, offset=offset
    )


@router.patch(
    "/log/{entry_id}",
    response_model=LogEntryView,
    responses=error_responses({404: ["LOG_ENTRY_NOT_FOUND"], 422: ["VALIDATION_ERROR"]}),
)
async def edit_log_entry(
    entry_id: uuid.UUID, body: LogEdit, user: Caller, service: Service
) -> LogEntryView:
    """Fix the note or the cost of an entry (the chairman and the board)."""
    return await service.edit_log(user, entry_id, body)
