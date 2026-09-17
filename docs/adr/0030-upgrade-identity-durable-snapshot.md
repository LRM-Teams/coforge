# ADR 0030: Computer upgrade identity is a durable snapshot, not a leased liveness signal

Status: accepted
Date: 2026-09-17
Supersedes: parts of [ADR 0017](0017-computer-upgrade-operation-receipt.md) (the upgrade
identity key's expiry, and a missing identity standing in for "offline" before a new request begins)

## Context

Staging incident, 2026-09-17: Computer `s144` showed a green online dot (Computer presence was
current) but a new upgrade request was refused with `COMPUTER_OFFLINE`. `RedisComputerUpgradeStore`
stored the Computer's process identity (`workerInstanceId`, `computerVersion`, `daemonVersion`,
`startedAt`) on the same key the pre-fix code leased for `COMPUTER_STATUS_LEASE_MS` (90 seconds, 3x
the Daemon's periodic status interval) - aligned with presence's lease by PR #266, but only `ready()`
could create or replace that key; `touchIdentity()` (called on every accepted periodic status) could
only **renew** an existing lease, never re-create a lost one. Once the identity key expired on a
Computer that stayed connected for more than 90 seconds without a fresh `ready()` - the ordinary case
for a long-lived connection - it never came back until the Daemon's next reconnect, and every upgrade
request in between failed as `COMPUTER_OFFLINE` even though the Computer was visibly online.

Constraints:

- `begin()` and `COMMIT_READY` read and write the identity key and the request key together; the
  identity key must remain readable/writable through the same Redis client the request store already
  uses, without a second store, transaction, or database round trip.
- Computer presence (`computer-status.server.ts`) already exists as an independent, self-healing
  liveness signal: `RedisComputerStatusCache` re-leases a 90-second TTL on every periodic Daemon
  status, unrelated to the upgrade identity key.
- `computer-restart-store.server.ts` already stores its own process identity as a durable,
  monotonically-overwritten key with no expiry (`STORE_NEWER_IDENTITY` there never carries `EX`), so
  precedent for this shape already exists in this codebase.

## Decision

Identity is a durable snapshot, not a liveness signal, the same way `computer-restart-store.server.ts`
already treats its own process identity:

- `ready()` still overwrites the identity key monotonically (newer `startedAt` wins; same `startedAt`
  requires the same `workerInstanceId`), but the key is written with no expiry (`SET` without `EX`).
- Computer presence is now the only liveness signal consulted before **beginning** a new upgrade
  request: `upgradeComputer` (via the extracted `UpgradeComputer.execute`) checks
  `ComputerStatusCache.get(scope)` and rejects with `AppError("COMPUTER_OFFLINE")` when it reads
  false. The upgrade identity snapshot is never consulted for liveness.
- A present Computer that has never reported an identity (a genuinely different failure - the Computer
  is online but `RedisComputerUpgradeStore.begin()` has nothing to compare `ready()` outcomes against)
  now fails with the distinct `AppError` code `COMPUTER_IDENTITY_UNKNOWN` (409, with restart guidance
  in its message), instead of the misleading `COMPUTER_OFFLINE`.
- An existing `requestId` is answered from the stored request status before the liveness check runs at
  all - a retried poll for a request that is itself mid-restart must not be refused because presence
  currently reads false.

## Rejected alternatives

- **Move identity onto the Computer's Postgres row.** `COMMIT_READY` writes the request record and the
  identity together as one atomic Lua script; splitting identity into Postgres would require a
  cross-store transaction (or accept a window where the two disagree) for every completed upgrade and
  every `ready()`.
- **Carry identity fields in the periodic status RPC so Web can re-create the key.** This is a wire
  protocol change and does not help a Computer that is already connected and already stuck on an
  already-deployed Daemon - only a future `ready()` (which happens on reconnect) would supply the
  fields the fix needs today.
- **Fall back to `computer-restart-store.server.ts`'s identity in `begin()`.** The two stores track the
  same underlying fact through different keys for different operations; reaching across stores couples
  them for a workaround. Whether to merge them into one identity store is a separate decision, not
  bundled into this fix.
- **Keep the lease and only lengthen its TTL.** Any finite lease reintroduces the same failure mode for
  a Computer connected longer than the TTL; only removing the expiry removes the class of bug.

## Consequences and migration plan

- Identity keys written by a Web deploy older than this change still carry a 90-second TTL. Because
  Daemons do not reconnect merely because Web deployed, a Computer that stays connected across the
  deploy would otherwise keep that stale lease until it happened to reconnect on its own.
  `touchIdentity()` stays as a **transitional** step - unchanged name, since it will be deleted rather
  than renamed - that re-`SET`s the currently stored identity value with no expiry on every accepted
  periodic status, through the same monotonic guard `ready()` uses so a concurrent, genuinely newer
  `ready()` is never clobbered by a stale renewal.
- **Follow-up**: remove `touchIdentity()` and its wiring in `rpc-handler.server.ts` once every
  connected Computer has re-sent `ready()` at least once after this change ships (the point at which no
  identity key anywhere still carries a legacy TTL).
- Identity keys for deleted Computers are not cleaned up, the same accepted cost
  `computer-restart-store.server.ts` already carries for its own identity key.
- A Computer that already lost its identity before this change ships needs one Restart (or any
  reconnect) to re-report `ready()` and clear `COMPUTER_IDENTITY_UNKNOWN`.
- The code comment in `computers.functions.ts` (now `upgrade-computer.server.ts`) that pointed at ADR
  0017 for the presence-decides-liveness rule now points at this record instead.

## Validation and rollback criteria

Validated by unit tests over `RedisComputerUpgradeStore` (identity write carries no TTL argument,
`touchIdentity` is a no-op for a Computer with no identity on record and never clobbers a fresher
concurrent `ready()`) and over the extracted `UpgradeComputer.execute` seam (present Computer accepted
and published; absent Computer rejected with `COMPUTER_OFFLINE` and nothing registered or published; an
existing `requestId` answered from stored status even while presence reads false, with no second
publish; present Computer with no identity rejected with `COMPUTER_IDENTITY_UNKNOWN`; a publish failure
marks the request `failed/publication` and still propagates). A run against real Redis showed the
identity key's TTL at `-1` (no expiry) after `ready()`, a legacy 90-second TTL cleared by
`touchIdentity()`, and `COMMIT_READY` completing normally with the request key's TTL still `600`
(10 minutes, unrelated and unchanged).

Rollback is a plain revert. Keys already written without an expiry are harmless to the reverted code:
it re-applies its own `EX` argument on the next `ready()` or `touchIdentity()` call for that Computer,
so the durable snapshot degrades back into a lease rather than causing an error.
