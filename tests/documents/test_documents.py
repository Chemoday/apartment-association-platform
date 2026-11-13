"""Documents of the association through the API (epic E11 task F3; docs/API.md section 13)."""

from typing import Any
from urllib.parse import unquote

import pytest
from httpx import AsyncClient, Response

from tests.issues.conftest import IssueWorld
from tests.issues.test_api import as_user

API = "/api/v1/documents"
PDF = b"%PDF-1.7\n" + b"0" * 2000 + b"\n%%EOF\n"


async def upload(
    client: AsyncClient,
    user,
    data: bytes = PDF,
    *,
    content_type: str = "application/pdf",
    headers: dict[str, str] | None = None,
    **params: Any,
) -> Response:
    query = {"title": "Minutes 2026", "category": "GENERAL_MEETING_MINUTES", "audience": "EVERYONE"}
    query.update(params)
    return await client.post(
        API,
        params=query,
        content=data,
        headers={**as_user(user), "Content-Type": content_type, **(headers or {})},
    )


async def uploaded(client: AsyncClient, user, **params: Any) -> dict:
    response = await upload(client, user, **params)
    assert response.status_code == 201, response.text
    return response.json()


async def titles(client: AsyncClient, user) -> list[str]:
    response = await client.get(API, headers=as_user(user))
    assert response.status_code == 200, response.text
    return [document["title"] for document in response.json()]


async def test_the_chairman_publishes_a_document_that_every_resident_downloads(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    document = await uploaded(
        api_client, world.chairman, title="Üldkoosolek: protokoll", document_date="2026-05-20"
    )

    assert (document["category"], document["audience"], document["size_bytes"]) == (
        "GENERAL_MEETING_MINUTES",
        "EVERYONE",
        len(PDF),
    )
    assert document["document_date"] == "2026-05-20"
    assert (document["mine"], document["can_edit"], document["can_delete"]) == (True, True, True)
    assert await titles(api_client, world.tenant_2) == ["Üldkoosolek: protokoll"]
    file = await api_client.get(f"{API}/{document['id']}/file", headers=as_user(world.tenant_2))
    assert file.status_code == 200
    assert file.content == PDF
    assert file.headers["content-type"] == "application/pdf"
    assert file.headers["x-content-type-options"] == "nosniff"
    assert file.headers["content-security-policy"] == "default-src 'none'; sandbox"
    disposition = file.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="')
    assert unquote(disposition.split("filename*=UTF-8''")[1]) == "Üldkoosolek protokoll.pdf"
    assert file.headers["cache-control"] == "private, no-store"
    assert int(file.headers["content-length"]) == len(PDF)


@pytest.mark.parametrize(
    ("audience", "resident", "accountant", "board"),
    [
        ("EVERYONE", True, True, True),
        ("BOARD_AND_ACCOUNTANT", False, True, True),
        ("BOARD", False, False, True),
    ],
)
async def test_who_sees_a_document_of_each_audience(
    api_client: AsyncClient,
    world: IssueWorld,
    audience: str,
    resident: bool,
    accountant: bool,
    board: bool,
) -> None:
    document = await uploaded(api_client, world.chairman, title="Doc", audience=audience)

    for user, sees in (
        (world.tenant_2, resident),
        (world.accountant, accountant),
        (world.board_15, board),
    ):
        assert (await titles(api_client, user) == ["Doc"]) is sees
        one = await api_client.get(f"{API}/{document['id']}", headers=as_user(user))
        assert one.status_code == (200 if sees else 404)
    other = await api_client.get(f"{API}/{document['id']}", headers=as_user(world.other_resident))
    assert (other.status_code, other.json()["error_code"]) == (404, "DOCUMENT_NOT_FOUND")


async def test_who_may_upload_into_which_audience(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    assert (await upload(api_client, world.board_15, audience="BOARD")).status_code == 201
    accountant_own = await upload(api_client, world.accountant, audience="BOARD_AND_ACCOUNTANT")
    accountant_public = await upload(api_client, world.accountant, audience="EVERYONE")
    resident = await upload(api_client, world.tenant_2, audience="EVERYONE")

    assert accountant_own.status_code == 201
    assert (accountant_public.status_code, accountant_public.json()["error_code"]) == (
        403,
        "FORBIDDEN",
    )
    assert resident.status_code == 403


async def test_staff_see_who_uploaded_as_a_badge_residents_never(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    document = await uploaded(api_client, world.board_15)

    staff = (
        await api_client.get(f"{API}/{document['id']}", headers=as_user(world.accountant))
    ).json()
    resident_view = await api_client.get(f"{API}/{document['id']}", headers=as_user(world.tenant_2))

    assert staff["uploaded_by"] is not None
    assert "Peeter" not in str(staff) and "Saar" not in str(staff)
    assert resident_view.json()["uploaded_by"] is None
    assert str(world.board_15.id) not in resident_view.text


async def test_the_chairman_and_the_board_edit_a_document(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    document = await uploaded(api_client, world.chairman, audience="BOARD_AND_ACCOUNTANT")
    url = f"{API}/{document['id']}"

    edited = await api_client.patch(
        url,
        json={
            "title": " Contract with the cleaner ",
            "category": "CONTRACT",
            "document_date": None,
        },
        headers=as_user(world.board_15),
    )
    accountant = await api_client.patch(url, json={"title": "x"}, headers=as_user(world.accountant))
    null_title = await api_client.patch(url, json={"title": None}, headers=as_user(world.board_15))

    assert edited.status_code == 200
    assert (edited.json()["title"], edited.json()["category"]) == (
        "Contract with the cleaner",
        "CONTRACT",
    )
    assert accountant.status_code == 403
    assert null_title.status_code == 422


async def test_only_the_chairman_deletes_and_the_document_is_gone_for_everyone(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    document = await uploaded(api_client, world.board_15)
    url = f"{API}/{document['id']}"

    board = await api_client.delete(url, headers=as_user(world.board_15))
    chairman = await api_client.delete(url, headers=as_user(world.chairman))

    assert (board.status_code, board.json()["error_code"]) == (403, "FORBIDDEN")
    assert chairman.status_code == 204
    assert await titles(api_client, world.tenant_2) == []
    assert (await api_client.get(f"{url}/file", headers=as_user(world.chairman))).status_code == 404
    assert (await api_client.delete(url, headers=as_user(world.chairman))).status_code == 404


@pytest.mark.parametrize(
    ("data", "content_type", "status", "code"),
    [
        (b"MZ\x90\x00 not a pdf at all", "application/pdf", 415, "UNSUPPORTED_MEDIA_TYPE"),
        (b"%P", "application/pdf", 415, "UNSUPPORTED_MEDIA_TYPE"),
        (PDF, "application/octet-stream", 415, "UNSUPPORTED_MEDIA_TYPE"),
        (b"%PDF-" + b"0" * 20_000_000, "application/pdf", 413, "FILE_TOO_LARGE"),
    ],
)
async def test_what_is_not_an_acceptable_document(
    api_client: AsyncClient,
    world: IssueWorld,
    data: bytes,
    content_type: str,
    status: int,
    code: str,
) -> None:
    response = await upload(api_client, world.chairman, data, content_type=content_type)

    assert (response.status_code, response.json()["error_code"]) == (status, code)
    assert await titles(api_client, world.chairman) == []


@pytest.mark.parametrize("title", ["   ", "a\x00b", "x" * 201])
async def test_a_title_must_be_text(api_client: AsyncClient, world: IssueWorld, title: str) -> None:
    response = await upload(api_client, world.chairman, title=title)

    assert (response.status_code, response.json()["error_code"]) == (422, "VALIDATION_ERROR")


async def test_a_repeated_upload_with_the_same_key_returns_the_first_document(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    key = {"Idempotency-Key": "doc-1"}
    first = await upload(api_client, world.chairman, headers=key)
    again = await upload(api_client, world.chairman, headers=key)
    await api_client.delete(f"{API}/{first.json()['id']}", headers=as_user(world.chairman))
    after_delete = await upload(api_client, world.chairman, headers=key)

    assert (first.status_code, again.status_code) == (201, 200)
    assert again.json()["id"] == first.json()["id"]
    assert (after_delete.status_code, after_delete.json()["error_code"]) == (
        409,
        "IDEMPOTENCY_KEY_REUSED",
    )


async def test_people_without_access_to_the_module(
    api_client: AsyncClient, world: IssueWorld, db_session
) -> None:
    from tests.factories import create_user

    stranger = await create_user(db_session, world.building, "No Flat")  # no membership, no role

    response = await api_client.get(API, headers=as_user(stranger))

    assert (response.status_code, response.json()["error_code"]) == (403, "FORBIDDEN")


async def test_a_staff_member_who_does_not_see_a_board_document_learns_nothing_about_it(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    document = await uploaded(api_client, world.chairman, audience="BOARD")
    url = f"{API}/{document['id']}"

    for response in (
        await api_client.get(f"{url}/file", headers=as_user(world.accountant)),
        await api_client.patch(url, json={"title": "x"}, headers=as_user(world.accountant)),
        await api_client.delete(url, headers=as_user(world.accountant)),
    ):
        assert (response.status_code, response.json()["error_code"]) == (404, "DOCUMENT_NOT_FOUND")


async def test_a_repeat_after_the_document_moved_out_of_sight_is_refused(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    key = {"Idempotency-Key": "acc-1"}
    first = await upload(api_client, world.accountant, audience="BOARD_AND_ACCOUNTANT", headers=key)
    await api_client.patch(
        f"{API}/{first.json()['id']}",
        json={"title": "Secret", "audience": "BOARD"},
        headers=as_user(world.chairman),
    )

    again = await upload(api_client, world.accountant, audience="BOARD_AND_ACCOUNTANT", headers=key)

    assert (again.status_code, again.json()["error_code"]) == (409, "IDEMPOTENCY_KEY_REUSED")
    assert "Secret" not in again.text


async def test_the_list_filters_by_category_and_pages(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    for number in range(3):
        await uploaded(api_client, world.chairman, title=f"Contract {number}", category="CONTRACT")
    await uploaded(api_client, world.chairman, title="Rules", category="HOUSE_RULES")

    contracts = await api_client.get(
        API, params={"category": "CONTRACT", "limit": 2}, headers=as_user(world.tenant_2)
    )
    rest = await api_client.get(
        API,
        params={"category": "CONTRACT", "limit": 2, "offset": 2},
        headers=as_user(world.tenant_2),
    )

    assert [d["title"] for d in contracts.json()] == ["Contract 2", "Contract 1"]
    assert [d["title"] for d in rest.json()] == ["Contract 0"]


async def test_a_document_whose_file_expired_disappears(
    api_client: AsyncClient, world: IssueWorld, db_session
) -> None:
    from datetime import UTC, datetime, timedelta

    from sqlalchemy import update

    from src.core.files import StoredFile

    document = await uploaded(api_client, world.chairman)
    now = datetime.now(UTC)
    await db_session.execute(
        update(StoredFile)
        .where(StoredFile.purpose == "document")
        .values(deleted_at=now, purge_after=now + timedelta(days=14))
    )
    await db_session.commit()

    assert await titles(api_client, world.chairman) == []
    one = await api_client.get(f"{API}/{document['id']}", headers=as_user(world.chairman))
    assert one.status_code == 404


async def test_a_body_longer_than_it_said_is_cut_off_and_leaves_nothing(
    api_client: AsyncClient, world: IssueWorld, db_app
) -> None:
    async def body():
        yield PDF
        yield b"0" * 1000

    response = await api_client.post(
        API,
        params={"title": "T", "category": "OTHER", "audience": "EVERYONE"},
        content=body(),
        headers={
            **as_user(world.chairman),
            "Content-Type": "application/pdf",
            "Content-Length": str(len(PDF)),
        },
    )

    assert (response.status_code, response.json()["error_code"]) == (413, "FILE_TOO_LARGE")
    assert list(db_app.state.file_disk.tmp.iterdir()) == []


async def test_a_client_that_goes_away_mid_upload_leaves_nothing(
    api_client: AsyncClient, world: IssueWorld, db_app
) -> None:
    from starlette.requests import ClientDisconnect

    async def gone():
        yield PDF[:100]
        raise ClientDisconnect()

    response = await api_client.post(
        API,
        params={"title": "T", "category": "OTHER", "audience": "EVERYONE"},
        content=gone(),
        headers={
            **as_user(world.chairman),
            "Content-Type": "application/pdf",
            "Content-Length": str(len(PDF)),
        },
    )

    assert (response.status_code, response.json()["error_code"]) == (400, "UPLOAD_INTERRUPTED")
    assert list(db_app.state.file_disk.tmp.iterdir()) == []


async def test_a_title_in_another_script_still_downloads_with_a_readable_fallback_name(
    api_client: AsyncClient, world: IssueWorld
) -> None:
    document = await uploaded(api_client, world.chairman, title="Πρακτικά συνέλευσης")

    file = await api_client.get(f"{API}/{document['id']}/file", headers=as_user(world.chairman))

    assert 'filename="document.pdf"' in file.headers["content-disposition"]
