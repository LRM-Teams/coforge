# ADR 0037: The Coordinator keeps settling Computer upgrades after startup, and exits when it says it has

Status: accepted
Date: 2026-09-17

## Context

Two incidents on 2026-09-17, both on machines running the receipt model from
[ADR 0017](0017-computer-upgrade-operation-receipt.md).

**A successful remote upgrade was never settled.** macOS dev.36 → dev.37 and
Linux dev.35 → dev.36 both **succeeded** (`result.json` `status: "succeeded"`),
yet `bindings.json` kept the operation `state: "pending"` afterwards. On the
Linux machine the next remote upgrade was refused twice with `Computer upgrade
operation <id> is still pending; wait for it to finish before starting
another`, and the web UI showed "The Computer did not report the new version
in time."

The cause is a timing gap in ADR 0017's own design, not a defect in any one
function. `sweepComputerUpgradeReceipts` is run twice: once at Coordinator
startup (`settlePendingUpgradeOperations`, before the local RPC server even
starts), and once by an in-process `watchUpgradeReceipt` bounded to 10 minutes,
owned by the very Coordinator that launched the job. But
`packages/computer/src/release/upgrade-coordinator.ts`'s `performSwitch` writes
the result receipt **after** `lifecycle.start()` (the new Coordinator comes up)
**and** `lifecycle.probe()` (it must answer the handshake and report the
expected version) succeed. The Coordinator that launched the job is the
process the upgrade replaces - it never gets to see the receipt at all, and it
is gone before the sequence above finishes. The *new* Coordinator's startup
sweep runs too early: `probe()` (and therefore the receipt) has not happened
yet, because `probe` itself depends on that new Coordinator having already
reached the point in its own startup where the sweep runs. Every
`upgrade:operation_settled` log line ever produced in the field was therefore
emitted by a **later** Coordinator start than the one whose upgrade produced
it - the receipt sat on disk, unread, until something else happened to
restart the Coordinator again.

**The Coordinator outlived its own shutdown by ~5 s and was SIGKILLed.**
Measured on macOS: `coordinator:stopped` logged at 17:19:04.17, process gone at
17:19:09 - exactly launchd's 5 s `SIGKILL` window (ADR 0032). Cause:
`watchUpgradeReceipt` looped on a bare `Bun.sleep(UPGRADE_RECEIPT_POLL_MS)` for
up to 10 minutes and was never cancelled at shutdown. A pending `Bun.sleep`
keeps Bun's event loop - and so the process - alive; this is the same class of
bug ADR 0032 fixed in `runner-hold.ts`'s `answeredWithin`, just in a second,
unrelated background wait that was not touched by that fix.

Two additions were folded in after comparing with Raft Computer 1.0.32's
`k-carrier`: it keeps one durable operation record and re-delivers /
acknowledges an unacknowledged terminal receipt on **every** server
(re)connect via `onComputerUpgradeReconcile`, and `raft-computer status`
prints `K terminal receipt, unacknowledged (id …)`. Raft has the same
single-pending-slot rule and the same refusal shape
(`OPERATION_RECEIPT_PENDING` / `K_UPGRADE_OPERATION_BLOCKED`), but reconciles
continuously and surfaces the state in its own status command; ours did
neither before this record.

## Decision

**The Coordinator keeps watching every still-pending operation after
startup**, not only once. `watchComputerUpgradeReceipt`
(`packages/daemon/src/platform/computer-upgrade-receipts.ts`) is the extracted,
unit-testable unit: given `{ signal, sleep, now, pollMs, ttlMs }` it checks
immediately, then polls, reusing `sweepComputerUpgradeReceipts` - the very
function the startup sweep already uses - for the actual settle. It resolves
the moment a receipt appears, the moment the operation ages past `ttlMs`, or
the moment `signal` aborts. The pending-TTL expiry that used to be enforced
only in the startup sweep is therefore enforced continuously by the same
mechanism, for as long as the Coordinator runs. `run-supervisor.ts` starts one
watch per still-pending operation right after the startup sweep, and one more
each time `daemon:upgrade` records a new operation; there is no longer a fixed
10-minute watch window separate from the TTL.

**`recordUpgrade` settles a stale blocker before refusing.** A new,
optional, constructor-injected `PendingUpgradeSettler` (`{workspaceId,
requestId, requestedAt} -> settlement | undefined`) is consulted only when a
pending operation would otherwise cause a refusal. It is read-only - it does
not call back into `completeUpgrade`, since `recordUpgrade` is already inside
that same serialized mutation and re-entering it would deadlock - so
`recordUpgrade` applies the settlement itself, in the same atomic write that
also records the new request. `run-supervisor.ts` wires this to a small
closure that reuses `sweepComputerUpgradeReceipts` purely to *read* the answer
(receipt present, or TTL passed), never to write through it. The single
pending slot rule is otherwise unchanged: a genuinely in-flight operation
still refuses with the same message.

**A settled result still has to reach the server, without a Workspace
restart.** `#reportUpgradeResults()` (`daemon-runtime/runtime.ts`) used to read
a static snapshot (`recoveredUpgradeResults`) captured once, at process
construction, from the config file the Coordinator wrote before spawning that
Workspace. That snapshot never reflected anything the continuous watch settled
afterwards. Two changes, both purely local (no wire or local-RPC protocol
change):

- The Coordinator (`run-supervisor.ts`) now rewrites the affected Workspace's
  own local config file (`buildChildConfig` / `refreshChildUpgradeConfig`) -
  the exact file, and the exact shape, it already writes once before spawning
  that Workspace - every time it settles an operation (via the continuous
  watch, via `recordUpgrade`'s pre-check, or via `daemon:upgrade_ack`), without
  restarting the Workspace process.
- `DaemonRuntime` gained an optional `lifecycle.refreshUpgradeResults()` hook
  that re-reads that same file fresh. `#reportUpgradeResults` prefers it over
  the static snapshot, and it is now also called from the Workspace daemon's
  existing `onReconnect` handler (previously used only for code-agent runtime
  reports, control replay, and reminder resync), not only once at the initial
  ready handshake. A result the watch settles while a Workspace keeps running
  therefore reaches the server on that Workspace's next reconnect, not only at
  its own next process start.

This is deliberately *not* Raft's model: Raft's carrier reconciles over its
own server RPC on every connect. Ours has no Coordinator→server channel at
all (ADR 0017's own rejected-alternatives already established that only the
Workspace daemon holds the cloud connection); re-reading a Coordinator-owned
local file that already existed for this exact purpose reaches the same
outcome without adding one.

**Every Coordinator-owned background wait is cancelled at shutdown.** A single
`AbortController` in `run-supervisor.ts` is threaded into every
`watchComputerUpgradeReceipt` call; `runWithSupervisorLock`'s `finally` aborts
it and awaits every in-flight watch before releasing the supervisor lock.
`abortableSleep` (`computer-upgrade-receipts.ts`) is the sleep primitive: it
clears its timer the instant `signal` aborts, so - unlike the bare
`Bun.sleep` it replaces - no pending timer is ever left behind for the event
loop to wait on.

**The `__daemon` and `__workspace-daemon` entries exit explicitly.**
`packages/computer/src/main.ts`'s `__daemon` branch now exits with
`process.exit(process.exitCode ?? 0)` once `runMachineSupervisor` resolves, or
`process.exit(1)` if it threw - belt and braces: shutdown there is already
fully awaited (every background wait cancelled, logging disposed) before the
promise settles, so this is a second line of defence, not the fix itself.
`__workspace-daemon` gets the identical treatment for the same reason:
`runDaemon`'s promise resolves only after its own SIGINT/SIGTERM shutdown has
stopped every Workspace runtime, closed the Agent proxy and local RPC server,
and disposed logging. `__managed-agent` (`runLaunchdAgent`) is deliberately
left alone: its promise resolves as soon as its relay socket *connects*, long
before the relayed Agent process or the socket itself ends, so its shutdown is
not "fully awaited" the way the other two are - it already terminates through
`process.exit` calls inside itself, at each real end of life, and exiting in
`main.ts` too would kill the relay the moment it connects. `process.exit` is
called only from this entrypoint file, never from library code.

**`coforge-computer status` lists unsettled upgrade operations, read-only.**
`collectComputerStatus` now reports every operation still not `acknowledged`
(`requestId`, `expectedVersion`, `state`, age in ms) per Workspace, in both the
human and `--json` output. No acknowledge command was added; `status` only
ever reads.

## Rejected alternatives

- **A fixed watch window longer than 10 minutes, kept separate from the
  pending TTL.** Two numbers governing the same question (how long is this
  operation allowed to sit unresolved) drift apart by construction. The watch
  now shares `ttlMs` with the sweep it calls.
- **Have `recordUpgrade`'s settle check call `completeUpgrade`.** Both run
  inside `MachineSupervisor`'s single serialized mutation queue; a call from
  inside an in-flight mutation back into a method that enqueues its own would
  deadlock rather than settle anything. The settle check is read-only by
  design; the caller (`recordUpgrade` itself) applies the answer.
- **A new local-RPC method (or a widened `daemon:snapshot`/lifecycle response)
  for the Workspace daemon to ask the Coordinator to sweep and hand back its
  current terminal operations.** Investigated and rejected for this record:
  every existing local-RPC response is either a bare accepted/rejected boolean
  or a `ManagedRuntimeIdentity[]` (pid/version/enabled) - none carries upgrade
  state, and adding a field or a method would be a local-RPC protocol change,
  which this record was explicitly scoped to avoid. Rewriting the
  already-Coordinator-owned per-Workspace config file the Workspace daemon
  already reads reaches the same outcome with no protocol surface change at
  all.
- **A manual "acknowledge" CLI command for a stuck operation.** Not added.
  `status` is read-only; the continuous watch plus the TTL is the only path to
  a terminal state.

## Consequences

- A pending operation is now bounded by exactly one number
  (`UPGRADE_OPERATION_PENDING_TTL_MS`, 30 minutes) enforced continuously, not
  by a startup sweep plus a separate, shorter watch window.
- `MachineSupervisor`'s constructor grew one more optional trailing parameter
  (`PendingUpgradeSettler`). Every existing call site that only passed
  `(store, processes)` or `(store, processes, now)` is unaffected.
- `DaemonRuntime`'s `lifecycle` parameter grew one more optional method
  (`refreshUpgradeResults`). A caller that never supplies it gets exactly the
  previous behaviour (the static `recoveredUpgradeResults` snapshot).
- The Coordinator now performs one extra small local file write per settle
  (startup sweep, continuous watch, `recordUpgrade`'s pre-check, and
  `daemon:upgrade_ack`) into the affected Workspace's own config file. That
  file was already rewritten unconditionally on every real Workspace start;
  this adds writes only at settlement, at most a handful per operation.
- `coforge-computer status --json` gains one field per Workspace
  (`unsettledUpgrades`). Existing consumers that read specific fields are
  unaffected; a consumer doing a strict full-object comparison against the old
  shape needs updating (two existing unit tests here needed exactly that).

## What was NOT verified

- No live remote upgrade was executed end to end on this machine (it already
  runs a live Coordinator that was deliberately left untouched). The fix is
  validated at the unit and integration-seam level: the extracted watch, the
  settle-before-refuse path, and a reproduction of the incident's exact
  sequencing (record → startup sweep finds nothing → receipt appears →
  continuous watch settles it → a second `recordUpgrade` is accepted) - see
  Validation below - but not against a real `launchComputerUpgrade` job or a
  real Coordinator restart.
- The `onReconnect`-triggered re-report was verified at the unit level
  (`refreshUpgradeResults` preferred over the static snapshot, and called from
  the reconnect handler); it was not verified against a real WSS reconnect or
  a real server accepting `computer:upgrade_result` a second time for the same
  operation.
- Whether two `#reportUpgradeResults()` calls racing (e.g. the initial ready
  handshake and an near-simultaneous reconnect) could both report and both
  acknowledge the same result was reasoned about, not tested: both `
  MachineSupervisor.acknowledgeUpgrade` and the server's own acceptance are
  expected to be idempotent, consistent with how every other retry path in
  this area already behaves, but no test exercises the race directly.
- The `50 ms`-granular handshake-polling `Bun.sleep` inside `MachineSupervisor`
  binding `start()` (waiting up to 30 s for a Workspace's own handshake) was
  reviewed and deliberately left alone: it runs on the main startup path
  already awaited by `recover()`/`configure()`, not as a detached background
  wait, so it is not the class of bug this record fixes.

## Validation

Unit tests over the extracted watch
(`packages/daemon/test/computer-upgrade-receipts.test.ts`): settles when a
receipt appears on a later poll; settles as failed/expired exactly at the TTL
without a receipt; stops promptly on abort without settling; does nothing
beyond its first check when a receipt is already present; and a real-process
test in the style of `runner-hold-quiescence.test.ts`'s `answeredWithin`
test - a child process given a ten-minute budget, aborted after 20 ms, exits
in under 3 s (confirmed to hang to the bound instead if the abort is not wired
through the sleep). Unit tests over `MachineSupervisor`
(`packages/daemon/test/machine-supervisor.test.ts`): `recordUpgrade` settles an
already-receipted pending operation and accepts the new request; still refuses
a genuinely in-flight one; still refuses if the settle check itself throws;
and (unchanged) still refuses exactly as before when no settle check is
configured at all. A reproduction of the field incident at the closest
available seam
(`packages/daemon/test/computer-upgrade-receipts.test.ts`): record → a sweep
with no receipt yet leaves the operation pending → the receipt is written
afterwards → the continuous watch, still in the same process, settles it to a
terminal state → it is acknowledged → a second `recordUpgrade` is accepted,
with no second process start anywhere in the test. `bun run check` passes for
every workspace; `bun run --cwd packages/daemon test` and
`bun run --cwd packages/computer test` were run in full, with only the
already-known local-only flakes (Claude/Codex/Kiro adapter and catalog tests'
`AgentProcessCleanupError`, the `assigned-skills` symlink test, and three
failures plus one error in `compiled-cli.test.ts`) failing, none in a file
this record touched.

Rollback is by revert. The only persisted-format addition is none: this
record adds behaviour around the existing `upgradeOperations` shape from ADR
0017, it does not change it. A reverted Coordinator goes back to settling only
at its own startup, and a reverted Workspace daemon goes back to reporting
only its static snapshot at its own start; neither corrupts state, they simply
reintroduce the settlement-timing gap this record closes.

See also [ADR 0017](0017-computer-upgrade-operation-receipt.md), which this
record does not supersede: the receipt file, the operation record shape, and
the report/acknowledge RPCs are unchanged. See also
[ADR 0032](0032-launchd-in-place-restart.md) for the first instance of the
"a pending `Bun.sleep` keeps the process alive past shutdown" class of bug,
in a different background wait (`runner-hold.ts`'s `answeredWithin`).
