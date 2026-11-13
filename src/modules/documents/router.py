"""Thin HTTP layer of the association's documents (docs/API.md section 13)."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, Request, Response

from src.core.exceptions import AUTH_ERRORS, error_responses
from src.core.files import streamed_file_response
from src.core.security import get_current_user
from src.modules.documents.schemas import (
    DOCUMENTS_PAGE_MAX,
    TITLE_MAX,
    DocumentAudience,
    DocumentCategory,
    DocumentDate,
    DocumentEdit,
    DocumentView,
    UploadOptions,
)
from src.modules.documents.service import DocumentsService, get_documents_service
from src.modules.property.schemas import CurrentUserDTO

router = APIRouter(
    prefix="/api/v1/documents",
    tags=["documents"],
    responses=error_responses(
        {401: AUTH_ERRORS, 403: ["FORBIDDEN"], 500: ["INTERNAL_SERVER_ERROR"]}
    ),
)

Service = Annotated[DocumentsService, Depends(get_documents_service)]
Caller = Annotated[CurrentUserDTO, Depends(get_current_user)]
IdempotencyKey = Annotated[
    str | None,
    Header(alias="Idempotency-Key", min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$"),
]
_ONE = {404: ["DOCUMENT_NOT_FOUND"], 422: ["VALIDATION_ERROR"]}
_PDF_BODY = {
    "requestBody": {
        "required": True,
        "description": "The PDF itself, at most 20,000,000 bytes.",
        "content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}},
    }
}


@router.get("/upload-options", response_model=UploadOptions)
async def upload_options(user: Caller, service: Service) -> UploadOptions:
    """Whether the caller may upload now, into which audiences, and the size limit."""
    return service.upload_options(user)


@router.post(
    "",
    response_model=DocumentView,
    status_code=201,
    openapi_extra=_PDF_BODY,
    responses={
        200: {"model": DocumentView, "description": "A repeat with the same Idempotency-Key"},
        **error_responses(
            {
                400: ["UPLOAD_INTERRUPTED"],
                403: ["FORBIDDEN", "UPLOADS_DISABLED"],
                409: ["IDEMPOTENCY_KEY_REUSED", "UPLOAD_REMOVED"],
                408: ["UPLOAD_TIMEOUT"],
                411: ["LENGTH_REQUIRED"],
                413: ["FILE_TOO_LARGE"],
                415: ["UNSUPPORTED_MEDIA_TYPE"],
                422: ["VALIDATION_ERROR"],
                429: ["RATE_LIMITED"],
                507: ["STORAGE_QUOTA_EXCEEDED", "STORAGE_LOW_DISK"],
            }
        ),
    },
)
async def upload_document(
    request: Request,
    response: Response,
    user: Caller,
    service: Service,
    title: Annotated[str, Query(min_length=1, max_length=TITLE_MAX + 50)],
    category: DocumentCategory,
    audience: DocumentAudience,
    document_date: Annotated[DocumentDate, Query()] = None,
    idempotency_key: IdempotencyKey = None,
) -> DocumentView:
    """Upload a PDF (the chairman, the board; the accountant only for the board and itself)."""
    document, new = await service.upload(
        user,
        request,
        title=title,
        category=category,
        audience=audience,
        document_date=document_date,
        idempotency_key=idempotency_key,
    )
    if not new:
        response.status_code = 200
    return document


@router.get(
    "", response_model=list[DocumentView], responses=error_responses({422: ["VALIDATION_ERROR"]})
)
async def list_documents(
    user: Caller,
    service: Service,
    category: DocumentCategory | None = None,
    limit: Annotated[int, Query(ge=1, le=DOCUMENTS_PAGE_MAX)] = 50,
    offset: Annotated[int, Query(ge=0, le=100_000)] = 0,
) -> list[DocumentView]:
    """The documents the caller sees, newest first."""
    return await service.list_documents(user, category=category, limit=limit, offset=offset)


@router.get("/{document_id}", response_model=DocumentView, responses=error_responses(_ONE))
async def get_document(document_id: uuid.UUID, user: Caller, service: Service) -> DocumentView:
    """One document."""
    return await service.get(user, document_id)


@router.get(
    "/{document_id}/file",
    response_class=Response,
    responses={
        200: {"content": {"application/pdf": {"schema": {"type": "string", "format": "binary"}}}},
        **error_responses(_ONE),
    },
)
async def download_document(document_id: uuid.UUID, user: Caller, service: Service) -> Response:
    """The PDF, always as an attachment, streamed from disk."""
    path, content_type, filename = await service.file(user, document_id)
    return streamed_file_response(path, content_type, filename)


@router.patch("/{document_id}", response_model=DocumentView, responses=error_responses(_ONE))
async def edit_document(
    document_id: uuid.UUID, body: DocumentEdit, user: Caller, service: Service
) -> DocumentView:
    """Change the title, category, audience or date (the chairman and the board)."""
    return await service.edit(user, document_id, body)


@router.delete(
    "/{document_id}", status_code=204, response_class=Response, responses=error_responses(_ONE)
)
async def delete_document(document_id: uuid.UUID, user: Caller, service: Service) -> Response:
    """Delete a document for everyone (the chairman)."""
    await service.delete(user, document_id)
    return Response(status_code=204)
