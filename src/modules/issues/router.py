"""Thin HTTP layer of the issue tracker (docs/API.md section 10)."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query

from src.core.exceptions import AUTH_ERRORS, error_responses
from src.core.security import get_current_user
from src.modules.issues.schemas import (
    ISSUES_PAGE_MAX,
    IssueCategory,
    IssueEdit,
    IssueForm,
    IssueReport,
    IssueSummary,
    IssueView,
    StatusFilter,
)
from src.modules.issues.service import IssuesService, get_issues_service
from src.modules.property.schemas import CurrentUserDTO

router = APIRouter(
    prefix="/api/v1/issues",
    tags=["issues"],
    responses=error_responses(
        {401: AUTH_ERRORS, 403: ["FORBIDDEN"], 500: ["INTERNAL_SERVER_ERROR"]}
    ),
)

Service = Annotated[IssuesService, Depends(get_issues_service)]
Caller = Annotated[CurrentUserDTO, Depends(get_current_user)]

_ONE_ISSUE = {404: ["ISSUE_NOT_FOUND"], 422: ["VALIDATION_ERROR"]}


@router.get("/form", response_model=IssueForm)
async def report_form(user: Caller, service: Service) -> IssueForm:
    """What the report form needs: the urgent switch, the caller's apartments, the entrances."""
    return await service.form(user)


@router.post(
    "",
    response_model=IssueView,
    status_code=201,
    responses=error_responses(
        {
            422: ["VALIDATION_ERROR", "INVALID_AUTHOR_APARTMENT", "INVALID_LOCATION"],
            429: ["RATE_LIMITED"],
        }
    ),
)
async def report_issue(body: IssueReport, user: Caller, service: Service) -> IssueView:
    """Report a problem in a common area from one of the caller's apartments."""
    return await service.report(user, body)


@router.get(
    "",
    response_model=list[IssueSummary],
    responses=error_responses({422: ["VALIDATION_ERROR"]}),
)
async def list_issues(
    user: Caller,
    service: Service,
    status: StatusFilter | None = None,
    category: IssueCategory | None = None,
    entrance: Annotated[int | None, Query(ge=0, le=1000)] = None,
    include_old: bool = False,
    limit: Annotated[int, Query(ge=1, le=ISSUES_PAGE_MAX)] = 50,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
) -> list[IssueSummary]:
    """The issues the caller sees: open ones first, then recently ended ones."""
    return await service.list_issues(
        user,
        status=status,
        category=category,
        entrance=entrance,
        include_old=include_old,
        limit=limit,
        offset=offset,
    )


@router.get("/{issue_id}", response_model=IssueView, responses=error_responses(_ONE_ISSUE))
async def get_issue(issue_id: uuid.UUID, user: Caller, service: Service) -> IssueView:
    """One issue with its timeline."""
    return await service.get_issue(user, issue_id)


@router.patch(
    "/{issue_id}",
    response_model=IssueView,
    responses=error_responses(
        {
            404: ["ISSUE_NOT_FOUND"],
            409: ["ISSUE_NOT_EDITABLE"],
            422: ["VALIDATION_ERROR", "INVALID_LOCATION"],
        }
    ),
)
async def edit_issue(
    issue_id: uuid.UUID, body: IssueEdit, user: Caller, service: Service
) -> IssueView:
    """The reporter fixes the text while the issue is still reported."""
    return await service.edit(user, issue_id, body)


@router.post(
    "/{issue_id}/withdraw",
    response_model=IssueView,
    responses=error_responses({**_ONE_ISSUE, 409: ["ISSUE_NOT_EDITABLE"]}),
)
async def withdraw_issue(issue_id: uuid.UUID, user: Caller, service: Service) -> IssueView:
    """The reporter takes the issue back while it is still reported."""
    return await service.withdraw(user, issue_id)


@router.put(
    "/{issue_id}/follow",
    response_model=IssueView,
    responses=error_responses({**_ONE_ISSUE, 409: ["ISSUE_ENDED"]}),
)
async def follow_issue(issue_id: uuid.UUID, user: Caller, service: Service) -> IssueView:
    """ "+1 / I see it too" (idempotent)."""
    return await service.follow(user, issue_id)


@router.delete(
    "/{issue_id}/follow", response_model=IssueView, responses=error_responses(_ONE_ISSUE)
)
async def unfollow_issue(issue_id: uuid.UUID, user: Caller, service: Service) -> IssueView:
    """Stop following (idempotent)."""
    return await service.unfollow(user, issue_id)
