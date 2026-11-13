"""Photos of issue reports through the API (task I4, epic E11 F2; fixture: conftest.py)."""

import io
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from httpx import AsyncClient, Response
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.files import StoredFile
from src.modules.issues.policies import photos_delete_at, photos_deleted_at_once
from src.modules.issues.schemas import IssueStatus
from tests.issues.conftest import IssueWorld
from tests.issues.test_api import API, as_user, reported


def jpeg(size: tuple[int, int] = (1600, 1200), gps: bool = True) -> bytes:
    image = Image.new("RGB", size, "green")
    exif = Image.Exif()
    if gps:
        exif.get_ifd(0x8825).update({1: "N", 2: (59.0, 26.0, 0.0)})
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", exif=exif.tobytes())
    return buffer.getvalue()


PHOTO = jpeg()


async def upload(
    client: AsyncClient, user, issue_id: str, data: bytes = PHOTO, **headers: str
) -> Response:
    return await client.post(
        f"{API}/{issue_id}/photos",
        content=data,
        headers={**as_user(user), "Content-Type": "image/jpeg", **headers},
    )


async def view(client: AsyncClient, user, issue_id: str) -> dict[str, Any]:
    response = await client.get(f"{API}/{issue_id}", headers=as_user(user))
    assert response.status_code == 200, response.text
    return response.json()


@pytest.fixture
async def issue(api_client: AsyncClient, world: IssueWorld) -> dict:
    return await reported(api_client, world.owner_14)


async def test_the_reporter_adds_a_photo_that_the_building_sees_without_metadata(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    response = await upload(api_client, world.owner_14, issue["id"])

    assert response.status_code == 201, response.text
    photo = response.json()
    assert (photo["width"], photo["height"], photo["mine"], photo["can_delete"]) == (
        1600,
        1200,
        True,
        True,
    )
    neighbour = await view(api_client, world.tenant_2, issue["id"])
    [seen] = neighbour["photos"]
    assert (seen["id"], seen["mine"], seen["can_delete"]) == (photo["id"], False, False)
    assert neighbour["can_add_photo"] is False
    for variant, edge in (("display", 1600), ("thumb", 320)):
        image = await api_client.get(
            f"{API}/{issue['id']}/photos/{photo['id']}",
            params={"variant": variant},
            headers=as_user(world.tenant_2),
        )
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/webp"
        assert image.headers["x-content-type-options"] == "nosniff"
        assert image.headers["cache-control"] == "private, max-age=31536000, immutable"
        decoded = Image.open(io.BytesIO(image.content))
        assert decoded.format == "WEBP" and max(decoded.size) == edge
        assert not decoded.getexif()


async def test_nobody_learns_who_uploaded_a_photo(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    await upload(api_client, world.board_15, issue["id"])

    for user in (world.owner_14, world.tenant_2, world.chairman):
        payload = await view(api_client, user, issue["id"])
        assert set(payload["photos"][0]) == {
            "id",
            "width",
            "height",
            "created_at",
            "mine",
            "can_delete",
        }
        assert str(world.board_15.id) not in str(payload["photos"])


async def test_who_may_add_photos(api_client: AsyncClient, world: IssueWorld, issue: dict) -> None:
    neighbour = await upload(api_client, world.tenant_2, issue["id"])
    other_building = await upload(api_client, world.other_resident, issue["id"])
    board = await upload(api_client, world.board_15, issue["id"])

    assert (neighbour.status_code, neighbour.json()["error_code"]) == (403, "FORBIDDEN")
    assert (other_building.status_code, other_building.json()["error_code"]) == (
        404,
        "ISSUE_NOT_FOUND",
    )
    assert board.status_code == 201
    assert (await view(api_client, world.owner_14, issue["id"]))["can_add_photo"] is True


async def test_at_most_three_photos_and_a_deleted_one_frees_its_place(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    ids = [(await upload(api_client, world.owner_14, issue["id"])).json()["id"] for _ in range(3)]

    fourth = await upload(api_client, world.owner_14, issue["id"])
    assert (fourth.status_code, fourth.json()["error_code"]) == (409, "PHOTO_LIMIT_REACHED")
    assert (await view(api_client, world.owner_14, issue["id"]))["can_add_photo"] is False

    deleted = await api_client.delete(
        f"{API}/{issue['id']}/photos/{ids[0]}", headers=as_user(world.owner_14)
    )
    assert deleted.status_code == 204
    gone = await api_client.get(
        f"{API}/{issue['id']}/photos/{ids[0]}", headers=as_user(world.owner_14)
    )
    assert (gone.status_code, gone.json()["error_code"]) == (404, "PHOTO_NOT_FOUND")
    assert (await upload(api_client, world.owner_14, issue["id"])).status_code == 201


async def test_who_may_delete_a_photo(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    photo = (await upload(api_client, world.owner_14, issue["id"])).json()
    url = f"{API}/{issue['id']}/photos/{photo['id']}"

    neighbour = await api_client.delete(url, headers=as_user(world.tenant_2))
    assert (neighbour.status_code, neighbour.json()["error_code"]) == (403, "FORBIDDEN")
    # Once the issue is resolved, its uploader may no longer delete it; the board still may.
    await _status(api_client, world, issue["id"], status="RESOLVED")
    assert (await api_client.delete(url, headers=as_user(world.owner_14))).status_code == 403
    assert (await api_client.delete(url, headers=as_user(world.chairman))).status_code == 204


async def test_no_photo_is_added_to_an_ended_issue(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    await api_client.post(f"{API}/{issue['id']}/withdraw", headers=as_user(world.owner_14))

    response = await upload(api_client, world.owner_14, issue["id"])

    assert (response.status_code, response.json()["error_code"]) == (409, "ISSUE_ENDED")


async def test_a_photo_of_another_issue_is_not_found(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    other = await reported(api_client, world.board_15, entrance=1)
    photo = (await upload(api_client, world.owner_14, issue["id"])).json()

    response = await api_client.get(
        f"{API}/{other['id']}/photos/{photo['id']}", headers=as_user(world.tenant_2)
    )
    deleted = await api_client.delete(
        f"{API}/{other['id']}/photos/{photo['id']}", headers=as_user(world.chairman)
    )

    assert (response.status_code, response.json()["error_code"]) == (404, "PHOTO_NOT_FOUND")
    assert deleted.status_code == 404


async def test_a_repeated_upload_with_the_same_key_stores_one_photo(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    first = await upload(api_client, world.owner_14, issue["id"], **{"Idempotency-Key": "abc-1"})
    again = await upload(api_client, world.owner_14, issue["id"], **{"Idempotency-Key": "abc-1"})
    bad = await upload(api_client, world.owner_14, issue["id"], **{"Idempotency-Key": "no spaces"})

    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["id"] == first.json()["id"]
    assert len((await view(api_client, world.owner_14, issue["id"]))["photos"]) == 1
    assert (bad.status_code, bad.json()["error_code"]) == (422, "VALIDATION_ERROR")


@pytest.mark.parametrize(
    ("data", "headers", "status", "code"),
    [
        (PHOTO, {"Content-Type": "image/png"}, 415, "UNSUPPORTED_MEDIA_TYPE"),
        (b"\x89PNG\r\n\x1a\n" + b"0" * 100, {}, 415, "UNSUPPORTED_MEDIA_TYPE"),
        (jpeg((2561, 100)), {}, 422, "IMAGE_TOO_LARGE"),
        (PHOTO[: len(PHOTO) // 2], {}, 422, "INVALID_IMAGE"),
        (b"x" * 4_000_001, {}, 413, "FILE_TOO_LARGE"),
    ],
)
async def test_what_is_not_a_usable_photo(
    api_client: AsyncClient,
    world: IssueWorld,
    issue: dict,
    data: bytes,
    headers: dict,
    status: int,
    code: str,
) -> None:
    response = await upload(api_client, world.owner_14, issue["id"], data, **headers)

    assert (response.status_code, response.json()["error_code"]) == (status, code)
    assert (await view(api_client, world.owner_14, issue["id"]))["photos"] == []


async def test_a_body_without_content_length_is_refused(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    async def chunks():
        yield PHOTO

    response = await api_client.post(
        f"{API}/{issue['id']}/photos",
        content=chunks(),
        headers={**as_user(world.owner_14), "Content-Type": "image/jpeg"},
    )

    assert (response.status_code, response.json()["error_code"]) == (411, "LENGTH_REQUIRED")


async def test_demo_mode_without_the_flag_refuses_uploads(
    api_client: AsyncClient, db_app: FastAPI, world: IssueWorld, issue: dict
) -> None:
    db_app.state.settings = db_app.state.settings.model_copy(update={"FILES_IN_DEMO": False})

    response = await upload(api_client, world.owner_14, issue["id"])

    assert (response.status_code, response.json()["error_code"]) == (403, "UPLOADS_DISABLED")


async def _delete_after(db_session: AsyncSession, issue_id: str) -> list[datetime | None]:
    return list(
        await db_session.scalars(
            select(StoredFile.delete_after)
            .where(StoredFile.owner_ref == uuid.UUID(issue_id))
            .execution_options(populate_existing=True)
        )
    )


async def _status(client: AsyncClient, world: IssueWorld, issue_id: str, **body: Any) -> dict:
    response = await client.post(
        f"{API}/{issue_id}/status", json=body, headers=as_user(world.chairman)
    )
    assert response.status_code == 200, response.text
    return response.json()


async def test_photos_of_a_resolved_issue_go_after_30_days_and_stay_when_it_is_reopened(
    api_client: AsyncClient,
    db_app: FastAPI,
    db_session: AsyncSession,
    world: IssueWorld,
    issue: dict,
) -> None:
    # Outside demo mode, so the demo's one-day retention does not apply.
    db_app.state.settings = db_app.state.settings.model_copy(update={"DEMO_MODE_ENABLED": False})
    await upload(api_client, world.owner_14, issue["id"])
    assert await _delete_after(db_session, issue["id"]) == [None]
    assert (await view(api_client, world.owner_14, issue["id"]))["photos_delete_at"] is None

    resolved = await _status(api_client, world, issue["id"], status="RESOLVED")
    ended_at = datetime.fromisoformat(resolved["ended_at"])
    assert await _delete_after(db_session, issue["id"]) == [ended_at + timedelta(days=30)]
    assert datetime.fromisoformat(resolved["photos_delete_at"]) == ended_at + timedelta(days=30)
    assert len(resolved["photos"]) == 1  # still shown until then

    reopened = await _status(api_client, world, issue["id"], status="IN_PROGRESS")
    assert await _delete_after(db_session, issue["id"]) == [None]
    assert reopened["photos_delete_at"] is None


@pytest.mark.parametrize("ending", ["DECLINED", "DUPLICATE", "WITHDRAWN"])
async def test_photos_of_an_issue_that_ends_otherwise_are_deleted_at_once(
    api_client: AsyncClient, world: IssueWorld, issue: dict, ending: str
) -> None:
    photo = (await upload(api_client, world.owner_14, issue["id"])).json()
    if ending == "WITHDRAWN":
        await api_client.post(f"{API}/{issue['id']}/withdraw", headers=as_user(world.owner_14))
    elif ending == "DUPLICATE":
        original = await reported(api_client, world.board_15, entrance=1)
        await _status(
            api_client, world, issue["id"], status="DUPLICATE", duplicate_of=original["id"]
        )
    else:
        await _status(api_client, world, issue["id"], status="DECLINED")

    ended = await view(api_client, world.owner_14, issue["id"])
    image = await api_client.get(
        f"{API}/{issue['id']}/photos/{photo['id']}", headers=as_user(world.owner_14)
    )

    assert (ended["photos"], ended["photos_delete_at"]) == ([], None)
    assert image.status_code == 404
    if ending != "WITHDRAWN":  # reopening does not bring them back
        reopened = await _status(api_client, world, issue["id"], status="IN_PROGRESS")
        assert reopened["photos"] == []


def test_which_photos_go_when() -> None:
    ended = datetime(2026, 11, 13, 10, tzinfo=UTC)
    assert photos_delete_at(IssueStatus.RESOLVED, ended) == ended + timedelta(days=30)
    for status in IssueStatus:
        if status != IssueStatus.RESOLVED:
            assert photos_delete_at(status, ended) is None
    assert {status for status in IssueStatus if photos_deleted_at_once(status)} == {
        IssueStatus.DUPLICATE,
        IssueStatus.DECLINED,
        IssueStatus.WITHDRAWN,
    }


async def test_a_lost_file_on_the_server_is_not_found_not_an_error(
    api_client: AsyncClient, db_app: FastAPI, world: IssueWorld, issue: dict
) -> None:
    photo = (await upload(api_client, world.owner_14, issue["id"])).json()
    db_app.state.file_disk.remove(uuid.UUID(photo["id"]))

    response = await api_client.get(
        f"{API}/{issue['id']}/photos/{photo['id']}", headers=as_user(world.owner_14)
    )

    assert (response.status_code, response.json()["error_code"]) == (404, "PHOTO_NOT_FOUND")


async def test_the_list_of_issues_carries_no_photos(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    await upload(api_client, world.owner_14, issue["id"])

    listing = await api_client.get(API, headers=as_user(world.tenant_2))

    assert listing.status_code == 200
    assert "photos" not in listing.json()[0]


async def test_a_key_used_for_another_or_a_deleted_photo_is_refused_not_a_server_error(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    other = await reported(api_client, world.board_15, entrance=1)
    first = (
        await upload(api_client, world.owner_14, issue["id"], **{"Idempotency-Key": "k"})
    ).json()
    on_other = await upload(api_client, world.owner_14, other["id"], **{"Idempotency-Key": "k"})
    await api_client.delete(
        f"{API}/{issue['id']}/photos/{first['id']}", headers=as_user(world.owner_14)
    )
    after_delete = await upload(api_client, world.owner_14, issue["id"], **{"Idempotency-Key": "k"})

    for response in (on_other, after_delete):
        assert (response.status_code, response.json()["error_code"]) == (
            409,
            "IDEMPOTENCY_KEY_REUSED",
        )


async def test_a_repeat_after_the_issue_ended_still_returns_the_photo(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    first = await upload(api_client, world.owner_14, issue["id"], **{"Idempotency-Key": "late"})
    await _status(api_client, world, issue["id"], status="RESOLVED")

    again = await upload(api_client, world.owner_14, issue["id"], **{"Idempotency-Key": "late"})

    assert (again.status_code, again.json()["id"]) == (200, first.json()["id"])


async def test_nobody_is_offered_to_add_a_photo_where_uploads_are_off(
    api_client: AsyncClient, db_app: FastAPI, world: IssueWorld, issue: dict
) -> None:
    assert (await view(api_client, world.owner_14, issue["id"]))["can_add_photo"] is True
    db_app.state.settings = db_app.state.settings.model_copy(update={"FILES_IN_DEMO": False})

    assert (await view(api_client, world.owner_14, issue["id"]))["can_add_photo"] is False


async def test_a_client_that_goes_away_mid_upload_is_no_server_error(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    from starlette.requests import ClientDisconnect

    async def gone():
        yield PHOTO[:100]
        raise ClientDisconnect()

    response = await api_client.post(
        f"{API}/{issue['id']}/photos",
        content=gone(),
        headers={
            **as_user(world.owner_14),
            "Content-Type": "image/jpeg",
            "Content-Length": str(len(PHOTO)),
        },
    )

    assert (response.status_code, response.json()["error_code"]) == (400, "UPLOAD_INTERRUPTED")


async def test_a_repeat_after_the_issue_was_withdrawn_gets_the_issues_answer(
    api_client: AsyncClient, world: IssueWorld, issue: dict
) -> None:
    await upload(api_client, world.owner_14, issue["id"], **{"Idempotency-Key": "gone"})
    await api_client.post(f"{API}/{issue['id']}/withdraw", headers=as_user(world.owner_14))

    again = await upload(api_client, world.owner_14, issue["id"], **{"Idempotency-Key": "gone"})

    # The photo went with the withdrawal: the client learns why, not that it misused the key.
    assert (again.status_code, again.json()["error_code"]) == (409, "ISSUE_ENDED")
