"""Pure rules of the documents module (docs/API.md section 13; owner decisions 2026-11-13)."""

from src.modules.documents.schemas import DocumentAudience
from src.modules.property.schemas import BuildingRole

BOARD_ROLES = frozenset({BuildingRole.CHAIRMAN, BuildingRole.BOARD})
STAFF_ROLES = BOARD_ROLES | {BuildingRole.ACCOUNTANT}


def is_staff(role: BuildingRole) -> bool:
    return role in STAFF_ROLES


def may_use_documents(role: BuildingRole, *, shared_access: bool) -> bool:
    """Members with shared access (not a tenant of a parking space or a garage only, epic E14)
    and the staff, by their role."""
    return shared_access or is_staff(role)


def visible_audiences(role: BuildingRole) -> frozenset[DocumentAudience]:
    if role in BOARD_ROLES:
        return frozenset(DocumentAudience)
    if role == BuildingRole.ACCOUNTANT:
        return frozenset({DocumentAudience.EVERYONE, DocumentAudience.BOARD_AND_ACCOUNTANT})
    return frozenset({DocumentAudience.EVERYONE})


def may_upload(role: BuildingRole, audience: DocumentAudience) -> bool:
    """The chairman and the board into any audience, the accountant only into "the board and the
    accountant", residents never."""
    if role in BOARD_ROLES:
        return True
    return role == BuildingRole.ACCOUNTANT and audience == DocumentAudience.BOARD_AND_ACCOUNTANT


def may_edit(role: BuildingRole) -> bool:
    return role in BOARD_ROLES


def may_delete(role: BuildingRole) -> bool:
    """Only the chairman deletes a document (owner decision)."""
    return role == BuildingRole.CHAIRMAN
