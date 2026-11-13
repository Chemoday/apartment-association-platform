"""The issue tracker: reporting, the list, "+1" and who sees what (docs/API.md section 10).

Apartments, memberships and badges come only from PropertyService, settings from
BuildingSettings. The rules are pure functions in policies.py.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from fastapi import Depends, Request
from sqlalchemy import (
    ColumnElement,
    DateTime,
    and_,
    case,
    delete,
    func,
    literal,
    or_,
    select,
    true,
)
from sqlalchemy.dialects.postgresql import UUID, insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.building_settings import BuildingSettings
from src.core.database import DbSession, get_event_outbox
from src.core.event_bus import EventOutbox
from src.core.exceptions import DomainError
from src.core.files import (
    FileDTO,
    FilePurpose,
    FileStore,
    PhotoVariant,
    declared_length,
    get_file_store_factory,
    read_body,
    require_content_type,
)
from src.modules.issues.events import IssueMerged, IssueReported, IssueStatusChanged
from src.modules.issues.models import Issue, IssueFollower, IssueStatusChange
from src.modules.issues.policies import (
    ENDED_STATUSES,
    LIMIT_WINDOW,
    MAX_PHOTOS_PER_ISSUE,
    OPEN_STATUSES,
    PHOTO_MAX_BYTES,
    RECENTLY_ENDED,
    Transition,
    board_transition,
    can_be_original,
    is_board,
    is_open,
    may_add_photo,
    may_delete_photo,
    photo_retention_end,
    retry_after_seconds,
    statuses_for,
    visible,
)
from src.modules.issues.schemas import (
    BoardStatus,
    IssueAction,
    IssueCategory,
    IssueEdit,
    IssueForm,
    IssuePhoto,
    IssueRefDTO,
    IssueReport,
    IssueStatus,
    IssueSummary,
    IssueView,
    ReporterView,
    StatusChange,
    StatusFilter,
    TimelineEntry,
)
from src.modules.issues.settings import (
    PHOTO_RETENTION_MONTHS,
    REPORTS_PER_APARTMENT_PER_DAY,
    URGENT_ENABLED,
    URGENT_PER_APARTMENT_PER_DAY,
)
from src.modules.property.schemas import CurrentUserDTO
from src.modules.property.service import PropertyService, get_property_service


def _now() -> datetime:
    return datetime.now(UTC)


def _forbidden(message: str = "You cannot use the issue tracker.") -> DomainError:
    return DomainError(status_code=403, error_code="FORBIDDEN", message=message)


def _not_found() -> DomainError:
    # The same answer for "does not exist", "another building" and "not visible to you".
    return DomainError(status_code=404, error_code="ISSUE_NOT_FOUND", message="Issue not found.")


def _not_editable(status: IssueStatus) -> DomainError:
    return DomainError(
        status_code=409,
        error_code="ISSUE_NOT_EDITABLE",
        message="Only a reported issue can be changed or withdrawn by its reporter.",
        extra={"status": status.value},
    )


def _ended(status: IssueStatus) -> DomainError:
    return DomainError(
        status_code=409,
        error_code="ISSUE_ENDED",
        message="The issue has ended.",
        extra={"status": status.value},
    )


def _invalid_transition(status: IssueStatus) -> DomainError:
    return DomainError(
        status_code=409,
        error_code="INVALID_ISSUE_TRANSITION",
        message="The issue cannot move to that status now.",
        extra={"status": status.value},
    )


def _invalid_duplicate() -> DomainError:
    return DomainError(
        status_code=422,
        error_code="INVALID_DUPLICATE",
        message="The original must be another open or recently ended issue of the building.",
    )


def _validation_error(field: str, message: str) -> DomainError:
    """The 422 VALIDATION_ERROR shape of the request validator, for a rule checked later."""
    return DomainError(
        status_code=422,
        error_code="VALIDATION_ERROR",
        message="The request is invalid.",
        extra={"errors": [{"loc": ["body", field], "message": message, "type": "value_error"}]},
    )


def _photo_not_found() -> DomainError:
    return DomainError(status_code=404, error_code="PHOTO_NOT_FOUND", message="Photo not found.")


def _photo_limit() -> DomainError:
    return DomainError(
        status_code=409,
        error_code="PHOTO_LIMIT_REACHED",
        message=f"An issue has at most {MAX_PHOTOS_PER_ISSUE} photos.",
        extra={"max_photos": MAX_PHOTOS_PER_ISSUE},
    )


PHOTO = FilePurpose.ISSUE_PHOTO


def _rate_limited(wait: int) -> DomainError:
    return DomainError(
        status_code=429,
        error_code="RATE_LIMITED",
        message="Your apartment has reached the limit of reports; try again later.",
        extra={"retry_after_seconds": wait},
        headers={"Retry-After": str(wait)},
    )


class IssuesService:
    def __init__(
        self,
        session: AsyncSession,
        property_service: PropertyService,
        outbox: EventOutbox | None = None,
        files: FileStore | None = None,
    ):
        self.session = session
        self.property_service = property_service
        self.settings = BuildingSettings(session)
        # The photos (epic E11 F2). None only for system-level readers, which never show photos.
        self.files = files
        # Events go out only after the request's transaction commits. None only for
        # system-level readers (the notifications module), which never write.
        self.outbox = outbox

    # --- System-level reads (no request caller; used by the notifications module) ---------------

    async def get_issue_ref(self, issue_id: uuid.UUID) -> IssueRefDTO | None:
        """The issue's state now, for the texts and the send-time checks. None if unknown."""
        issue = await self.session.get(Issue, issue_id, populate_existing=True)
        if issue is None:
            return None
        return IssueRefDTO(
            issue_id=issue.id,
            building_id=issue.building_id,
            status=issue.status,
            is_open=is_open(issue.status),
            urgent=issue.urgent,
            category=issue.category,
            entrance=issue.entrance,
        )

    async def follower_ids(self, issue_id: uuid.UUID) -> list[uuid.UUID]:
        """Who follows the issue (the reporter and "+1"), in a stable order; never returned by
        the API."""
        rows = await self.session.scalars(
            select(IssueFollower.user_id)
            .where(IssueFollower.issue_id == issue_id)
            .order_by(IssueFollower.user_id)
        )
        return list(rows)

    async def can_see(self, user: CurrentUserDTO, issue_id: uuid.UUID) -> bool:
        """Whether this user sees the issue under the rules of GET /issues/{id}."""
        try:
            await self._visible_issue(user, issue_id)
        except DomainError:
            return False
        return True

    def _publish(self, event: IssueReported | IssueStatusChanged | IssueMerged) -> None:
        if self.outbox is None:
            raise RuntimeError("writing issues needs the request outbox")
        self.outbox.add(event)

    # --- Reporting ------------------------------------------------------------------------------

    async def form(self, user: CurrentUserDTO) -> IssueForm:
        self._require_access(user)
        return IssueForm(
            urgent_enabled=await self.settings.get(user.building_id, URGENT_ENABLED),
            apartment_ids=[membership.apartment_id for membership in user.memberships],
            entrances=await self._entrances(user.building_id),
        )

    async def report(self, user: CurrentUserDTO, request: IssueReport) -> IssueView:
        self._require_access(user)
        board = is_board(user.building_role)
        apartment_id = self._reporting_apartment(
            user,
            request.apartment_id,
            board=board,
            apartment_id_given="apartment_id" in request.model_fields_set,
        )
        await self._check_entrance(user.building_id, request.entrance)
        if request.urgent and not await self.settings.get(user.building_id, URGENT_ENABLED):
            raise _validation_error("urgent", "the chairman has not enabled urgent reports")
        if apartment_id is not None:
            await self._check_limits(
                user.building_id, apartment_id, urgent=request.urgent, limited=not board
            )

        now = _now()
        issue = Issue(
            building_id=user.building_id,
            reporter_user_id=user.id,
            reporter_apartment_id=apartment_id,
            category=request.category,
            entrance=request.entrance,
            place=request.place,
            title=request.title,
            description=request.description or "",
            urgent=request.urgent,
            reported_urgent=request.urgent,
            status=IssueStatus.REPORTED,
            created_at=now,
            updated_at=now,
        )
        self.session.add(issue)
        await self.session.flush()
        self.session.add_all(
            [
                IssueFollower(issue_id=issue.id, user_id=user.id, created_at=now),
                IssueStatusChange(
                    issue_id=issue.id,
                    from_status=None,
                    to_status=IssueStatus.REPORTED,
                    changed_by_user_id=user.id,
                    changed_at=now,
                ),
            ]
        )
        await self.session.flush()
        self._publish(
            IssueReported(
                issue_id=issue.id,
                building_id=issue.building_id,
                reporter_user_id=user.id,
                urgent=issue.urgent,
            )
        )
        return await self._view(user, issue)

    async def edit(
        self, user: CurrentUserDTO, issue_id: uuid.UUID, request: IssueEdit
    ) -> IssueView:
        issue = await self._own_reported_issue(user, issue_id)
        given = request.model_fields_set
        for field in ("category", "place", "title"):
            if field in given and getattr(request, field) is None:
                raise _validation_error(field, "this field cannot be empty")
        if not given:
            return await self._view(user, issue)
        if "entrance" in given:
            await self._check_entrance(user.building_id, request.entrance)
            issue.entrance = request.entrance
        if request.category is not None:
            issue.category = request.category
        if request.place is not None:
            issue.place = request.place
        if request.title is not None:
            issue.title = request.title
        if "description" in given:
            issue.description = request.description or ""
        issue.updated_at = _now()
        await self.session.flush()
        return await self._view(user, issue)

    async def withdraw(self, user: CurrentUserDTO, issue_id: uuid.UUID) -> IssueView:
        issue = await self._own_reported_issue(user, issue_id)
        now = _now()
        self.session.add(
            IssueStatusChange(
                issue_id=issue.id,
                from_status=issue.status,
                to_status=IssueStatus.WITHDRAWN,
                changed_by_user_id=user.id,
                changed_at=now,
            )
        )
        issue.status, issue.ended_at, issue.updated_at = IssueStatus.WITHDRAWN, now, now
        await self.session.flush()
        await self._sync_photo_retention(issue)
        return await self._view(user, issue)

    # --- Following ------------------------------------------------------------------------------

    async def follow(self, user: CurrentUserDTO, issue_id: uuid.UUID) -> IssueView:
        """ "+1 / I see it too"; the issue row is share-locked, so it cannot end meanwhile."""
        issue = await self._visible_issue(user, issue_id, lock="share")
        if not is_open(issue.status):
            raise _ended(issue.status)
        await self.session.execute(
            insert(IssueFollower)
            .values(issue_id=issue.id, user_id=user.id, created_at=_now())
            .on_conflict_do_nothing(index_elements=["issue_id", "user_id"])
        )
        return await self._view(user, issue)

    async def unfollow(self, user: CurrentUserDTO, issue_id: uuid.UUID) -> IssueView:
        issue = await self._visible_issue(user, issue_id)
        await self.session.execute(
            delete(IssueFollower).where(
                IssueFollower.issue_id == issue.id, IssueFollower.user_id == user.id
            )
        )
        return await self._view(user, issue)

    # --- The board's work -----------------------------------------------------------------------

    async def change_status(
        self, user: CurrentUserDTO, issue_id: uuid.UUID, request: StatusChange
    ) -> IssueView:
        """Move an issue on (the board). A duplicate's followers join the original.

        The issue and the original are locked in id order, so two board members merging in
        opposite directions wait for each other instead of making a cycle or a deadlock.
        """
        await self._visible_issue(user, issue_id)
        self._require_board(user)
        locked = await self._lock(user, {issue_id, *filter(None, [request.duplicate_of])})
        issue = locked[issue_id]
        now = _now()
        # The transition first: a repeated or refused change never depends on the original.
        verdict = board_transition(
            issue.status,
            request.status,
            ended_at=issue.ended_at,
            same_original=issue.duplicate_of_id is not None
            and issue.duplicate_of_id == request.duplicate_of,
            now=now,
        )
        if verdict == Transition.REFUSED:
            raise _invalid_transition(issue.status)
        if verdict == Transition.UNCHANGED:
            return await self._view(user, issue)
        original = None
        if request.status == BoardStatus.DUPLICATE:
            original = locked.get(request.duplicate_of)  # type: ignore[arg-type]
            if original is None or not can_be_original(
                original.status,
                ended_at=original.ended_at,
                is_same_issue=original.id == issue.id,
                now=now,
            ):
                raise _invalid_duplicate()
            if original.status == IssueStatus.REPORTED:
                # Others now follow it: its reporter may no longer rewrite or withdraw it.
                started = IssueStatusChange(
                    id=uuid.uuid4(),
                    issue_id=original.id,
                    from_status=IssueStatus.REPORTED,
                    to_status=IssueStatus.IN_PROGRESS,
                    changed_by_user_id=user.id,
                    changed_at=now,
                )
                self.session.add(started)
                original.status, original.updated_at = IssueStatus.IN_PROGRESS, now
                self._publish(
                    IssueStatusChanged(
                        issue_id=original.id,
                        building_id=original.building_id,
                        change_id=started.id,
                        changed_by_user_id=user.id,
                        status=IssueStatus.IN_PROGRESS.value,
                    )
                )

        target = IssueStatus(request.status.value)
        change = IssueStatusChange(
            id=uuid.uuid4(),
            issue_id=issue.id,
            from_status=issue.status,
            to_status=target,
            changed_by_user_id=user.id,
            changed_at=now,
        )
        self.session.add(change)
        issue.status, issue.updated_at = target, now
        issue.ended_at = None if is_open(target) else now
        issue.duplicate_of_id = original.id if original is not None else None
        if original is not None:
            moved = select(
                literal(original.id, UUID(as_uuid=True)),
                IssueFollower.user_id,
                literal(now, DateTime(timezone=True)),
            ).where(IssueFollower.issue_id == issue.id)
            await self.session.execute(
                insert(IssueFollower)
                .from_select(["issue_id", "user_id", "created_at"], moved)
                .on_conflict_do_nothing(index_elements=["issue_id", "user_id"])
            )
        await self.session.flush()
        await self._sync_photo_retention(issue)
        if original is not None:
            self._publish(
                IssueMerged(
                    issue_id=issue.id,
                    original_id=original.id,
                    building_id=issue.building_id,
                    change_id=change.id,
                    changed_by_user_id=user.id,
                )
            )
        else:
            self._publish(
                IssueStatusChanged(
                    issue_id=issue.id,
                    building_id=issue.building_id,
                    change_id=change.id,
                    changed_by_user_id=user.id,
                    status=target.value,
                )
            )
        return await self._view(user, issue)

    async def clear_urgent(self, user: CurrentUserDTO, issue_id: uuid.UUID) -> IssueView:
        """The board clears a false urgent flag; logged in the action log."""
        await self._visible_issue(user, issue_id)
        self._require_board(user)
        issue = (await self._lock(user, {issue_id}))[issue_id]
        if not is_open(issue.status):
            raise _ended(issue.status)
        if issue.urgent:
            now = _now()
            self.session.add(
                IssueStatusChange(
                    issue_id=issue.id,
                    from_status=issue.status,
                    to_status=issue.status,
                    action=IssueAction.URGENT_CLEARED,
                    changed_by_user_id=user.id,
                    changed_at=now,
                )
            )
            issue.urgent, issue.updated_at = False, now
            await self.session.flush()
        return await self._view(user, issue)

    # --- Photos (task I4, epic E11 F2) -----------------------------------------------------------

    async def add_photo(
        self,
        user: CurrentUserDTO,
        issue_id: uuid.UUID,
        request: Request,
        idempotency_key: str | None,
    ) -> tuple[IssuePhoto, bool]:
        """Store one photo; returns it and whether it is new (False: a repeat of the same key).

        The rules first, then the storage's admission, then the size; the request's transaction
        is committed before the body is read, so a slow upload holds no database connection. The
        issue is locked and checked again before the photo is stored.
        """
        files = self._require_files()
        # A repeat answers like the first upload did, even if the issue ended meanwhile.
        issue = await self._visible_issue(user, issue_id)
        if idempotency_key is not None:
            repeat = await files.find_repeat(user.id, idempotency_key, PHOTO, issue.id)
            if repeat is not None:
                return self._photo_view(user, issue, repeat), False
        issue = await self._photo_target(user, issue_id)
        if await files.count(PHOTO, issue.id) >= MAX_PHOTOS_PER_ISSUE:
            raise _photo_limit()
        await files.admit(user.building_id, user.id, PHOTO, PHOTO_MAX_BYTES)
        require_content_type(request, "image/jpeg")
        length = declared_length(request, PHOTO_MAX_BYTES)
        await self.session.commit()
        with files.reservations.hold(user.building_id, length):
            with files.gate.receiving():
                data = await read_body(request, length, PHOTO_MAX_BYTES)
            photo = await files.gate.reencode(data)
            issue = await self._photo_target(user, issue_id, lock=True)
            if idempotency_key is not None:  # a parallel request with the same key was first
                repeat = await files.find_repeat(user.id, idempotency_key, PHOTO, issue.id)
                if repeat is not None:
                    return self._photo_view(user, issue, repeat), False
            if await files.count(PHOTO, issue.id) >= MAX_PHOTOS_PER_ISSUE:
                raise _photo_limit()
            stored, new = await files.store_photo(
                building_id=user.building_id,
                purpose=PHOTO,
                owner_ref=issue.id,
                created_by=user.id,
                photo=photo,
                idempotency_key=idempotency_key,
            )
        return self._photo_view(user, issue, stored), new

    async def photo_bytes(
        self,
        user: CurrentUserDTO,
        issue_id: uuid.UUID,
        photo_id: uuid.UUID,
        variant: PhotoVariant,
    ) -> tuple[bytes, str]:
        """The image of a photo for everyone who sees the issue."""
        files = self._require_files()
        issue = await self._visible_issue(user, issue_id)
        stored = await files.get(photo_id, PHOTO, issue.id)
        data = await files.read(stored, variant) if stored is not None else None
        if stored is None or data is None:
            raise _photo_not_found()
        return data, stored.content_type

    async def delete_photo(
        self, user: CurrentUserDTO, issue_id: uuid.UUID, photo_id: uuid.UUID
    ) -> None:
        files = self._require_files()
        issue = await self._visible_issue(user, issue_id, lock="update")
        stored = await files.get(photo_id, PHOTO, issue.id, caller_id=user.id)
        if stored is None:
            raise _photo_not_found()
        if not may_delete_photo(
            uploaded_by_caller=stored.uploaded_by_caller,
            board=is_board(user.building_role),
            status=issue.status,
        ):
            raise _forbidden("Only the uploader, while the issue is open, or the board may delete.")
        await files.delete(photo_id, PHOTO, issue.id)

    def _require_files(self) -> FileStore:
        if self.files is None:
            raise RuntimeError("photos need the file store")
        return self.files

    async def _photo_target(
        self, user: CurrentUserDTO, issue_id: uuid.UUID, *, lock: bool = False
    ) -> Issue:
        """The issue a photo is added to: visible, the caller is its reporter or the board, open."""
        issue = await self._visible_issue(user, issue_id, lock="update" if lock else None)
        if issue.reporter_user_id != user.id and not is_board(user.building_role):
            raise _forbidden("Only the reporter and the board add photos.")
        if not is_open(issue.status):
            raise _ended(issue.status)
        return issue

    @staticmethod
    def _photo_view(user: CurrentUserDTO, issue: Issue, stored: FileDTO) -> IssuePhoto:
        return IssuePhoto(
            id=stored.id,
            width=stored.width,
            height=stored.height,
            created_at=stored.created_at,
            mine=stored.uploaded_by_caller,
            can_delete=may_delete_photo(
                uploaded_by_caller=stored.uploaded_by_caller,
                board=is_board(user.building_role),
                status=issue.status,
            ),
        )

    async def _sync_photo_retention(self, issue: Issue) -> None:
        """Photos of an ended issue are kept for the building's setting; reopened: kept again."""
        if self.files is None:
            raise RuntimeError("changing the status of an issue needs the file store")
        months = await self.settings.get(issue.building_id, PHOTO_RETENTION_MONTHS)
        await self.files.set_delete_after(
            PHOTO, issue.id, photo_retention_end(issue.ended_at, months)
        )

    # --- Reading --------------------------------------------------------------------------------

    async def list_issues(
        self,
        user: CurrentUserDTO,
        *,
        status: StatusFilter | None,
        category: IssueCategory | None,
        entrance: int | None,
        include_old: bool,
        limit: int,
        offset: int,
    ) -> list[IssueSummary]:
        """Open issues first (newest first), then ended ones (newest end first)."""
        self._require_access(user)
        statement = select(Issue).where(self._visible_to(user, include_old=include_old))
        if (statuses := statuses_for(status)) is not None:
            statement = statement.where(Issue.status.in_(sorted(statuses)))
        if category is not None:
            statement = statement.where(Issue.category == category)
        if entrance is not None:
            statement = statement.where(
                Issue.entrance.is_(None) if entrance == 0 else Issue.entrance == entrance
            )
        open_first = case((Issue.status.in_(sorted(OPEN_STATUSES)), 0), else_=1)
        statement = statement.order_by(
            open_first,
            func.coalesce(Issue.ended_at, Issue.created_at).desc(),
            Issue.id,
        )
        issues = list(await self.session.scalars(statement.limit(limit).offset(offset)))
        return await self._summaries(user, issues)

    async def get_issue(self, user: CurrentUserDTO, issue_id: uuid.UUID) -> IssueView:
        return await self._view(user, await self._visible_issue(user, issue_id))

    # --- Internals: access ----------------------------------------------------------------------

    @staticmethod
    def _require_access(user: CurrentUserDTO) -> None:
        """Residents of the building (an active membership), the chairman and the board."""
        if not user.memberships and not is_board(user.building_role):
            raise _forbidden()

    def _visible_to(self, user: CurrentUserDTO, *, include_old: bool) -> ColumnElement[bool]:
        """SQL twin of policies.visible for the caller's building."""
        board = is_board(user.building_role)
        in_building = Issue.building_id == user.building_id
        if board and include_old:
            return in_building
        recently_ended = and_(
            Issue.status.in_(sorted(ENDED_STATUSES - {IssueStatus.WITHDRAWN})),
            Issue.ended_at > _now() - RECENTLY_ENDED,
        )
        withdrawn = and_(
            Issue.status == IssueStatus.WITHDRAWN,
            Issue.ended_at > _now() - RECENTLY_ENDED,
            true() if board else Issue.reporter_user_id == user.id,
        )
        return and_(
            in_building, or_(Issue.status.in_(sorted(OPEN_STATUSES)), recently_ended, withdrawn)
        )

    async def _visible_issue(
        self, user: CurrentUserDTO, issue_id: uuid.UUID, *, lock: str | None = None
    ) -> Issue:
        self._require_access(user)
        statement = select(Issue).where(Issue.id == issue_id, Issue.building_id == user.building_id)
        if lock == "update":
            statement = statement.with_for_update()
        elif lock == "share":
            statement = statement.with_for_update(read=True)
        issue = await self.session.scalar(statement.execution_options(populate_existing=True))
        if issue is None or not visible(
            status=issue.status,
            ended_at=issue.ended_at,
            is_reporter=issue.reporter_user_id == user.id,
            board=is_board(user.building_role),
            include_old=True,  # a direct link works at any age (for the board; own withdrawn)
            now=_now(),
        ):
            raise _not_found()
        return issue

    @staticmethod
    def _require_board(user: CurrentUserDTO) -> None:
        if not is_board(user.building_role):
            raise _forbidden("Only the board changes the status of an issue.")

    async def _lock(self, user: CurrentUserDTO, ids: set[uuid.UUID]) -> dict[uuid.UUID, Issue]:
        """Lock these issues of the caller's building in id order; unknown ids are left out."""
        rows = await self.session.scalars(
            select(Issue)
            .where(Issue.id.in_(sorted(ids)), Issue.building_id == user.building_id)
            .order_by(Issue.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        return {issue.id: issue for issue in rows}

    async def _own_reported_issue(self, user: CurrentUserDTO, issue_id: uuid.UUID) -> Issue:
        issue = await self._visible_issue(user, issue_id, lock="update")
        if issue.reporter_user_id != user.id:
            raise _forbidden("Only the reporter may change or withdraw an issue.")
        if issue.status != IssueStatus.REPORTED:
            raise _not_editable(issue.status)
        return issue

    # --- Internals: reporting -------------------------------------------------------------------

    @staticmethod
    def _reporting_apartment(
        user: CurrentUserDTO,
        apartment_id: uuid.UUID | None,
        *,
        board: bool,
        apartment_id_given: bool,
    ) -> uuid.UUID | None:
        """The apartment a report comes from. An explicit null is "no apartment", for the board
        only; residents who leave the field out report from their one apartment."""
        mine = [membership.apartment_id for membership in user.memberships]
        if board and apartment_id_given and apartment_id is None:
            return None
        if apartment_id is not None:
            if apartment_id not in mine:
                raise DomainError(
                    status_code=422,
                    error_code="INVALID_AUTHOR_APARTMENT",
                    message="You can report only from your own apartment.",
                )
            return apartment_id
        if len(mine) == 1:
            return mine[0]
        if len(mine) > 1:
            raise _validation_error("apartment_id", "choose the apartment you report from")
        if board:
            return None
        raise _forbidden()  # pragma: no cover - _require_access already refused

    async def _entrances(self, building_id: uuid.UUID) -> list[int]:
        apartments = await self.property_service.list_apartments(building_id)
        return sorted({apartment.entrance for apartment in apartments})

    async def _check_entrance(self, building_id: uuid.UUID, entrance: int | None) -> None:
        if entrance is not None and entrance not in await self._entrances(building_id):
            raise DomainError(
                status_code=422,
                error_code="INVALID_LOCATION",
                message=f"The building has no entrance {entrance}.",
            )

    async def _check_limits(
        self, building_id: uuid.UUID, apartment_id: uuid.UUID, *, urgent: bool, limited: bool
    ) -> None:
        """The chairman's per-apartment limits over the last 24 hours. Concurrent reports of one
        apartment wait for each other on an advisory lock until this transaction ends."""
        await self.session.execute(
            select(func.pg_advisory_xact_lock(func.hashtextextended(f"issues:{apartment_id}", 0)))
        )
        if not limited:
            return  # the board is never limited; holding the lock keeps others' counts right
        now = _now()
        rows = (
            await self.session.execute(
                select(Issue.created_at, Issue.reported_urgent).where(
                    Issue.reporter_apartment_id == apartment_id,
                    Issue.created_at > now - LIMIT_WINDOW,
                )
            )
        ).all()
        limit = await self.settings.get(building_id, REPORTS_PER_APARTMENT_PER_DAY)
        if (wait := retry_after_seconds([at for at, _ in rows], limit, now)) is not None:
            raise _rate_limited(wait)
        if urgent:
            urgent_limit = await self.settings.get(building_id, URGENT_PER_APARTMENT_PER_DAY)
            window = [at for at, was_urgent in rows if was_urgent]
            if (wait := retry_after_seconds(window, urgent_limit, now)) is not None:
                raise _rate_limited(wait)

    # --- Internals: views -----------------------------------------------------------------------

    async def _summaries(self, user: CurrentUserDTO, issues: Sequence[Issue]) -> list[IssueSummary]:
        if not issues:
            return []
        ids = [issue.id for issue in issues]
        counts = dict(
            (
                await self.session.execute(
                    select(IssueFollower.issue_id, func.count())
                    .where(IssueFollower.issue_id.in_(ids))
                    .group_by(IssueFollower.issue_id)
                )
            ).all()
        )
        mine = set(
            await self.session.scalars(
                select(IssueFollower.issue_id).where(
                    IssueFollower.issue_id.in_(ids), IssueFollower.user_id == user.id
                )
            )
        )
        board = is_board(user.building_role)
        badges = (
            await self.property_service.get_masked_author_badges(
                {(issue.reporter_user_id, issue.reporter_apartment_id) for issue in issues}
            )
            if board
            else {}
        )
        return [
            IssueSummary(
                id=issue.id,
                category=issue.category,
                entrance=issue.entrance,
                place=issue.place,
                title=issue.title,
                status=issue.status,
                urgent=issue.urgent,
                duplicate_of=issue.duplicate_of_id,
                followers=counts.get(issue.id, 0),
                i_reported=issue.reporter_user_id == user.id,
                i_follow=issue.id in mine,
                can_edit=issue.reporter_user_id == user.id and issue.status == IssueStatus.REPORTED,
                can_follow=is_open(issue.status) and issue.id not in mine,
                created_at=issue.created_at,
                updated_at=issue.updated_at,
                ended_at=issue.ended_at,
                reporter=(
                    ReporterView(
                        badge=badges[(issue.reporter_user_id, issue.reporter_apartment_id)],
                        apartment_id=issue.reporter_apartment_id,
                    )
                    if board
                    else None
                ),
            )
            for issue in issues
        ]

    async def _view(self, user: CurrentUserDTO, issue: Issue) -> IssueView:
        [summary] = await self._summaries(user, [issue])
        stored = (
            await self.files.list_files(PHOTO, issue.id, caller_id=user.id)
            if self.files is not None
            else []
        )
        return IssueView(
            **summary.model_dump(),
            description=issue.description,
            timeline=await self._timeline(user, issue),
            photos=[self._photo_view(user, issue, photo) for photo in stored],
            can_add_photo=self.files is not None
            and self.files.uploads_enabled
            and may_add_photo(
                is_reporter=issue.reporter_user_id == user.id,
                board=is_board(user.building_role),
                status=issue.status,
                photos=len(stored),
            ),
        )

    async def _timeline(self, user: CurrentUserDTO, issue: Issue) -> list[TimelineEntry]:
        """Residents: the statuses with dates. The board: the action log with who acted (the
        privacy badge without an apartment context, never a raw name)."""
        rows = list(
            await self.session.scalars(
                select(IssueStatusChange)
                .where(IssueStatusChange.issue_id == issue.id)
                .order_by(IssueStatusChange.changed_at, IssueStatusChange.id)
            )
        )
        if not is_board(user.building_role):
            return [
                TimelineEntry(status=row.to_status, at=row.changed_at)
                for row in rows
                if row.action == IssueAction.STATUS
            ]
        badges = await self.property_service.get_masked_author_badges(
            {(row.changed_by_user_id, None) for row in rows}
        )
        return [
            TimelineEntry(
                status=row.to_status,
                at=row.changed_at,
                action=row.action,
                changed_by=badges[(row.changed_by_user_id, None)],
            )
            for row in rows
        ]


def get_issues_service(
    request: Request,
    session: DbSession,
    property_service: PropertyService = Depends(get_property_service),
    outbox: EventOutbox = Depends(get_event_outbox),
) -> IssuesService:
    return IssuesService(
        session, property_service, outbox, get_file_store_factory(request)(session)
    )
