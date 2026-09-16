# ADR 0021: A Workspace restart holds its own runners before stopping them

Status: accepted
Date: 2026-09-16

## Context

[ADR 0020](0020-upgrade-runner-hold.md) gave a Computer upgrade a bounded runner
hold and deliberately left `restart` out, on the grounds that it is a different
seam: `restart` does not go through `UpgradeLifecycle` at all. `createDaemonCommand`
calls `DaemonCommandRunner.command("restart", workspace)`, which is the
`daemon:restart` local RPC, handled by `MachineSupervisor.command(...)`. A remote
restart from the web arrives at exactly the same place, because the Workspace
daemon's `requestRestart` dials the Coordinator's `daemon:restart` too.

So `coforge-computer restart` still gave an Agent halfway through a tool call the
~2 s SIGTERM/SIGKILL ladder in `DaemonRuntime.stop()` — the very failure ADR 0020
was written to remove. A restart is the *more* common operation of the two, and
the one a person is most likely to run while watching an Agent work. This record
closes that gap. It changes no protocol and no daemon behaviour; everything it
needs already shipped with ADR 0020.

Raft Computer 1.0.32 is prior art for quiescing runners before a lifecycle
operation and proceeding regardless. As in ADR 0020, this record is a comparison
against that product's observable behaviour; no Raft code, identifier or wording
is used.

## Decision

**The hold goes in `MachineSupervisor.#advanceRestart`, in the `stopping`
phase.** It runs immediately before `await this.#stop(binding)`, inside the
branch that actually stops (`current === null || current === restart.previousInstanceId`),
and only when `current !== null`. A restart that finds no live invocation, or one
the OS has already replaced, has nothing to drain and does not wait.

This is the narrowest placement that covers every way a restart is asked for,
because they all converge on `MachineSupervisor.command("restart", ...)`. It also
inherits the restart state machine's existing recovery for free: a restart
interrupted after the hold and before the stop resumes from `stopping` and
re-asks, which is idempotent.

**The hold is per Workspace, not machine-wide.** An unscoped restart holds each
enabled binding in turn as the command loop reaches it; a scoped restart holds
only its target. That is why it does not go through the Coordinator-wide
`fanOutRunnerHold` in `run-supervisor.ts`, which is the upgrade's path: an
upgrade replaces the whole process tree and must quiesce all of it, whereas
`coforge-computer restart --workspace X` must not stop Y's Agents admitting turns.

**`WorkspaceProcesses` gains an optional `hold`.** `MachineSupervisor` reaches
its children only through that interface, so the hold arrives the same way `start`,
`stop` and `instance` do. `run-supervisor.ts` implements it with
`childClient(workspaceId).hold("hold", "restart")` raced against the existing
`RUNNER_HOLD_WORKSPACE_TIMEOUT_MS` (5 s). The single-Workspace call is factored
out of `fanOutRunnerHold`, so the fan-out and the restart share one definition of
"asked one Workspace, treated `accepted: false`, a timeout and an error alike as
unreachable-and-idle". A `WorkspaceProcesses` with no `hold` restarts exactly as
before.

**The wait itself moves into the daemon package.**
`holdRunnersUntilQuiescent` and its constants were in
`packages/computer/src/release/runner-hold.ts` but are not upgrade-specific, so
they now live in `packages/daemon/src/supervisor/runner-hold.ts` and are exported
from the daemon package's public entry. `UPGRADE_RUNNER_HOLD_MS` and
`UPGRADE_RUNNER_HOLD_POLL_MS` become `RUNNER_HOLD_MS` (30 s) and
`RUNNER_HOLD_POLL_MS` (250 ms). The module's own two log lines take their category
and event prefix from the caller, so the Computer upgrade keeps emitting
`upgrade:runner_hold_*` from `coforge.computer.upgrade` unchanged, and the restart
emits `restart:runner_hold_*` from `coforge.daemon.supervisor`.

**Release only when the stop fails.** The hold is in-memory in the Workspace
daemon and `#stop` kills that process; the replacement is born without one
(ADR 0020, "the hold is never persisted"), so the ordinary path never releases.
The one case where the held daemon survives is an OS stop that throws. Nothing
retries a failed restart on its own: the record stays in `stopping` until an
operator issues the next command, which may be hours later, and in the meantime
a held daemon would queue every delivery without acknowledging it. So
`#advanceRestart` lifts the hold (`WorkspaceProcesses.release`, the same
`daemon:release` verb the upgrade uses, best-effort) before rethrowing the stop
failure. A later retry re-asks the hold, which is idempotent.

**Every failure resolves towards proceeding.** A restart is never failed because
the hold could not be asked, the Workspace did not answer, or the Agents did not
go idle within 30 s. When the wait ends, the supervisor logs one structured line —
`restart:runner_hold_quiescent` or `restart:runner_hold_expired`, with
`workspace_id`, `quiescent`, `elapsed_ms` and `busy_agent_count` — alongside the
per-Agent `restart:runner_hold_deadline` lines the shared helper already emits.

### Which commands hold

`restart` does, whether it comes from the CLI, from the web, or from a Workspace
daemon's own `requestRestart`. `stop` does not, and this record does not change
that: as in ADR 0020, an explicit stop is an operator saying "now". `configure`
does not either; it is a Workspace replacement, not a lifecycle pause, and its
stop is followed immediately by a start with a new identity.

## Consequences

- A restart of a Workspace with busy Agents now takes up to 30 s longer, and is
  unchanged when they are idle: the first poll returns immediately.
- **The wait runs inside the supervisor's serialized mutation.** Every other
  lifecycle command — `configure`, `start`, `stop`, another `restart`, `snapshot`
  — queues behind it for up to 30 s. This is accepted rather than worked around:
  an upgrade's `pauseLaunches` already blocks the same queue for as long, and a
  command that raced ahead of the drain would defeat the point of draining. The
  bound is what makes it safe.
- No protocol change, no new RPC verb, and no new persisted state. `daemon:hold`
  and the `HeldBusyAgent` messages shipped with ADR 0020; this record only calls
  them from a second place.
- **Needs a Computer release**, for the same reason ADR 0020 did: a machine gets
  the behaviour once its Coordinator and its Workspace daemons are both on a
  build that has it. A Workspace daemon too old to answer `daemon:hold` replies
  `accepted: false` and is counted as idle, so a mixed-version machine restarts
  with today's behaviour rather than failing.
- The upgrade path now imports `holdRunnersUntilQuiescent` from
  `@lrm/coforge-daemon`. `packages/computer` already depends on that package for
  `createDaemonHost` and `LocalDaemonLauncher`, so this adds no dependency and no
  new direction of coupling.

## Rejected alternatives

- **Route `restart` through `UpgradeLifecycle` so it reuses ADR 0020's hold.**
  That seam stops the whole Computer process tree, including the Coordinator. A
  restart of one Workspace must not do that, and forcing it through would have
  made a scoped command machine-wide.
- **Hold from `run-supervisor.ts`'s `daemon:restart` handler, before calling
  `supervisor.command`.** It would miss the recovery path that resumes an
  interrupted restart, and it would hold every Workspace for an unscoped restart
  before stopping the first one, stretching the worst case rather than bounding
  it per Workspace.
- **Give `stop` the hold too.** An explicit stop is immediate by contract
  (ADR 0020). A person who wants the drain has `restart`.
- **Leave a failed stop held until the next command re-asks.** Rejected: a
  restart that fails at the stop is not retried automatically, so "the next
  command" can be far away, and until it arrives the daemon would sit accepting
  deliveries it never drains or acknowledges.
- **Make the bound configurable per restart.** 30 s is already the number ADR 0020
  chose for the same wait over the same busy predicate; a second, divergent
  budget would only invite them to drift.

## Validation and rollback

Unit tests over `MachineSupervisor`: `hold` is asked before `stop` for a live
instance, with `"restart"` as the reason; `stop` still runs when the Agents are
busy past the deadline; a restart skips the hold when the instance is already
gone, and neither holds nor stops when the OS has already replaced it; a hold
that throws, reports its Workspace unreachable, or starts failing mid-poll still
restarts; `stop` never holds; a `WorkspaceProcesses` without `hold` behaves as
before; and an unscoped restart holds each binding as the loop reaches it. The
moved quiescence wait keeps its own tests against a virtual clock.

Not verified: no live restart was run against a real Agent mid tool call, so the
end-to-end claim rests on the unit-level seams, exactly as in ADR 0020.

Rollback is by revert and strands nothing: the hold lives only in one Workspace
daemon's memory and dies with that process. A reverted Coordinator simply stops
sending `daemon:hold` before a restart.
