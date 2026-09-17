# ADR 0038: Agent Start and Stop are user operations with a persisted stopped state

Status: accepted
Date: 2026-09-17

> **Amendment (2026-09-17, ADR 0039):** every reference below to ADR 0035's "abandoned-operation-
> supersede rules" now means [ADR 0039](0039-agent-control-latest-command-wins.md)'s plain
> "a different requestId always supersedes" rule — ADR 0035's `updatedAtMs`/`abandonAfterMs`
> mechanism this record's constraints and test list describe no longer exists. Nothing in this
> record's own decision (the persisted `stoppedAt` column, `operationFence`'s exclusion list, or
> the `AgentControl.execute()` Start/Stop surface) changes; only the *reason a competing operation
> yields* changed underneath it. `stoppedAt` remains outside `operationFence`/the CAS fence for the
> same reason stated here — it still needs no conflict detection stronger than last-writer-wins.

## Context

Today's Agent detail page (`features/agents/agent-control.tsx`) offers only Restart, Reset
Session and Full Reset. All three are Stop → … → Start command chains
(`server/agents/agent-control.server.ts`'s `chains`); none of them expresses "stop this Agent and
leave it stopped." The server has no persisted notion of that intent either:
`WorkspaceAgentRecovery.recoverWorkspace` (`agent-runtime-control.server.ts`) restarts every
Agent assigned to a Computer that the Daemon's `ready` reports as not running, on every
reconnect, and `AgentControl.publishStart` treats a completed (or any non-`"stop"`, terminal)
operation as startable. A user who stopped an Agent today (there is no button for this, but the
`"stop"` action already existed as an internal chain step used by config/credential/environment
mutations) would see it start again at the very next Daemon `ready` — the intent was never
durable.

### Raft comparison

This section separates what was verified by reading Raft Computer 1.0.32's shipped client/daemon
code (per `docs/agents/reference-cli-research.md`) from what is inferred because the server side
of Raft is not available to inspect.

**VERIFIED** (client/daemon code):

- Agent `status` is a three-valued enum: `active | inactive | stopped`.
- The client exposes `POST /agents/:id/start` and `POST /agents/:id/stop`.
- A `stopped` Agent "doesn't respond to messages or activate on triggers"; an `inactive` (idle)
  Agent wakes on a message.
- On an explicit user Stop, the Daemon forgets the restart snapshot for that Agent (so a later
  delivery cannot resurrect it) and reports `inactive` with activity kind `stopped`.

**INFERRED** (no server source available):

- The server persists the `stopped` status and never starts or wakes an Agent in that status
  until a user issues an explicit Start.
- Start resumes the stored session; only a session or full reset clears it.

CoForge's Daemon already has the equivalent of the verified behavior:
`AgentProcessManager.stop` deletes the process's `#restartConfigs` entry, and
`deliverAgentMessage` closes the input queue with an inactive-Agent message when the Agent is not
wakeable. No Daemon change was needed or made for this record; this ADR is a Web/backend-only
change that gives the *server* the persisted "stopped" concept Raft's server is inferred to have.

### Constraints already in place that the design has to respect

- `controlState` (`AgentControlState`, JSONB) is documented as "current control request and
  fencing only, not Session history or a job queue" — it is not the right place for a durable
  desired-state flag, and ADR 0035's abandoned-operation-supersede rules already depend on its
  exact shape (`operationFence` excludes specific fields from the CAS comparison; adding an
  unrelated flag to that JSON would have to thread through every one of those rules).
- `AgentControlStore.replace` is a single compare-and-swap `UPDATE ... WHERE ...` inside one
  `$transaction`, guarded by the Agent row's current `runtimeConfig`/`runtimeSession`/
  `controlState`/Session association. A second, separately-committed `UPDATE agents SET
  stoppedAt = ...` racing that transaction is exactly the "second unguarded update" this design
  avoids for the case where a full `AgentControlAgent` (Computer assigned) is already being
  written.
- `execute()` is the sole user-initiated path; `recover`/`publishStart`/`publishStop` are the
  internal/system paths already exempted from ADR 0034's Workspace-capability authorization and
  must keep working exactly as before for creation, config/credential/environment mutation, and
  Daemon-ready recovery.
- `agentDisplay()` (`features/agents/agent-activity-presentation.ts`) is the sole online/offline
  decision the UI reads; AGENTS.md requires Activity labels to stay un-internationalized English.

## Decision

**A. Persisted desired state.** `agents.stoppedAt` (nullable `DateTime`) means "a user stopped
this Agent; nothing may start or wake it except an explicit user Start, Restart, Reset session or
Full reset." It is a sibling of `controlState`, not a field inside it, and is not part of
`AgentControlState`'s CAS fence (`operationFence`) — it is a simple last-writer-wins flag, not an
optimistic-concurrency-checked value, because there is no scenario where losing a race on "who
last decided to stop/start" needs conflict detection stronger than "the last explicit user action
wins."

**B. `AgentControl.execute()` accepts `"start"` and `"stop"`.** Both actions require
`controlAgentRuntime` (ADR 0034's any-current-member capability, same as Restart/Reset Session);
`chains.start = ["start"]` and `chains.stop = ["stop"]` already existed as internal single-step
chains and needed no change. `execute()` now always decides `stoppedAt` explicitly for every
action: `stop` sets it to `now`, and `start`/`restart`/`reset-session`/`full-reset` clear it to
`null`. The write happens inside `begin()`'s existing CAS `store.replace(agent, state, {
stoppedAt })` call — the same transaction that writes the new `controlState`, not a second
statement — so the intent is durable the moment `begin()` returns, before `drive()` ever attempts
to publish to the Daemon. This is what makes Stop's intent survive a Computer that is offline or a
Daemon that never answers: the chain may end up `"pending"` (an accepted, still-in-flight
`AgentControlView`, not a `"failed"` one — `executeAgentControl` only throws on `"failed"`), but
`stoppedAt` is already committed.

A user-initiated `"start"` additionally reads `conversations.readAgentRecoveryContext(workspaceId,
agentId)` (the same seam `WorkspaceAgentRecovery.recoverWorkspace` already uses for Daemon-ready
recovery) and threads it into the single `publishCurrent` call `drive()` makes for a `"start"`
chain, so messages that arrived while the Agent was stopped are surfaced to it exactly the way a
reconnect-recovered Start already surfaces them. `AgentControl` gained an optional 7th
constructor argument, `conversations: AgentControlRecoveryReader` (structurally
`{ readAgentRecoveryContext }`), consulted only for this one action; `recover`/`publishStart`/
`publishStop` and Restart/Reset Session/Full Reset are unchanged.

**C. Nothing else may start a stopped Agent.**

- `WorkspaceAgentRecovery.recoverWorkspace` skips any Agent with `stoppedAt` set before it would
  otherwise decide to redeliver pending messages (already-running branch) or recover/start it
  (not-running branch). If the Daemon's `ready` still reports that Agent as *running* — Stop was
  requested while the Computer was offline, or the Daemon's stop result never reached the server —
  `recoverWorkspace` reconciles by calling `AgentControl.publishStop` (the existing
  owner-authorized internal path) for it, fire-and-forget (`void ... .catch(() => {})`), so one
  Agent's reconciliation round-trip never delays the rest of the Computer's Agents through the
  same `Promise.all`.
- `ManageAgents.update`, `ChangeAgentRuntimeCredential#restartAroundMutation` and
  `AgentEnvironment.save` each already fetch the Agent record before deciding whether to run their
  stop → persist → start sequence; all three now check that record's `stoppedAt` first. When it is
  set, they persist the config/credential/environment change directly and return the existing
  `"deferred"` outcome (already part of each method's return type) instead of publishing a Stop or
  Start at all — there is no running process for a Stop to protect, and requiring a confirmed Stop
  first would make a stopped Agent on an offline Computer permanently uneditable. Creating an
  Agent (`ManageAgents.create`) is unaffected: a new Agent has no `stoppedAt` and still starts.
- Message/task/reminder publishers were audited and confirmed to only ever publish *deliveries*,
  never a Start; they needed no change. `readPendingAgentDeliveries`/`receiveDeliveryAck`
  (`direct-conversation.repositories.server.ts`) were also audited: the only delivery-state
  transition is `receiveDeliveryAck`, called exclusively on a successful Daemon-side ack. No code
  path marks a pending delivery consumed or rejected on a Daemon-reported inactive/stopped Agent —
  there is no such path today at all (grepped for "Agent is inactive" and equivalents; zero
  matches in `apps/web/src`). A pending delivery for a stopped Agent therefore remains pending and
  is still available to `readAgentRecoveryContext`/`readPendingAgentDeliveries` at the next Start.

**D. Read model.** `getAgentDetail` and `AgentDetailQuery` expose `stopped: boolean` (from
`stoppedAt`); `listAgents` exposes it too (cheap: `AgentRecord`/`mapAgent` already carry the
column once selected). `agentDisplay(display, { stopped })` gained an additive `statusDetail?`
field: when the display itself is already offline (`kind === "offline"`) *and* `stopped` is true,
it reuses the existing un-internationalized Activity sentence "Stopped — won't receive messages
until restarted" (already used verbatim for the offline-history activity row in
`presentActivity`, now hoisted to the shared `STOPPED_STATUS_DETAIL` constant) as a caption; it
never changes `isOnline` or the short badge `label`, and stays silent for a stopped Agent whose
Daemon has not yet caught up (still "working"/"online", not overridden into looking offline
early). `AgentDetail` renders this caption as an extra segment of the existing header meta line,
not inside the status `Badge` — the product UI guidelines (`docs/ui-guidelines.md` §9) keep
Badges to a single status word.

**E. UI.** `features/agents/agent-control.tsx` gained a Start-or-Stop button, chosen by
`agentDisplay(display).isOnline` (an errored Agent, `isOnline: true`, still shows Stop). It sits
next to the existing Restart button, is rendered as a sibling of the memoized `Profile` (not
inside it, so a live status heartbeat does not force `Profile` to re-render — see "Consequences"),
and reuses the file's existing Dialog/Modal building blocks for Stop's confirmation:

- Start submits immediately, with its own pending label and a submit guard
  (`useSubmitGuard`, the same hook `Profile` already uses).
- Stop opens a confirm dialog: title "Stop Agent", message `Are you sure you want to stop
  "{name}"? The agent will stop processing messages.`, confirm button label "Stop Agent" (pending
  label "Stopping…"). Failure is shown inline inside the dialog (never a toast), reusing the
  existing `ACCESS_DENIED` → `agent_control_access_denied` mapping.
- `executeAgentControl` already only throws when `result.phase === "failed"` — a `"pending"`
  outcome (Computer offline, Daemon never answered within the request's timeout window) resolves
  normally, because the intent is already durably persisted (Decision B) and will be reconciled at
  the next Daemon `ready` (Decision C). For a Start specifically, the UI shows a truthful inline
  note ("Starts when {computer} reconnects.") when the assigned Computer's already-known
  connection state (the same `listComputers()` loader data the Edit dialog's Computer picker
  already uses — no new realtime subscription) is offline.
- Every existing `data-agent-control`/`data-control-action`/`data-control-submit` selector is
  unchanged (`apps/web/test/agent-control.e2e.ts` still compiles against them); the new controls
  add `data-control-start-stop` and `data-control-stop-confirm`.

## Rejected alternatives

- **Derive "stopped" from `controlState.action === "stop"`.** Rejected: `controlState` is a
  transient in-flight operation record, terminal or not, that gets overwritten by the very next
  operation (including the auto-published deliveries/recovery this ADR needs to *suppress*); it
  cannot represent "stopped" durably once, say, a subsequent config-mutation-triggered internal
  `publishStart`/`publishStop` runs and rewrites it for an unrelated reason. It would also require
  every one of ADR 0035's abandoned-operation-supersede rules to be re-derived around a meaning
  the field was never designed to carry.
- **A three-valued status enum (`active | inactive | stopped`) replacing the existing display
  pipeline.** Rejected: CoForge's online/working/thinking/error/offline reduction
  (`agent-display.server.ts`) is a best-effort, Redis-backed, expiring *observation* of process
  liveness and Activity, deliberately kept separate from "process status" per AGENTS.md
  ("Daemon process and Activity facts separate"). Collapsing a durable, PostgreSQL-persisted user
  *intent* into that transient, TTL'd projection would either make the intent itself expire (wrong
  — a Stop must survive Redis eviction and Daemon downtime indefinitely) or force the display
  reducer to special-case a value it was never designed to hold. Keeping them separate (a durable
  Postgres column plus the existing display pipeline, combined only in `agentDisplay()`'s
  `statusDetail`) is a smaller, additive change with no risk to the existing reducer's Redis
  atomicity guarantees.
- **Put the flag in Redis (alongside `AgentStatusCache`/`AgentDisplay`).** Rejected: Redis in this
  architecture is explicitly scoped to "Centrifugo broker/presence/hot-history state plus Web
  message-request idempotency state," with PostgreSQL as "the message recovery boundary." A
  user's stop intent is exactly the kind of fact that must survive a Redis flush, TTL expiry, or
  the cache being unavailable — it belongs with the rest of the Agent's durable configuration.

## Consequences and migration plan

- Additive nullable-column migration (`apps/web/prisma/migrations/20260917091507_agent_stopped_at`,
  `ALTER TABLE "agents" ADD COLUMN "stoppedAt" TIMESTAMP(3);`); no backfill needed, existing rows
  default to `NULL` (not stopped). Produced with `prisma migrate diff --from-schema <pre-change
  schema> --to-schema prisma/schema.prisma --script` and applied with `prisma migrate deploy`
  rather than `prisma migrate dev`, because the shared local dev Postgres had unrelated drift from
  a concurrent session's in-progress migration (`20260917091342_agent_manual_event`, not present
  in this branch or `origin/main`) that `migrate dev` would only resolve by resetting the
  database — explicitly forbidden. The generated SQL is Prisma's own unedited diff output, not
  hand-trimmed.
- `AgentControlStore.replace`'s `options` grew an additional optional `stoppedAt?: Date | null`;
  `AgentControlAgent`/`AgentRecord` gained an optional `stoppedAt` field. Every existing in-memory
  test store that does not pass or read this option continues to compile and pass unchanged
  (optional field, ignored by a store that never sets it).
- `AgentControl`'s constructor gained a new *trailing* optional 7th parameter
  (`conversations`), so every existing positional call site that stops at `signal` (the 6th
  parameter) is source-compatible; only the two places that actually authorize a user `"start"`
  (`agent-control.functions.ts`'s `executeAgentControl` composition and
  `rpc-composition.server.ts`'s `createCentrifugoRpcHandler`) pass it.
- `features/agents/agent-control.tsx`'s `AgentControl` component moved out of the memoized
  `Profile` component in `agent-detail.tsx` (now a sibling under a shared `divide-y` wrapper,
  same visual position) so that threading the live `isOnline` value into it does not defeat
  `Profile`'s existing "only a status heartbeat forces the *header* to re-render" memoization
  boundary.
- **Known scope cuts, stated rather than silently done:**
  - `AgentControl.execute()`'s Stop for an Agent with **no assigned Computer at all**
    (`computerId: null`) is not reachable: `AgentControlStore.get()` already returns `undefined`
    for such an Agent (pre-existing behavior, identical to today's Restart/Reset Session), so
    `authorizedForExecute` throws before any `stoppedAt` write. This is not reachable from the UI
    either, since the Stop button only renders when `isOnline` is true, which requires an assigned,
    reachable Computer. The brief's "if the Agent has no Computer, just persist" case is therefore
    implemented only where it is actually reachable — `ManageAgents`/`ChangeAgentRuntimeCredential`/
    `AgentEnvironment`, which read `stoppedAt` off the plain `AgentRepository` record and do not
    depend on `AgentControlStore.get()` at all. A computer-less Agent's Stop desire cannot exist
    yet by construction (nothing to stop), so this is believed to be a non-gap, not a deferred fix;
    flagged as an open question below.
  - `stopped` was **not** threaded through `LiveAgent`/`useLiveAgents`'s realtime merge pipeline
    (`agent-status-realtime.ts`). It is exposed in the `listAgents` server response (cheap), but
    the Agent detail page's Start/Stop button and status caption read `detail.stopped` from the
    route loader (refreshed via the existing `router.invalidate({ sync: true })` after a
    successful Start/Stop), not from the live-merged list. Threading it through the heartbeat
    reducer touches a documented realtime-ownership seam (`workspace-agents-realtime.tsx`) for a
    flag that changes far less often than online/offline; out of scope for this record.
  - Raft colours its Stop confirmation orange. Untitled UI has no warning Button variant, and Stop
    is reversible, so `*-destructive` would overstate it. The confirm button is the dialog's one
    primary action and uses `color="primary"` (`docs/ui-guidelines.md` §8).
  - No component-level (DOM/interaction) test was added for the Start/Stop button or Stop confirm
    flow: `apps/web/test` has exactly one `.tsx` test today (`login-page.test.tsx`), and it only
    renders static markup (`renderToStaticMarkup`, no jsdom/happy-dom, no click simulation) — there
    is no existing interactive component-test harness for `features/agents` to extend, and the
    brief's condition for adding one ("only if the repo already has DOM/component tests for
    features/agents") is not met.
  - `apps/web/test/agent-control.e2e.ts` (gated on `COFORGE_CONTROL_E2E=1`, requires a live local
    Postgres/Redis/Centrifugo/Daemon/browser stack) was left unmodified beyond continuing to
    compile against the unchanged selectors it already depends on. It was not extended with a
    Stop → Start round trip, since that cannot be authored with confidence without running it
    against the real stack, which was out of reach in this environment; the brief explicitly
    allows leaving it as-is and saying so.

## Validation and rollback criteria

Validated by unit tests (in-memory stores; every `AgentControlStore`/`AgentControlAgent` fixture
that needs it supplies `memberRole`):

- `apps/web/test/agent-control.test.ts`: a Workspace member who does not own the Agent can Start
  and Stop it; a non-member is rejected for both; Stop persists `stoppedAt` inside `begin()`'s CAS
  write even when the Daemon never answers (`timeoutMs: 0`); Start/Restart/Reset Session/Full
  Reset each clear a previously persisted `stoppedAt`; a user-initiated Start carries the same
  `resumeMessages`/`unreadSummary` a Daemon-ready recovery Start carries; ADR 0035's abandoned-
  pending-operation supersede still applies uniformly when the *new* action is Start or Stop.
- `apps/web/test/cloud-agent.test.ts`: `recoverWorkspace` skips a stopped-and-not-running Agent
  entirely (no recovery-context read, no publish); a stopped-but-Daemon-reports-running Agent gets
  a reconciling `AgentControl.publishStop`, proven not to block `recoverWorkspace`'s own
  completion (the mock `publish` never resolves during the test).
- `apps/web/test/manage-agents.test.ts`, `change-agent-runtime-credential.test.ts`,
  `agent-environment.test.ts`: a stopped Agent's config/credential/environment change persists
  with `restart: "deferred"` and publishes neither a Stop nor a Start.
- `apps/web/test/agent-detail.test.ts`: `AgentDetailQuery.get()` exposes `stopped` from
  `stoppedAt`; `agentDisplay()`'s `statusDetail` appears only when `stopped` is true *and* the
  display kind is already `offline`, never changes `isOnline` or `label`, and is absent while the
  display is still `working`/`online`/etc.

`bun run check` (Prisma generate, `tsc --noEmit`, `oxlint`, `oxfmt --check`) passes at the repo
root; `bun run --cwd apps/web build` was run since the change touches a route
(`agents.$agentId.tsx`'s data shape) — `routeTree.gen.ts` regenerated byte-identical.

Rollback is a plain revert of this record's changes plus the migration
(`ALTER TABLE "agents" DROP COLUMN "stoppedAt";`, not written since no rollback was requested);
the column is additive and nullable, so a revert that stops writing to it is safe without a
companion migration.

## Follow-ups (explicitly out of scope for this record)

- Bulk Start/Stop on the Computer page (stopping/starting every Agent assigned to one Computer at
  once).
- A channel-level "Stop all agents" action.
- Moving Agent controls into the planned Agent profile side panel (this record keeps them in the
  existing Agent detail page's Profile tab, per the brief's "do not redesign" instruction).
- Agent-facing CLI commands for Start/Stop (the CoForge Agent CLI surface, distinct from the
  Workspace member-facing Web UI this record adds).
