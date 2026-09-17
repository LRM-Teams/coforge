# ADR 0039: Agent control — the latest command always wins

Status: accepted
Date: 2026-09-17

## Context

`AgentControl.begin()` (`apps/web/src/server/agents/agent-control.server.ts`) is the single
writer behind `execute()`, `publishStart()`, and `publishStop()`. Before this record, a
non-terminal `controlState` made every new operation throw `"Agent control operation is
pending"`, unless [ADR 0035](0035-agent-control-abandoned-pending-supersede.md)'s abandonment
rule judged it abandoned (no `updatedAtMs`, or older than `abandonAfterMs`, default 60 s) — in
which case it was superseded exactly like a terminal `old`. A double click, two Workspace members
clicking Restart on the same Agent within the same minute, or a Stop issued while a Start was
still genuinely in flight, all hit the "pending" rejection and surfaced as a generic submit error
in the Web UI (`m.agent_control_submit_error`), on the click that lost the race — even though a
second, entirely reasonable command was the one that actually mattered to the person who issued
it.

### Product decision (owner, 2026-09-17)

What Raft does not have, CoForge does not keep. Raft Computer 1.0.32 keeps no record of an
operation in progress at all; a user may issue start/stop/reset at any time, and the newest
command simply takes effect while earlier work is cancelled or ignored by epoch. There is
therefore no "operation is pending, try later" rejection on Raft's side, and no concept of an
"abandoned" operation to detect — an operation can never sit around long enough to need detecting.
The owner directed that CoForge follow this exactly: remove both concepts (pending-blocks and
abandonment) rather than merely shortening the abandonment window or adding more special cases.

### Raft Computer 1.0.32 comparison

Following the split [ADR 0033](0033-agent-stop-outcome-and-control-repair.md) and
[ADR 0038](0038-agent-start-and-stop-persisted-state.md) already use: what is **VERIFIED** by
reading the shipped 1.0.32 daemon bundle (`docs/agents/reference-cli-research.md`; design
reference only, nothing copied), versus what is **INFERRED** because Raft's server is not
available to inspect.

**VERIFIED** (daemon bundle, e.g. `stopAgent` and its neighbours):

- `stopAgent(agentId)` immediately removes the agent from the in-memory running-agent table
  (`this.agents.delete(agentId)`), calls `this.lifecycleRecords.recordStop(agentId)`, and calls
  `this.cancelQueuedAgentStart(agentId, "stop requested")` — a Start still *queued* (not yet
  launched) for that Agent is actively cancelled, not launched and then killed.
  `cancelQueuedAgentStart` resolves the queued caller and logs
  `daemon.agent.start.cancelled` with `reason: "stop requested"`; it never lets a cancelled queue
  entry reach a real process spawn.
- The daemon tracks a per-Agent `startEpoch`; after a Stop completes, `startEpochChanged(agentId,
  startEpochAtStop)` is checked before reporting the stop's own status, specifically to suppress a
  stale stop report "after replacement start" — i.e. epochs exist purely to tell a superseded
  operation's own late-arriving status apart from the operation that replaced it, never to block
  the replacement from starting.
- There is no code path in the daemon that rejects a Start, Stop, or reset because another
  operation for the same Agent is already in progress. The daemon has queueing/backoff for
  concurrency and capacity reasons (`agentStarts` queue, spawn-fail backoff), never a "this Agent
  has a pending operation, reject" gate.
- Client/daemon activity/status vocabulary stays binary (`active`/`inactive`) with no
  "pending"/"in progress" status Rate a caller could poll for (already recorded in ADR 0033/0038).

**INFERRED** (no server source available):

- Raft's server-side equivalent of CoForge's `AgentControl.execute()`/`begin()` almost certainly
  has no "operation is pending" rejection either, since nothing on the wire or in the daemon
  expects one, and the daemon's own cancel-on-supersede behaviour above would be unreachable if
  the server queued or rejected competing commands before they reached the daemon at all.
- Raft's server has no equivalent of `updatedAtMs`/an abandonment timer; there is nothing to time
  out when nothing can ever be "pending" long enough to need it.

### Constraints already in place that this change has to respect

- `begin()`'s existing terminal-`old` supersede path (epoch + 1, identity retained by the
  `computerId`/`provider` rule, `launchId`/`launchIdentityBound` dropped) is already the correct
  shape for "this operation is over, a new one can start." This record only removes the condition
  that limited that shape to a terminal (or abandoned) `old`.
- The CAS retry loop (3 attempts), `operationFence`'s exclusion list, `requireCurrentAgentScope`'s
  `sameScope`/`current` staleness checks, ADR 0034's Workspace-capability authorization, and ADR
  0038's `stoppedAt` handling are all independent of *why* a supersede happens and needed no
  redesign — only `begin()`'s single precondition changed.
- `agents.controlState`'s zod schema (`apps/web/src/server/db/repositories/agent-control.
  repositories.server.ts`) is `.strict()`, and rows already written by ADR 0035's code carry
  `updatedAtMs`. Removing the TypeScript field outright without a compatible read path would make
  every legacy row fail to parse.
- `AgentControlAgent.storedRuntimeConfig`/`storedRuntimeSession` already exist for exactly one
  reason: the Prisma CAS predicate must compare against the *exact* stored JSON, not a
  value reconstructed from the cleaned, application-level shape. `controlState` needed the same
  treatment once it could carry a legacy extra key.

## Decision

**1. Latest command wins.** `begin()` drops both the "pending" throw and the abandonment check
entirely. Its only remaining precondition is unchanged in shape: `old?.requestId === requestId`
stays idempotent (returns the existing state, no new epoch, "Operation scope changed" still
guards a same-requestId replay whose action or scope changed). Any *other* `old` — terminal or
not, any action, any phase, including a Full Reset caught mid `clearing` — is superseded exactly
as a terminal `old` already was: epoch + 1, identity retained by the existing rule, `launchId`/
`launchIdentityBound` dropped. There is no "abandoned" distinction left to make.

**2. The abandonment machinery is deleted, not deprecated.** `AgentControlState.updatedAtMs`,
`AgentControl#isAbandoned`, `AgentControl#operationAge`, the constructor's `abandonAfterMs`
option and `DEFAULT_ABANDON_AFTER_MS`, every `updatedAtMs: this.clock()` stamp (in `begin`,
`advance`, `authorizeLaunch`, `result`), and the "must NOT stamp `updatedAtMs`" comments in
`advance()`/`recover()` are all gone. The injectable clock (`timing.now`) is kept — ADR 0038's
`execute()` still uses it to stamp `stoppedAt` deterministically in tests.

**Schema compatibility.** A row persisted before this change still carries `updatedAtMs` in its
stored JSONB. `stateSchema` keeps accepting it as an optional field — documented as "legacy,
ignored, never written" — so a legacy row still parses. `PrismaAgentControlStore.get()` strips it
before constructing the `AgentControlState` handed to the rest of the application, so the field
never reaches `AgentControl` or anything downstream of it, and the write path
(`controlState()`) never reproduces it, because `AgentControlState` has no such field at the
TypeScript level to write in the first place.

This creates a CAS hazard the change also has to close: `replace()`'s compare-and-swap predicate
used to be built by reconstructing the expected JSON from the application-level `before.state`
(`controlState(before.state)`). Postgres JSONB `=` is structural equality, not "same keys after
reconstruction" — a legacy row's stored value still has `updatedAtMs`, but a value rebuilt from
the now-`updatedAtMs`-free `AgentControlState` never would, so every compare-and-swap against a
legacy row would silently report `count: 0` and fail. `AgentControlAgent` gains
`storedControlState?: unknown` — the raw stored JSON exactly as `get()` read it, alongside the
already-established `storedRuntimeConfig`/`storedRuntimeSession` pattern — and `replace()`'s CAS
predicate now compares against that raw value instead of a reconstruction.

**3. Supersede is logged once per occurrence, at info.** `agent_control:pending_superseded`
(ADR 0035, warning level) is replaced by `agent_control:operation_superseded` (info level — this
is normal behaviour, not an anomaly, per `docs/observability.md`'s level guidance), with fields
`agent_id`, `workspace_id`, `computer_id`, `previous_action`, `previous_phase`, `previous_epoch`,
`previous_request_id`, `new_action`, `request_id` (the new request), and `outcome: "superseded"`.
Logged through the same mechanism the codebase already uses for structured events
(`console.info(JSON.stringify({...}))`, mirroring `start.ts`'s existing info-level events and the
warn-level pattern `agent-control-receiver.server.ts`/`agent-session-receiver.server.ts` already
use for their own rejection logs).

**4. The superseded caller sees no error.** Today, `drive()`'s waiter found `state.requestId !==
requestId` and threw `"Agent operation scope changed"`, which the UI rendered as a generic submit
failure — on the *first* click, even when a second, newer command was the one actually running. A
`phase: "superseded"` outcome is added to `AgentControlView` only (never to the persisted
`AgentControlState.phase` — it is synthesized, never stored). `drive()` now distinguishes a
genuine scope change (Agent moved Computer, config revision changed, Agent gone — still `current(agent,
state)` returning false, still throws) from "the Agent's own scope is unchanged but a different,
newer request now owns it" (returns `supersededView(state)`). The same distinction is made in
`drive()`'s publish-failure catch, so a publish that fails because the request was superseded
underneath it is told apart from a genuine transport failure (which still returns the last-known
pending view, unchanged). `executeAgentControl` (`apps/web/src/features/agents/agent-control.
functions.ts`) already only throws on `phase: "failed"`, so it returns normally for `superseded`
with no code change needed there. `publishStop()` — an internal path whose callers need a
*confirmed* stop before mutating configuration — still throws when its stop did not complete,
including when it was superseded, and now says so explicitly in the error message rather than the
generic "has not completed."

**5. Internal paths.**

- `publishStart()`/`publishStop()` are explicit commands made on a user's behalf (config,
  credential, or environment change; Agent creation), reached through
  `PublishAgentRuntimeControl.start()`/`.stop()` (`agent-runtime-control.server.ts`). They follow
  rule 1 unconditionally: they never throw "pending." `publishStart()`'s own inline pending
  check (`state.action !== "start"` → throw unless abandoned) is replaced with an unconditional
  `begin()` call for that branch — the same call, minus the now-nonexistent abandonment gate.
  `publishStart()` keeps its one deliberate carve-out unrelated to pending/abandonment: when the
  in-flight operation is *itself* a Start, it continues that same operation (same requestId,
  no new epoch, no restarted launch) rather than superseding a Start with another Start for the
  same purpose — this is what lets a config-mutation's own `publishStart()` and a Daemon-ready
  recovery's Start land on the Agent without racing each other into two separate launches for no
  reason. Any *other* in-flight action (Stop, Restart, Reset session, Full reset) is now
  superseded like any other command.
- `recover()` (Daemon `ready` reconciliation, called only from `WorkspaceAgentRecovery.
  recoverWorkspace`) is **not** a user command and is unchanged: it never supersedes a non-terminal
  operation, and keeps republishing the current one exactly as before. This is what lets a Daemon
  that lost a command answer the one it already has instead of racing a fresh epoch on every
  reconnect. With pending-blocks gone, a stuck non-terminal operation no longer wedges anyone
  else — the next owner-initiated command (or the next `ready` republish) always makes progress —
  so keeping `recover()` passive costs nothing and avoids the epoch churn a superseding `recover()`
  would cause on every reconnect for an Agent whose Daemon keeps answering slowly. ADR 0038's rule
  that recovery never starts a stopped Agent (`stoppedAt` check in `recoverWorkspace`) is
  untouched.

See the CR/report's caller table for the full enumeration (`agent-runtime-control.server.ts`,
`manage-agents.server.ts`, `agent-environment.server.ts`, `change-agent-runtime-credential.
server.ts`, `agents.functions.ts`, `routes/api/agent-api-keys.ts`,
`centrifugo/rpc-composition.server.ts`) and each caller's post-change behaviour.

**6. Late results from a superseded operation stay harmless.** `result()`, `authorizeLaunch()`,
and the independent Session snapshot receiver (`agent-session.server.ts`) all key off
`requireCurrentAgentScope`/`sameScope`, which already rejects any epoch mismatch with `"Stale
Agent scope"` — superseding bumps `epoch`, so a stale message from the operation that lost the
race is rejected exactly as before, without loosening any of those checks. This record adds
regression tests proving it for a stale stop result, a stale `authorizeLaunch`, and a stale
started result, each landing after a supersede and each confirmed not to move the new operation's
state.

**7. Daemon interplay — analysis only; the Daemon is unchanged by this record.**
`packages/daemon/src/agent-runtime/agent-control.ts` serializes every command for one Agent
through `state.run(agentId, ...)` — a per-agent async mutex, not a queue with visibility into a
newer command until its own turn arrives. When the server supersedes an operation whose Daemon
command is still executing and immediately publishes the next command at epoch + 1:

| In-flight Daemon work | Superseding command | Daemon behaviour | Server learns? |
| --- | --- | --- | --- |
| `stop()` awaiting `runtime.stop()` | Another Stop, or a chain step whose first command is Stop | Queues behind the mutex; the new Stop applies once the old one finishes (idempotent — process is already stopping/stopped) | Old stop's own result carries the old epoch and is rejected `"Stale Agent scope"`, logged `agent_control:result_rejected` — server learns via the rejection log, not a silent drop |
| `start()` awaiting `runtime.launch()` | A Stop (bare Stop, or Restart's first step) | Queues behind the mutex; once the launch finishes (success or its own cleanup), the queued Stop runs and stops the just-launched process | Same as above for the launch's own result; the Stop itself succeeds normally |
| `resetWorkspace()` awaiting `store.clearWorkspace()` | Any command | Queues behind the mutex; the clear always runs to completion (it is not interruptible today, independent of this record) before the queued command is evaluated | The clear's own `workspace-reset` result carries the old epoch and is rejected the same way |
| `start()` already completed (`phase: "running"`, process alive) | Another Start (double Start click, or a user Start racing a Daemon-ready `recover()`-initiated Start) | `start()`'s own `agent_already_running` rejection fires, **before** the daemon ever calls `runtime.result(...)` for this attempt — no result is published for it at all | **No.** The newest epoch's server-side state stays non-terminal (`"starting"`) until a further command supersedes it or the Daemon's next `ready()` triggers `recover()`'s republish |

The `agent_already_running` case is the one outcome that is worse than before, and review found
it is more than a cosmetic stuck row. When a newer Start supersedes an operation that is already
`starting`, the launch that is actually running belongs to the OLD epoch: its `started` result
and its Session snapshots are rejected as stale (rule 6), so the server never records the new
native Session, and the next Restart cannot resume it. It is also easy to reach: during a Restart
the Agent shows offline, so the UI offers Start.

**7a. A user Start joins a launch already in flight.** Raft treats a Start that meets a
running, starting or queued Agent as a rebind, never a second launch
([ADR 0033](0033-agent-stop-outcome-and-control-repair.md)'s Raft comparison;
`cancelQueuedAgentStart` verified again for this record). `execute()` therefore does not call
`begin()` for `action: "start"` when the current operation is non-terminal, in phase `starting`,
still current for the Agent's scope, and the Agent is not marked stopped: it drives the in-flight
request instead and returns that request's view. No epoch is minted, nothing is published twice,
no supersede is logged. Every other action still supersedes a `starting` operation (a Stop must
win over a launch), and `publishStart()` already behaved this way for internal callers.

What remains for a Daemon follow-up, out of scope here: a Start that reaches the Daemon while the
Agent is ALREADY RUNNING under an older, completed operation (a user Start racing a Daemon-ready
`recover()` Start, or Start clicked on an Agent the UI wrongly shows offline) is still rejected
with `agent_already_running` and no result, leaving the new operation non-terminal until the next
command. That case existed before this record. Raft answers it with a rebind; doing the same
needs the Daemon to report the running launch under the new scope and the server to accept it,
which is a wire-visible change for the owner to decide. No row of the table above corrupts state
or deletes a workspace under a live process.

**8. UI.** `apps/web/src/features/agents/agent-control.tsx` already resolves normally (no throw,
no `catch` handler invoked) for a `superseded` outcome, since `executeAgentControl` only throws on
`failed` — no code change was needed to make a superseded outcome show nothing. A grep of
`apps/web/messages/{en,zh-CN}/agents.json` found no copy that existed only to describe "operation
pending, try again"; the existing `agent_control_submit_error`/`agent_control_access_denied`
strings are generic submit-failure/authorization copy still used for genuine failures, so nothing
was removed.

## Rejected alternatives

- **Keep pending-blocks + abandonment (ADR 0035), unchanged.** Rejected per the explicit product
  decision: Raft has neither concept, and CoForge's own incident history (the ADR 0035 context)
  shows an age threshold is a liveness patch on top of a rule Raft does not have in the first
  place, not a requirement of the underlying product. Keeping it would also keep the exact
  "how long is abandoned enough" judgment call the owner directed against making at all.
- **Shorten the abandonment window instead of removing it.** Rejected: any nonzero window still
  produces the same class of "why did my click just error" surprise this record removes, only
  less often; it also keeps `updatedAtMs`, its schema-compatibility burden, and the CAS-predicate
  hazard this record had to fix anyway once a legacy row could carry it. A shorter window does not
  change the double-click-produces-an-error outcome at all, since a fresh operation (age below any
  window) still blocks.
- **Per-action priority rules** (for example: Stop always wins over Start immediately, but two
  Starts still queue). Rejected: Raft has no per-action priority table either — "the newest command
  wins" is uniform across every action pair. A priority table would also need its own matrix of
  cases to define and test (5 actions × 5 actions), for a distinction Raft's own design does not
  make.
- **Error the superseded caller, but with a distinguishable error code instead of a generic
  failure.** Considered as a smaller step than adding a `superseded` view phase. Rejected: it
  still shows an error for a request that was not actually rejected for anything the user did
  wrong — a double click (or two members clicking) would still show *something* on the first
  click's UI even though the newer command is the one running; the brief's explicit requirement is
  that a superseded outcome shows nothing.

## Consequences and migration plan

- `AgentControlState` loses the `updatedAtMs` field. `AgentControlView` gains `phase:
  "superseded"`, additive to the existing `"pending" | "completed" | "failed"` union; nothing
  reads `AgentControlView.phase` exhaustively as a switch today, so this is source-compatible.
- `AgentControlAgent` gains `storedControlState?: unknown`, populated by
  `PrismaAgentControlStore.get()` and consulted only by `PrismaAgentControlStore.replace()`'s CAS
  predicate; every hand-rolled in-memory `AgentControlStore` fake in the test suite ignores it
  (optional field), unaffected.
- A `controlState` row written before this change still parses (`updatedAtMs` accepted, stripped
  on read) and is safely compare-and-swapped against (via `storedControlState`) despite carrying a
  key the new code never reconstructs. No data migration is needed; the next successful write to
  any such row naturally drops the field for good.
- `agent_control:pending_superseded` (warning) is replaced by `agent_control:operation_superseded`
  (info) — a log-consumer dashboard or alert keyed on the old event name needs updating; there is
  no wire or schema change, so this is a pure logging-contract change.
- ADR 0035's Decision B (rejection logging for `agent_control:result_rejected`/
  `agent_session:snapshot_rejected`) is untouched and still in effect — this record only
  supersedes Decision A.
- No change to the wire protocol, the command chains, the CAS retry count, or ADR 0034's
  authorization model.

## Validation and rollback criteria

Validated by unit tests in `apps/web/test/agent-control.test.ts`: a fresh pending operation
(no age concept left to vary) is superseded by each of start/stop/restart/reset-session/
full-reset via `execute()`, and by `publishStart()`/`publishStop()`, each with `epoch + 1` and the
new log event's full field set; a pending Full Reset caught in `stopping`/`clearing`/`starting` is
superseded by every competing action, with a Full Reset caught in `clearing` starting its
replacement chain fresh at `stopping`; the same `requestId` stays idempotent both while pending
and after completion (no new epoch, no throw, at most a harmless duplicate republish); a
superseded waiter resolves `phase: "superseded"` from `drive()` itself, deterministically, using a
controlled publish-time race rather than a sleep; `recover()` still republishes the same pending
request unchanged, without superseding it; three stale-message tests (an old stop result, an old
`authorizeLaunch`, and an old started result, each arriving after a supersede) are all rejected as
stale and leave the new operation's state untouched; two repository-level tests
(`apps/web/test/agent-control-repositories.test.ts`) prove a legacy row with `updatedAtMs` parses
through `get()` with the field stripped, and that `replace()`'s compare-and-swap succeeds against
that legacy row's raw stored JSON, with the next write dropping the field. All of ADR 0035's
60-second-window-specific tests were deleted; every other assertion was converted to the new rule.
`bun run check`, the full Agent control/session test files, and `bun run --cwd apps/web build`
were run; see the CR/report for verbatim pass counts.

Rollback is a plain revert: this record removes fields and branches rather than adding
irreversible ones, and the schema change (accepting, then dropping, `updatedAtMs`) reverts
together with the rest of the record.
