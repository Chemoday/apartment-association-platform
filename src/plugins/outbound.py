"""Bounded outbound requests of plugins that read public registers (docs/ARCHITECTURE.md 13).

Only the hosts a caller allows, no redirects, a short timeout, a capped response read as a
stream, a generic User-Agent without data of the association or the user. Errors carry no
provider text and no URL (a URL can hold a query).
"""

import asyncio
import json
from typing import Any

import httpx

TIMEOUT_SECONDS = 10.0
MAX_RESPONSE_BYTES = 5_000_000
USER_AGENT = "apartment-association-platform"


class OutboundError(Exception):
    """The source did not answer usably: network, timeout, size, status or not JSON."""

    def __init__(self, reason: str, status: int | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


async def get_json(
    url: str,
    params: dict[str, str],
    allowed_hosts: frozenset[str],
    transport: httpx.AsyncBaseTransport | None = None,
) -> tuple[int, Any]:
    """GET `url` and return (status, parsed JSON); raise OutboundError otherwise.

    A 4xx answer with a JSON body is returned (the caller decides, e.g. "not found"); a 5xx, a
    body that is not JSON or is larger than MAX_RESPONSE_BYTES raises.
    """
    host = httpx.URL(url).host
    if host not in allowed_hosts or not url.startswith("https://"):
        raise OutboundError("HOST_NOT_ALLOWED")
    try:
        # One deadline for the whole exchange: httpx's timeout is per phase, so a source that
        # trickles bytes would otherwise keep the request open.
        async with asyncio.timeout(TIMEOUT_SECONDS):
            status, raw = await _exchange(url, params, transport)
    except TimeoutError:
        raise OutboundError("UNREACHABLE") from None
    if status >= 500 or 300 <= status < 400:
        raise OutboundError("BAD_STATUS", status)
    try:
        return status, json.loads(raw)
    except (ValueError, RecursionError):
        if 400 <= status < 500:
            return status, None  # the caller still sees the status (e.g. not found)
        raise OutboundError("NOT_JSON", status) from None


async def _exchange(
    url: str, params: dict[str, str], transport: httpx.AsyncBaseTransport | None
) -> tuple[int, bytes]:
    try:
        async with httpx.AsyncClient(
            timeout=TIMEOUT_SECONDS,
            follow_redirects=False,
            transport=transport,
            # identity: the size cap then counts what arrives, no compressed bomb is inflated
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
                "Accept-Encoding": "identity",
            },
        ) as client:
            async with client.stream("GET", url, params=params) as response:
                chunks: list[bytes] = []
                size = 0
                async for chunk in response.aiter_raw():
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise OutboundError("TOO_LARGE", response.status_code)
                    chunks.append(chunk)
                if response.headers.get("content-encoding", "identity") not in ("identity", ""):
                    raise OutboundError("ENCODED", response.status_code)
                return response.status_code, b"".join(chunks)
    except httpx.HTTPError:  # timeouts, connection errors; the text may hold the URL
        raise OutboundError("UNREACHABLE") from None
