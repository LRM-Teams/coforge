#!/bin/sh
set -eu

# Production Nitro backend (compiled). Default: 127.0.0.1:8789
# Requires: ./scripts/build-prod.sh
# Alias: ./scripts/start-server.sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
exec "$root/scripts/start-server.sh"
