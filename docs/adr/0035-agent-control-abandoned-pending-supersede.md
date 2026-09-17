# ADR 0035: An abandoned Agent control operation can be superseded server-side

Status: accepted
Date: 2026-09-17

## Context

Staging incident, Computer `s144`, 2026-09-16/17: a Daemon-side Stop failed at control epoch 8,
leaving `agents.controlState` (`AgentControlState`, `apps/web/src/server/agents/agent-control.
server.ts`) terminal `failed`. On the next Daemon `ready`, `WorkspaceAgentRecovery.
recoverWorkspace` (`agent-runtime-control.server.ts`) called `AgentControl.recover`, which
minted epoch 9, phase `starting`, and published a Start. The Daemon rejected that Start locally —
a fence in its own control record threw before it produced any result — so the server never
received a control result for epoch 9. `AgentControl.drive`'s waiter gives up after 7 s and
nothing else times out a control operation; `controlState` stayed non-terminal `starting`
forever. For the next 22 hours, across three Daemon upgrades:

- every Daemon `ready` re-published the same stored `requestId` (`recover`'s `advance` branch),
  because the Daemon kept answering the reconnect with "not running" and the server kept
  believing epoch 9 was still in flight;
- `begin()` (the single writer behind `execute`, `publishStart`, and `publishStop`) throws
  `"Agent control operation is pending"` for **any** new operation whenever the stored state is
  non-terminal — so Restart, Stop, and `ManageAgents.update`'s stop → persist → start sequence
  (`manage-agents.server.ts`, provider/model/credential changes) all failed. The user could not
  switch the Agent's runtime provider; the UI only reported that the request failed, with no path
  to recovery short of a manual database fix.

The server-side sequence above is reconstructed from the Daemon log (one Start `requestId`
replayed at every `ready`, each rejected within 100 ms) and from the code paths; the
`agents.controlState` row itself was not inspected.

Raft Computer 1.0.32's Daemon protocol has no control receipts and no pending operation: status
is `active`/`inactive`, `agent:start` is idempotent, and the server reconciles from
`ready.runningAgents`, so nothing on that side can stay pending. CoForge keeps receipts and
epochs; this ADR gives the stored operation the same property, it cannot latch.

`controlState` carried no timestamp, no lease, and no way out of a non-terminal phase other than
a Daemon control result. This is true regardless of *why* the Daemon never answers: offline
forever, crashed mid-operation, running a build that predates the fix, or (as here) a result that
was produced and lost. [ADR 0033](0033-agent-stop-outcome-and-control-repair.md) fixes the
Daemon-side latch that caused this specific incident (a stale local control record rejecting a
Start it should have repaired and answered), but it only helps once every affected Daemon has
that fix deployed and reconnects. This record is the complementary server-side fix: the server
must be able to un-wedge itself no matter what a Daemon does or fails to do.

Constraints already in place that the fix has to respect:

- `begin()`'s existing terminal-`old` supersede path (epoch + 1, identity retained per
  `computerId`/`provider`, `launchId`/`launchIdentityBound` dropped) is the correct shape for
  "this operation is over, a new one can start" — the fix needs the same shape for "this
  operation isn't over, but nobody is driving it".
- The destructive Full Reset chain (`stop` → `reset-workspace` → `clear-session` → `start`) has
  an existing rule for a **failed** `full-reset`: only a new, explicitly confirmed `full-reset`
  may retry it, because the Daemon may have half-deleted the Agent workspace and its own control
  record enforces the same thing. A **stuck** (non-terminal, abandoned) `full-reset` carries the
  identical risk and needs the identical rule.
- `requireCurrentAgentScope`'s `sameScope`/`current` checks, and `begin`'s own CAS-retry fence
  comparison (`operationFence`), already have to distinguish "this state changed in a way that
  matters" from "this state changed in a way that doesn't" (identity, `sessionSequence`,
  `launchIdentityBound`, `recovered` are already excluded from the fence for that reason).
- `AgentSessionReceiver.accept` (`agent-session.server.ts`) writes into the same JSONB column for
  an unrelated purpose (recording native Session identity mid-launch) and must keep working
  without knowing about this change.
- `agent-control-receiver.server.ts`'s `createAgentControlResultMethod` catches every exception
  from `AgentControl.result` and returns a bare 403 with no log, so a rejected result — the exact
  failure mode that produced this incident, if it happens again — is invisible.

## Decision

**A. An abandoned pending operation can be superseded.**

1. `AgentControlState` gains an optional `updatedAtMs: number`, stamped by every write
   `AgentControl` itself performs (`begin`, the chain-progression write inside `advance`,
   `authorizeLaunch`, `result`). It is optional so existing persisted rows still parse, and a
   missing value is treated as infinitely old — that is what un-wedges rows persisted before this
   field existed. `AgentControl`'s clock is injectable (`timing.now`, defaulting to `Date.now`),
   the same way `timing.timeoutMs`/`timing.fallbackMs` already are, so abandonment is
   deterministic in tests. `operationFence` (the CAS-retry comparison inside `begin`) excludes
   `updatedAtMs`, the same way it already excludes `identity`/`sessionSequence`/
   `launchIdentityBound`/`recovered` — a timestamp-only difference must never break a comparison
   that must succeed, and must never make one succeed that must fail. The Prisma store's `zod`
   schema gains the same optional field so a state that includes it still round-trips.
2. A state is **abandoned** when it is non-terminal and either has no `updatedAtMs` or is older
   than `abandonAfterMs` (default 60 s — well beyond `drive`'s 7 s waiter, short enough to
   unwedge an Agent within a reasonable retry, long enough not to race a Daemon that is still
   genuinely mid-operation). `abandonAfterMs` is part of the same injectable `timing` option.
3. `begin()` treats an abandoned non-terminal `old` exactly like a terminal one for superseding
   purposes (epoch + 1, identity retained by the existing `computerId`/`provider` rule,
   `launchId`/`launchIdentityBound` dropped because the new `state` literal never copies them
   forward) — **except** the destructive chain: if the abandoned operation's `action` is
   `"full-reset"`, only a new, explicitly confirmed `"full-reset"` may supersede it; anything else
   still throws `"Explicit Agent reset retry is required"`, mirroring the existing failed-`full-
   reset` rule immediately above it. A non-abandoned pending operation still throws `"Agent
   control operation is pending"`. Same-`requestId` replay is unchanged. Every actual supersede
   logs `agent_control:pending_superseded` at warning with `agent_id`, the previous
   action/phase/epoch, `age_ms` (or `"unknown"` for a legacy row), and the new action — a stuck
   operation being cleared is an operational event worth seeing, not a silent recovery.
4. `publishStart()` had its own inline pending check (`state.action !== "start"` always threw).
   It now routes an abandoned non-`start` pending state through `begin()` instead, so rule 3's
   Full Reset guard applies uniformly instead of being bypassable through this second entry
   point. A non-abandoned pending state still blocks it, unchanged.
5. `recover()` (the `ready`-recovery path) is **not** changed to supersede. It keeps calling
   `advance()` for any non-terminal state, abandoned or not, which republishes the stored
   `requestId` unchanged when the phase hasn't reached a chain boundary — and, critically, that
   republish path never calls `store.replace`, so it never stamps `updatedAtMs`. See "Rejected
   alternatives" for why.
6. A late control result for a superseded epoch keeps being rejected exactly as before: superseding
   bumps `epoch`, and `requireCurrentAgentScope`'s `sameScope` check already rejects any `epoch`
   mismatch with `"Stale Agent scope"`. No change was needed there; a regression test proves it.

**B. A rejected control result (and session snapshot) is visible.**

`createAgentControlResultMethod` keeps its wire behavior — a bare 403, same message — but now
logs `agent_control:result_rejected` at warning with `agent_id`, `workspace_id`, `computer_id`,
the result's `phase`/`epoch`/`sequence`/`errorCode`, and a `reason`. The reason is one of the
fixed strings `AgentControl.result`/`requireCurrentAgentScope` throw (`"Stale Agent scope"`,
`"Unexpected command result"`, `"Unexpected launch result"`, `"Operation already finished"`,
`"Reset retained old Session"`, `"Native Session identity changed during launch"`, `"Control
result lost its fence"`), allowlisted explicitly; anything else logs `"unexpected: <Error name>"`
— never an arbitrary caught message or the raw payload. `agent-session-receiver.server.ts`'s
`createAgentSessionMethod` had the identical silent-catch-to-403 pattern for a rejected Session
snapshot and is fixed the same way, logging `agent_session:snapshot_rejected` with its own
allowlist covering `AgentSessionReceiver` and `AgentSessions`' fixed messages.

## Rejected alternatives

- **A background sweeper/cron that fails stale operations.** This still requires every writer to
  agree on "stale", adds a new scheduled job, a new failure mode (the sweeper itself lagging or
  crashing), and a window where the Agent is wedged until the next tick. Superseding inline, at
  the moment someone actually tries a new operation, needs no extra process and fixes the Agent
  exactly when someone next interacts with it.
- **Let `ManageAgents.update` persist configuration changes even when Stop hasn't completed.**
  Rejected: "confirm stop before mutating configuration" (the existing `publishStop` comment)
  protects credential and config changes from applying to a runtime that might still be alive
  under the old configuration. A wrong desired-state/actual-state split — the Agent looking
  configured for provider B while a provider-A process is still running — is worse than a clear,
  retryable error. The fix keeps that confirm-stop-first invariant; it only ensures the confirm-
  stop step itself can no longer wedge forever.
- **A server-side Agent API key TTL, as a companion bound on a stuck launch's credentials.**
  Unnecessary: `PrismaAgentApiKeyRepository.replaceActive` already revokes every earlier active
  key of the Agent the moment a new launch mints one, so a lagging Daemon-side revoke (from a
  Stop that never lands) is already bounded by the Agent's *next* launch, not by wall-clock time.
  A TTL would instead break a long-running Agent that legitimately keeps one launch's key active
  for hours or days.
- **Have `recover()` supersede an abandoned pending operation instead of republishing it.**
  `recover()` only runs for an Agent the Daemon's `ready` just reported as **not** running, so
  there is no risk of a duplicate live process either way. But superseding on every reconnect
  would mint a new epoch — and republish a brand new Start — on every single `ready()` for an
  Agent whose Daemon keeps reconnecting without ever answering, which is exactly the churn ADR
  0033's Daemon-side repair is meant to prevent by finally letting the Daemon answer the request
  it already has. Superseding only through an owner-initiated retry (`execute`, `publishStart`,
  `publishStop`) keeps `recover()` passive and lets ADR 0033 do its job; a stuck user-facing
  button is still one click away from unwedging the Agent via rule 3.

## Consequences and migration plan

- A `controlState` row written before this change has no `updatedAtMs` and is therefore treated
  as abandoned the first time anything calls `begin()` or `publishStart()` against it, regardless
  of how old it actually is. This is intentional: it is the mechanism that clears the specific
  rows this incident produced, with no backfill migration needed. It also means a very recently
  written pre-upgrade row (in the deploy's first `abandonAfterMs` window, effectively immediately
  since it has no timestamp at all) could be superseded slightly sooner than a post-upgrade row
  would be; the risk is bounded by the same "Daemon isn't currently answering it" precondition
  that made the operation supersedable in the first place, and an in-flight write already carries
  its own CAS fence.
- `AgentSessionReceiver.accept`'s state write (`{...state, identity, sessionSequence, ...}`)
  preserves whatever `updatedAtMs` was already on the state via the spread; it does not stamp a
  new one. A Session snapshot arriving mid-launch therefore does not, by itself, reset the
  abandonment clock — only `AgentControl`'s own writes do.
- The two new log events are additive and do not change any wire response; nothing downstream of
  the RPC layer needs to change.
- A row written with `updatedAtMs` by the new code would fail the *old* code's `.strict()` zod
  schema (an unrecognized key). This is not a rollback hazard: the schema change and the field
  that needs it are one change in this same record, so reverting rolls both back together, and
  there is no separate migration to coordinate since `updatedAtMs` lives in existing JSONB, not a
  new column.

## Validation and rollback criteria

Validated by unit tests in `apps/web/test/agent-control.test.ts`: a legacy pending `starting`
state with no `updatedAtMs` is superseded by `execute({action:"restart"})` instead of throwing,
with the supersede logged; a fresh pending operation (age below `abandonAfterMs`) still throws
`"Agent control operation is pending"`; a pending operation older than `abandonAfterMs` is
superseded; an abandoned pending Full Reset still refuses `restart`/`stop`/`start` and only a new
confirmed Full Reset supersedes it; a control result for a superseded (stale) epoch is rejected
with `"Stale Agent scope"` and leaves the new epoch's state unchanged; `recover()` republishes an
abandoned pending Start with its original `requestId` and does not refresh its `updatedAtMs`; and
an `AgentControl`-level stop-then-start sequence (standing in for `ManageAgents.update`, which
fakes `runtimeControl` entirely and cannot observe `AgentControl` directly) succeeds against an
Agent whose stored state is an abandoned `starting` operation. `apps/web/test/agent-control-
receiver.test.ts` and `apps/web/test/agent-session-receiver.test.ts` cover the rejection logging:
an allowlisted reason is logged verbatim, an unrecognized error logs `"unexpected: <name>"`
without the raw message, and a successful result/snapshot logs nothing. `apps/web/test/agent-
control-runtime.test.ts` and `apps/web/test/agent-control-signal.test.ts` (the Daemon-roundtrip
and signal-wakeup suites) pass unchanged, confirming the new field and logic don't disturb the
existing control chain's ordering or timing guarantees.

Rollback is a plain revert; see "Consequences" above for the one coordination point (the Prisma
store's schema change reverts together with the rest of this record).
