"""Thin HTTP layer of the issue tracker (docs/API.md section 10)."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, Response

from src.core.exceptions import AUTH_ERRORS, error_responses
from src.core.files import PhotoVariant, file_response
from src.core.security import get_current_user
from src.modules.issues.schemas import (
    ISSUES_PAGE_MAX,
    IssueCategory,
    IssueEdit,
    IssueForm,
    IssuePhoto,
    IssueReport,
    IssueSummary,
    IssueView,
    PhotoVariantName,
    StatusChange,
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


@router.post(
    "/{issue_id}/status",
    response_model=IssueView,
    responses=error_responses(
        {
            404: ["ISSUE_NOT_FOUND"],
            409: ["INVALID_ISSUE_TRANSITION"],
            422: ["VALIDATION_ERROR", "INVALID_DUPLICATE"],
        }
    ),
)
async def change_issue_status(
    issue_id: uuid.UUID, body: StatusChange, user: Caller, service: Service
) -> IssueView:
    """The board moves an issue on, marks a duplicate, declines or reopens it."""
    return await service.change_status(user, issue_id, body)


@router.post(
    "/{issue_id}/urgent/clear",
    response_model=IssueView,
    responses=error_responses({**_ONE_ISSUE, 409: ["ISSUE_ENDED"]}),
)
async def clear_urgent_flag(issue_id: uuid.UUID, user: Caller, service: Service) -> IssueView:
    """The board clears a false urgent flag."""
    return await service.clear_urgent(user, issue_id)


# --- Photos (task I4, epic E11 F2; docs/API.md sections 10 and 12) -------------------------------

_PHOTO_BODY = {
    "requestBody": {
        "required": True,
        "description": "The photo itself: JPEG of at most 2560 px, at most 4,000,000 bytes.",
        "content": {"image/jpeg": {"schema": {"type": "string", "format": "binary"}}},
    }
}
IdempotencyKey = Annotated[
    str | None,
    Header(alias="Idempotency-Key", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
]


@router.post(
    "/{issue_id}/photos",
    response_model=IssuePhoto,
    status_code=201,
    openapi_extra=_PHOTO_BODY,
    responses={
        200: {"model": IssuePhoto, "description": "A repeat with the same Idempotency-Key"},
        **error_responses(
            {
                400: ["UPLOAD_INTERRUPTED"],
                403: ["FORBIDDEN", "UPLOADS_DISABLED"],
                404: ["ISSUE_NOT_FOUND"],
                409: ["ISSUE_ENDED", "PHOTO_LIMIT_REACHED", "IDEMPOTENCY_KEY_REUSED"],
                408: ["UPLOAD_TIMEOUT"],
                411: ["LENGTH_REQUIRED"],
                413: ["FILE_TOO_LARGE"],
                415: ["UNSUPPORTED_MEDIA_TYPE"],
                422: ["VALIDATION_ERROR", "INVALID_IMAGE", "IMAGE_TOO_LARGE"],
                429: ["RATE_LIMITED"],
                507: ["STORAGE_QUOTA_EXCEEDED", "STORAGE_LOW_DISK"],
            }
        ),
    },
)
async def add_issue_photo(
    issue_id: uuid.UUID,
    request: Request,
    response: Response,
    user: Caller,
    service: Service,
    idempotency_key: IdempotencyKey = None,
) -> IssuePhoto:
    """Add a photo (the reporter or the board, while the issue is open; at most 3)."""
    photo, new = await service.add_photo(user, issue_id, request, idempotency_key)
    if not new:
        response.status_code = 200
    return photo


@router.get(
    "/{issue_id}/photos/{photo_id}",
    response_class=Response,
    responses={
        200: {"content": {"image/webp": {"schema": {"type": "string", "format": "binary"}}}},
        **error_responses({404: ["ISSUE_NOT_FOUND", "PHOTO_NOT_FOUND"], 422: ["VALIDATION_ERROR"]}),
    },
)
async def get_issue_photo(
    issue_id: uuid.UUID,
    photo_id: uuid.UUID,
    user: Caller,
    service: Service,
    variant: PhotoVariantName = PhotoVariantName.DISPLAY,
) -> Response:
    """The image of a photo: `display` (at most 1920 px) or `thumb` (at most 320 px)."""
    data, content_type = await service.photo_bytes(
        user, issue_id, photo_id, PhotoVariant(variant.value)
    )
    return file_response(data, content_type)


@router.delete(
    "/{issue_id}/photos/{photo_id}",
    status_code=204,
    response_class=Response,
    responses=error_responses(
        {404: ["ISSUE_NOT_FOUND", "PHOTO_NOT_FOUND"], 422: ["VALIDATION_ERROR"]}
    ),
)
async def delete_issue_photo(
    issue_id: uuid.UUID, photo_id: uuid.UUID, user: Caller, service: Service
) -> Response:
    """Delete a photo (its uploader while the issue is open, the board at any time)."""
    await service.delete_photo(user, issue_id, photo_id)
    return Response(status_code=204)
