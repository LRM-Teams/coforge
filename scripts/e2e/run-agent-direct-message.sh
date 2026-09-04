#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
secrets="$root/infra/secrets"
for file in redis_password centrifugo_http_api_key centrifugo_proxy_secret postgres_password; do
  test -s "$secrets/$file" || { printf 'Run amp orb services ensure first.\n' >&2; exit 1; }
done

DATABASE_URL="postgresql://coforge:$(<"$secrets/postgres_password")@127.0.0.1:5432/coforge"
REDIS_URL="redis://:$(<"$secrets/redis_password")@127.0.0.1:6379"
export DATABASE_URL REDIS_URL
export COFORGE_WORKER_JWT_PRIVATE_JWK
COFORGE_WORKER_JWT_PRIVATE_JWK=$(<"$root/.amp/e2e/worker-private.jwk")
export COFORGE_WORKER_JWT_KEY_ID=coforge-e2e
export COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY_FILE="$root/.amp/e2e/agent-runtime-credential-key"
export COFORGE_CENTRIFUGO_API_URL=http://127.0.0.1:8000/api
export COFORGE_CENTRIFUGO_API_KEY
COFORGE_CENTRIFUGO_API_KEY=$(<"$secrets/centrifugo_http_api_key")
export COFORGE_CENTRIFUGO_PROXY_SECRET
COFORGE_CENTRIFUGO_PROXY_SECRET=$(<"$secrets/centrifugo_proxy_secret")
export COFORGE_E2E_ALLOW_RESET=1

cd "$root/apps/web"
bun run db:migrate:deploy
exec bun test ./test/e2e-agent-direct-message.e2e.ts
