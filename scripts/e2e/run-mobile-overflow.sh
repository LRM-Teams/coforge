#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
secrets="$root/infra/secrets"
for file in redis_password postgres_password; do
  test -s "$secrets/$file" || { printf 'Run amp orb services ensure first.\n' >&2; exit 1; }
done

DATABASE_URL="postgresql://coforge:$(<"$secrets/postgres_password")@127.0.0.1:5432/coforge"
REDIS_URL="redis://:$(<"$secrets/redis_password")@127.0.0.1:6379"
export DATABASE_URL REDIS_URL
# The assertion is layout-only: no realtime, runtime, or provider is needed, and the
# seed-dev workspace already exists, so the full managed stack is unnecessary — just the
# web service serving the seeded database (managed-web.sh in another shell works too).
export COFORGE_E2E_WEB_URL="${COFORGE_E2E_WEB_URL:-http://127.0.0.1:8788}"

cd "$root/apps/web"
exec bun test ./test/e2e-mobile-no-horizontal-overflow.e2e.ts
