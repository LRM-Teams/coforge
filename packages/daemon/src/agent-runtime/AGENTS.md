# agent-runtime instructions

Rules for Agent lifecycle, control, Session state, and Activity in
`src/agent-runtime/`. They extend `packages/daemon/AGENTS.md`.

## Status and Activity

- Agent lifecycle status values are `active` and `inactive` only. Starting,
  tool use, turns, commands, file operations, warnings, and provider errors are
  Activity records, never additional statuses.
- `activity-trajectory.ts` owns launch-local display-delta coalescing (350 ms),
  boundary flushing, bounded retention, and assembled-text redaction. Adapters
  supply only official display events and explicit lineage, never raw
  reasoning.

## Start and stop

- Lifecycle control uses separate versioned `agent:start` and `agent:stop`
  intents; there is no `agent:replace`. A stop emits no `stopping` Activity.
- When a start follows a stop for the same Agent, wait for confirmed stop
  completion before launching the replacement.
- A start for an already running Agent preserves its process, session, and
  config. It accepts only `wakeMessage` and `resumePrompt` and ignores that
  start's `resumeMessages` and `unreadSummary`. A replay of the same Start
  (equal epoch) never delivers its `resumePrompt` again.
- A still-launching Agent is not reported as running; it accepts the full
  recovery context and `resumePrompt` on its shared launch.
- A `resumePrompt` is the launch's first turn, in place of message recovery,
  on a new or resumed session alike.
- Restart recovery must not eagerly load all canonical Message history.

## Control fencing (`agent-control.ts`)

- `agent-control.ts` owns request/epoch-fenced stop, reset-workspace, and start
  plus their control completion. It does not deliver Session input.
- A managed Start launches under the server-supplied `launchId`, never a
  locally minted one.
- `startPending(agentId)` is true from the synchronous `start` call until the
  Start launches, runs out of attempts, or is ended by a Stop or newer
  operation, launch-retry cooldowns included; `Runtime.startSettled` fires once
  when it turns false.
- A Start that meets an already running process under an older, terminal
  operation rebinds it through the injected `Runtime.rebind(intent, launchId)`
  hook: no second process and no new launch config. A running process without
  a matching `running` record answers `failed` with `agent_already_running` so
  the server operation terminates.
- When a stored native Session cannot be resumed, report it through
  `Runtime.invalidateSession` before the fresh retry launch, and pass the same
  reason as that launch's `invalidateReason`. Do this only for
  `session_missing` and `provider_replay_rejected`; `session_in_use` is a retry
  signal, not evidence that the session is gone.

## Launch failures (`launch-failure.ts`)

- A launch that does not start reports `agent:status(inactive)` and one
  `runtime_error` Activity whose `runtimeError` is class `LauncherError` with
  a `LAUNCH_FAILURE_REASON` as `errorReason`, and whose `detail` says what
  happened and the next step (a runnable `coforge-computer` command or the
  Agent setting to change).
- Decide the reason only from `hasErrorCode` against a typed launch error:
  an Error subclass whose `readonly code` is its reason, thrown where the
  cause is known (`AgentAuthorizationError` here, the spawner's
  `RuntimeExecutableNotFoundError`, the errors in `code-agent/contract.ts`).
  Never match message text or read provider-specific errors; anything else is
  `runtime_spawn_failed`. Add a reason only together with its thrower.
- Log every failed launch as `agent_runtime:launch_failed` with
  `launchFailureLogFields` (reason, redacted message, SDK trace); the
  Activity sends people to that log line.
- The reason changes no retry: every managed Start keeps the same launch
  attempts and backoff whatever the reason.

## Launch identity

- `AgentRestartConfig` remembers, per Agent and only for that Agent's lifetime,
  the last server-supplied launch identity (`requestId`, `controlEpoch`,
  `launchId`) and the last Activity `clientSeq` sent for it. A managed launch or
  rebind sets it; `stop()` or `shutdown()` forgets it.
- A launch the daemon initiates itself (waking an idle or exited Agent for a
  Message or App Inbox item) reuses that identity: never mint a new `launchId`,
  continue the `clientSeq` counter, and send no `previousLaunchId`. The server's
  Activity idempotency key is `(agentId, launchId, clientSeq)`.
- Mint a new `launchId` only when no identity is remembered.
- After such a launch, `AgentControl.wake()` sets the persisted record back to
  `phase: "running"` so a later server Start rebinds instead of meeting a stale
  `"stopped"` record.

## Session state and records

- `agent-session.ts` owns current native Session snapshots, launch-scoped
  updates, and cloud snapshot replay. Session reports go through the Session
  acceptance path; sequenced snapshots validate their upstream launch fence
  before the snapshot receiver sees them.
- Adapters report only official provider Session identities. Late Claude Code
  initialization must not block the first cloud prompt.
- Route every shared runtime-record update through `agent-runtime-state.ts`,
  which serializes them so delayed Session events cannot overwrite Reset
  progress.
- Full Reset never replays deletion after that request has finished clearing.

## Agent memory seed

- `agent-memory-seed.ts` seeds a starter `MEMORY.md`, `notes/active-context.md`
  and `notes/work-log.md` right after the workspace directory is created. It
  only creates files (`flag: "wx"`, `EEXIST` ignored) and never overwrites one
  the Agent already wrote. A seed failure is logged and never fails the launch.
- `MEMORY.md` holds references only; the Active Context lives in
  `notes/active-context.md`. Older workspaces get the missing notes files, but
  an existing `MEMORY.md` is never migrated or rewritten.
- Seed `MEMORY.md` for on-demand recovery. Do not require per-turn memory
  maintenance in the standing instructions.
