"""Bounded outbound requests of register plugins (docs/ARCHITECTURE.md 13), without the network."""

import asyncio
import gzip
import json

import httpx
import pytest

from src.plugins import outbound
from src.plugins.outbound import OutboundError, get_json
from tests.plugins.streams import streamed

URL = "https://register.example/api"
HOSTS = frozenset({"register.example"})


def transport(handler) -> httpx.MockTransport:
    return httpx.MockTransport(handler)


async def test_a_json_answer_and_the_headers_sent() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return streamed(200, json_body={"ok": True})

    assert await get_json(URL, {"a": "b"}, HOSTS, transport(handler)) == (200, {"ok": True})
    (request,) = seen
    assert request.headers["accept-encoding"] == "identity"
    assert request.headers["user-agent"] == "apartment-association-platform"


@pytest.mark.parametrize(
    "url", ["https://elsewhere.example/api", "http://register.example/api", "file:///etc/passwd"]
)
async def test_only_allowed_hosts_over_https(url: str) -> None:
    with pytest.raises(OutboundError) as caught:
        await get_json(url, {}, HOSTS, transport(lambda request: streamed(200, json_body={})))
    assert caught.value.reason == "HOST_NOT_ALLOWED"


async def test_a_client_error_without_json_still_gives_the_status() -> None:
    answer = await get_json(
        URL, {}, HOSTS, transport(lambda request: streamed(404, text="<html>no</html>"))
    )
    assert answer == (404, None)


@pytest.mark.parametrize(
    ("response", "reason"),
    [
        (streamed(200, text="<html>maintenance</html>"), "NOT_JSON"),
        (streamed(200, text="[" * 100_000 + "]" * 100_000), "NOT_JSON"),
        (streamed(503, json_body={}), "BAD_STATUS"),
        (streamed(301, headers={"location": "https://register.example/x"}), "BAD_STATUS"),
        (
            streamed(
                200,
                content=gzip.compress(json.dumps({"a": 1}).encode()),
                headers={"content-encoding": "gzip"},
            ),
            "ENCODED",
        ),
        (streamed(200, content=b" " * (outbound.MAX_RESPONSE_BYTES + 1)), "TOO_LARGE"),
    ],
)
async def test_unusable_answers_raise(response: httpx.Response, reason: str) -> None:
    with pytest.raises(OutboundError) as caught:
        await get_json(URL, {}, HOSTS, transport(lambda request: response))
    assert caught.value.reason == reason


async def test_a_network_error_raises_without_the_url() -> None:
    def fail(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout(f"timed out reading {request.url}", request=request)

    with pytest.raises(OutboundError) as caught:
        await get_json(URL, {"address": "Secret 1"}, HOSTS, transport(fail))
    assert caught.value.reason == "UNREACHABLE"
    assert "Secret" not in str(caught.value) and caught.value.__cause__ is None


async def test_one_deadline_for_a_source_that_trickles(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(outbound, "TIMEOUT_SECONDS", 0.2)

    class Trickle(httpx.AsyncByteStream):
        async def __aiter__(self):
            for _ in range(100):
                await asyncio.sleep(0.05)  # every chunk well within a per-read timeout
                yield b" "

    with pytest.raises(OutboundError) as caught:
        await get_json(
            URL, {}, HOSTS, transport(lambda request: httpx.Response(200, stream=Trickle()))
        )
    assert caught.value.reason == "UNREACHABLE"
