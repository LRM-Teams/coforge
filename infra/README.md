# Local Centrifugo services

This Compose project starts three separate containers:

- `centrifugo/centrifugo:v6.9.2` — standalone WSS/RPC transport;
- `redis:8.2.6` — Centrifugo broker/presence/hot-history backend and Web message-request idempotency store.
- `postgres:18.6` — private PostgreSQL backend for CoForge canonical state.

Redis is reachable on the private Compose network and from the host only through
`127.0.0.1:${REDIS_PORT:-6379}`; it is never bound to a public interface. It uses a Docker
secret for its password. Centrifugo's HTTP API key and the backend proxy
shared secret are also mounted as Docker secrets. Worker connection JWTs are
verified through the backend's public JWKS endpoint; Centrifugo does not hold
the Worker signing private key.
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

```bash
mkdir -p infra/secrets
openssl rand -hex 32 > infra/secrets/redis_password
openssl rand -hex 32 > infra/secrets/centrifugo_http_api_key
openssl rand -hex 32 > infra/secrets/centrifugo_proxy_secret
openssl rand -hex 32 > infra/secrets/postgres_password
docker compose -p coforge \
  -f infra/docker-compose.centrifugo.yml up -d
```

Check the rendered configuration and service health:

```bash
docker compose -p coforge \
  -f infra/docker-compose.centrifugo.yml config --quiet
docker compose -p coforge \
  -f infra/docker-compose.centrifugo.yml ps
curl http://localhost:8000/health
```

PostgreSQL is intentionally not published to the host. Containers on the
Compose network connect with `postgresql://coforge@postgres:5432/coforge` and
the password in `infra/secrets/postgres_password`.

Stop the services without deleting the Redis volume:

```bash
docker compose -p coforge \
  -f infra/docker-compose.centrifugo.yml down
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
