# ADR 0033: Agent Stop outcome is local process exit; control records are repaired, never latched

Status: accepted
Date: 2026-09-17

## Context

Staging Computer s144, 2026-09-17, daemon versions dev.28 through dev.35 (spanning the
upgrades in ADR 0030/0032): an Agent became permanently unstartable across three daemon
upgrades.

1. The server sent a fenced Stop at control epoch 8. `DaemonRuntime.#releaseAgentRuntime`
   (`packages/daemon/src/daemon-runtime/runtime.ts`) ran the remote Agent API key revoke and
   the local process stop in one `Promise.allSettled` and threw if either rejected. The local
   process exited cleanly (exit 143, expected for a requested stop); the revoke HTTP call
   failed because the server was mid-deploy. The combined `allSettled` still rejected, and
   `AgentControl.stop` (`packages/daemon/src/agent-runtime/agent-control.ts`) persisted the
   result as `phase: "stopping"` with a terminal `stopResult: { phase: "failed", errorCode:
   "stop_failed" }` — a *local* Stop recorded as failed because of a *remote* revoke failure.
2. Nothing about that persisted record distinguished "the process didn't exit" from "the
   process exited fine but something else failed." Every subsequent operation treated it as
   the former: a same-epoch Stop retry replayed the stored failed receipt instead of trying
   again; a Start was rejected with `previous_control_not_completed` because the phase was
   still `"stopping"`; and after each of the three following daemon restarts, `fence()`
   rejected every request at every epoch with `previous_process_stop_unconfirmed`, because the
   record's `daemonInstanceId` no longer matched the running daemon and the phase was still one
   of `running`/`starting`/`stopping`. The same fence unconditionally treats *any* record left
   at `running`/`starting`/`stopping` by a daemon that never got to write a clean `stopped()`
   fact (a crash, not just this revoke case) the same way: wedged forever, because "a higher
   epoch" was never treated as proof the old process is gone.
3. Diagnostics made this worse, not just slower to notice: the stop failure's `catch {}` logged
   nothing at all, and `agent_runtime:start_failed` logged `error_code: diagnosticErrorCode(error)`,
   which is `"Error"` for every one of `AgentControl`'s fixed rejection messages (`Error.name`
   is generic; the useful information is in `Error.message`, which `diagnosticErrorCode`
   deliberately never logs verbatim for arbitrary errors).

## Decision

**A. Stop's outcome is the local process's exit, full stop.** `#releaseAgentRuntime` now
decides success or failure from `#agentProcessManager.stop(agentId)` alone. The Agent API key
revoke is fire-and-forget: Stop does not await it, the shared Agent API key HTTP helper now
carries the 10 s `AGENT_RPC_TIMEOUT_MS` abort so a hung request cannot linger, a rejection is caught, logged at warning
(`agent_api_key:revoke_failed`, with `agent_id` and `error_code`, never the key), and the key
stays in `#pendingAgentApiKeyRevokes` (it already only left that set on a successful revoke).
The same fix applies to the launch-failure cleanup path, `session.onExit`'s best-effort revoke,
and the shutdown revoke pass — a revoke failure never fails a local operation, and it never
sets `#stop()`'s `shutdownError`. `#stopFailureMessage`'s old text ("Agent authorization could
not be revoked. The Agent process has been stopped.") is now unreachable for the revoke case
and reads "Agent runtime could not be stopped." for a genuine local Stop failure instead;
`CLEANUP_UNCONFIRMED` handling is unchanged. Pending keys are retried on a non-blocking,
best-effort pass (`#retryPendingAgentApiKeyRevokes`) fired after `#agentControl.replay()` on
both the initial `ready()` path and every reconnect, and again at shutdown. The shutdown pass
does *not* unconditionally recreate the transport: `DaemonConnection.revokeAgentApiKey` only
needs the token/`serverHttpUrl` `.start()` already gave it, not the WSS client `.stop()` tears
down, so keeping the same transport instance while a revoke is still pending lets the retry
reuse its already-authenticated state; the transport is recreated once every pending key clears,
same as before.

**B. A stale control record is repaired, not latched, before it can fence a new request.**
`AgentControl.stop`/`start`/`resetWorkspace` now run a repair step (inside the same
`state.run` mutex, before `fence()` and before the `previous_control_not_completed` checks):
if a record's phase is `running`, `starting`, or `stopping`, the process is locally confirmed
not running (`Runtime.running(agentId)` is `false`), the record is **not** flagged
`exitUnconfirmed`, and either the record's `daemonInstanceId` names a daemon instance that is
no longer this one, or the phase is `stopping` with a `stopResult.phase === "failed"` — the
record is rewritten in place to `phase: "stopped"`, preserving `scope`, `sequence`, `identity`
and every prior receipt so idempotency and monotonic sequencing are unaffected, then persisted
and logged **at error level** (`agent_control:stale_record_repaired`, with `agent_id`,
`previous_phase`, `previous_daemon_instance_id`, `daemon_instance_id`, `epoch`). Processing of
the incoming request then continues normally. Error level is deliberate: a stale fact is a bug
in the writer that left it behind, not a normal event, and this repair must never become a
silent, unobserved path.

The new `Runtime.cleanupUnconfirmed(agentId, error): boolean` adapter method (wired in
`runtime.ts` to the existing `#cleanupUnconfirmed`, which already checks
`error instanceof AgentProcessCleanupError || #agentProcessManager.isStopping(agentId)`) is
what AgentControl uses to tell a genuine "process did not exit" failure apart from everything
else. Only that case sets the new optional `AgentRuntimeRecord.exitUnconfirmed` field (optional
so an existing on-disk version-1 record without it still parses); a record so flagged keeps
exactly the previous behavior — fenced forever until an explicit, successful Stop clears it —
both for a Stop that could not confirm exit and for the launch-failure path's own cleanup
attempt (`await this.runtime.stop(intent.agentId)` inside the launch catch can itself reject;
that case is still left fenced, phase `"starting"`, exactly as the pinned test "unconfirmed
launch cleanup remains fenced across daemon restart" already asserted before this change — it
now asserts it through the typed `cleanupUnconfirmed` signal instead of a bare rejection). A
repair only ever touches `running`/`starting`/`stopping`; `"clearing"` (a Full Reset's
workspace deletion in progress) is deliberately excluded, so a repair can never interrupt or
paper over an in-progress destructive operation — it keeps its own resume semantics
unconditionally.

**C. Control rejections are diagnosable.** `AgentControl`'s eight fixed rejection messages
(`previous_control_not_completed`, `previous_process_stop_unconfirmed`, `stale_control_request`,
`control_request_mismatch`, `control_record_missing`, `control_epoch_required`,
`agent_already_running`, `confirmed_stop_required`) are a small, stable, allowlisted set, safe
to log verbatim — unlike an arbitrary error message, which stays out of the logs on purpose.
`#logAgentStartFailure` and `#logAgentOperationFailure` (the latter already covers a fenced
Stop failure in `handleAgentStop`, via the existing `failure("stop", …)` wrapper) now add a
`control_code` field when `error.message` matches one of the eight; `error_code:
diagnosticErrorCode(error)` is kept unchanged alongside it (still `"Error"` for these, since
that is what `Error.name` is — `control_code` is what makes them diagnosable). No other error
message is ever logged this way.

### Comparison with Raft Computer 1.0.32

Behaviour read from the shipped 1.0.32 daemon bundle (see
`docs/agents/reference-cli-research.md`); no code was copied.

- Raft keeps no per-Agent lifecycle state on disk. The running-Agent table, stop/start epochs
  and every fence are in-memory and tied to the live process, so a daemon restart is a clean
  slate. Its status vocabulary is binary (`active`/`inactive`) and a Stop has no receipt, so a
  "failed Stop" is not representable. CoForge keeps its durable control record and Stop
  receipts; decision B gives that record the same property Raft gets for free: it cannot latch.
- Raft removes the Agent from its table before awaiting the kill, and its credential revoke is
  `void`-ed with a trace on either outcome. It never awaits or branches on the revoke. Decision
  A matches this.
- A Start that meets a running, starting or queued Agent is a rebind to the newer request, never
  a rejection; epochs only cancel superseded work. CoForge still rejects genuinely conflicting
  requests (`control_request_mismatch`, `stale_control_request`), which the server relies on.
- Raft repairs stale lifecycle facts before asserting invariants and logs each repair at error
  level, after a field incident where one stale fact blocked Agents until a daemon restart. The
  repair-then-proceed rule and its error-level log in decision B follow that precedent.
- Orphans: Raft reaps by pid when the daemon shuts down cleanly and does not look for a crashed
  instance's processes on the next start. CoForge reaps at the start of the next instance (see
  below), which also covers a crash.

## Why a repair is safe: no orphan survives into a new daemon instance

The concern this ADR's first draft raised — that repairing a `running`/`starting`/`stopping`
record from a *different* daemon instance could resurrect an Agent process a crashed daemon
left running, unfenced — does not apply on either platform this repo supports today, because
the process itself cannot survive into the new instance:

- **macOS**: an Agent process is a per-agent launchd job (`ProcessTreeOwner.spawn` →
  `LaunchdProcessOwner`, labelled under the `COFORGE_WORKSPACE_AGENT_PREFIX` prefix — see
  `packages/daemon/src/platform/process-tree.ts` and `launchd-process.ts`). Every daemon start
  reaps every leftover job under that prefix *before* the Workspace runtime is even constructed:
  `packages/daemon/index.ts` calls `await stopLaunchdJobs(prefix, directory)`
  (`packages/daemon/src/platform/launchd-job.ts`) ahead of `let runtime: DaemonRuntime |
  undefined`. `LaunchdJob.stop()` (used by `stopLaunchdJobs`) does not just ask launchd to tear
  the job down — it polls until the label is gone from `launchctl list` *and* the process group
  is confirmed absent (`processGroupExists`), for up to 10 s, and throws
  `"launchd job cleanup did not complete"` if that does not happen. Because this call is not
  inside a try/catch in `index.ts`, that throw fails daemon startup outright — fail-closed, by
  construction, not by omission: a daemon that cannot prove a previous instance's Agent jobs are
  gone never gets far enough to reach the repair path at all.
- **Linux**: the systemd user units for both the daemon host and each Workspace instance
  (`packages/daemon/src/daemon-host/systemd-user.ts`, `supervisor/systemd-workspace-instance.ts`)
  set `KillMode=mixed`, so stopping/replacing the unit kills its whole cgroup, Agent child
  processes included.

So a repaired record's `Runtime.running(agentId) === false` is not merely the *local* check
passing — on both platforms, a process owned by a previous daemon instance genuinely cannot
still be alive when a new instance evaluates it. This is what makes the cross-instance half of
decision B's repair condition safe, not just convenient.

## Consequences

- **A revoke can lag.** The accepted trade-off of decision A: an Agent API key can remain valid
  for longer than the Stop that was supposed to invalidate it, bounded only by how long the
  retry pass keeps failing (every ready/reconnect, plus shutdown). The key is never silently
  lost — `#pendingAgentApiKeyRevokes` is the durable-enough-for-one-process-lifetime record of
  it — but there is no cross-restart persistence and no hard upper bound today. **Follow-up
  recommended**: a server-side Agent API key TTL, so a lagging revoke has a worst-case expiry
  independent of whether the daemon ever gets back online to retry it.
- **A repair is only as trustworthy as `Runtime.running()`.** If a future platform's process
  ownership model does not give the same guarantee the macOS/Linux note above relies on (an
  orphan cannot outlive its daemon instance), decision B's cross-instance repair branch would
  need a process-identity check added before it could be reused there — recording a process
  group id in the control record and verifying it, the way an orphan reaper would, is the
  natural extension if that ever becomes necessary. Not needed for either platform today.
- **`AgentRuntimeRecord.exitUnconfirmed` is a new optional field.** Existing on-disk version-1
  records without it still parse (`FileAgentRuntimeStateStore.read` does not require it); its
  absence means "the last writer never flagged this exit as unconfirmed," not "confirmed."
- **Log volume**: a repair is error-level and is meant to be rare and actionable — if it starts
  firing routinely, that is itself a sign of a writer bug (a daemon crashing far more than
  expected, or a revoke/transport failure mode not anticipated here), not evidence the repair
  itself is wrong.
- Nothing here changes the wire protocol, the Full Reset command chain, or `AgentSession`'s
  ownership of native Session identity; `docs/architecture.md`'s control-record paragraph is
  updated in the same change to describe the repair instead of "may remain pending, needs
  manual diagnosis."

This does not supersede an existing ADR — a repo-wide search of `docs/adr` for "fence", "agent
control", and "Stop receipt" found no prior record describing `AgentControl`'s fencing design;
it was implemented directly against `docs/architecture.md` without one. This is the first ADR
for that mechanism, not a supersession.

## Validation and rollback

Covered by `packages/daemon/test/agent-control.test.ts` (the exact legacy record shape from
this incident repaired for both a new Start and a new Stop; a `running`-phase record left by a
crashed daemon instance repaired for a newer Start; an `exitUnconfirmed` record still fenced
across a simulated restart; a `"clearing"` reset-workspace-in-progress record left untouched by
a repair) and `packages/daemon/test/daemon-runtime.test.ts` (a revoke rejection with the process
stopping cleanly resolves `stopAgent`, reports status `inactive` and a stopped Activity, keeps
the key pending, and retries it on the next reconnect pass; a fenced Start failure's log record
carries `control_code`). Rollback is by revert; the change is additive to the on-disk record
shape (`exitUnconfirmed` optional) and does not require a data migration either direction.
