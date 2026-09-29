#!/usr/bin/env bash
# The environment every E2E runner shares: the managed stack's credentials, the Worker issuer and
# key material, and the Centrifugo API URL with the two secrets the Web and the tests call it with.
#
# Source it (`source "$root/scripts/e2e/e2e-env.sh"`), do not run it: it exports into the caller's
# shell and stops the run when a secret the stack writes is missing. A runner that *creates* those
# files first (`managed-web.sh` runs `prepare-environment.ts`) sources it after that.
#
#   DATABASE_URL, REDIS_URL, COFORGE_WORKER_JWT_PRIVATE_JWK, COFORGE_WORKER_JWT_KEY_ID,
#   COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY_FILE, COFORGE_CENTRIFUGO_API_URL,
#   COFORGE_CENTRIFUGO_API_KEY, COFORGE_CENTRIFUGO_PROXY_SECRET
#
# `e2e_root` and `e2e_secrets` are set for a runner that needs the paths (the Web Push pair, the
# `.amp/e2e` artifacts). One style in one place: a new required value is added here, not in each
# of the four runners that used to spell this block out.
e2e_root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
e2e_secrets="$e2e_root/infra/secrets"
for file in redis_password centrifugo_http_api_key centrifugo_proxy_secret postgres_password; do
  test -s "$e2e_secrets/$file" || { printf 'Run amp orb services ensure first.\n' >&2; exit 1; }
done

export DATABASE_URL
DATABASE_URL="postgresql://coforge:$(<"$e2e_secrets/postgres_password")@127.0.0.1:5432/coforge"
export REDIS_URL
REDIS_URL="redis://:$(<"$e2e_secrets/redis_password")@127.0.0.1:6379"
export COFORGE_WORKER_JWT_PRIVATE_JWK
COFORGE_WORKER_JWT_PRIVATE_JWK=$(<"$e2e_root/.amp/e2e/worker-private.jwk")
export COFORGE_WORKER_JWT_KEY_ID=coforge-e2e
export COFORGE_AGENT_CREDENTIAL_ENCRYPTION_KEY_FILE="$e2e_root/.amp/e2e/agent-runtime-credential-key"
# The standard stack publishes Centrifugo on 8000; a host where that port is taken passes
# COFORGE_CENTRIFUGO_API_URL instead, and the Web/WebSocket URLs the same way.
export COFORGE_CENTRIFUGO_API_URL="${COFORGE_CENTRIFUGO_API_URL:-http://127.0.0.1:8000/api}"
export COFORGE_CENTRIFUGO_API_KEY
COFORGE_CENTRIFUGO_API_KEY=$(<"$e2e_secrets/centrifugo_http_api_key")
export COFORGE_CENTRIFUGO_PROXY_SECRET
COFORGE_CENTRIFUGO_PROXY_SECRET=$(<"$e2e_secrets/centrifugo_proxy_secret")
