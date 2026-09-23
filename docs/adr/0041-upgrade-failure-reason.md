# ADR 0041: A Computer upgrade failure always carries its real reason, and a concrete next step

Status: accepted
Date: 2026-09-17

## Context

"When something fails, always give the reason, and let the user fix it by
hand." Before this record, a refused `daemon:upgrade` request was swallowed
outright: `DaemonConnection#acceptLifecycleRequest` (`packages/daemon/src/
connection/daemon-connection.ts`) ran `void run().catch(() => { seen.delete
(requestId); })` for both the upgrade and restart lifecycle intents. When
`MachineSupervisor.recordUpgrade` refused a request - most commonly "Computer
upgrade operation `<id>` is still pending; wait for it to finish before
starting another" (see [ADR 0037](0037-upgrade-settlement-and-coordinator-
shutdown.md)) - nothing reached the server at all. The server waited out its
own request TTL and only then reported `computer_upgrade_failed_timeout`
("The Computer did not report the new version in time") to the Workspace
member watching the Version row, even though the Workspace daemon knew,
within milliseconds, exactly why the request never even started.

Two more gaps compounded this. First, the reporting pipeline this failure
should have used already existed and was simply unused for this case: proto
`ComputerUpgradeResult { status, error }`, the server's
`computer-upgrade-store.server.ts`, and the web's `upgrade-failure.ts`
(`reason: "reported"` renders "The Computer reported that the upgrade
failed: <error>"). Second, no copy anywhere told a Workspace member what to
*do* about any failure - not even the two pre-flight `AppError`s
(`COMPUTER_OFFLINE`, `COMPUTER_IDENTITY_UNKNOWN`) that already reached the
web with a decoded sentence. And there was no CLI command that restarts the
*Coordinator* itself - `coforge-computer start|stop|restart` are all RPCs
*to* the Coordinator that act on Workspace runtimes
(`packages/computer/src/cli.ts`) - so the only way to unstick a Coordinator
that refuses to answer was `systemctl --user restart
coforge-daemon.service` or `launchctl kickstart -k …` by hand, wording that
must never appear in a Workspace member's own screen.

## Decision

**Every throw site that can refuse or fail a Computer upgrade names a stable
code.** `UPGRADE_ERROR_CODE` (`packages/coforge-sdk/src/internal/index.ts`)
is defined once, with the same discipline this codebase already applies to
`RUNTIME_PROVIDER`: a `const` object, a derived type, a values tuple, and a
`parseUpgradeErrorCode` that accepts a well-formed-but-unrecognized value
rather than rejecting it (forward compatibility - an older Web build must
not choke on a code a newer Daemon has learned to report). Its members, each
verified against a real throw site:

- `UPGRADE_OPERATION_PENDING` - `MachineSupervisor.recordUpgrade`'s "still
  pending" refusal. This single code deliberately covers what the brief
  first considered splitting into a second `UPGRADE_IN_PROGRESS`: the
  Coordinator has no way to probe whether the external job behind a pending
  slot is still alive versus orphaned, only whether a receipt or the pending
  TTL has arrived (`settlePendingUpgrade` in `run-supervisor.ts`, reusing
  `sweepComputerUpgradeReceipts`). Splitting the code without the Coordinator
  actually being able to tell the difference would have been inventing a
  distinction this system cannot make.
- `UPGRADE_LAUNCHES_PAUSED` - `MachineSupervisor#assertMutable`'s pause
  guard, which only ever fires because an upgrade already has the exclusive
  launch-hold file down.
- `UPGRADE_LAUNCH_FAILED` - `run-supervisor.ts`'s `daemon:upgrade` handler,
  when `recordUpgrade` accepts the request but `launchComputerUpgrade` itself
  cannot start the external job. This handler now also immediately
  `completeUpgrade`s the just-opened operation as failed with this code
  before rethrowing, so a launch failure does not sit as a "pending"
  operation for the full 30-minute TTL, refusing every later upgrade in the
  meantime - the second half of "no operation is silently swallowed."
- `UPDATE_BUSY` / `UPDATE_FEED_INVALID` / `UPDATE_INTEGRITY_FAILED` /
  `UPDATE_NO_ROLLBACK` / `UPDATE_UNSUPPORTED_TARGET` - reused verbatim from
  `packages/computer/src/updater.ts`'s existing `UpdateError.code`, surfaced
  when the upgrade job fails before any switch and there is no previous
  version to restore (`runUpgradeCoordinator`'s catch, when the error is not
  an `UpgradeCoordinatorError`).
- `UPGRADE_ROLLED_BACK` / `UPGRADE_ROLLBACK_FAILED` - `upgrade-
  coordinator.ts`'s `switchRuntime`, for its two existing outcomes
  ("candidate failed; previous version restored" and "candidate and
  rollback failed" respectively).
- `UPGRADE_EXPIRED_WITHOUT_RECEIPT` - `computer-upgrade-receipts.ts`'s
  `expiredReceipt`, when a pending operation's job never left a receipt
  before the pending TTL passed.

The Coordinator throws typed errors carrying these codes
(`packages/daemon/src/supervisor/upgrade-error.ts`: `UpgradeError` and three
subclasses) rather than a caller parsing a message string. A receipt-
reported failure carries a code the same way, threaded through
`ComputerUpgradeReceipt.errorCode` -> `UpgradeOperationTerminal.errorCode` ->
`RecoveredUpgradeResult.errorCode` -> the wire.

**A refused request is reported immediately, not swallowed.**
`DaemonRuntime#requestUpgrade` (`packages/daemon/src/daemon-runtime/
runtime.ts`) now wraps `lifecycle.requestUpgrade`: on rejection it builds a
`ComputerUpgradeResult` (`status: "failed"`, the sanitized error text via
the existing `sanitizeUpgradeErrorText`, and `errorCode` when the rejection
carries one) and sends it through the exact same `#transport.
sendUpgradeResult` path and dedupe `#reportUpgradeResults` already uses,
before rethrowing so `DaemonConnection#acceptLifecycleRequest`'s existing
dedupe-clearing behaviour is unaffected. `restart`'s equivalent swallow was
checked and left alone: no `ComputerRestartResult` message exists on the
wire (`daemon_runtime.proto` has `ComputerRestartIntent` but no result
counterpart), so there is nothing to report through - inventing one was out
of scope here.

**The local RPC between the Coordinator and a Workspace daemon gained the
narrowest change that lets a refusal carry a reason at all.** Before this
record it could not carry one under any circumstances: `local-rpc.ts`'s
`#lifecycle` let any exception from `runtime.command()` propagate to
`receive()`'s outer catch, which only logs and closes the socket - the
caller saw an indistinguishable dropped connection, never a message or a
code. `DaemonCommandResponse` gained two additive optional fields (`error`,
`error_code`); `#lifecycle` now catches its own handler's rejection and
encodes a normal `accepted: false` response carrying both, and
`LocalDaemonLauncher.control()` (`daemon-host/launcher.ts`) throws a new
`DaemonCommandRejectedError` carrying `code` instead of a bare "did not
accept" string. This also improves every other lifecycle refusal
(`start`/`stop`/`restart`/`daemon:upgrade_ack`), which is why the resulting
scope is not the local-RPC redesign ADR 0017 and ADR 0037 both explicitly
declined to pursue for this exact protocol boundary - this stays inside
`DaemonCommandResponse`'s existing shape.

**`coforge-computer restart --supervisor`** restarts the Coordinator process
itself, not a Workspace runtime, mutually exclusive with `--workspace`.
launchd uses the existing `LaunchdDaemonHost.restart()`
(`kickstart -k`, ADR 0032); `SystemdUserDaemonHost.restart()` is new
(`systemctl --user reset-failed <unit>`, its own exit code ignored, then
`restart <unit>`); `WindowsUserDaemonHost.restart()` is new (`schtasks /End`
then `/Run`, using the primitives that command already had). Each waits for
the local handshake afterward. Before restarting, it engages the same
fanned-out runner hold a Coordinator-initiated restart already uses (ADR
0021, `holdRunnersUntilQuiescent`), unless the Coordinator cannot be reached
at all - the one case this command exists for - in which case it restarts
without a hold rather than refusing. On launchd it refuses outright on a
`foreground` externally supervised Computer (`assertRestartable()`, the same
wording an upgrade's own restartability check already uses) rather than
silently bootstrapping a fresh user agent; on systemd/Windows, any restart
failure is presumed to be that same case, matching the precedent `upgrade-
lifecycle.ts`'s `stop()` failure already set for those platforms.

**Server and web.** The Redis-backed upgrade status record already used a
plain object, not a Prisma model - `computer-upgrade-store.server.ts`'s
`ComputerUpgradeStatus`/`ReportedComputerUpgradeResult` gained an
`errorCode` field with no migration involved; the wire handler
(`rpc-handler.server.ts`) forwards it unchanged. `apps/web/src/features/
computers/upgrade-failure.ts` is one exhaustive table
(`Record<UpgradeErrorCode, …>`, so a new code fails `tsc`) mapping every
code, plus the existing `reason` kinds and the two pre-flight `AppError`s,
to a headline and an ordered list of steps - each step a sentence and an
optional real `coforge-computer` command, never a raw code.
`ComputerUpgradeFailureView` (a small `Error` subclass carrying the
already-composed view) replaces collapsing a terminal poll failure into an
`Error`'s message string, which could not have carried a steps list.
`computer-detail.tsx` renders the headline and steps inline where the
failure already showed (never a toast - see `docs/design.md` §13),
keeps the existing quiet "Error reference {id}" line, and gives each command
the app's existing mono-command-plus-copy-button treatment
(`ComputerInstallCommand`'s `ButtonUtility` + Copy/Check pattern, sized for
an inline list item).

**Why a real field, not parsing `error`.** `error` is a sanitized free-text
sentence meant for a human, and sanitization (`sanitizeUpgradeErrorText`)
already rewrites paths and secret-shaped substrings out of it - parsing it
for a stable signal would be parsing a string this project already promises
not to keep stable. A dedicated field is the only place a decision (which
headline, which steps) can be made without also depending on English
prose staying byte-for-byte the same release to release.

**Raft 1.0.32 as reference, not as a source vendored into this repo.** Raft
Computer's `UPGRADE_START_REJECTION_TEXT` (a fixed rejection sentence for
its own upgrade-start refusal) and `reportAgentStartFailure` (its Agent-
start failure report) are the same shape this record gives Computer
upgrades: a stable, named reason instead of a caller re-deriving one from
prose. `raft-computer status` listing unacknowledged receipts is the
precedent `coforge-computer status`'s unsettled-upgrades listing
(ADR 0037) already followed; this record's guidance for
`UPGRADE_OPERATION_PENDING` (`coforge-computer status`, then, if it stays
stuck, `coforge-computer restart --supervisor`) is the natural extension of
that same status command now that a code, not a bare timeout, names the
condition.

## Rejected alternatives

- **A second `UPGRADE_IN_PROGRESS` code, distinct from
  `UPGRADE_OPERATION_PENDING`.** Rejected: the Coordinator has no liveness
  probe for the external job behind a pending slot, so a second code would
  not correspond to anything this system can actually distinguish. One code
  says so honestly.
- **Parsing `error`'s free text for a signal.** Rejected: the text is
  sanitized human prose with no promised stability, and parsing it would
  make the UI's reasoning depend on that stability implicitly.
- **A new local-RPC method, or a widened response, to carry richer upgrade
  state across the Coordinator<->Workspace boundary.** ADR 0017 and ADR
  0037 already declined this for reading terminal operation state; this
  record's need is narrower (why *this one command* was refused) and fits
  inside `DaemonCommandResponse`'s two new optional fields without a new
  method.
- **Bootstrapping a fresh launchd user agent from `restart --supervisor`
  when none is loaded**, mirroring `ensureRunning()`'s recovery fallback.
  Rejected: that would silently take over a `foreground` externally
  supervised Computer's process lifecycle instead of refusing, the opposite
  of "let the user fix it by hand."
- **Inventing a `ComputerRestartResult` wire message so a refused restart
  request could be reported the same way as a refused upgrade.** Not done:
  out of scope for this record, which only reports what a real field can
  already carry; flagged as a known gap instead.

## Consequences

- `ComputerUpgradeResult` and `DaemonCommandResponse` each gain one
  additive optional field (`error_code`, and `error`+`error_code`
  respectively). No existing peer needs to change to keep working; an old
  peer simply never sets or reads the new fields.
- `UpgradeResult` (`packages/computer/src/release/upgrade-coordinator.ts`),
  `ComputerUpgradeReceipt`, `UpgradeOperationTerminal`, and
  `RecoveredUpgradeResult` each gain one additive optional `errorCode`
  field, threaded through unchanged persisted shapes - no migration, no
  Prisma model (the upgrade status record has always been a plain Redis
  JSON value).
- `apps/web`'s upgrade-failure copy is now exhaustive over the code
  vocabulary by construction: adding a new `UPGRADE_ERROR_CODE` value
  without also adding its `CODE_COPY` entry fails `tsc`.
- Every local lifecycle refusal (`start`/`stop`/`restart`/`daemon:upgrade`/
  `daemon:upgrade_ack`), not only upgrade, now reaches its caller as a
  normal rejected response instead of a closed socket - a strict
  improvement, verified against the existing `local-rpc.test.ts` suite,
  which asserted no specific "socket closes on refusal" behaviour for any
  of them.
- `coforge-computer restart --supervisor` is a new, real wire operation
  (per ADR-adjacent convention "no CLI-side shortcuts" already in force for
  this queue): it drives the platform's actual process manager, never
  precomputes or maps onto an existing op.

## What is NOT covered

- Agent start failures. `reportAgentStartFailure`-shaped parity for Agent
  starts (as opposed to Computer upgrades) is explicitly left to a later
  change; this record is scoped to the Computer-upgrade failure path only.
- A dedicated `ComputerRestartResult` wire message, and therefore a
  reasoned report for a refused **restart** request the way this record
  gives a refused **upgrade** request. The restart swallow in
  `DaemonConnection#acceptLifecycleRequest` was checked and found to have no
  equivalent result message to report through; adding one was out of
  scope.
- `UPGRADE_IN_PROGRESS` as a code distinct from `UPGRADE_OPERATION_PENDING`
  (see Decision and Rejected alternatives above) - not implemented because
  the Coordinator cannot currently tell the two states apart, not because
  it was overlooked.

## Validation

SDK: `packages/coforge-sdk/src/internal/computer-upgrade-result.test.ts`
round-trips `ComputerUpgradeResult` and `DaemonCommandResponse` with and
without `errorCode`, including a well-formed-but-unknown code (never
rejected) and a malformed shape (rejected on both encode and decode).
Daemon: `machine-supervisor.test.ts` asserts `recordUpgrade`'s and
`configure`'s refusals are typed errors carrying the right code, and that
immediately completing a just-opened operation as failed (mirroring a
launch failure) leaves nothing pending for the next request;
`daemon-runtime.test.ts` exercises `DaemonRuntime#requestUpgrade` end to
end - a refused `lifecycle.requestUpgrade` produces exactly one
`sendUpgradeResult` call with the right code, never an acknowledgement, and
still rethrows; `computer-upgrade-receipts.test.ts` updated for the new
`errorCode` on an expired-without-receipt settlement; `local-rpc.test.ts`
passes unchanged. Computer: `upgrade-coordinator.test.ts` asserts
`UPGRADE_ROLLED_BACK`/`UPGRADE_ROLLBACK_FAILED` on the two existing rollback
outcomes; `daemon-host-systemd.test.ts`/`daemon-host-windows.test.ts` assert
the new `restart()` command sequences (including that `reset-failed`'s/
`/End`'s own exit code is ignored); `restart-supervisor.test.ts` covers the
hold-then-restart order, the unreachable-Coordinator path, the foreground
refusal, and that the hold is released even when the restart itself fails;
`cli.test.ts` covers `--supervisor`/`--workspace` mutual exclusion, CLI
dispatch, and - the drift guard - that the CLI's actual registered commands
equal the shared `COMPUTER_CLI_COMMANDS` vocabulary the web copy is checked
against. Web: `computer-upgrade-failure.test.ts` asserts the failure table
is exhaustive over every known code, every step's command is one of that
same shared `COMPUTER_CLI_COMMANDS` list, and the exact headline/steps a
`UPGRADE_OPERATION_PENDING` failure produces (the data path
`computer-detail.tsx` renders from - this repository has no jsdom/testing-
library harness yet, so this is a data-level assertion of what would render
inline, not a DOM render); `centrifugo-rpc-handler.test.ts` covers the wire
handler forwarding `errorCode` to the store. `bun run check` passes for
`packages/coforge-sdk`, `packages/daemon`, `packages/computer`, and
`apps/web`. Full suite counts and the pre-existing unrelated local-only
flakes are recorded in this branch's handback report.

Rollback is by revert. The only persisted-format additions are the
additive optional fields above; a reverted build simply never sets or
reads them, matching every other machine's untouched behaviour.

See also [ADR 0017](0017-computer-upgrade-operation-receipt.md) and
[ADR 0037](0037-upgrade-settlement-and-coordinator-shutdown.md), neither of
which this record supersedes: the receipt file, the operation record shape,
and the settlement/reconciliation machinery are unchanged - this record
only adds a reason to what was already reported, and reports what
previously never reached the wire at all.
