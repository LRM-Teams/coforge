#!/bin/sh
set -eu

# Daily Web UI + control-plane Vite server. Default: 127.0.0.1:8788
root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$root/scripts/lib/local-web.sh"

name=dev-frontend.sh
web="$root/apps/web"
port=${PORT:-8788}

validate_local_web_port "$name" "$port"
prepare_local_web_runtime "$name"
replace_listener_on_port "$name" "$port"

export PORT="$port"
cd "$web"
exec bun run ./scripts/dev-frontend.ts
