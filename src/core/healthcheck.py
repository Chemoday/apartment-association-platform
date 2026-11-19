"""The Docker health check of the backend: `GET /health/ready` over a plain socket.

The compose files run it as `python -S -I /app/src/core/healthcheck.py`. Docker starts a new
process for every check, so the check must be cheap: without site packages (`-S`) and with only
the `socket` module it costs about half the CPU of a check with `urllib.request`
(docs/DEPLOYMENT.md, "Resource limits and disk hygiene"). Standard library only; it never imports
the application. Exit code 0 when the backend answers HTTP 200, 1 otherwise.
"""

import os
import socket
import sys

REQUEST = b"GET /health/ready HTTP/1.0\r\nHost: localhost\r\n\r\n"


def check(port: int, timeout: float = 3.0) -> bool:
    """True when 127.0.0.1:<port> answers the readiness probe with status 200."""
    try:
        # An IPv4 socket and connect(), not create_connection(): no name resolution, so the check
        # never imports the encodings and regular expressions that getaddrinfo needs.
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as conn:
            conn.settimeout(timeout)
            conn.connect(("127.0.0.1", port))
            conn.sendall(REQUEST)
            head = b""
            while b"\r\n" not in head and len(head) < 1024:
                chunk = conn.recv(1024)
                if not chunk:
                    break
                head += chunk
    except OSError:
        return False
    status_line = head.split(b"\r\n", 1)[0].split()
    return len(status_line) >= 2 and status_line[1] == b"200"


def main() -> int:
    # The same port as entrypoint.sh; -I ignores PYTHON* variables, not PORT.
    port = int(os.environ.get("PORT") or 8000)
    return 0 if check(port) else 1


if __name__ == "__main__":
    sys.exit(main())
