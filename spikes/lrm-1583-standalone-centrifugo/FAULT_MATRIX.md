# LRM-1589 fault and recovery matrix

This report was produced from immutable LRM-1583 baseline commit
`d106038e2e9cd04d0b764954bd55a354470374be`. The LRM-1589 additions are
disposable observability for this spike: Redis-backed presence and five-minute
hot history, loopback-only replica API ports, a read-only online-view endpoint,
and the repeatable fault runner. They do not define production architecture,
wire contracts, persistence, or deployment.

## Fixed versions and command

| Component                          | Version         |
| ---------------------------------- | --------------- |
| Centrifugo OSS                     | `v6.9.3`        |
| Redis                              | `7.4.5-alpine`  |
| Caddy                              | `2.10.2-alpine` |
| Bun backend/client and host runner | `1.4.0`         |
| `centrifuge-js`                    | `5.7.0`         |

Run from this directory:

```sh
/home/andong3/.local/share/mise/installs/bun/1.4.0/bin/bun run fault-matrix.ts
```

The runner validates Compose, executes the exact commands listed below, emits
one JSON object per observation, and finally removes its containers, network,
and volumes. The final measured run exited `0`; initial `up --build --wait`
took 7,311 ms and cleanup took 11,211 ms.

## Observations

### Backend rolling restart and full outage

Exact commands and elapsed times:

```text
docker compose -p lrm1589-fixed -f <artifact>/compose.yaml stop backend-a                 10,435 ms
docker compose -p lrm1589-fixed -f <artifact>/compose.yaml start backend-a                   425 ms
docker compose -p lrm1589-fixed -f <artifact>/compose.yaml stop backend-b                 10,452 ms
docker compose -p lrm1589-fixed -f <artifact>/compose.yaml start backend-b                   502 ms
docker compose -p lrm1589-fixed -f <artifact>/compose.yaml stop backend-a backend-b        10,517 ms
docker compose -p lrm1589-fixed -f <artifact>/compose.yaml start backend-a backend-b          469 ms
```

- With `backend-a` down, RPC recorded one transient failure and recovered via
  `backend-b` in 441 ms. With `backend-b` down, RPC succeeded via `backend-a`
  in 9 ms with zero failures.
- With both backends down, RPC failed explicitly in 557 ms. After both started,
  the first recovery probe succeeded in 11 ms with zero additional failures.
- Neither rolling restart nor the full backend outage produced a WebSocket
  connecting/disconnected event: the two existing WSS sessions stayed on
  Centrifugo.
- After both backends restarted, `/test-control/online` reconstructed the full
  tested view from Centrifugo/Redis: one Alice connection in
  `conversation:alpha` and one Bob connection in `conversation:beta`.

### Cross-replica broker, presence, and hot history

A client connected directly to `centrifugo-a` published through the backend;
the subscription connected directly to `centrifugo-b` received the same
`cross-replica-before-redis` publication. The presence APIs on both replicas
returned the same three Alice connection IDs. The history APIs on both replicas
returned the same epoch `GfIfeANW`, offsets 1 through 4, and the same four
publications.

### Redis restart

Exact commands and elapsed times:

```text
docker compose -p lrm1589-fixed -f <artifact>/compose.yaml stop redis    499 ms
docker compose -p lrm1589-fixed -f <artifact>/compose.yaml start redis   472 ms
```

- Publish failed explicitly while Redis was down. Both presence and history
  APIs returned Centrifugo error code 100 (`internal server error`). Existing
  WSS sessions emitted no disconnect/reconnect event.
- From the start command, publish recovered in 950 ms with zero failed recovery
  probes; total measured outage-to-observation recovery was 4,433 ms.
- The pre-restart history epoch `GfIfeANW` at offset 4 disappeared. The first
  post-restart query returned a new epoch `TjPBAVZf` at offset 0 with no old
  publications. Redis was configured with both RDB and AOF disabled, so this is
  expected hot-state loss, not message loss from a durable store.

### Centrifugo rolling restart

Exact commands and elapsed times:

```text
docker compose -p lrm1589-fixed -f <artifact>/compose.yaml restart centrifugo-a   5,823 ms
docker compose -p lrm1589-fixed -f <artifact>/compose.yaml restart centrifugo-b   5,826 ms
```

- Replica A's direct client emitted `connecting(code=3001) -> connected` and
  reconnected 6,117 ms after command start. Replica B emitted the same sequence
  and reconnected in 6,210 ms.
- RPC after A and B recovery succeeded with zero failures in 7 ms and 5 ms,
  respectively.
- After both restarts, both presence APIs again returned the same three Alice
  connections, demonstrating reconstruction through the shared Redis engine.

### Network interruption

Exact commands and elapsed times:

```text
docker network disconnect lrm1589-fixed_default lrm1589-fixed-edge-1             259 ms
docker network connect --alias edge lrm1589-fixed_default lrm1589-fixed-edge-1   129 ms
```

- During the edge network partition, three RPC probes failed over the 2.5-second
  observation window and no call was reported as successful.
- Both edge clients emitted `connecting(code=1) -> connected`. They reconnected
  about 4.0 seconds after interruption. End-to-end outage-to-RPC recovery was
  4,031 ms; the first post-reconnect RPC succeeded in 10 ms with zero failures.
- The reconstructed online view then contained all tested sessions: three Alice
  connections in alpha and one Bob connection in beta.

## Durability boundary

This standalone harness intentionally contains no PostgreSQL service and no
workspace-daemon spool. Its backend constructs deterministic objects named
`canonical:*` to test authorization ordering, but does not persist them. Those
objects are therefore simulations, not canonical durable messages.

The observed Redis restart changed the history epoch, discarded every prior hot
publication, and temporarily made presence/history unavailable while WSS
connections remained established. Consequently:

- Centrifugo plus Redis provide cross-replica fan-out, presence, and bounded hot
  recovery only.
- PostgreSQL must remain the backend's canonical message/delivery truth.
- The workspace-daemon durable inbox/outbox spool must remain the machine-side
  retry and takeover truth.

No delivery guarantee can be inferred from this spike's Redis history.
