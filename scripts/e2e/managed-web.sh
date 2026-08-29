#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
secrets="$root/infra/secrets"

for file in redis_password centrifugo_http_api_key centrifugo_proxy_secret postgres_password; do
  test -s "$secrets/$file" || { printf 'E2E secret is missing: %s\n' "$file" >&2; exit 1; }
done

bun "$root/scripts/e2e/prepare-environment.ts"
postgres_password=$(<"$secrets/postgres_password")
redis_password=$(<"$secrets/redis_password")
export DATABASE_URL="postgresql://coforge:${postgres_password}@127.0.0.1:5432/coforge"
export REDIS_URL="redis://:${redis_password}@127.0.0.1:6379"
export COFORGE_WORKER_JWT_PRIVATE_JWK
COFORGE_WORKER_JWT_PRIVATE_JWK=$(<"$root/.amp/e2e/worker-private.jwk")
export COFORGE_WORKER_JWT_KEY_ID=coforge-e2e
export COFORGE_CENTRIFUGO_API_URL=http://127.0.0.1:8000/api
export COFORGE_CENTRIFUGO_API_KEY
COFORGE_CENTRIFUGO_API_KEY=$(<"$secrets/centrifugo_http_api_key")
export COFORGE_CENTRIFUGO_PROXY_SECRET
COFORGE_CENTRIFUGO_PROXY_SECRET=$(<"$secrets/centrifugo_proxy_secret")
export COFORGE_DEV_SKIP_AUTH=1
export NODE_ENV=development
export HOST=0.0.0.0
export PORT

for _ in $(seq 1 60); do
  if (: </dev/tcp/127.0.0.1/5432) 2>/dev/null; then break; fi
  sleep 1
done
cd "$root/apps/web"
bun run db:migrate:deploy
NODE_ENV=production bun run build
exec bun run ./scripts/dev-backend.ts
