"""The issue tracker: reporting, the list, "+1" and who sees what (docs/API.md section 10).

Apartments, memberships and badges come only from PropertyService, settings from
BuildingSettings. The rules are pure functions in policies.py.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime

from fastapi import Depends
from sqlalchemy import ColumnElement, and_, case, delete, func, or_, select, true
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.building_settings import BuildingSettings
from src.core.database import DbSession
from src.core.exceptions import DomainError
from src.modules.issues.models import Issue, IssueFollower, IssueStatusChange
from src.modules.issues.policies import (
    ENDED_STATUSES,
    LIMIT_WINDOW,
    OPEN_STATUSES,
    RECENTLY_ENDED,
    is_board,
    is_open,
    retry_after_seconds,
    statuses_for,
    visible,
)
from src.modules.issues.schemas import (
    IssueCategory,
    IssueEdit,
    IssueForm,
    IssueReport,
    IssueStatus,
    IssueSummary,
    IssueView,
    ReporterView,
    StatusFilter,
    TimelineEntry,
)
from src.modules.issues.settings import (
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


def _validation_error(field: str, message: str) -> DomainError:
    """The 422 VALIDATION_ERROR shape of the request validator, for a rule checked later."""
    return DomainError(
        status_code=422,
        error_code="VALIDATION_ERROR",
        message="The request is invalid.",
        extra={"errors": [{"loc": ["body", field], "message": message, "type": "value_error"}]},
    )


def _rate_limited(wait: int) -> DomainError:
    return DomainError(
        status_code=429,
        error_code="RATE_LIMITED",
        message="Your apartment has reached the limit of reports; try again later.",
        extra={"retry_after_seconds": wait},
        headers={"Retry-After": str(wait)},
    )


class IssuesService:
    def __init__(self, session: AsyncSession, property_service: PropertyService):
        self.session = session
        self.property_service = property_service
        self.settings = BuildingSettings(session)

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
            without_apartment="apartment_id" in request.model_fields_set,
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
        without_apartment: bool,
    ) -> uuid.UUID | None:
        """The apartment a report comes from. An explicit null is "no apartment", for the board
        only; residents who leave the field out report from their one apartment."""
        mine = [membership.apartment_id for membership in user.memberships]
        if board and without_apartment and apartment_id is None:
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
        now = _now()
        rows = (
            await self.session.execute(
                select(Issue.created_at, Issue.urgent).where(
                    Issue.reporter_apartment_id == apartment_id,
                    Issue.created_at > now - LIMIT_WINDOW,
                )
            )
        ).all()
        if not limited:
            return  # the board is never limited; holding the lock keeps others' counts right
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
        timeline = await self.session.scalars(
            select(IssueStatusChange)
            .where(IssueStatusChange.issue_id == issue.id)
            .order_by(IssueStatusChange.changed_at, IssueStatusChange.id)
        )
        return IssueView(
            **summary.model_dump(),
            description=issue.description,
            timeline=[TimelineEntry(status=row.to_status, at=row.changed_at) for row in timeline],
        )


def get_issues_service(
    session: DbSession, property_service: PropertyService = Depends(get_property_service)
) -> IssuesService:
    return IssuesService(session, property_service)
