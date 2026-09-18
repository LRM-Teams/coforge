# ADR 0017: Computer upgrade as an explicit operation with a durable receipt

Status: accepted (amended by [ADR 0020](0020-upgrade-runner-hold.md) for runner quiescence,
[ADR 0030](0030-upgrade-identity-durable-snapshot.md) for durable identity/liveness, and
[ADR 0037](0037-upgrade-settlement-and-coordinator-shutdown.md) for receipt-before-Workspace-launch
ordering)
Date: 2026-09-16

## Context

A remote Computer upgrade begins as `ComputerUpgradeIntent` on the daemon WSS
(`COMPUTER_UPGRADE_METHOD = "computer:upgrade"`), reaches the Coordinator as the
`daemon:upgrade` local RPC, and is executed by an external one-shot job that
replaces the executable the Coordinator is running from (ADR 0007, and the
one-shot launchd/systemd job added in PR #255). Three things about that path
were wrong.

**The operation's identity travelled through the environment.** `main.ts`
parsed `__remote-upgrade --request-id … --version …` and wrote the values into
`Bun.env.COFORGE_UPGRADE_REQUEST_ID` / `COFORGE_UPGRADE_VERSION`;
`runRemoteUpgrade()` read them back, and both `launchUpgradeCoordinator` and
`coordinateUpgrade` carried `?? Bun.env.COFORGE_UPGRADE_REQUEST_ID` fallbacks.
An ambient, process-wide, untyped channel decided which operation a process was
running, so an inherited or stale variable could silently rename an operation,
and nothing in the type system said an operation needed an identity at all.

**Pending requests were never cleared.** `MachineSupervisor.recordUpgrade`
appended `{requestId, expectedVersion}` to `upgradeRequests` in
`~/.coforge/daemon/bindings.json` purely to deduplicate re-delivered intents.
Entries were never removed. On 2026-09-16 this machine was still carrying a
request for `0.1.0-dev.28` that had completed hours earlier; every Workspace
daemon start replayed it as a cloud "recovered upgrade" hint. Mutual exclusion
was left entirely to the updater's sqlite installation lock, so a second request
was not refused — it was launched and then failed deep inside the installer,
which is how the same incident produced a leftover `cn.coforge.upgrade.<id>`
job repeatedly retaking that lock.

**The Daemon never reported what happened.** The coordinator wrote
`~/.coforge/computer/install/upgrade-results/<id>.result.json` and nothing read
it. `RedisComputerUpgradeStore` could only infer an outcome from the Computer's
next identity, so a local failure was indistinguishable from a slow reconnect
and surfaced ten minutes later as `failed/timeout`. The server could not tell
"still running" from "finished and not coming back".

Raft Computer 1.0.32 is prior art for the shape of the fix: it models an update
as an operation with an identity, a receipt written to disk, a terminal state,
an explicit acknowledgement, and exclusion at the operation level rather than at
the installer. We adopt that shape. No Raft code, identifier, or wording is
used here; the names, protocol, and storage below are ours.

## Decision

**One operation object, constructed at the process boundary.**
`UpgradeOperation` (`packages/computer/src/release/upgrade-operation.ts`) is
`{ requestId, operation: "upgrade" | "rollback", selection, origin: "remote" | "cli", quiet }`.
`main.ts` builds it from `__remote-upgrade` arguments via
`parseRemoteUpgradeOperation`; the interactive commands build their own with
`crypto.randomUUID()`. `runRemoteUpgrade(operation)`,
`runUpgradeOperation(operation)` and `launchUpgradeCoordinator(operation, paths)`
take it explicitly, and `coordinateUpgrade` reads it out of the durable request
file it already reads. `createUpdateCommand` is now a thin CLI adapter over the
same function. `COFORGE_UPGRADE_REQUEST_ID` and `COFORGE_UPGRADE_VERSION` are
deleted, together with every `?? Bun.env…` fallback; a unit test fails if either
name reappears anywhere under `packages/computer/src`.

**`<id>.request.json` / `<id>.result.json` remain the only inter-process
channel.** The result receipt now names its own operation
(`request_id`), so a reader can refuse a file that belongs to a different one.

**Operation records in the Coordinator.** `upgradeRequests` is replaced by
`upgradeOperations`: `{ requestId, expectedVersion, state, terminal? }` with
`state` in `pending | succeeded | failed | acknowledged` and
`terminal = { version?, error?, at }`. `FileBindingStore` validates the shape,
refuses more than one `pending` record per binding, and reopens legacy
`upgradeRequests` entries as `pending` operations on load. Records are capped at
`UPGRADE_OPERATION_HISTORY` (128), newest last, so the `acknowledged` tail is
bounded audit history rather than unbounded state.

`recordUpgrade` now rejects a new request while another operation is pending,
naming the operation that holds the slot. Exclusion is an operation-level
decision made before anything is launched; the sqlite installation lock remains
only as the last defence against a process outside this path.

That slot is bounded. Each operation records `requestedAt`, and a pending
operation still without a receipt after `UPGRADE_OPERATION_PENDING_TTL_MS`
(30 minutes — the server gives a request up after ten, so the margin is
deliberate) is settled by the same sweep as `failed` with
`terminal.error = "expired without a receipt"`. Migrated legacy entries take the
migration time as their `requestedAt`, so a machine carrying a request whose job
never ran clears it at the next Coordinator start instead of refusing every
later upgrade. An operation with no `requestedAt` cannot be aged out, so the
validator fails closed on one. The expiry is reported to the server like any
other failure, which is the honest answer: this machine cannot claim the upgrade
succeeded.

**Receipts settle operations.** `sweepComputerUpgradeReceipts`
(`packages/daemon/src/platform/computer-upgrade-receipts.ts`) moves a pending
operation to `succeeded`/`failed` from its result file. The Coordinator runs it
at startup — a remote upgrade stops and replaces the Coordinator itself, so
startup is the first moment any process can observe what the previous one
launched — and polls for the specific receipt while a job it launched is still
running. Startup is the durable path; the poll is best-effort.

**Terminal results are reported and acknowledged.** New protobuf message
`ComputerUpgradeResult { protocol_major, request_id, workspace_id, computer_id,
status, completed_at_ms, message_type, version?, error? }`, sent over the
existing daemon RPC path as `computer:upgrade_result`. It is additive;
`protocol_major` stays `1`. `DaemonConnection.sendUpgradeResult` applies the same
replay discipline as the other lifecycle results: an already-reported operation
is dropped, a failed send stays replayable, and the set is cleared on reconnect.
The Workspace daemon reports every non-acknowledged terminal operation the
Coordinator handed it, right after its ready handshake.

The server's acceptance is the acknowledgement. On a successful RPC the Workspace
daemon calls the new `daemon:upgrade_ack` local RPC and the Coordinator marks the
record `acknowledged`, dropping it from the active set. A refused or failed
report leaves the record alone, so the next ready handshake retries it.

**The server never trusts a reported success on its own.**
`RedisComputerUpgradeStore.reported` settles a reported failure as
`failed` with reason `"reported"` and the error text. A reported success is only
corroborating evidence: it completes a request solely when the identity check
that already existed agrees — a worker instance different from the one that was
running, `expectedVersion === computerVersion`, and `computerVersion ===
daemonVersion`. Otherwise the request stays `accepted` and the ordinary ready
path completes it later. A settled request is never reopened by a late report.

**Reported failure text is sanitized at both ends.**
`sanitizeUpgradeErrorText` replaces absolute POSIX/Windows paths with `<path>`,
credential-shaped runs with `<redacted>`, collapses whitespace and truncates to
300 characters. The Daemon applies it on encode, the server on decode and again
before storing.

**The page shows availability, one loading state, and one terminal line.** The
Computer list carries no upgrade control: an available release shows as a small
brand badge on the Computer's tile, which becomes a spinner while that
Computer's operation is in flight and disappears once the new version is
reported. The upgrade itself is started from the detail panel, where the meta
line carries a brand "New version …" pill and the actions cluster a primary
"Upgrade to …" button. While the operation runs, the pill becomes a spinner with
"Upgrading…", both actions are disabled, and the button carries the Untitled UI
button's own loading state. Success shows the new version plus a brief inline
confirmation; failure shows one line with the reported reason and turns the
button into "Retry upgrade". No stage list, no request IDs, no timings in the
UI — those stay in the logs and the result files.

## Runner hold before an upgrade

This gap was closed by [ADR 0020](0020-upgrade-runner-hold.md). The Coordinator writes
`launch-hold`, fans a hold out to running Workspace daemons, and waits within a fixed bound for
in-flight Agent work to quiesce before stopping the old process tree. ADR 0037 further requires a
replacement Coordinator born under that hold to load bindings without starting Workspace children;
those children start only after terminal receipt commit and resume.

## Rejected alternatives

- **Keep the environment handoff and only add a receipt.** The ambient channel
  is the reason an operation could be misidentified; leaving it in place keeps
  the defect that makes the receipt hard to trust.
- **Trust a reported success.** The Computer reporting success proves the
  coordinator finished, not that the new version is running and healthy. The
  identity check stays mandatory.
- **Report the result from the Coordinator's own cloud connection.** The
  Coordinator has none; only the Workspace daemon holds the WSS connection
  (ADR 0004). Handing terminal operations to the child in its config keeps that
  invariant.
- **Clear a pending operation on a timer.** A timer cannot distinguish a slow
  upgrade from a dead one. The receipt can.

## Consequences and migration

- **Computer and Web must ship together.** The Daemon only calls
  `computer:upgrade_result` if the server exposes it; an older server answers
  "method not found", the report is left unacknowledged, and the operation is
  retried on every ready handshake until a deployed server accepts it. It never
  corrupts state, but the failure reason stays invisible until Web is deployed.
- Older Computers keep working unchanged: `ComputerUpgradeIntent` and the ready
  handshake are untouched, and a server that never receives a result falls back
  to today's identity-only completion and `failed/timeout`.
- Existing `bindings.json` files migrate on first load; the stale
  `0.1.0-dev.28` request becomes a pending operation whose receipt (still on
  disk) settles it at the next Coordinator start.
- One pending operation per binding is now enforced, so a user who clicks
  Upgrade twice gets a clear refusal rather than a second job racing the lock.

## Validation and rollback

Validated by unit tests over each seam: operation construction from argv and the
absence of the environment names; the request file carrying the identity and an
unrelated environment UUID being ignored; binding-store validation, legacy
migration, state transitions, concurrent-pending rejection and the record cap;
the result message's encoding, dedupe and sanitization; and the server's
reported-failure, reported-success-without-identity and
reported-success-with-identity paths. No live remote upgrade was executed end to
end for this change.

Rollback is by revert. The only persisted change is `upgradeOperations` in
`bindings.json`. A reverted Daemon's validator ignores the unknown field, so it
starts cleanly, but it also loses the record: dedupe falls back to
`DaemonConnection`'s in-memory request set, and completion falls back to the
identity-only path. A reverted machine carrying an unacknowledged terminal
operation simply stops reporting it. Re-upgrading such a machine after a
rollback should be done once the Coordinator has restarted, so the in-memory
dedupe set is the only thing in play.

The upgrade identity key's expiry and the liveness check performed before a new upgrade request
begins are superseded by [ADR 0030](0030-upgrade-identity-durable-snapshot.md).

The settlement-timing flaw in this record's own design - the Coordinator that launches a job is
never the one that gets to see its receipt, and the startup sweep here ran too early to see it
either - together with the Coordinator outliving its own shutdown, is fixed by
[ADR 0037](0037-upgrade-settlement-and-coordinator-shutdown.md), which keeps watching after startup
instead of only once.
