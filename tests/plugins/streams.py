"""A response whose body arrives as a stream, as from the network (outbound reads it raw)."""

import json

import httpx


def streamed(status: int, *, json_body=None, text=None, content=None, headers=None):
    if json_body is not None:
        body = json.dumps(json_body).encode()
    elif text is not None:
        body = text.encode()
    else:
        body = content or b""
    return httpx.Response(status, stream=httpx.ByteStream(body), headers=headers)
