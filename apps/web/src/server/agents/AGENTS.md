# Agent server modules

These rules apply to `src/server/agents/`. Centrifugo receivers that feed
these modules have their own rules in `src/server/centrifugo/AGENTS.md`.

## Create, edit, and delete

- Creating an Agent requires Workspace owner/admin (`assertCanCreateAgents`),
  including when a human commits an `agent:create` action card. Creating an
  Agent starts it.
- `manage-agents.server.ts` owns create/edit orchestration: runtime selection,
  credential-aware restart decisions, and public response redaction.
  `AgentRuntimeCredentials` owns Agent/provider-bound encryption; repositories
  persist only the completed runtime config, and Server Function composition
  supplies encryption lazily.
- `agent-environment.server.ts` persists only user-declared environment
  overrides and applies them by restart. Never collect or upload the local
  inherited environment.
- Only an Agent's creator replaces or removes its avatar; Workspace members
  read it. The image store keeps the bytes, and `avatarObjectKey` is the only
  PostgreSQL fact. Surfaces read `agentAvatarUrl`.
- Deleting an Agent requires Workspace owner/admin. It takes the runtime lock,
  writes `deletedAt` durably, then attempts a best-effort Stop. Deletion is
  soft: Messages, Tasks, and Action cards are preserved, and an Agent row is
  never hard-deleted.
- Every live-view Agent query applies `ACTIVE_AGENT_WHERE`
  (`active-agent.server.ts`), and every mutation and control path calls
  `assertAgentLive`, so a deleted Agent answers the same `NOT_FOUND`
  everywhere.
- `TaskView.owner` on the shared Task contract carries no delete marker.
  Adding one is a wire-protocol change and needs approval.

## Visibility

- `agent-visibility.server.ts` is the one authorization seam for
  visibility-aware reads and writes: `visibleAgentWhere` (used beside
  `ACTIVE_AGENT_WHERE`), `canSeeAgent` (the same rule in memory), and
  `assertAgentVisible` (throws `AGENT_NOT_VISIBLE` for by-id, name, or handle
  lookups).
- Build an `AgentVisibilityViewer` from a human's existing
  `resolveActorServerRole` lookup or an already-resolved Agent principal. Never
  issue a second query for it.

## Inbox purge

- `agent-inbox-purge.server.ts` (`AgentInboxPurgePublisher`) is the one
  publisher of `AgentInboxPurge` on the daemon control channel. Callers pass
  the Agent and channel ids after the membership write commits; it resolves
  the Computer and `#channel` targets, skips an Agent on no Computer, and logs
  instead of throwing. `ChangeAgentVisibility` sends one purge for every
  channel a public→private change left.

## Control operations

- `agent-control.server.ts` runs Start, Stop, Restart, Reset Session, and Full
  Reset as fixed command chains with receipt-driven state transitions and
  request/epoch fences. Operation progress is not a new Agent status and not a
  durable command mailbox.
- Each operation mints one `launchId` when it enters `starting` and supplies it
  in the Start intent. `authorizeLaunch` is read-only: it verifies that id and
  never writes.
- `authorizeLaunch` also accepts a daemon-initiated wake that resends the exact
  `requestId`/`controlEpoch`/`launchId` of its last completed start-ending
  chain, unless the Agent is user-stopped. It refuses a superseded scope, a
  failed or stopped operation, and a stopped Agent.
- `execute()` authorizes by the actor's current Workspace membership and
  capability: `controlAgentRuntime` (Start, Stop, Restart, Reset Session) for
  any current member; `resetAgentWorkspace` (Full Reset) for owner/admin only,
  even for the Agent's own owner. The internal paths `recover`,
  `publishStart`, `publishStop` (still checked against Agent ownership), and
  `authorizeLaunch` (Workspace/Computer scope only) skip this capability
  check.
- The latest command wins: `begin()` supersedes any non-terminal operation
  with a different `requestId`. Do not add a pending-operation rejection or an
  abandonment/age concept.
- A superseded caller's `drive()` resolves `phase: "superseded"` instead of
  throwing; `executeAgentControl` throws only on `failed`. `publishStop()`
  throws on supersede because its callers need a confirmed stop.
- `recover()` (Daemon `ready` reconciliation) never supersedes; it only
  republishes the current operation.
- Control clears the Session binding at the local chain step.

## Stopped Agents

- `Agent.stoppedAt` is the persisted user stop intent, independent of
  `controlState`. Nothing may start or wake a stopped Agent except an explicit
  user Start, Restart, Reset Session, Full Reset, or a channel's "Resume all".
- `stop` persists `stoppedAt` before running the stop chain, so the intent
  survives an unresponsive Computer. The other user operations clear it first.
- `stopMany` and `startMany` (a channel's "Stop all Agents" and "Resume
  all", `ChannelAgentControl`) write the same stop or start as `execute` for
  many Agents with the actor's role read once, at most four at a time (each
  holds a runtime-lock connection and a transaction). They send each command
  without waiting for the Daemon and retry a failed send once; an Agent still
  `stopping` is sent its stop again by the next stop. Do not loop `execute`
  over Agents: each call re-reads the role and polls for its receipt.
- `startMany`'s Start carries the user's `resumePrompt` and no message
  recovery, and only on that first send: ready recovery re-sends the same
  Start without it, so the Agent never reads the guidance twice.
- A user `start` carries the same recovery context
  (`conversations.readAgentRecoveryContext`) as a Daemon-ready recovery start.
- Ready recovery skips a stopped Agent; if the Daemon still reports it running,
  reconcile with a Stop through `AgentControl.publishStop` without blocking
  the rest of recovery.
- `ManageAgents.update`, `ChangeAgentRuntimeCredential`, and
  `AgentEnvironment.save` skip the stop → persist → start restart for a stopped
  Agent and return `"deferred"`.

## Sessions

- `AgentSession` is the sole persisted owner of the native session ID and
  state, scoped by Agent, Workspace, Computer, and provider.
  `Agent.runtimeSession` stores only the upstream fence fields and is hydrated
  from that table.
- Acknowledged `agent:session` WSS reports never travel as Activity.
- Ready recovery selects Agents in the cloud; no local transcript scan starts
  Agents.
- Session snapshot acceptance (`agent-session.server.ts`) shares the control
  authorization guard but never advances control operations. Sequenced
  snapshots validate the upstream launch fence first. Control-result dispatch
  stays separate.
- `AgentSessionReceiver.invalidate` clears the Session association only on an
  exact `launchId` and native `sessionId` match, with the same `clearSession`
  primitive Reset Session uses. It leaves every other control-state field
  untouched and never marks the state `recovered`. Its `currentDaemon`
  constructor argument is required so the freshness check cannot be skipped.
  A mismatch is an idempotent no-op; a genuine failure propagates.

## Display and Activity

- `agent-display.server.ts` is the only reducer from ordered process status
  and authorized Activity to online/working/thinking/error/offline. RPC and
  publication adapters call it and never duplicate its transition rules.
- Expiry uses server receipt time. Working/thinking fall back to online while
  the process lease lives; error remains until recognized activity or reset;
  process lease expiry yields offline. The revision counter persists with a
  Redis server-time floor.
- The reducer's `runtimeSession` launch read is a best-effort fence, not a
  Redis-atomic guarantee.
- `packages/coforge-sdk/src/internal/agent-display.ts` is the browser display contract;
  change it additively.
- `agent:status` carries only `active` or `inactive`; Activity keeps raw
  detail and entries. Backend `activity_kind` classification overrides any
  Daemon-supplied classification.
- Persist every Activity frame except busy heartbeats, liveness-probe replies,
  and `runtime_progress`. Never blank `detail` before persisting.
- `AgentActivityRepository.HISTORY_LIMIT` matches the browser's Activity
  window; change them together.

## Skills, context, and reminders

- `agent-skills.server.ts` authorizes the Agent owner and correlates bounded
  requests.
- `agent-context-report.server.ts` authorizes through the Agent owner's
  assignment (the Skills/Workspace Files rule) and resolves the launch and
  session from the persisted session reference.
- `agent-reminders.server.ts` is an owner-only, Workspace-scoped browser read
  model of bounded, scheduled Reminders. Reminder lifecycle stays in
  `server/reminders/`.
