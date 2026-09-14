#!/usr/bin/env bash
set -euo pipefail

# Local-only harness. It invokes the installed product and never
# imports app internals or registers rows directly in PostgreSQL.
# The compiled CLI performs the real computer:register RPC over Centrifugo.
root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
: "${COFORGE_E2E_WEB_URL:?Set COFORGE_E2E_WEB_URL to the trusted local HTTPS endpoint}"
: "${COFORGE_E2E_WORKSPACE_SLUG:?Set COFORGE_E2E_WORKSPACE_SLUG}"

if [[ "${COFORGE_E2E_ALLOW_INSTALL:-}" != 1 ]]; then
  echo 'Use a disposable OS user and set COFORGE_E2E_ALLOW_INSTALL=1: this installs and starts Computer for that user.' >&2
  exit 2
fi
if [[ "$(uname -s)" != Linux ]]; then
  echo 'This native setup harness currently verifies Linux/systemd only.' >&2
  exit 2
fi
if [[ "$HOME" != "$(getent passwd "$(id -u)" | cut -d: -f6)" ]]; then
  echo 'HOME must match the OS user and its systemd manager; use a disposable OS user, not a HOME override.' >&2
  exit 2
fi
systemctl --user show-environment >/dev/null
# The service manager, not the invoking shell, supplies child-process environment.
for variable in OPENROUTER_API_KEY NODE_EXTRA_CA_CERTS; do
  if [[ -n "${!variable:-}" ]]; then systemctl --user import-environment "$variable"; fi
done

mise exec -- bun run --cwd "$root/packages/protocol" generate
export COFORGE_E2E_CENTRIFUGO_ENDPOINT="${COFORGE_E2E_CENTRIFUGO_ENDPOINT:-ws://127.0.0.1:8000/connection/websocket}"
mise exec -- bun "$root/scripts/e2e/build-computer-fixture.ts"
version=$(mise exec -- bun -e 'console.log((await Bun.file(Bun.argv[1]).json()).version)' "$root/.amp/e2e/native-package/manifest.json")
"$root/.amp/e2e/bin/coforge-computer" __install-local --version "$version" --directory "$root/.amp/e2e/native-package"

# First use waits for the real browser device-code approval. Repeated runs reuse
# the normal credential store. No automatic approval or direct runtime start.
"$HOME/.coforge/computer/install/active/coforge-computer" setup --workspace "$COFORGE_E2E_WORKSPACE_SLUG" --json
systemctl --user is-active coforge-daemon.service
echo 'Native setup completed. Verify this Computer is Online and create an Agent in the browser.'
