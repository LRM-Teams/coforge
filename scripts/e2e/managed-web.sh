#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)

bun "$root/scripts/e2e/prepare-environment.ts"
# shellcheck source=scripts/e2e/e2e-env.sh
source "$root/scripts/e2e/e2e-env.sh"
export COFORGE_WEB_PUSH_PUBLIC_KEY
COFORGE_WEB_PUSH_PUBLIC_KEY=$(<"$root/.amp/e2e/web-push-public-key")
export COFORGE_WEB_PUSH_PRIVATE_KEY_FILE="$root/.amp/e2e/web-push-private-key"
export COFORGE_WEB_PUSH_SUBJECT=https://coforge.cn
export COFORGE_DEV_SKIP_AUTH=1
export COFORGE_E2E_ALLOW_DEVICE_AUTH=0
export NODE_ENV=development
export HOST=0.0.0.0
export PORT

for _ in $(seq 1 60); do
  if (: </dev/tcp/127.0.0.1/5432) 2>/dev/null; then break; fi
  sleep 1
done
bun run --cwd "$root/packages/coforge-sdk" generate
cd "$root/apps/web"
bun run db:migrate:deploy
NODE_ENV=production bun run build
bun run ./scripts/seed-dev-data.ts
exec bun run ./scripts/start-server.ts
