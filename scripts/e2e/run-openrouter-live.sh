#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
test -n "${OPENROUTER_API_KEY:-}" || {
  printf 'OPENROUTER_API_KEY must be provided by the caller\n' >&2
  exit 1
}
amp orb services ensure >/dev/null
# shellcheck source=scripts/e2e/e2e-env.sh
source "$root/scripts/e2e/e2e-env.sh"
unset COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY
exec mise exec -- bun test "$root/apps/web/test/e2e-openrouter-live.e2e.ts"
