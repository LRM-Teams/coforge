#!/usr/bin/env python3
"""Perform a strict WSS handshake and a close-frame exchange."""

from __future__ import annotations

import argparse
import base64
import hashlib
import os
import socket
import ssl
import struct
import time
from urllib.parse import urlsplit


GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class Deadline:
    def __init__(self, timeout: float) -> None:
        if timeout <= 0:
            raise ValueError("timeout must be positive")
        self.ends_at = time.monotonic() + timeout

    def remaining(self) -> float:
        remaining = self.ends_at - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("WSS smoke exceeded its total timeout")
        return remaining


def read_exact(stream: ssl.SSLSocket, length: int, deadline: Deadline) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        stream.settimeout(deadline.remaining())
        chunk = stream.recv(length - len(chunks))
        if not chunk:
            raise RuntimeError("WSS peer closed before completing a frame")
        chunks.extend(chunk)
    return bytes(chunks)


def read_headers(
    stream: ssl.SSLSocket, deadline: Deadline
) -> tuple[str, dict[str, str]]:
    response = bytearray()
    while b"\r\n\r\n" not in response:
        stream.settimeout(deadline.remaining())
        chunk = stream.recv(4096)
        if not chunk:
            raise RuntimeError("WSS peer closed before completing the handshake")
        response.extend(chunk)
        if len(response) > 65536:
            raise RuntimeError("WSS handshake headers exceed 64 KiB")
    head, _ = bytes(response).split(b"\r\n\r\n", 1)
    lines = head.decode("iso-8859-1").split("\r\n")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        name, separator, value = line.partition(":")
        if not separator:
            raise RuntimeError("malformed WSS response header")
        headers[name.lower()] = value.strip()
    return lines[0], headers


def masked_close_frame() -> bytes:
    payload = struct.pack("!H", 1000)
    mask = os.urandom(4)
    masked = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
    return bytes((0x88, 0x80 | len(payload))) + mask + masked


def verify(url: str, timeout: float) -> None:
    deadline = Deadline(timeout)
    parsed = urlsplit(url)
    if parsed.scheme not in {"https", "wss"} or not parsed.hostname:
        raise ValueError("URL must be an absolute https:// or wss:// URL")
    host = parsed.hostname
    port = parsed.port or 443
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    expected_accept = base64.b64encode(
        hashlib.sha1(f"{key}{GUID}".encode("ascii")).digest()
    ).decode("ascii")
    request = (
        f"GET {path} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Connection: Upgrade\r\n"
        "Upgrade: websocket\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Sec-WebSocket-Key: {key}\r\n\r\n"
    ).encode("ascii")

    context = ssl.create_default_context()
    with socket.create_connection((host, port), timeout=deadline.remaining()) as tcp:
        tcp.settimeout(deadline.remaining())
        with context.wrap_socket(tcp, server_hostname=host) as stream:
            stream.settimeout(deadline.remaining())
            stream.sendall(request)
            status, headers = read_headers(stream, deadline)
            if not status.startswith("HTTP/1.1 101 "):
                raise RuntimeError(f"unexpected WSS status: {status}")
            if headers.get("upgrade", "").lower() != "websocket":
                raise RuntimeError("WSS response is missing Upgrade: websocket")
            connection_tokens = {
                token.strip().lower()
                for token in headers.get("connection", "").split(",")
            }
            if "upgrade" not in connection_tokens:
                raise RuntimeError("WSS response is missing Connection: Upgrade")
            if headers.get("sec-websocket-accept") != expected_accept:
                raise RuntimeError("WSS response has an invalid Sec-WebSocket-Accept")

            stream.settimeout(deadline.remaining())
            stream.sendall(masked_close_frame())
            first, second = read_exact(stream, 2, deadline)
            if first & 0x0F != 0x08:
                raise RuntimeError("WSS peer did not answer with a close frame")
            if second & 0x80:
                raise RuntimeError("WSS server sent an invalid masked frame")
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", read_exact(stream, 2, deadline))[0]
            elif length == 127:
                length = struct.unpack("!Q", read_exact(stream, 8, deadline))[0]
            read_exact(stream, length, deadline)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()
    verify(args.url, args.timeout)


if __name__ == "__main__":
    main()
