#!/usr/bin/env python3

from __future__ import annotations

import base64
import hashlib
import importlib.util
from pathlib import Path


module_path = Path(__file__).with_name("wss_smoke.py")
spec = importlib.util.spec_from_file_location("wss_smoke", module_path)
assert spec is not None and spec.loader is not None
wss_smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(wss_smoke)


class FakeSocket:
    def __init__(self, mode: str = "valid") -> None:
        self.mode = mode
        self.buffer = bytearray()
        self.send_count = 0

    def __enter__(self) -> FakeSocket:
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def settimeout(self, _: float) -> None:
        return None

    def sendall(self, payload: bytes) -> None:
        self.send_count += 1
        if self.send_count == 1:
            key = next(
                line.split(": ", 1)[1]
                for line in payload.decode("ascii").split("\r\n")
                if line.startswith("Sec-WebSocket-Key:")
            )
            accept = base64.b64encode(
                hashlib.sha1(f"{key}{wss_smoke.GUID}".encode("ascii")).digest()
            ).decode("ascii")
            if self.mode == "bad-accept":
                accept = "invalid"
            connection = "Upgrade" if self.mode != "bad-connection" else "close"
            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                f"Connection: {connection}\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            )
            self.buffer.extend(response.encode("ascii"))
        elif self.mode != "missing-close":
            self.buffer.extend(b"\x88\x02\x03\xe8")

    def recv(self, length: int) -> bytes:
        chunk = bytes(self.buffer[:length])
        del self.buffer[:length]
        return chunk


class FakeContext:
    def __init__(self, stream: FakeSocket) -> None:
        self.stream = stream

    def wrap_socket(self, _: FakeSocket, server_hostname: str) -> FakeSocket:
        assert server_hostname == "example.test"
        return self.stream


def run(mode: str) -> None:
    stream = FakeSocket(mode)
    original_connect = wss_smoke.socket.create_connection
    original_context = wss_smoke.ssl.create_default_context
    try:
        wss_smoke.socket.create_connection = lambda *_args, **_kwargs: stream
        wss_smoke.ssl.create_default_context = lambda: FakeContext(stream)
        wss_smoke.verify("wss://example.test/v1/connect", 1)
    finally:
        wss_smoke.socket.create_connection = original_connect
        wss_smoke.ssl.create_default_context = original_context


run("valid")
for invalid_mode in ("bad-accept", "bad-connection", "missing-close"):
    try:
        run(invalid_mode)
    except RuntimeError:
        continue
    raise AssertionError(f"WSS smoke accepted invalid case: {invalid_mode}")

print("WSS smoke tests passed")
