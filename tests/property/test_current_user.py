"""Loading the caller on every request (PropertyService.get_current_user, issue #168).

One query now loads the user and the memberships together; the result must stay what the two
queries gave: only active memberships, only apartments of the user's own building, None for an
unknown or deactivated user.
"""

from datetime import UTC, datetime

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from src.modules.property.schemas import BuildingRole, DisplayMode, RelationType
from src.modules.property.service import PropertyService
from tests import factories


async def _queries(session: AsyncSession, user_id) -> tuple[object, int]:
    # As in a request: nothing of the user is in the session yet (session.get would otherwise
    # answer from the identity map without a query).
    session.expunge_all()
    statements: list[str] = []
    sync_connection = (await session.connection()).sync_connection

    def count(*_args) -> None:
        statements.append("q")

    event.listen(sync_connection, "before_cursor_execute", count)
    try:
        result = await PropertyService(session).get_current_user(user_id)
    finally:
        event.remove(sync_connection, "before_cursor_execute", count)
    return result, len(statements)


async def test_one_query_loads_the_user_and_their_memberships(db_session: AsyncSession):
    building = await factories.create_building(db_session)
    apt_2 = await factories.create_apartment(db_session, building, "2", entrance=1)
    apt_14 = await factories.create_apartment(db_session, building, "14", entrance=2)
    apt_old = await factories.create_apartment(db_session, building, "3", entrance=1)
    user = await factories.create_user(db_session, building, "Owner", role=BuildingRole.BOARD)
    await factories.create_membership(db_session, user, apt_14, mode=DisplayMode.FULL_NAME)
    await factories.create_membership(
        db_session, user, apt_2, RelationType.TENANT, mode=DisplayMode.INITIALS
    )
    ended = await factories.create_membership(db_session, user, apt_old)
    ended.ended_at = datetime.now(UTC)  # a former apartment never counts
    await db_session.flush()

    current, queries = await _queries(db_session, user.id)

    assert queries == 1
    assert current.id == user.id and current.building_id == building.id
    assert current.building_role == BuildingRole.BOARD
    assert [m.apartment_number for m in current.memberships] == ["2", "14"]  # entrance order
    assert current.memberships[0].relation_type == RelationType.TENANT
    assert current.privacy_display_mode == DisplayMode.INITIALS  # the most private one


async def test_a_user_without_an_apartment_has_no_memberships(db_session: AsyncSession):
    building = await factories.create_building(db_session)
    chairman = await factories.create_user(
        db_session, building, "Chair", role=BuildingRole.CHAIRMAN
    )

    current, _ = await _queries(db_session, chairman.id)

    assert current is not None and current.memberships == ()


async def test_an_apartment_of_another_building_is_never_a_membership(db_session: AsyncSession):
    own = await factories.create_building(db_session, name="Own")
    other = await factories.create_building(db_session, name="Other")
    user = await factories.create_user(db_session, own, "Owner")
    await factories.create_membership(
        db_session, user, await factories.create_apartment(db_session, own, "1")
    )
    await factories.create_membership(
        db_session, user, await factories.create_apartment(db_session, other, "9")
    )

    current, _ = await _queries(db_session, user.id)

    assert [m.apartment_number for m in current.memberships] == ["1"]


async def test_an_unknown_or_deactivated_user_is_none(db_session: AsyncSession):
    building = await factories.create_building(db_session)
    gone = await factories.create_user(db_session, building, "Gone", is_active=False)
    await factories.create_membership(
        db_session, gone, await factories.create_apartment(db_session, building, "1")
    )

    assert (await _queries(db_session, gone.id))[0] is None
    assert (await _queries(db_session, factories.uuid.uuid4()))[0] is None
