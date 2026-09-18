# ADR 0037: Commit Computer upgrade results before Workspace launch

Status: accepted, amended 2026-09-18

Date: 2026-09-17

## Context

Two field incidents exposed an invalid ordering in the local Computer upgrade transaction.

First, a successful remote upgrade could remain pending. The replacement Coordinator started every
enabled Workspace during `recover()`. A Workspace daemon connected to cloud and ran its initial
ready/result reconciliation before the external upgrade job finished its local health probe and
wrote `result.json`. The result therefore was absent from that first ready. The old implementation
only re-read it on a later reconnect, so a continuously healthy WSS connection timed out in Web even
though the machine already ran the new version.

PR #430 added a pending-only 250 ms reconciliation loop in each Workspace daemon. It repaired the
visible timeout, including acknowledgement and stop/restart races, but retained the inverted cause:
Workspace startup was still a prerequisite for creating the Computer terminal receipt.

Second, the earlier Coordinator receipt watch used an uncancelled `Bun.sleep`. It kept a stopped
Coordinator process alive until the OS manager's forced-kill deadline. The existing abortable receipt
watch remains necessary for crash recovery, independently of the ordering decision below.

The previous release contract also defined candidate health as a new Supervisor plus a replacement
identity for every previously running Workspace child. That coupled immutable Computer promotion to
application recovery. Frank approved separating those outcomes on 2026-09-18: Computer promotion is
committed after the replacement Supervisor passes its local identity/version probe; Workspace startup
happens afterwards and reports its own faults without rewriting or rolling back the Computer result.

## Decision

### Keep the pre-switch quiescence boundary

Before changing bytes, the old Coordinator still:

1. writes `launch-hold` containing the exact upgrade request ID and pauses lifecycle mutations;
2. fans a runner hold out to every running Workspace daemon;
3. waits within the existing bound for active Agent/tool work to quiesce;
4. snapshots the registered/running Workspace set for post-promotion reconciliation and evidence;
5. stops the old Supervisor and activates the candidate.

The bounded wait behavior is unchanged. An unreachable or perpetually busy Workspace cannot block the
machine forever; the Coordinator records that evidence and proceeds under the existing runner-hold
contract.

### A replacement Coordinator honors launch-hold during recovery

`run-supervisor.ts` checks `launch-hold` before calling `MachineSupervisor.recover`. When present,
recovery loads durable bindings and exposes local RPC but starts no Workspace process. `pause` still
blocks configure/start/stop/restart/upgrade mutations.

`MachineSupervisor.resume` clears its internal pause and reconciles the loaded binding set. This same
operation is idempotent for an old Coordinator whose Workspace processes survived the pause.

### Probe only the promoted Computer Supervisor

The upgrade health probe verifies the replacement Supervisor has:

- a new process identity (not the pre-switch daemon ID); and
- the expected Computer/Daemon version.

It no longer requires Workspace child processes to be online, to have new PIDs, or to report the
candidate version. Workspace processes are intentionally still stopped under launch-hold at this
point.

When no Supervisor was running before the operation, the existing executable-only version probe
remains unchanged.

### Commit the terminal receipt before resume

The external upgrade job receives a write-once result commit callback. After the candidate Supervisor
probe succeeds, it atomically writes the `succeeded` receipt before invoking `resumeLaunches`.

If candidate Supervisor health fails and the previous immutable version is restored successfully, the
job writes the `failed`/`UPGRADE_ROLLED_BACK` receipt before resume. If rollback fails, it writes
`UPGRADE_ROLLBACK_FAILED` and retains launch-hold for explicit recovery.

A receipt commit failure is fail-closed: Workspace launch remains held. The job never releases
Workspace startup without durable terminal evidence.

Once a candidate or rollback receipt is committed, a later Workspace recovery error cannot overwrite
that receipt or trigger executable rollback. It is an application lifecycle fault under the promoted
Computer version.

### Settle before starting Workspace children

A Coordinator born under launch-hold completes the exact upgrade request in this order:

1. sweep that request's durable receipt;
2. require that exact operation to be terminal;
3. persist terminal state in the binding and refresh the affected child config;
4. reconcile enabled Workspace bindings;
5. remove `launch-hold`.

The external job's `daemon:resume` RPC and the Coordinator's receipt watcher/startup sweep share one
idempotent `HeldUpgradeRecovery` seam bound to the request ID stored in `launch-hold`. If the job
exits after receipt rename, or resume side effects commit but the RPC response is lost, terminal
settlement still resumes Workspace bindings and clears hold. An unrelated receipt cannot join or
release the held request. On Coordinator restart, the persisted request ID selects its exact
operation; legacy `upgrade\n` hold files fall back to the newest pending or verified terminal
operation by `requestedAt`. `UPGRADE_ROLLBACK_FAILED` and unknown failure receipts retain hold for
explicit recovery.

Workspace recovery is best effort across bindings. A failed child is logged as
`upgrade:workspace_recovery_incomplete`; healthy peers continue and machine-wide hold is released.
The existing Workspace lifecycle/error surface owns subsequent repair.

### Report once on first ready; reconnect remains recovery

Because terminal state is in child config before a Workspace starts, its first cloud ready is followed
by the existing `computer:upgrade_result` report and local acknowledgement. No active polling, file
watcher, or new local/cloud protocol is needed.

A later reconnect replays an unacknowledged terminal result. Server-side request ID idempotency and the
existing `daemon:upgrade_ack` path handle a lost response. Coordinator startup/continuous receipt
sweeps remain crash recovery for jobs that outlive the process that launched them.

### Cancel Coordinator-owned waits at shutdown

The existing `AbortController` continues to own every `watchComputerUpgradeReceipt` wait.
`runWithSupervisorLock` aborts and awaits those watches before releasing the Supervisor lock.
`abortableSleep` clears its timer immediately, so no receipt watch retains the process after shutdown.

## Why this ordering

The design follows the established transactional-upgrade pattern used by Raft Computer 1.0.32:
quiesce work, promote and attest the machine service, commit durable outcome, then resume managed
work. CoForge makes the receipt-before-resume boundary strict rather than relying on process startup
latency.

Cloud ready is not delayed inside a running Workspace daemon. Instead, Workspace creation itself is
held until terminal commit. The meanings remain separate:

- Supervisor probe: the Computer version is promoted;
- receipt: the upgrade transaction is terminal;
- Workspace ready: one application child is online;
- Workspace fault: post-promotion application recovery needs repair.

## Rejected alternatives

### Keep PR #430's 250 ms Workspace reconciliation loop

It can self-heal the timeout, but it adds a second state machine to every Workspace daemon to compensate
for a deterministic ordering inversion. Generation fencing, pending-ID authority, ambiguous ack
handling, and timer lifecycle all disappear when terminal state precedes Workspace startup.

### Push a local notification after config refresh

A notification reduces latency but still needs reconnect/poll fallback for lost delivery and retains the
same inverted order. It also adds a local RPC compatibility surface without removing durable config.

### Let the Coordinator report directly to cloud HTTPS

This would add a second machine-result reporter, a new authenticated endpoint, Workspace credential
selection for a machine-wide operation, retry/outbox behavior, and a security-boundary exception.
The existing Workspace daemon remains the sole cloud reporter; durable receipt plus first-ready/reconnect
reconciliation is sufficient once ordering is correct.

### Keep Workspace children in the Computer promotion health gate

This was the old release contract. It makes one application child's recovery failure roll immutable
Computer bytes back even after the Supervisor is healthy, and forces Workspace startup before the
terminal receipt can exist. Frank approved the separated contract on 2026-09-18.

## Consequences

- `launch-hold` now stores the owning request UUID. The legacy literal `upgrade` remains readable by
  selecting the newest pending or verified terminal operation, so no migration is required.
- `docs/release.md` now defines local Computer promotion health by the replacement Supervisor identity
  and expected version. Workspace recovery is a separate post-promotion gate/fault.
- `MachineSupervisor.recover({ paused: true })` loads bindings without starting them;
  `resume()` performs reconciliation.
- Upgrade receipts become write-once commit records before Workspace launch.
- The runtime polling state introduced by PR #430 is removed.
- No Protobuf, cloud RPC, local RPC method, manifest, or persisted record shape changes.
- A machine whose Supervisor is healthy but one Workspace fails to start remains on the promoted
  version and exposes that Workspace fault for repair.
- A missing/unwritable terminal receipt leaves launch-hold in place rather than starting children
  without auditable outcome.

## Validation

Required regression seams:

- paused recovery loads bindings but starts no Workspace; resume reconciles enabled/stopped bindings;
- candidate success commit occurs before resume;
- successful rollback commit occurs before resume;
- candidate Supervisor success followed by Workspace recovery failure does not restore old bytes;
- candidate/rollback Supervisor failure keeps launch-hold;
- external job exit after receipt commit is self-completed by watcher/startup settlement;
- a lost explicit-resume response is idempotent and does not leave hold behind;
- an unrelated terminal receipt cannot release another request's hold;
- Coordinator restart uses persisted hold ownership; legacy hold selects the newest operation by age;
- first Workspace ready reports terminal result from initial child config without reconnect or timers;
- Coordinator receipt watches remain abortable and do not retain shutdown;
- Computer, Daemon, Web upgrade suites plus package check/build gates pass.

Staging still needs one real connected upgrade and rollback rehearsal before this behavior is treated as
release evidence. This ADR authorizes implementation and review, not staging or production publication.

## Rollback

Rollback is a normal revert of the implementation and contract changes. Persisted operation and receipt
formats are unchanged. Reverting restores the old ordering and, if PR #430 is also restored, its
pending-only reconciliation loop; no data migration is required.

See also [ADR 0017](0017-computer-upgrade-operation-receipt.md),
[ADR 0020](0020-upgrade-runner-hold.md),
[ADR 0032](0032-launchd-in-place-restart.md), and
[ADR 0030](0030-upgrade-identity-durable-snapshot.md).
