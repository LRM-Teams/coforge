#!/bin/sh
set -eu

# Production Nitro frontend (compiled). Default: 127.0.0.1:8788
# Requires: ./scripts/build-prod.sh
# Alias: ./scripts/start-web.sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
exec "$root/scripts/start-web.sh"
