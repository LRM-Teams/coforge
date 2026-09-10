#!/bin/sh
set -eu

# Production Nitro backend (compiled). Default: 127.0.0.1:8789
# Requires: ./scripts/build-prod.sh
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$root/scripts/lib/local-web.sh"

name=start-server.sh
web="$root/apps/web"
port=${PORT:-8789}

validate_local_web_port "$name" "$port"
prepare_local_web_runtime "$name"
replace_listener_on_port "$name" "$port"

export PORT="$port"
cd "$web"
exec bun run ./scripts/start-server.ts
