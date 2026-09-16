# ADR 0020: A bounded runner hold before a Computer upgrade stops the supervisor

Status: accepted
Date: 2026-09-16

## Context

A Computer upgrade replaces the executable the Coordinator runs from, so it must
stop the whole process tree first. `coordinateUpgrade`
(`packages/computer/src/release/upgrade-coordinator.ts`) sequences that as
`prepare` → `pauseLaunches` → `snapshot` → `stop` → activate → `start` → `probe`
→ `resumeLaunches`.

Nothing in that sequence reaches an Agent. `MachineSupervisor.pause()` only sets
a private `#paused` flag that makes `configure`, `command` and `recordUpgrade`
throw, plus a `launch-hold` marker that makes the Coordinator's own local RPC
refuse callers — it blocks *lifecycle commands*, not work. `lifecycle.stop()`
then stops the OS job, and `DaemonRuntime.stop()`
(`packages/daemon/src/daemon-runtime/runtime.ts`) rejects every queued input
synchronously and hands each Agent process group a ~1 s SIGTERM / 1 s SIGKILL
ladder. The effective grace period for an Agent halfway through a tool call is
about two seconds. A remote upgrade can therefore kill an Agent mid-command:
a half-written file, an interrupted `git push`, a migration applied but not
recorded.

Three facts about the existing code shaped the fix.

**There was no Coordinator→Workspace channel, but there were already sockets.**
ADR 0017 recorded this as the main cost of the work. In practice
`run-supervisor.ts` already builds a `childClient(workspaceId)`
`LocalDaemonLauncher` per Workspace, pointed at that Workspace's `daemon.sock`,
and uses it for the startup handshake. The fan-out needed a verb, not a
transport.

**The busy predicate already existed.** `BUSY_ACTIVITY_DETAIL_KINDS` and
`#lastBusyActivity` (ADR 0016) are set on every busy Activity emission and
cleared by `#clearActivityHeartbeat`, which every terminal detail kind
(`idle`, `stopped`, `runtime_error`, `freshness_hold`), every launch change and
every stop path already runs. "The Agent's last emitted activity is busy and no
terminal kind has arrived since" is exactly the contents of that map.

**The delivery ACK is sent from inside the drain.** A delivery reaches
`DaemonRuntime.handleAgentMessage`, is pushed onto the per-Agent
`AgentInputQueue`, and is only acted on by `#drainAgentInputs`, which calls
`AgentMessageAttentionIndex.receive(...)`. That method notifies the session and
*then* sends `agent:deliver:ack`
(`packages/daemon/src/daemon-runtime/agent-message-attention-index.ts`). The
server records the ACK as `AgentMessageDelivery.receivedAt`, and
`readPendingAgentDeliveries` republishes every delivery whose `receivedAt` is
still null on the next ready handshake. So "queued but not drained" is already,
exactly, "accepted locally, never acknowledged, redelivered after restart".
No new spool, no new persistence and no ACK suppression logic were needed.

Raft Computer 1.0.32 is prior art for the shape: an update quiesces its runners
behind an admission gate, waits a bounded time for in-flight work, and proceeds
regardless rather than letting one stuck runner pin a machine on an old version.
This record was written by comparing that public product behaviour against this
codebase's own seams. No Raft code, identifier or wording is used; the verbs,
protocol messages, constants and gate placement below are ours.

## Decision

**Two additive local RPC verbs.** `daemon:hold` and `daemon:release`
(`LOCAL_RPC_METHODS.HOLD` / `.RELEASE`), carrying new protobuf messages
`DaemonHoldRequest` / `DaemonHoldResponse` with `HeldBusyAgent`
(`proto/coforge/rpc/v1/local_rpc.proto`). `protocol_major` stays `1`. They are
deliberately *not* `LIFECYCLE_METHODS`: a lifecycle response carries
`ManagedRuntimeIdentity[]`, and the caller here needs the busy set instead.

A daemon that does not implement the port answers `accepted: false`. Every
caller reads that as "cannot hold, carry on" — an upgrade is never blocked by a
daemon that cannot be held.

**Queue, never reject, never acknowledge.** `DaemonRuntime.holdRunners(reason)`
sets an in-memory `#runnerHold` and returns the busy set. While it is set:

- `handleAgentMessage` still enqueues the delivery on the existing
  `AgentInputQueue` and returns immediately, but does not drain it and does not
  wake a stopped Agent.
- `#ensureAgentInputDrain` refuses to start a drain, which closes the second
  route in (an in-flight launch's `.then` also calls it).
- `#startAgent` refuses a *brand-new* process launch. A launch that only extends
  a live runtime returns before the gate and is untouched. Refusing is safe:
  `#agentControl.replay()` re-issues the intent after the restart, and a process
  started inside the window would have been killed seconds later anyway.

Because the drain is the only thing that ACKs, a held delivery is never
acknowledged, so the server keeps it pending and republishes it after the
restart. `releaseRunners()` clears the flag and re-drains every queue, so
anything queued behind a hold resumes in arrival order.

**The hold is never persisted.** `#runnerHold` is a private field and nothing
writes it to disk, so a restarted Workspace daemon is never born held. `stop()`
clears it too, so a runtime object that is restarted in place starts clean.
This is the whole of the rollback story: if the install fails and the previous
version is restored, the replacement daemon simply has no hold.

**The Coordinator fans out; unreachable counts as idle.**
`run-supervisor.ts` answers `daemon:hold` by calling `childClient(...).hold(...)`
on every *running* Workspace in parallel, merging their busy sets and stamping
each with its Workspace id. A Workspace that does not answer within
`RUNNER_HOLD_WORKSPACE_TIMEOUT_MS = 5_000`, or answers `accepted: false`, is
reported in `unreachable_workspace_ids` and counted as idle. A wedged Workspace
daemon must not be able to block a Computer upgrade.

**The upgrade waits, bounded, then proceeds.**
`holdRunnersUntilQuiescent` (`packages/computer/src/release/runner-hold.ts`)
polls the hold — which is idempotent, so a poll is simply a repeat call — every
`UPGRADE_RUNNER_HOLD_POLL_MS` (250 ms) until the busy set is empty or
`UPGRADE_RUNNER_HOLD_MS` (30 s) elapses. At the deadline it logs one structured
`upgrade:runner_hold_deadline` event per still-busy Agent with its Workspace id,
Agent id, detail kind and elapsed ms, and returns. Every failure mode resolves
towards proceeding: a hold that cannot be asked at all, or that starts failing
mid-poll, returns quiescent immediately.

`UpgradeLifecycle` gains `holdRunners()`, called by `switchRuntime` immediately
before the first `lifecycle.stop(snapshot)`. The rollback path's second `stop`
is deliberately *not* held: that path is already failure recovery, and a second
30 s wait there buys nothing.

**Release rides on `resumeLaunches`.** The supervisor lifecycle's
`resumeLaunches()` sends `daemon:release` before `daemon:resume`. That is what
lifts a hold when an upgrade aborts between the hold and the stop. On the
success path the daemon answering is a fresh process that was never held, and
`daemon:release` is idempotent, so the extra call is a no-op rather than a
special case.

### Which commands hold

Only the paths that go through `UpgradeLifecycle` do — that is `upgrade` and
`rollback`, whether started by the server (`__remote-upgrade` → `daemon:upgrade`
→ the detached coordinator) or from the CLI, since ADR 0017 already routed both
through `runUpgradeOperation`.

`coforge-computer stop` does not hold, and should not: an explicit stop is an
operator saying "now". It goes through `daemon:stop`, which never touches
`UpgradeLifecycle`.

`coforge-computer restart` does **not** hold either, and this record does not
change that. Contrary to how it is often described, `restart` does not go
through `UpgradeLifecycle`: `createDaemonCommand` calls
`DaemonCommandRunner.command("restart", workspace)`, which is the `daemon:restart`
local RPC handled by `MachineSupervisor.command(...)`. Giving `restart` the same
hold is a reasonable follow-up, but it is a different seam (the Coordinator's own
lifecycle command path, not the upgrade coordinator) and is left out here to keep
this record to one concern.

### CLI-originated sends are not gated

An Agent's own `coforge message send` (`DaemonRuntime.agentMessage`, reached
through the Agent CLI proxy) passes through a hold untouched. Gating it would be
actively harmful: the Agents that hold the upgrade up are precisely the ones
mid-turn, and blocking their CLI calls would deadlock the quiescence wait
against the work it is waiting for, then lose the send when the 30 s bound
expired into a SIGKILL.

It is also unnecessary. A send from Agent A to Agent B is not delivered locally;
it goes to the server, which publishes a delivery back down to B — where the
`handleAgentMessage` gate already stops it. The hold therefore already covers
the *effect* of a CLI send on a new turn without blocking the sender.

## Consequences

- An upgrade now takes up to 30 s longer when Agents are mid-turn, and is
  unchanged when they are idle (the first poll returns immediately).
- `packages/coforge-sdk` carries three new messages and two new method names, all
  additive. An older Workspace daemon answers `accepted: false` to `daemon:hold`
  and is treated as unreachable-but-idle, so a mixed-version machine upgrades
  with today's behaviour rather than failing.
- The Coordinator now makes outbound calls to its children during an upgrade.
  This is the first Coordinator→Workspace RPC; it reuses the `childClient`
  sockets and adds no new listener.
- **Needs a Computer release.** The hold is entirely Computer-side (daemon +
  coordinator + protocol); no web deploy is involved, and no server behaviour
  changes. A machine only gets the hold once both the Coordinator and its
  Workspace daemons are on a build that has it.
- A held Agent's deliveries sit in memory for up to 30 s and are then rejected by
  `stop()`. That is not a loss — they were never acknowledged, and the server
  republishes them — but it does mean the daemon logs a burst of
  `message_delivery` operation failures during an upgrade.

## Rejected alternatives

- **Drain by waiting on the Agent process rather than on Activity.** The process
  is alive between turns too, so it would never go quiet. The Activity busy set
  is the only signal that distinguishes "mid-tool-call" from "idle and resident".
- **Suppress the ACK explicitly during a hold.** Unnecessary and riskier: the ACK
  is already downstream of the drain, so not draining is not acking. An explicit
  suppression would have introduced a second, divergent notion of "handled".
- **Persist the hold so it survives a restart.** The opposite of what is wanted.
  A hold that outlived a failed install would leave a restored daemon refusing
  turns with nothing left to lift it.
- **Block the upgrade until every Agent is idle.** One stuck Agent would pin a
  machine on an old version indefinitely, including on the security fix the
  upgrade was carrying. The bound is the point.
- **Put the wait inside `MachineSupervisor.pause()`.** `pause` is about lifecycle
  commands and is also reached from paths that must stay fast. Overloading it
  would have made an already subtle flag mean two unrelated things.

## Validation and rollback

Unit tests over each seam: the runtime gate (a held delivery queued and not
acknowledged, release resuming in arrival order, idempotence, the busy query
against BUSY/terminal detail kinds, a refused new launch, and a fresh runtime
starting unheld); the local RPC round-trip including a daemon that cannot hold;
the quiescence wait against a virtual clock (early return, the 30 s bound with a
logged busy list, unreachable-as-idle, and a hold that fails outright or
mid-poll); and the coordinator ordering (`hold` recorded before `stop`, and
`stop` not entered until `holdRunners` resolved).

Not verified: no live remote upgrade was run against a real Agent under load, so
the end-to-end claim that a real mid-tool-call Agent finishes inside 30 s rests
on the unit-level seams rather than on an observed run.

Rollback is by revert, and is unusually cheap here because nothing is persisted
and no server behaviour changes. A reverted Coordinator simply stops sending
`daemon:hold`; a reverted Workspace daemon answers `accepted: false` and is
treated as unreachable-but-idle, which is today's behaviour. There is no state
to migrate back and no in-flight operation that a revert can strand: the hold
lives only in one process's memory and dies with it.
