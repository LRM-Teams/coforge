#!/usr/bin/env python3
"""Exit successfully only when a TCP endpoint cannot be connected to."""

from __future__ import annotations

import argparse
import errno
import socket


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("host")
    parser.add_argument("port", type=int)
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()

    try:
        connection = socket.create_connection((args.host, args.port), args.timeout)
    except TimeoutError:
        return
    except OSError as error:
        if error.errno in {
            errno.ECONNREFUSED,
            errno.EHOSTUNREACH,
            errno.ENETUNREACH,
            errno.ETIMEDOUT,
        }:
            return
        raise

    connection.close()
    raise SystemExit(f"TCP endpoint {args.host}:{args.port} accepted a connection")


if __name__ == "__main__":
    main()
