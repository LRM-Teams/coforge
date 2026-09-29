#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
# shellcheck source=scripts/e2e/e2e-env.sh
source "$root/scripts/e2e/e2e-env.sh"
# The standard stack publishes Web on 8789 and Centrifugo on 8000; hosts where those host ports are
# taken pass these instead (the Centrifugo API URL is the same knob e2e-env.sh reads).
export COFORGE_E2E_SERVER_HTTP_URL="${COFORGE_E2E_SERVER_HTTP_URL:-http://127.0.0.1:8789}"
export COFORGE_E2E_CENTRIFUGO_WS_URL="${COFORGE_E2E_CENTRIFUGO_WS_URL:-ws://127.0.0.1:8000/connection/websocket}"
curl --fail --silent "${COFORGE_CENTRIFUGO_API_URL%/api}"/health >/dev/null
curl --fail --silent "${COFORGE_E2E_SERVER_HTTP_URL}"/health >/dev/null

cd "$root/apps/web"
bun run db:migrate:deploy
exec bun test ./test/e2e-mention-delivery.e2e.ts
