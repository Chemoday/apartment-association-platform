"""Documents of the association (epic E11 task F3; docs/API.md section 13).

Users, roles and badges come only from PropertyService; the PDF goes through the core FileStore
(purpose `document`, owner = the document). The rules are pure functions in policies.py.
"""

import asyncio
import uuid
from datetime import UTC, date, datetime
from pathlib import Path

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.database import DbSession
from src.core.exceptions import DomainError
from src.core.files import (
    PDF_CONTENT_TYPE,
    PDF_SIGNATURE,
    FileDTO,
    FilePurpose,
    FileStore,
    FileVariant,
    attachment_name,
    declared_length,
    get_file_store_factory,
    key_reused,
    receive_to_disk,
    require_content_type,
)
from src.core.validation import clean_required_text
from src.modules.documents.models import Document
from src.modules.documents.policies import (
    is_staff,
    may_delete,
    may_edit,
    may_upload,
    may_use_documents,
    visible_audiences,
)
from src.modules.documents.schemas import (
    TITLE_MAX,
    DocumentAudience,
    DocumentCategory,
    DocumentEdit,
    DocumentView,
)
from src.modules.property.schemas import CurrentUserDTO
from src.modules.property.service import PropertyService, get_property_service

DOCUMENT = FilePurpose.DOCUMENT
# The request body cap of the upload route (also the edge limit of deploy/edge/Caddyfile).
DOCUMENT_MAX_BYTES = 20_000_000


def _now() -> datetime:
    return datetime.now(UTC)


def _forbidden(message: str = "You cannot use the documents of the association.") -> DomainError:
    return DomainError(status_code=403, error_code="FORBIDDEN", message=message)


def _not_found() -> DomainError:
    return DomainError(
        status_code=404, error_code="DOCUMENT_NOT_FOUND", message="Document not found."
    )


def _invalid_title(message: str) -> DomainError:
    return DomainError(
        status_code=422,
        error_code="VALIDATION_ERROR",
        message="The request is invalid.",
        extra={"errors": [{"loc": ["query", "title"], "message": message, "type": "value_error"}]},
    )


def _clean_title(title: str) -> str:
    try:
        cleaned = clean_required_text(title)
    except ValueError as exc:
        raise _invalid_title(str(exc)) from exc
    if len(cleaned) > TITLE_MAX:
        raise _invalid_title(f"at most {TITLE_MAX} characters")
    return cleaned


class DocumentsService:
    def __init__(
        self, session: AsyncSession, property_service: PropertyService, files: FileStore
    ) -> None:
        self.session = session
        self.property_service = property_service
        self.files = files

    # --- Uploading ------------------------------------------------------------------------------

    async def upload(
        self,
        user: CurrentUserDTO,
        request: Request,
        *,
        title: str,
        category: DocumentCategory,
        audience: DocumentAudience,
        document_date: date | None,
        idempotency_key: str | None,
    ) -> tuple[DocumentView, bool]:
        """Store one PDF; returns it and whether it is new (False: a repeat of the same key).

        The rules and the storage's admission come first, then the size; the request's
        transaction is committed before the body is streamed to disk."""
        self._require_access(user)
        if not may_upload(user.building_role, audience):
            raise _forbidden("You cannot upload documents into this audience.")
        title = _clean_title(title)
        if idempotency_key is not None:
            repeat = await self._repeat(user, idempotency_key)
            if repeat is not None:
                return repeat, False
        await self.files.admit(user.building_id, user.id, DOCUMENT, DOCUMENT_MAX_BYTES)
        require_content_type(request, PDF_CONTENT_TYPE)
        length = declared_length(request, DOCUMENT_MAX_BYTES)
        await self.session.commit()
        with self.files.reservations.hold(user.building_id, length):
            with self.files.gate.receiving():
                received = await receive_to_disk(
                    request, self.files.disk, length, DOCUMENT_MAX_BYTES, PDF_SIGNATURE
                )
            document_id = uuid.uuid4()
            try:
                stored = await self.files.store_received(
                    building_id=user.building_id,
                    purpose=DOCUMENT,
                    owner_ref=document_id,
                    created_by=user.id,
                    received=received,
                    content_type=PDF_CONTENT_TYPE,
                    idempotency_key=idempotency_key,
                )
            except DomainError as error:
                received.path.unlink(missing_ok=True)
                if error.error_code == "IDEMPOTENCY_KEY_REUSED" and idempotency_key is not None:
                    repeat = await self._repeat(user, idempotency_key)  # a parallel request won
                    if repeat is not None:
                        return repeat, False
                raise
            except BaseException:
                received.path.unlink(missing_ok=True)
                raise
        now = _now()
        document = Document(
            id=document_id,
            building_id=user.building_id,
            file_id=stored.id,
            title=title,
            category=category,
            audience=audience,
            document_date=document_date,
            size_bytes=stored.size_bytes,
            uploaded_by_user_id=user.id,
            created_at=now,
            updated_at=now,
        )
        self.session.add(document)
        try:
            await self.session.flush()
        except BaseException:
            # The blob is in place but its row rolls back with this transaction: remove it now
            # instead of leaving up to 20 MB to the weekly comparison.
            await asyncio.to_thread(self.files.disk.remove, stored.id)
            raise
        return await self._view(user, document), True

    async def _repeat(self, user: CurrentUserDTO, key: str) -> DocumentView | None:
        found: FileDTO | None = await self.files.find_by_key(user.id, key, DOCUMENT)
        if found is None:
            return None
        document = await self.session.get(Document, found.owner_ref, populate_existing=True)
        if (
            found.deleted
            or document is None
            or document.deleted_at is not None
            or document.building_id != user.building_id
            # moved meanwhile into an audience the caller no longer sees: tell nothing about it
            or document.audience not in visible_audiences(user.building_role)
        ):
            raise key_reused()
        return await self._view(user, document)

    # --- Reading --------------------------------------------------------------------------------

    async def list_documents(
        self,
        user: CurrentUserDTO,
        *,
        category: DocumentCategory | None,
        limit: int,
        offset: int,
    ) -> list[DocumentView]:
        self._require_access(user)
        statement = (
            select(Document)
            .where(
                Document.building_id == user.building_id,
                Document.deleted_at.is_(None),
                Document.audience.in_(sorted(visible_audiences(user.building_role))),
                FileStore.file_is_live(Document.file_id),
            )
            .order_by(Document.created_at.desc(), Document.id.desc())
            .limit(limit)
            .offset(offset)
        )
        if category is not None:
            statement = statement.where(Document.category == category)
        documents = list(await self.session.scalars(statement))
        return await self._views(user, documents)

    async def get(self, user: CurrentUserDTO, document_id: uuid.UUID) -> DocumentView:
        return await self._view(user, await self._visible(user, document_id))

    async def file(self, user: CurrentUserDTO, document_id: uuid.UUID) -> tuple[Path, str, str]:
        """Where the PDF lies (it is streamed, never read whole), its content type and the name
        it is saved under."""
        document = await self._visible(user, document_id)
        stored = (
            await self.files.get(document.file_id, DOCUMENT, document.id)
            if document.file_id is not None
            else None
        )
        path = (
            await self.files.blob_path(stored, FileVariant.ORIGINAL) if stored is not None else None
        )
        if stored is None or path is None:
            raise _not_found()
        return path, stored.content_type, attachment_name(document.title, "pdf")

    # --- Editing and deleting -------------------------------------------------------------------

    async def edit(
        self, user: CurrentUserDTO, document_id: uuid.UUID, request: DocumentEdit
    ) -> DocumentView:
        document = await self._visible(user, document_id, lock=True)
        if not may_edit(user.building_role):
            raise _forbidden("Only the chairman and the board edit documents.")
        changes = request.model_dump(exclude_unset=True)
        for field, value in changes.items():
            setattr(document, field, value)
        if changes:
            document.updated_at = _now()
            await self.session.flush()
        return await self._view(user, document)

    async def delete(self, user: CurrentUserDTO, document_id: uuid.UUID) -> None:
        document = await self._visible(user, document_id, lock=True)
        if not may_delete(user.building_role):
            raise _forbidden("Only the chairman deletes documents.")
        document.deleted_at, document.deleted_by_user_id = _now(), user.id
        await self.files.delete_all(DOCUMENT, document.id)
        await self.session.flush()

    # --- Internals ------------------------------------------------------------------------------

    @staticmethod
    def _require_access(user: CurrentUserDTO) -> None:
        if not may_use_documents(user.building_role, has_membership=bool(user.memberships)):
            raise _forbidden()

    async def _visible(
        self, user: CurrentUserDTO, document_id: uuid.UUID, *, lock: bool = False
    ) -> Document:
        self._require_access(user)
        statement = select(Document).where(
            Document.id == document_id,
            Document.building_id == user.building_id,
            Document.deleted_at.is_(None),
            # A file that expired (demo mode) or was purged hides its document too.
            FileStore.file_is_live(Document.file_id),
        )
        if lock:
            statement = statement.with_for_update()
        document = await self.session.scalar(statement.execution_options(populate_existing=True))
        if document is None or document.audience not in visible_audiences(user.building_role):
            raise _not_found()
        return document

    async def _view(self, user: CurrentUserDTO, document: Document) -> DocumentView:
        [view] = await self._views(user, [document])
        return view

    async def _views(self, user: CurrentUserDTO, documents: list[Document]) -> list[DocumentView]:
        staff = is_staff(user.building_role)
        uploaders = {
            (document.uploaded_by_user_id, None)
            for document in documents
            if document.uploaded_by_user_id is not None
        }
        badges = (
            await self.property_service.get_masked_author_badges(uploaders)
            if staff and uploaders
            else {}
        )
        return [
            DocumentView(
                id=document.id,
                title=document.title,
                category=document.category,
                audience=document.audience,
                document_date=document.document_date,
                size_bytes=document.size_bytes,
                created_at=document.created_at,
                updated_at=document.updated_at,
                mine=document.uploaded_by_user_id == user.id,
                can_edit=may_edit(user.building_role),
                can_delete=may_delete(user.building_role),
                uploaded_by=badges.get((document.uploaded_by_user_id, None)) if staff else None,
            )
            for document in documents
        ]


def get_documents_service(
    request: Request,
    session: DbSession,
    property_service: PropertyService = Depends(get_property_service),
) -> DocumentsService:
    return DocumentsService(session, property_service, get_file_store_factory(request)(session))
