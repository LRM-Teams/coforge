#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
# shellcheck source=scripts/e2e/e2e-env.sh
source "$root/scripts/e2e/e2e-env.sh"
export COFORGE_E2E_ALLOW_RESET=1

cd "$root/apps/web"
bun run db:migrate:deploy
exec bun test ./test/e2e-agent-direct-message.e2e.ts
