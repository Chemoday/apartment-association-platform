"""The maintenance calendar: tasks, their occurrences and the log (docs/API.md section 11).

Users and badges come only from PropertyService; the notice target is checked by
CommunicationService. The date rules are pure functions in policies.py.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import Depends
from sqlalchemy import ColumnElement, and_, case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.config import get_settings
from src.core.database import DbSession
from src.core.exceptions import DomainError
from src.modules.communication.schemas import PostCategory
from src.modules.communication.service import CommunicationService
from src.modules.maintenance.models import LogEntry, Occurrence, Task
from src.modules.maintenance.policies import (
    done_on_problem,
    due_date_problem,
    is_board,
    local_today,
    next_after,
    occurrence_state,
    period_problem,
    reads_log,
)
from src.modules.maintenance.schemas import (
    ClosedOccurrence,
    CurrentOccurrence,
    DoneRequest,
    LogEdit,
    LogEntryView,
    LogKind,
    NoticeDraft,
    NoticeView,
    OccurrenceState,
    OccurrenceStatus,
    PeriodUnit,
    SkipRequest,
    TaskCreate,
    TaskEdit,
    TaskResume,
    TaskStatus,
    TaskView,
)
from src.modules.property.schemas import CurrentUserDTO, TargetScope
from src.modules.property.service import PropertyService, get_property_service


def _now() -> datetime:
    return datetime.now(UTC)


def _forbidden() -> DomainError:
    return DomainError(
        status_code=403, error_code="FORBIDDEN", message="Only the board runs the calendar."
    )


def _task_not_found() -> DomainError:
    return DomainError(
        status_code=404, error_code="MAINTENANCE_TASK_NOT_FOUND", message="Task not found."
    )


def _entry_not_found() -> DomainError:
    return DomainError(
        status_code=404, error_code="LOG_ENTRY_NOT_FOUND", message="Log entry not found."
    )


def _archived() -> DomainError:
    return DomainError(status_code=409, error_code="TASK_ARCHIVED", message="The task is archived.")


def _invalid_transition(status: TaskStatus) -> DomainError:
    return DomainError(
        status_code=409,
        error_code="INVALID_TASK_TRANSITION",
        message="The task cannot change to that state now.",
        extra={"status": status.value},
    )


def _occurrence_closed(current: uuid.UUID | None) -> DomainError:
    return DomainError(
        status_code=409,
        error_code="OCCURRENCE_CLOSED",
        message="That occurrence is already closed.",
        extra={"current_occurrence_id": None if current is None else str(current)},
    )


def _validation_error(field: str, message: str) -> DomainError:
    """The 422 VALIDATION_ERROR shape of the request validator, for a rule checked later."""
    return DomainError(
        status_code=422,
        error_code="VALIDATION_ERROR",
        message="The request is invalid.",
        extra={"errors": [{"loc": ["body", field], "message": message, "type": "value_error"}]},
    )


class MaintenanceService:
    def __init__(self, session: AsyncSession, property_service: PropertyService):
        self.session = session
        self.property_service = property_service
        self.timezone = ZoneInfo(get_settings().INSTANCE_TIMEZONE)

    def _today(self) -> date:
        return local_today(_now(), self.timezone)

    # --- Tasks ----------------------------------------------------------------------------------

    async def create_task(self, user: CurrentUserDTO, request: TaskCreate) -> TaskView:
        self._require_board(user)
        self._check_period(request.period_unit, request.period_count, request.lead_days)
        self._check_due_date("first_due_date", request.first_due_date)
        await self._check_notice(user, request.notice)
        now = _now()
        task = Task(
            building_id=user.building_id,
            title=request.title,
            instructions=request.instructions or "",
            period_unit=request.period_unit,
            period_count=request.period_count,
            lead_days=request.lead_days,
            anchor_date=request.first_due_date,
            status=TaskStatus.ACTIVE,
            created_by_user_id=user.id,
            updated_by_user_id=user.id,
            created_at=now,
            updated_at=now,
        )
        self._set_notice(task, request.notice)
        self.session.add(task)
        await self.session.flush()
        self.session.add(self._occurrence(task, 0, request.first_due_date))
        await self.session.flush()
        return await self._view(task)

    async def list_tasks(
        self,
        user: CurrentUserDTO,
        *,
        status: TaskStatus | None,
        state: OccurrenceState | None,
        limit: int,
        offset: int,
    ) -> list[TaskView]:
        """Active and paused tasks by default, by the current due date; archived ones newest
        first."""
        self._require_board(user)
        statement = (
            select(Task)
            .outerjoin(
                Occurrence,
                and_(Occurrence.task_id == Task.id, Occurrence.status == OccurrenceStatus.OPEN),
            )
            .where(Task.building_id == user.building_id)
        )
        if status is None:
            statement = statement.where(Task.status != TaskStatus.ARCHIVED)
        else:
            statement = statement.where(Task.status == status)
        if state is not None:
            statement = statement.where(self._in_state(state))
        statement = statement.order_by(
            case((Task.status == TaskStatus.ARCHIVED, 1), else_=0),
            Occurrence.due_date,
            Task.archived_at.desc(),
            Task.id,
        )
        tasks = list(await self.session.scalars(statement.limit(limit).offset(offset)))
        return await self._views(tasks)

    async def get_task(self, user: CurrentUserDTO, task_id: uuid.UUID) -> TaskView:
        self._require_board(user)
        return await self._view(await self._task(user, task_id))

    async def edit_task(
        self, user: CurrentUserDTO, task_id: uuid.UUID, request: TaskEdit
    ) -> TaskView:
        self._require_board(user)
        task = await self._task(user, task_id, lock=True)
        if task.status == TaskStatus.ARCHIVED:
            raise _archived()
        given = request.model_fields_set
        for field in ("title", "period_unit", "period_count", "lead_days", "next_due_date"):
            if field in given and getattr(request, field) is None:
                raise _validation_error(field, "this field cannot be empty")
        if ("period_unit" in given) != ("period_count" in given):
            raise _validation_error("period_unit", "give period_unit and period_count together")
        unit = request.period_unit or task.period_unit
        count = request.period_count or task.period_count
        lead = task.lead_days if request.lead_days is None else request.lead_days
        if {"period_unit", "lead_days"} & given:
            self._check_period(unit, count, lead)
        if request.next_due_date is not None:
            self._check_due_date("next_due_date", request.next_due_date)
        if "notice" in given:
            await self._check_notice(user, request.notice)
            self._set_notice(task, request.notice)
        if request.title is not None:
            task.title = request.title
        if "instructions" in given:
            task.instructions = request.instructions or ""
        task.lead_days = lead
        if "period_unit" in given or request.next_due_date is not None:
            # The rhythm continues from the current due date, or from the new one.
            task.period_unit, task.period_count = unit, count
            await self._reanchor(task, request.next_due_date)
        self._touch(task, user)
        await self.session.flush()
        return await self._view(task)

    async def pause(self, user: CurrentUserDTO, task_id: uuid.UUID) -> TaskView:
        self._require_board(user)
        task = await self._task(user, task_id, lock=True)
        if task.status != TaskStatus.ACTIVE:
            raise _invalid_transition(task.status)
        task.status = TaskStatus.PAUSED
        self._touch(task, user)
        await self.session.flush()
        return await self._view(task)

    async def resume(
        self, user: CurrentUserDTO, task_id: uuid.UUID, request: TaskResume
    ) -> TaskView:
        self._require_board(user)
        task = await self._task(user, task_id, lock=True)
        if task.status != TaskStatus.PAUSED:
            raise _invalid_transition(task.status)
        if request.next_due_date is not None:
            self._check_due_date("next_due_date", request.next_due_date)
            await self._reanchor(task, request.next_due_date)
        task.status = TaskStatus.ACTIVE
        self._touch(task, user)
        await self.session.flush()
        return await self._view(task)

    async def archive(self, user: CurrentUserDTO, task_id: uuid.UUID) -> TaskView:
        """For good: the open occurrence is cancelled, the log stays."""
        self._require_board(user)
        task = await self._task(user, task_id, lock=True)
        if task.status == TaskStatus.ARCHIVED:
            raise _invalid_transition(task.status)
        now = _now()
        if (open_occurrence := await self._open_occurrence(task.id)) is not None:
            open_occurrence.status, open_occurrence.closed_at = OccurrenceStatus.CANCELLED, now
        task.status, task.archived_at = TaskStatus.ARCHIVED, now
        self._touch(task, user)
        await self.session.flush()
        return await self._view(task)

    # --- Done and skip --------------------------------------------------------------------------

    async def mark_done(
        self, user: CurrentUserDTO, task_id: uuid.UUID, request: DoneRequest
    ) -> ClosedOccurrence:
        task, occurrence = await self._closable(user, task_id, request.occurrence_id)
        if problem := done_on_problem(request.done_on, occurrence.due_date, self._today()):
            raise _validation_error("done_on", problem)
        return await self._close(
            user,
            task,
            occurrence,
            kind=LogKind.DONE,
            closed_on=request.done_on,
            note=request.note or "",
            cost=request.cost,
        )

    async def skip(
        self, user: CurrentUserDTO, task_id: uuid.UUID, request: SkipRequest
    ) -> ClosedOccurrence:
        task, occurrence = await self._closable(user, task_id, request.occurrence_id)
        return await self._close(
            user,
            task,
            occurrence,
            kind=LogKind.SKIPPED,
            closed_on=self._today(),
            note=request.note,
            cost=None,
        )

    async def _closable(
        self, user: CurrentUserDTO, task_id: uuid.UUID, occurrence_id: uuid.UUID
    ) -> tuple[Task, Occurrence]:
        """The task (locked) and its open occurrence, which must be the one the caller saw."""
        self._require_board(user)
        task = await self._task(user, task_id, lock=True)
        if task.status == TaskStatus.ARCHIVED:
            raise _archived()
        occurrence = await self._open_occurrence(task.id)
        if occurrence is None or occurrence.id != occurrence_id:
            raise _occurrence_closed(None if occurrence is None else occurrence.id)
        return task, occurrence

    async def _close(
        self,
        user: CurrentUserDTO,
        task: Task,
        occurrence: Occurrence,
        *,
        kind: LogKind,
        closed_on: date,
        note: str,
        cost: Decimal | None,
    ) -> ClosedOccurrence:
        now = _now()
        occurrence.closed_at = now
        occurrence.status = (
            OccurrenceStatus.DONE if kind == LogKind.DONE else OccurrenceStatus.SKIPPED
        )
        await self.session.flush()  # the unique "one open" index sees the old one closed
        entry = LogEntry(
            building_id=task.building_id,
            task_id=task.id,
            occurrence_id=occurrence.id,
            kind=kind,
            closed_on=closed_on,
            note=note,
            cost=cost,
            recorded_by_user_id=user.id,
            created_at=now,
            updated_at=now,
        )
        seq, due = next_after(
            task.anchor_date,
            task.period_unit,
            task.period_count,
            occurrence.seq,
            occurrence.due_date,
            closed_on,
        )
        self.session.add_all([entry, self._occurrence(task, seq, due)])
        task.updated_at = now
        await self.session.flush()
        [view] = await self._entry_views([entry])
        return ClosedOccurrence(entry=view, task=await self._view(task))

    # --- The log --------------------------------------------------------------------------------

    async def list_log(
        self,
        user: CurrentUserDTO,
        *,
        task_id: uuid.UUID | None,
        date_from: date | None,
        date_to: date | None,
        limit: int,
        offset: int,
    ) -> list[LogEntryView]:
        """The chairman, the board and the accountant; newest closing date first."""
        if not reads_log(user.building_role):
            raise _forbidden()
        statement = select(LogEntry).where(LogEntry.building_id == user.building_id)
        if task_id is not None:
            statement = statement.where(LogEntry.task_id == task_id)
        if date_from is not None:
            statement = statement.where(LogEntry.closed_on >= date_from)
        if date_to is not None:
            statement = statement.where(LogEntry.closed_on <= date_to)
        statement = statement.order_by(
            LogEntry.closed_on.desc(), LogEntry.created_at.desc(), LogEntry.id
        )
        entries = list(await self.session.scalars(statement.limit(limit).offset(offset)))
        return await self._entry_views(entries)

    async def edit_log(
        self, user: CurrentUserDTO, entry_id: uuid.UUID, request: LogEdit
    ) -> LogEntryView:
        self._require_board(user)
        entry = await self.session.scalar(
            select(LogEntry)
            .where(LogEntry.id == entry_id, LogEntry.building_id == user.building_id)
            .with_for_update()
        )
        if entry is None:
            raise _entry_not_found()
        given = request.model_fields_set
        if "cost" in given and request.cost is not None and entry.kind == LogKind.SKIPPED:
            raise _validation_error("cost", "a skipped occurrence has no cost")
        if "note" in given:
            note = request.note or ""
            if entry.kind == LogKind.SKIPPED and not note:
                raise _validation_error("note", "a skipped occurrence needs a note")
            entry.note = note
        if "cost" in given:
            entry.cost = request.cost
        if given:
            entry.updated_at, entry.updated_by_user_id = _now(), user.id
            await self.session.flush()
        [view] = await self._entry_views([entry])
        return view

    # --- Internals ------------------------------------------------------------------------------

    @staticmethod
    def _require_board(user: CurrentUserDTO) -> None:
        if not is_board(user.building_role):
            raise _forbidden()

    @staticmethod
    def _check_period(unit: PeriodUnit, count: int, lead: int) -> None:
        if problem := period_problem(unit, count, lead):
            raise _validation_error("period_count", problem)

    def _check_due_date(self, field: str, due: date) -> None:
        if problem := due_date_problem(due, self._today()):
            raise _validation_error(field, problem)

    async def _check_notice(self, user: CurrentUserDTO, notice: NoticeDraft | None) -> None:
        if notice is None:
            return
        communication = CommunicationService(self.session, self.property_service)
        if problem := await communication.notice_target_problem(
            user.building_id,
            notice.target_scope,
            notice.target_entrance,
            notice.target_apartment_ids,
        ):
            raise DomainError(status_code=422, error_code="INVALID_TARGET", message=problem)

    @staticmethod
    def _set_notice(task: Task, notice: NoticeDraft | None) -> None:
        task.notice_title = None if notice is None else notice.title
        task.notice_body = None if notice is None else notice.body
        task.notice_category = None if notice is None else notice.category.value
        task.notice_target_scope = None if notice is None else notice.target_scope.value
        task.notice_target_entrance = None if notice is None else notice.target_entrance
        task.notice_target_apartment_ids = (
            None
            if notice is None or notice.target_apartment_ids is None
            else [str(apartment_id) for apartment_id in notice.target_apartment_ids]
        )
        task.notice_comments_enabled = None if notice is None else notice.comments_enabled

    @staticmethod
    def _touch(task: Task, user: CurrentUserDTO) -> None:
        task.updated_at, task.updated_by_user_id = _now(), user.id

    @staticmethod
    def _occurrence(task: Task, seq: int, due: date) -> Occurrence:
        return Occurrence(
            task_id=task.id,
            building_id=task.building_id,
            seq=seq,
            due_date=due,
            status=OccurrenceStatus.OPEN,
        )

    async def _reanchor(self, task: Task, new_due: date | None) -> None:
        """The open occurrence becomes occurrence 0 of a new anchor (its own or a new date)."""
        occurrence = await self._open_occurrence(task.id)
        if occurrence is None:  # pragma: no cover - only archived tasks have none
            return
        if new_due is not None:
            occurrence.due_date = new_due
        occurrence.seq, task.anchor_date = 0, occurrence.due_date

    async def _task(self, user: CurrentUserDTO, task_id: uuid.UUID, *, lock: bool = False) -> Task:
        statement = select(Task).where(Task.id == task_id, Task.building_id == user.building_id)
        if lock:
            statement = statement.with_for_update()
        task = await self.session.scalar(statement.execution_options(populate_existing=True))
        if task is None:
            raise _task_not_found()
        return task

    async def _open_occurrence(self, task_id: uuid.UUID) -> Occurrence | None:
        return await self.session.scalar(
            select(Occurrence)
            .where(Occurrence.task_id == task_id, Occurrence.status == OccurrenceStatus.OPEN)
            .execution_options(populate_existing=True)
        )

    def _in_state(self, state: OccurrenceState) -> ColumnElement[bool]:
        """SQL twin of policies.occurrence_state for the list filter."""
        today = self._today()
        if state == OccurrenceState.PAUSED:
            return Task.status == TaskStatus.PAUSED
        active = Task.status == TaskStatus.ACTIVE
        if state == OccurrenceState.OVERDUE:
            return and_(active, Occurrence.due_date < today)
        publish_on = Occurrence.due_date - Task.lead_days
        if state == OccurrenceState.DUE:
            return and_(active, publish_on <= today, Occurrence.due_date >= today)
        return and_(active, publish_on > today)

    async def _view(self, task: Task) -> TaskView:
        [view] = await self._views([task])
        return view

    async def _views(self, tasks: Sequence[Task]) -> list[TaskView]:
        if not tasks:
            return []
        ids = [task.id for task in tasks]
        open_by_task = {
            occurrence.task_id: occurrence
            for occurrence in await self.session.scalars(
                select(Occurrence)
                .where(Occurrence.task_id.in_(ids), Occurrence.status == OccurrenceStatus.OPEN)
                .execution_options(populate_existing=True)
            )
        }
        last_closed = dict(
            (
                await self.session.execute(
                    select(LogEntry.task_id, func.max(LogEntry.closed_on))
                    .where(LogEntry.task_id.in_(ids))
                    .group_by(LogEntry.task_id)
                )
            ).all()
        )
        today = self._today()
        views = []
        for task in tasks:
            occurrence = open_by_task.get(task.id)
            current = None
            if occurrence is not None:
                current = CurrentOccurrence(
                    occurrence_id=occurrence.id,
                    due_date=occurrence.due_date,
                    publish_on=occurrence.due_date - timedelta(days=task.lead_days),
                    state=occurrence_state(occurrence.due_date, task.lead_days, today, task.status),
                )
            views.append(
                TaskView(
                    id=task.id,
                    title=task.title,
                    instructions=task.instructions,
                    period_unit=task.period_unit,
                    period_count=task.period_count,
                    lead_days=task.lead_days,
                    anchor_date=task.anchor_date,
                    status=task.status,
                    notice=_notice_view(task),
                    current=current,
                    last_closed_on=last_closed.get(task.id),
                    created_at=task.created_at,
                    updated_at=task.updated_at,
                    archived_at=task.archived_at,
                )
            )
        return views

    async def _entry_views(self, entries: Sequence[LogEntry]) -> list[LogEntryView]:
        if not entries:
            return []
        task_ids = {entry.task_id for entry in entries}
        titles = dict(
            (
                await self.session.execute(select(Task.id, Task.title).where(Task.id.in_(task_ids)))
            ).all()
        )
        planned = dict(
            (
                await self.session.execute(
                    select(Occurrence.id, Occurrence.due_date).where(
                        Occurrence.id.in_([entry.occurrence_id for entry in entries])
                    )
                )
            ).all()
        )
        building_id = entries[0].building_id
        people = {entry.recorded_by_user_id for entry in entries} | {
            entry.updated_by_user_id for entry in entries if entry.updated_by_user_id
        }
        badges = await self.property_service.get_named_author_badges(building_id, people)
        return [
            LogEntryView(
                id=entry.id,
                task_id=entry.task_id,
                task_title=titles[entry.task_id],
                kind=entry.kind,
                planned_date=planned[entry.occurrence_id],
                closed_on=entry.closed_on,
                note=entry.note,
                cost=None if entry.cost is None else f"{entry.cost:.2f}",
                recorded_by=badges[entry.recorded_by_user_id],
                recorded_at=entry.created_at,
                updated_at=entry.updated_at,
                updated_by=(
                    None if entry.updated_by_user_id is None else badges[entry.updated_by_user_id]
                ),
            )
            for entry in entries
        ]


def _notice_view(task: Task) -> NoticeView | None:
    if task.notice_title is None:
        return None
    return NoticeView(
        title=task.notice_title,
        body=task.notice_body or "",
        category=PostCategory(task.notice_category),
        target_scope=TargetScope(task.notice_target_scope),
        target_entrance=task.notice_target_entrance,
        target_apartment_ids=(
            None
            if task.notice_target_apartment_ids is None
            else [uuid.UUID(value) for value in task.notice_target_apartment_ids]
        ),
        comments_enabled=bool(task.notice_comments_enabled),
    )


def get_maintenance_service(
    session: DbSession, property_service: PropertyService = Depends(get_property_service)
) -> MaintenanceService:
    return MaintenanceService(session, property_service)
