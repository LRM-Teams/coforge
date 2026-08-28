# Local Centrifugo services

This Compose project starts three separate containers:

- `centrifugo/centrifugo:v6.9.2` — standalone WSS/RPC transport;
- `redis:8.2.6` — Centrifugo broker, presence, and hot-history backend.
- `postgres:18.6` — private PostgreSQL backend for CoForge canonical state.

Redis is reachable only on the private Compose network and uses a Docker
secret for its password. Centrifugo's token signing secret and HTTP API key
are also mounted as Docker secrets.
Centrifugo exposes its WebSocket and internal HTTP endpoint on the configured
local port (default `8000`). Backend proxy/API wiring is not included yet; the
service can therefore be health-checked and connected to, but business RPC
methods still require the future backend proxy configuration.

## Start

```bash
mkdir -p infra/secrets
openssl rand -hex 32 > infra/secrets/redis_password
openssl rand -hex 32 > infra/secrets/centrifugo_token_hmac_secret_key
openssl rand -hex 32 > infra/secrets/centrifugo_http_api_key
openssl rand -hex 32 > infra/secrets/postgres_password
docker compose -p coforge \
  -f infra/docker-compose.yml up -d
```

Check the rendered configuration and service health:

```bash
docker compose -p coforge \
  -f infra/docker-compose.yml config --quiet
docker compose -p coforge \
  -f infra/docker-compose.yml ps
curl http://localhost:8000/health
```

PostgreSQL is intentionally not published to the host. Containers on the
Compose network connect with `postgresql://coforge@postgres:5432/coforge` and
the password in `infra/secrets/postgres_password`.

Stop the services without deleting the Redis volume:

```bash
docker compose -p coforge \
  -f infra/docker-compose.yml down
```

The committed image versions are intentionally not `latest`. Production must
replace tags with reviewed immutable image digests before release.

Configuration follows the official [Centrifugo configuration guide](https://centrifugal.dev/docs/server/configuration),
[Redis engine guide](https://centrifugal.dev/docs/server/engines), and
[Docker installation guide](https://centrifugal.dev/docs/getting-started/installation).
