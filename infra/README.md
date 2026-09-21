# Local Centrifugo services

This Compose project starts four separate containers:

- `centrifugo/centrifugo:v6.9.2` — standalone WSS/RPC transport;
- `redis:8.2.6` — Centrifugo broker/presence/hot-history backend and Web message-request idempotency store.
- `postgres:18.6` — private PostgreSQL backend for CoForge canonical state.
- `causal-memory` — one private Rust HTTP runtime with a persistent SQLite volume; it is exposed only on `127.0.0.1:${CAUSAL_MEMORY_PORT:-9938}` for a host-run Web server and never through Caddy.

Redis is reachable on the private Compose network and from the host only through
`127.0.0.1:${REDIS_PORT:-6379}`; it is never bound to a public interface. It uses a Docker
secret for its password. Centrifugo's HTTP API key and the backend proxy
shared secret are also mounted as Docker secrets. Daemon connections use the
backend Connect Proxy and a Daemon API key supplied in connection data;
Centrifugo does not hold the private key used by the separate Computer
registration flow.
Centrifugo exposes its WebSocket and internal HTTP endpoint on the configured
local port (default `8000`). The RPC proxy and JWKS endpoints are configured
for a Web backend on the local host. Set
`COFORGE_RPC_PROXY_ENDPOINT` and `COFORGE_WORKER_JWKS_ENDPOINT` when the Web
backend is not running on the default local host endpoints.

Message sends from a host-run Web backend require an explicit `REDIS_URL`; read
paths do not. Use the same password stored in `infra/secrets/redis_password`, URL-encoded
when necessary, for example `redis://:<password>@127.0.0.1:${REDIS_PORT:-6379}`.
Do not commit that runtime value or print the password in logs.

## Start

Build the reviewed local runtime skeleton first (W1-A must later replace its
extension revision as described in [the Causal Memory operations runbook](../docs/operations/causal-memory-runtime.md)):

```bash
checkout=/home/zhoujie22/river2_0/causal-memory
base=9657b2414ce7c56047d8273c9c0c8ebaf63985ee
[ "$(git -C "$checkout" rev-parse HEAD)" = "$base" ]
docker build \
  --build-arg "CAUSAL_MEMORY_REVIEWED_COMMIT=$base" \
  --build-arg "CAUSAL_MEMORY_EXTENSION_REVISION=$base" \
  -f infra/causal-memory/Dockerfile \
  -t coforge-causal-memory:reviewed-9657b24 "$checkout"

mkdir -p infra/secrets
openssl rand -hex 32 > infra/secrets/redis_password
openssl rand -hex 32 > infra/secrets/centrifugo_http_api_key
openssl rand -hex 32 > infra/secrets/centrifugo_proxy_secret
openssl rand -hex 32 > infra/secrets/postgres_password
# Provision these two files from the approved secret manager; do not generate,
# print, or commit example values.
# infra/secrets/coforge_causal_memory_tenant_tokens
# infra/secrets/coforge_causal_memory_distill_model_api_key
COFORGE_CAUSAL_MEMORY_IMAGE=coforge-causal-memory:reviewed-9657b24 \
  docker compose -p coforge -f infra/docker-compose.yml up -d
```

A host-run Web server uses `COFORGE_CAUSAL_MEMORY_URL=http://127.0.0.1:${CAUSAL_MEMORY_PORT:-9938}` and reads its tenant map through `COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE`; both values are server-only. A containerized Web server instead uses the internal DNS URL `http://causal-memory:9938`.

Check the rendered configuration and service health:

```bash
COFORGE_CAUSAL_MEMORY_IMAGE=coforge-causal-memory:reviewed-9657b24 \
  docker compose -p coforge -f infra/docker-compose.yml config --quiet
COFORGE_CAUSAL_MEMORY_IMAGE=coforge-causal-memory:reviewed-9657b24 \
  docker compose -p coforge -f infra/docker-compose.yml ps
curl --fail http://127.0.0.1:${CAUSAL_MEMORY_PORT:-9938}/healthz
curl --fail http://127.0.0.1:${CAUSAL_MEMORY_PORT:-9938}/readyz
```

PostgreSQL is intentionally not published to the host. Containers on the
Compose network connect with `postgresql://coforge@postgres:5432/coforge` and
the password in `infra/secrets/postgres_password`.

Stop the services without deleting the Redis, PostgreSQL, or Causal Memory volumes:

```bash
COFORGE_CAUSAL_MEMORY_IMAGE=coforge-causal-memory:reviewed-9657b24 \
  docker compose -p coforge -f infra/docker-compose.yml down
```

The committed image versions are intentionally not `latest`. Production must
replace tags with reviewed immutable image digests before release.

## Agent direct-message E2E

The orb service declaration starts an isolated `coforge-e2e` Compose project,
publishes its PostgreSQL port only on loopback, migrates and builds the Web
backend, and enables the fixed development test identity. Generated secrets
and the E2E database are local-only and must not be reused for production.

Run the complete slice with:

```bash
mise run test:e2e:agent-direct-message
```

The test resets only the managed E2E PostgreSQL and Redis instances. It covers
Workspace registration, scoped Worker WSS authentication, ready recovery,
Agent process startup, User-to-Agent persistence and attention delivery,
acceptance ACK, Agent check/read/send through the local proxy and HTTPS Agent
identity, request-id retries, and server-rendered chat output.

Configuration follows the official [Centrifugo configuration guide](https://centrifugal.dev/docs/server/configuration),
[Redis engine guide](https://centrifugal.dev/docs/server/engines), and
[Docker installation guide](https://centrifugal.dev/docs/getting-started/installation).
