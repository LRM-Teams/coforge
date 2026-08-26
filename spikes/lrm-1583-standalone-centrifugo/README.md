# LRM-1583 standalone Centrifugo harness

This directory is disposable architecture evidence. It does not define the
CoForge production wire format, persistence schema, or deployment topology.
It is outside the root Bun workspaces, and its lockfile and candidate
dependencies are local to this directory.

## What it proves

The fixed Compose topology contains:

- one Caddy edge and consumer-visible WebSocket endpoint on
  `ws://127.0.0.1:18083/connection/websocket`;
- two standalone Centrifugo OSS replicas sharing one self-hosted Redis engine;
- two minimal Bun proxy-backend replicas behind the same edge; and
- one ephemeral Bun client image, enabled only by the `test` Compose profile.

The black-box test uses the official Protobuf client over the single edge. It
proves connect-proxy authentication, RPC proxying, backend server publish,
two subscriptions multiplexed on one connection, Redis-backed delivery across
the replica topology, and negative cross-conversation authorization.

The Bun backend owns every business decision in the harness:

- access tokens are mapped to users by the connect proxy;
- conversation membership is checked by subscribe and RPC proxies;
- `message.publish` simulates creation of a canonical message; and
- only after that simulation succeeds does the backend call Centrifugo's
  authenticated server publish API.

Centrifugo is transport and fan-out only. It has no PostgreSQL configuration,
driver, network route, or Compose dependency. Redis is ephemeral broker state,
not canonical message storage.

## Fixed versions

| Dependency         | Version         |
| ------------------ | --------------- |
| Centrifugo OSS     | `v6.9.3`        |
| Redis              | `7.4.5-alpine`  |
| Caddy              | `2.10.2-alpine` |
| Bun backend/client | `1.4.0-alpine`  |
| `centrifuge-js`    | `5.7.0`         |

The configuration follows the official Centrifugo documentation for
[HTTP event proxies](https://centrifugal.dev/docs/server/proxy),
[Protobuf WebSocket transport](https://centrifugal.dev/docs/transports/websocket),
[Redis engines](https://centrifugal.dev/docs/server/engines), and the
[server publish API](https://centrifugal.dev/docs/server/server_api). The client
uses the official [`centrifuge-js`](https://github.com/centrifugal/centrifuge-js)
Protobuf build.

## Run

From this directory:

```sh
./verify.sh
```

The script validates Compose, waits for the six core services, runs the real
client in the pinned Bun 1.4 image, and removes containers and volumes on exit.
The API key and tokens in this directory are inert disposable fixtures, not
deployable credentials.
