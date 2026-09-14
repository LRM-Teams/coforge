#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd)
secrets="$root/infra/secrets"
test -n "${OPENROUTER_API_KEY:-}" || {
  printf 'OPENROUTER_API_KEY must be provided by the caller\n' >&2
  exit 1
}
amp orb services ensure >/dev/null
export DATABASE_URL="postgresql://coforge:$(<"$secrets/postgres_password")@127.0.0.1:5432/coforge"
export REDIS_URL="redis://:$(<"$secrets/redis_password")@127.0.0.1:6379"
export COFORGE_WORKER_JWT_PRIVATE_JWK="$(<"$root/.amp/e2e/worker-private.jwk")"
export COFORGE_WORKER_JWT_KEY_ID=coforge-e2e
unset COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY
export COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY_FILE="$root/.amp/e2e/agent-runtime-credential-key"
export COFORGE_CENTRIFUGO_API_URL=http://127.0.0.1:8000/api
export COFORGE_CENTRIFUGO_API_KEY="$(<"$secrets/centrifugo_http_api_key")"
export COFORGE_CENTRIFUGO_PROXY_SECRET="$(<"$secrets/centrifugo_proxy_secret")"
exec mise exec -- bun test "$root/apps/web/test/e2e-openrouter-live.e2e.ts"
