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

from src.core.building_settings import BuildingSettings
from src.core.config import get_settings
from src.core.database import DbSession, get_event_outbox
from src.core.event_bus import EventOutbox
from src.core.exceptions import DomainError
from src.modules.communication.schemas import (
    CommentCreateRequest,
    PostCategory,
    PostCreateRequest,
    PostOrigin,
    PostType,
)
from src.modules.communication.service import CommunicationService
from src.modules.maintenance.events import MaintenanceTaskDue
from src.modules.maintenance.messages import local_date, render
from src.modules.maintenance.models import LogEntry, Occurrence, Task
from src.modules.maintenance.policies import (
    BOARD_ROLES,
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
    OccurrenceRefDTO,
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
from src.modules.maintenance.settings import OVERDUE_REMINDER_DAYS
from src.modules.property.schemas import BuildingRole, CurrentUserDTO, TargetScope
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
    def __init__(
        self,
        session: AsyncSession,
        property_service: PropertyService,
        outbox: EventOutbox | None = None,
    ):
        self.session = session
        self.property_service = property_service
        # Posts and events go out only after the transaction commits. None only where nothing
        # is published.
        self.outbox = outbox
        settings = get_settings()
        self.timezone = ZoneInfo(settings.INSTANCE_TIMEZONE)
        self.locale = settings.DEFAULT_LOCALE

    def _today(self) -> date:
        return local_today(_now(), self.timezone)

    # --- System-level reads (no request caller; used by the notifications module) ---------------

    async def get_occurrence_ref(self, occurrence_id: uuid.UUID) -> OccurrenceRefDTO | None:
        """The task's current title and the occurrence's state now; None if unknown."""
        row = (
            await self.session.execute(
                select(Occurrence, Task)
                .join(Task, Task.id == Occurrence.task_id)
                .where(Occurrence.id == occurrence_id)
                .execution_options(populate_existing=True)
            )
        ).first()
        if row is None:
            return None
        occurrence, task = row
        return OccurrenceRefDTO(
            occurrence_id=occurrence.id,
            task_id=task.id,
            building_id=task.building_id,
            title=task.title,
            due_date=occurrence.due_date,
            is_open=occurrence.status == OccurrenceStatus.OPEN,
            task_active=task.status == TaskStatus.ACTIVE,
        )

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
            anchor_day=request.first_due_date.day,
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
        new_period = (unit, count) != (task.period_unit, task.period_count)
        monthly = {PeriodUnit.MONTH, PeriodUnit.YEAR}
        keep_day = task.period_unit in monthly and unit in monthly
        if new_period or request.next_due_date is not None:
            # The rhythm continues from the current due date, or from the new one; the same
            # period or the same date sent again changes nothing (a form may send every field).
            task.period_unit, task.period_count = unit, count
            await self._reanchor(
                task,
                request.next_due_date,
                moved_by=user,
                seen=request.occurrence_id,
                new_period=new_period,
                keep_day=keep_day,
            )
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
            await self._reanchor(
                task, request.next_due_date, moved_by=user, seen=request.occurrence_id
            )
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
        last = await self.session.scalar(
            select(func.max(LogEntry.closed_on)).where(LogEntry.task_id == task.id)
        )
        if last is not None and request.done_on < last:
            raise _validation_error("done_on", "done_on is before the last closed occurrence")
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
        if occurrence.board_post_id is not None:
            # The reminder topic gets its outcome, so the board room is not left with open ends.
            outcome = (
                render("comment.done", self.locale, date=local_date(closed_on))
                if kind == LogKind.DONE
                else render("comment.skipped", self.locale, note=note)
            )
            await self._comment(user, occurrence, outcome)
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
            task.anchor_day,
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

    # --- Publishing (task M2; called by the publisher, one task per transaction) ---------------

    async def publish_due(self, occurrence_id: uuid.UUID, now: datetime) -> str | None:
        """Publish the occurrence or remind of it when it is time; None when nothing to do.

        The task row is locked with SKIP LOCKED (a task being changed waits for the next run)
        and everything is checked again under the lock, so two workers never publish twice.
        """
        task_id = await self.session.scalar(
            select(Occurrence.task_id).where(Occurrence.id == occurrence_id)
        )
        if task_id is None:
            return None
        task = await self.session.scalar(
            select(Task)
            .where(Task.id == task_id)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True)
        )
        if task is None or task.status != TaskStatus.ACTIVE:
            return None
        occurrence = await self._open_occurrence(task.id)
        if occurrence is None or occurrence.id != occurrence_id:
            return None
        today = local_today(now, self.timezone)
        if occurrence.published_at is None:
            if today < occurrence.due_date - timedelta(days=task.lead_days):
                return None
            author = await self._author(task)
            if author is None:
                return None
            await self._publish(task, occurrence, author, today, now)
            return "published"
        if occurrence.next_remind_on is None or today < occurrence.next_remind_on:
            return None
        author = await self._author(task)
        if author is None:
            return None
        every = await BuildingSettings(self.session).get(task.building_id, OVERDUE_REMINDER_DAYS)
        await self._remind(task, occurrence, author, today, every)
        return "reminded"

    async def _publish(
        self, task: Task, occurrence: Occurrence, author: CurrentUserDTO, today: date, now: datetime
    ) -> None:
        communication = CommunicationService(self.session, self.property_service, self.outbox)
        if task.notice_title is not None:
            scope = TargetScope(task.notice_target_scope)
            apartments = self._notice_apartments(task)
            problem = await communication.notice_target_problem(
                task.building_id, scope, task.notice_target_entrance, apartments
            )
            if problem is None:
                planned = render(
                    "notice.planned", self.locale, date=local_date(occurrence.due_date)
                )
                notice = await communication.create_post(
                    author,
                    PostCreateRequest(
                        post_type=PostType.OFFICIAL_NOTICE,
                        category=PostCategory(task.notice_category),
                        title=task.notice_title,
                        body=f"{task.notice_body}\n\n{planned}",
                        target_scope=scope,
                        target_entrance=task.notice_target_entrance,
                        target_apartment_ids=apartments,
                        comments_enabled=bool(task.notice_comments_enabled),
                    ),
                    origin=PostOrigin.MAINTENANCE,
                )
                occurrence.notice_post_id = notice.id
            else:
                occurrence.notice_failed = True
        # A republication after a move keeps the topic and says the new date on it.
        due_line = render("comment.due", self.locale, date=local_date(occurrence.due_date))
        if not await self._comment(author, occurrence, due_line):
            occurrence.board_post_id = await self._board_topic(task, occurrence, author, today)
        occurrence.published_at, occurrence.last_reminded_on = now, today
        # The first overdue reminder is the day after the due date (or at once when late).
        occurrence.next_remind_on = max(
            occurrence.due_date + timedelta(days=1), today + timedelta(days=1)
        )
        await self.session.flush()
        self._task_due(task, occurrence, today, reminder_number=0)

    async def _remind(
        self, task: Task, occurrence: Occurrence, author: CurrentUserDTO, today: date, every: int
    ) -> None:
        number = occurrence.reminder_count + 1
        text = render(
            "comment.overdue", self.locale, date=local_date(occurrence.due_date), number=number
        )
        if not await self._comment(author, occurrence, text):
            # The board topic was deleted: the task is still not done, so it is posted again.
            occurrence.board_post_id = await self._board_topic(task, occurrence, author, today)
        occurrence.reminder_count, occurrence.last_reminded_on = number, today
        occurrence.next_remind_on = today + timedelta(days=every)
        await self.session.flush()
        self._task_due(task, occurrence, today, reminder_number=number)

    async def _board_topic(
        self, task: Task, occurrence: Occurrence, author: CurrentUserDTO, today: date
    ) -> uuid.UUID:
        title = render(
            "board.title.OVERDUE" if today > occurrence.due_date else "board.title.DUE",
            self.locale,
            title=task.title,
            date=local_date(occurrence.due_date),
        )
        lines = [task.instructions] if task.instructions else []
        if occurrence.notice_failed:
            lines.append(render("board.notice_failed", self.locale))
        lines.append(render("board.footer", self.locale))
        communication = CommunicationService(self.session, self.property_service, self.outbox)
        topic = await communication.create_post(
            author,
            PostCreateRequest(
                post_type=PostType.BOARD_TOPIC,
                category=PostCategory.MAINTENANCE,
                title=title,
                body="\n\n".join(lines),
                comments_enabled=True,
            ),
            origin=PostOrigin.MAINTENANCE,
        )
        return topic.id

    async def _comment(self, author: CurrentUserDTO, occurrence: Occurrence, text: str) -> bool:
        """A comment on the occurrence's board topic; False when the topic is gone."""
        if occurrence.board_post_id is None:
            return False
        communication = CommunicationService(self.session, self.property_service, self.outbox)
        try:
            await communication.add_comment(
                author, occurrence.board_post_id, CommentCreateRequest(body=text)
            )
        except DomainError as error:
            if error.error_code == "POST_NOT_FOUND":
                return False
            raise
        return True

    async def _author(self, task: Task) -> CurrentUserDTO | None:
        """Who the posts are published as: the creator while on the board, else the chairman,
        else a board member (the first by id); None when the building has nobody."""
        creator = await self.property_service.get_current_user(task.created_by_user_id)
        if creator is not None and creator.building_role in BOARD_ROLES:
            return creator
        for role in (BuildingRole.CHAIRMAN, BuildingRole.BOARD):
            for recipient in await self.property_service.users_with_roles(task.building_id, [role]):
                if user := await self.property_service.get_current_user(recipient.user_id):
                    return user
        return None

    def _task_due(
        self, task: Task, occurrence: Occurrence, today: date, *, reminder_number: int
    ) -> None:
        if self.outbox is None:
            raise RuntimeError("publishing needs an outbox")
        self.outbox.add(
            MaintenanceTaskDue(
                task_id=task.id,
                occurrence_id=occurrence.id,
                building_id=task.building_id,
                due_date=occurrence.due_date,
                overdue=today > occurrence.due_date,
                reminder_number=reminder_number,
            )
        )

    @staticmethod
    def _notice_apartments(task: Task) -> list[uuid.UUID] | None:
        if task.notice_target_apartment_ids is None:
            return None
        return [uuid.UUID(value) for value in task.notice_target_apartment_ids]

    # --- Internals ------------------------------------------------------------------------------

    @staticmethod
    def _require_board(user: CurrentUserDTO) -> None:
        if not is_board(user.building_role):
            raise _forbidden()

    @staticmethod
    def _check_period(unit: PeriodUnit, count: int, lead: int) -> None:
        if problem := period_problem(unit, count, lead):
            field = "lead_days" if "lead_days" in problem else "period_count"
            raise _validation_error(field, problem)

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
            message, extra = problem
            raise DomainError(
                status_code=422, error_code="INVALID_TARGET", message=message, extra=extra
            )

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

    async def _reanchor(
        self,
        task: Task,
        new_due: date | None,
        *,
        moved_by: CurrentUserDTO,
        seen: uuid.UUID | None,
        new_period: bool = False,
        keep_day: bool = True,
    ) -> None:
        """The open occurrence becomes occurrence 0 of a new anchor (its own or a new date).

        A new period between months and years keeps the rhythm's day of the month (31 stays 31
        even from a clamped 28 February); a new date, or a switch from or to days, takes the
        day of that date. A published occurrence keeps its posts and its board topic says
        where the date moved; when the new date is beyond the lead time again, it is published
        once more at its new publish date (a comment on the topic, a new notice for residents).
        """
        occurrence = await self._open_occurrence(task.id)
        if occurrence is None:  # pragma: no cover - only archived tasks have none
            return
        if seen is not None and seen != occurrence.id:
            raise _occurrence_closed(occurrence.id)
        moved = new_due is not None and new_due != occurrence.due_date
        if not (moved or new_period):
            return
        if moved:
            assert new_due is not None
            occurrence.due_date, task.anchor_day = new_due, new_due.day
            if occurrence.board_post_id is not None:
                text = render("comment.moved", self.locale, date=local_date(new_due))
                await self._comment(moved_by, occurrence, text)
            if occurrence.published_at is not None:
                today = self._today()
                if new_due - timedelta(days=task.lead_days) > today:
                    occurrence.published_at, occurrence.next_remind_on = None, None
                else:
                    occurrence.next_remind_on = max(
                        new_due + timedelta(days=1), today + timedelta(days=1)
                    )
        elif keep_day is False:
            task.anchor_day = occurrence.due_date.day
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
                    published_at=occurrence.published_at,
                    board_post_id=occurrence.board_post_id,
                    notice_post_id=occurrence.notice_post_id,
                    notice_failed=occurrence.notice_failed,
                    reminder_count=occurrence.reminder_count,
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
    session: DbSession,
    property_service: PropertyService = Depends(get_property_service),
    outbox: EventOutbox = Depends(get_event_outbox),
) -> MaintenanceService:
    return MaintenanceService(session, property_service, outbox)
