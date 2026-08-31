#!/usr/bin/env bash
set -euo pipefail

# Destructive, local-only harness. It invokes the compiled products and never
# imports app internals or registers rows directly in PostgreSQL.
# The compiled CLI performs the real computer:register RPC over Centrifugo.
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
: "${COFORGE_E2E_WEB_URL:?Set COFORGE_E2E_WEB_URL to the local Web portal}"
: "${COFORGE_E2E_WORKSPACE_SLUG:?Set COFORGE_E2E_WORKSPACE_SLUG}"
: "${COFORGE_E2E_HOME:=$root/.amp/e2e/computer-home}"

if [[ "${COFORGE_E2E_ALLOW_DEVICE_AUTH:-}" != 1 ]]; then
  echo 'Refusing E2E device authorization: set COFORGE_E2E_ALLOW_DEVICE_AUTH=1 explicitly.' >&2
  exit 2
fi

mise run build:computer
bun run --cwd apps/coforge-daemon build
mkdir -p "$COFORGE_E2E_HOME"
export HOME="$COFORGE_E2E_HOME"
export COFORGE_SETUP_INTENT
COFORGE_SETUP_INTENT=$(COFORGE_E2E_WORKSPACE_SLUG="$COFORGE_E2E_WORKSPACE_SLUG" bun -e \
  'console.log(JSON.stringify({workspaceSlug: Bun.env.COFORGE_E2E_WORKSPACE_SLUG}))')
export COFORGE_E2E_DAEMON_EXECUTABLE="$root/apps/coforge-daemon/dist/coforge-daemon"
export COFORGE_E2E_CENTRIFUGO_ENDPOINT="ws://127.0.0.1:8000/connection/websocket"
export COFORGE_E2E_DAEMON_CONNECTION_ENDPOINT="$COFORGE_E2E_CENTRIFUGO_ENDPOINT"
export COFORGE_DAEMON_CONNECTION_ENDPOINT="$COFORGE_E2E_DAEMON_CONNECTION_ENDPOINT"
export COFORGE_DAEMON_HOME="$COFORGE_E2E_HOME/.coforge/daemon"

"$root/apps/coforge-computer/dist/coforge-computer" setup --server "$COFORGE_E2E_WEB_URL" --json
echo 'setup completed; waiting for the Web computer view to observe Online'
"$root/scripts/e2e/wait-for-online.sh" "$COFORGE_E2E_WEB_URL" "$COFORGE_E2E_WORKSPACE_SLUG"
