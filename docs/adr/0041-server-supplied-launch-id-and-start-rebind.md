# ADR 0041: The server supplies `launchId`; a Start that meets a running Agent rebinds

Status: accepted
Date: 2026-09-17

## Context

[ADR 0039](0039-agent-control-latest-command-wins.md) made the latest control command win and
left one case open (§7a): a managed Start that reaches the Daemon while the Agent's process is
already running under an older, completed operation — a user Start racing a Daemon-ready
`recover()` Start, or Start clicked on an Agent the UI wrongly shows offline. `AgentControl.start()`
answered it with `agent_already_running` and **no result**, so the server's new operation stayed
non-terminal until another command arrived, and because the server state already carried the new
epoch and requestId, the running launch's later Session reports were stale.

A second, related fact: the Daemon minted `launchId` and the server learned it through
`authorizeLaunch`, a read-validate-**write**. That write raced the fire-and-forget
`agent:session:invalidate` of [ADR 0040](0040-agent-session-invalidate.md) and needed a re-read
and retry loop.

### Raft Computer 1.0.32

VERIFIED in the shipped daemon bundle (`docs/agents/reference-cli-research.md`):

- The **server** supplies `launchId` in `agent:start`; the daemon never mints one for a
  server-initiated start.
- `startAgentNow`: a Start for an Agent that is already running calls `rebindRunningStart` and
  returns; a Start while another start is in progress defers the rebind until that start
  finishes. Never a rejection, never a second process.
- `rebindRunningStart`: the running process is kept with its current session and credentials; it
  adopts the new `launchId`, stores the new config for future restarts, reports `agent:status
  active` and `agent:session` under the new `launchId`, and delivers the Start's wake message to
  the running process.
- An explicit Stop clears a pending rebind.

INFERRED (Raft's server is not available): that the server mints one `launchId` per start it
issues and matches later reports against it.

## Decision

**A. The server supplies `launchId`.** `AgentStartIntent` gains `launch_id` (field 19). A managed
start — one that carries `controlEpoch` — must carry it; the SDK rejects encoding or decoding one
without it. The server mints the id the moment an operation enters phase `starting`, in the same
compare-and-swap write that sets the phase: in `begin()` for `action: "start"`, and in `advance()`
when a Restart / Reset session / Full reset chain moves to its start step. A republish of the same
operation (`recover()`, a `drive()` retry, `publishStart()` continuing an in-flight start) sends
the same stored id. A `starting` row persisted before this record gets one minted and persisted
by `publishCurrent` before it is published.

**B. `authorizeLaunch` only verifies.** It checks the current scope, `phase === "starting"`,
requestId, epoch and `input.launchId === state.launchId`, and writes nothing. ADR 0040's re-read
and retry loop and the "Agent launch lost its fence" error are removed: with no write there is no
race with a concurrent Session clear. `AgentSessions.prepare()` records the intent's `launchId` on
the session reference ahead of the Daemon's first report, so `verify()` keeps an exact-match fence
for the whole operation. `result()` is unchanged and stays strict: a `started` result must carry
`launchId === state.launchId`.

**C. The Daemon uses the supplied id.** `AgentControl.start()` launches under `intent.launchId`.
A managed intent without one produces a `failed` result (`agent_launch_id_required`). The cold-start
retry of ADR 0040 keeps reusing the same id.

**D. A Start that meets a running Agent rebinds.** When the process is running, the on-disk
record is `running` with a `launchId` and the same provider, and the incoming epoch is higher,
`start()` rebinds instead of rejecting:

- the record adopts the new scope and the new `launchId`, stays `running`, keeps `identity` and
  `daemonInstanceId`, restarts its sequence, and drops the previous epoch's receipts;
- one runtime hook, `rebind(intent, launchId)`, re-points every place that remembers the launch's
  identity — the session reference (`requestId`, `controlEpoch`, `launchId`), the activity launch
  (`launchId`; `clientSeq` restarts, the server's idempotency key is `(agentId, launchId,
  clientSeq)`) — by mutating the existing objects in place, so the process-exit handler and the
  activity memory keep their identity checks;
- it re-reports the Session under the new scope with `previousLaunchId`, sends `agent:status`
  active, delivers the Start's wake message through the existing `wake` hook, and sends a
  `started` result for the new scope, stored for equal-epoch replay;
- the Agent API key and local proxy token are kept; no launch config is requested;
- a pending `agent:session:invalidate` for the replaced launch is dropped by ADR 0040's existing
  rule once the re-report goes out;
- logged once as `agent_control:start_rebound` (info).

Commands for one Agent are serialized by `AgentRuntimeState.run`, so a Start that arrives while
another is launching runs after it and takes this path; no deferred-rebind structure is needed.
A running process without a matching `running` record still answers `agent_already_running`, now
with a `failed` result so the server operation terminates. Records in `stopping` / `clearing` /
`starting`, a lower epoch, a provider mismatch and `exitUnconfirmed` are rejected as before.

ADR 0039's join rule stays: a user Start that meets an operation still in phase `starting` joins
it on the server and never reaches the Daemon as a second Start.

**E. No backward compatibility.** Owner-approved on 2026-09-17 (root `AGENTS.md` decision gate
for wire changes): a Daemon older than this record ignores `launch_id`, mints its own id, and its
`authorizeLaunch` is refused until the Computer upgrades.

## Rejected alternatives

- **Keep rejecting with `agent_already_running`.** Leaves the operation hanging and diverges from
  Raft.
- **A `rebound` flag on `AgentControlResult` with a server rule accepting an unauthorized
  `launchId`.** Keeps the Daemon-minted id, adds a wire field and a special case to the strictest
  check in `result()`; Raft needs neither.
- **The server keeps both rules for old Daemons.** A second `launchId` regime is a concept Raft
  does not have; the fleet is a handful of self-upgrading Computers.
- **Stop then start instead of rebinding.** Kills a healthy process and its context to satisfy
  bookkeeping.

## Consequences and migration plan

- One wire field added to `AgentStartIntent`; `AgentControlResult` is unchanged.
- Computers must upgrade to a release containing this record before their Agents can be started
  by a server containing it.
- Known remaining difference from Raft: a launch the Daemon initiates itself (an idle Agent woken
  by a delivery) still mints its own `launchId` and hands over with `previousLaunchId`; Raft
  reuses the restart snapshot's id. Out of scope here.
- A rebind does not adopt the new Start's runtime config for the running process. In CoForge a
  config change always goes through Stop → persist → Start, so a rebind never carries a different
  config.
- ADR 0038 holds: a user-stopped Agent has no running process once Stop completed, and
  `recover()` skips Agents with `stoppedAt`, so a rebind cannot resurrect one.

## Validation and rollback criteria

- SDK: `launchId` round-trip; a managed intent without it is rejected on encode and decode.
- Server: one id per operation, stable across republish, present for start / restart /
  reset-session / full-reset; `authorizeLaunch` makes zero writes and is unaffected by a
  concurrent Session clear; a legacy `starting` row gets an id.
- Daemon: start uses the supplied id; rebind happy path, equal-epoch replay, stale epoch, provider
  mismatch, non-terminal record, running-without-record, back-to-back Starts → one launch; after a
  rebind the next session report, status and activity carry the new scope.
- End to end (`apps/web/test/agent-control-runtime.test.ts`): start, complete, second Start while
  running → completes under the new `launchId`, one process, later snapshot accepted, wake
  delivered.
- Roll back by reverting this record's change on both sides together; the field is additive on
  the wire, but a server that mints ids requires Daemons that use them.
