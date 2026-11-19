"""The Docker health check of the backend (src/core/healthcheck.py; docs/DEPLOYMENT.md "Resource
limits and disk hygiene", issue #166).

The check runs as its own process without site packages, so it is tested both as a function and
as `python -S -I <file>` against a tiny local server.
"""

import os
import socket
import socketserver
import subprocess
import sys
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest

from src.core import healthcheck

SCRIPT = Path(healthcheck.__file__)


class _Handler(socketserver.BaseRequestHandler):
    reply: bytes = b""
    seen: list[bytes] = []

    def handle(self) -> None:
        self.seen.append(self.request.recv(1024))
        if self.reply:
            # Byte by byte: the check must not depend on getting the status line in one recv.
            for byte in self.reply:
                self.request.sendall(bytes([byte]))


@pytest.fixture
def server() -> Iterator[tuple[int, type[_Handler]]]:
    handler = type("Handler", (_Handler,), {"reply": b"", "seen": []})
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as srv:
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        try:
            yield srv.server_address[1], handler
        finally:
            srv.shutdown()


@pytest.mark.parametrize(
    ("reply", "healthy"),
    [
        (b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{}", True),
        (b"HTTP/1.0 200 OK\r\n\r\n", True),
        (b"HTTP/1.1 503 Service Unavailable\r\n\r\n", False),
        (b"HTTP/1.1 2000 Odd\r\n\r\n", False),
        (b"garbage", False),
        (b"", False),  # the connection closes without an answer
    ],
)
def test_only_status_200_is_healthy(
    server: tuple[int, type[_Handler]], reply: bytes, healthy: bool
) -> None:
    port, handler = server
    handler.reply = reply

    assert healthcheck.check(port) is healthy
    assert handler.seen[0].startswith(b"GET /health/ready HTTP/1.0\r\n")


def test_nothing_listening_is_unhealthy() -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]  # closed again before the check

    assert healthcheck.check(port, timeout=1) is False


def test_a_server_that_never_answers_times_out(server: tuple[int, type[_Handler]]) -> None:
    port, handler = server
    handler.handle = lambda self: threading.Event().wait(2)  # type: ignore[method-assign]

    assert healthcheck.check(port, timeout=0.3) is False


@pytest.mark.parametrize(
    ("reply", "code"), [(b"HTTP/1.1 200 OK\r\n\r\n", 0), (b"HTTP/1.1 500 x\r\n\r\n", 1)]
)
def test_it_runs_without_site_packages_on_the_port_of_the_backend(
    server: tuple[int, type[_Handler]], reply: bytes, code: int
) -> None:
    """As the compose files run it: python -S -I <file>, the port from PORT."""
    port, handler = server
    handler.reply = reply

    result = subprocess.run(
        [sys.executable, "-S", "-I", str(SCRIPT)],
        env={"PATH": os.environ.get("PATH", ""), "PORT": str(port)},
        capture_output=True,
        timeout=10,
    )

    assert result.returncode == code, result.stderr


def test_it_imports_nothing_of_the_application() -> None:
    """The check never pays for importing the backend or third-party packages."""
    source = SCRIPT.read_text()
    imports = {line.split()[1] for line in source.splitlines() if line.startswith("import ")}

    assert imports == {"os", "socket", "sys"}
    assert not any(line.startswith("from ") for line in source.splitlines())
    assert "socket.create_connection(" not in source  # no name resolution (no idna, no re)
