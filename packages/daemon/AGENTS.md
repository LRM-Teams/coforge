# coforge-daemon instructions

These rules extend the repository root `AGENTS.md` for this package component.

## Product boundary

`coforge-daemon` owns the long-lived local supervisor and the isolated
per-Workspace Daemon processes it starts. Each child owns one Workspace configuration,
Agent process lifecycle, provider adapters, and one cloud WSS/RPC connection. It is not a public CLI and it must not
become a second user-installed product. Release builds embed this package role
in the sole `coforge-computer` executable and start it through the internal
`__daemon` dispatch; it remains an independent OS process.

## Source layout and ownership

Keep the daemon split by stable responsibility. The intended module map is:

```text
src/
├── main.ts                         # process entrypoint only
├── daemon-host/                    # user-session startup and host lifecycle
├── supervisor/                     # binding registry and per-Workspace process lifecycle
├── daemon-application/             # daemon use cases and orchestration
├── local-rpc/                      # Computer↔Daemon IPC server and handlers
├── daemon-runtime/                 # child-owned one-Workspace runtime
├── agent-proxy.ts                  # local Agent capability boundary and approved HTTPS forwarding
├── agent-app-inbox/                # typed Agent-scoped App items and registry
├── agent-reminder/                 # authoritative reminder mirror, timers, and durable fire receipts
├── connection/                    # Daemon WSS connection and reconnect loop
├── protocol/                       # daemon-side protocol ports/codecs
├── agent-runtime/                  # Agent state, activity, and process control
├── code-agent/                     # Provider public seam, Sessions, and provider adapters
│   ├── codex/
│   ├── claude-code/
│   ├── cursor/
│   ├── pi/
│   ├── tool-activity.ts            # recognized tool aliases → a generic detail label; the argument summary goes only in the entry's toolInput
│   ├── assigned-skills.ts          # CoForge-owned skill pack install before native discovery
│   └── runtime-inventory.ts        # combines Provider runtime/catalog capabilities
├── persistence/                    # durable spool and local daemon state
└── platform/                       # OS primitives, including process-tree, socket, and native process locks
```

Some of these boundaries are represented by existing files and may be
introduced incrementally. Do not create a new directory or rename an existing
module solely for aesthetics; first state the responsibility that requires the
boundary, then update this map if the ownership changes.

The `coforge-computer` entrypoint dispatches internal `__daemon` here before
normal Computer CLI startup, and dispatches `__agent-cli` directly to
`@lrm/coforge/runner` before starting Daemon logging, sockets, or Workspace
recovery. Agent command parsing and transport remain in `packages/coforge` and are
compiled into the unified executable. This is not a user-facing Daemon
management CLI. Computer's updater installs the version-local launcher. Daemon startup does
not mutate the installation or supply missing files for older installers.

`src/connection/built-server.ts` supplies the build-inlined server and WSS
endpoint. `src/persistence/daemon-config.ts` owns environment validation for
configuration and recovery; the entrypoint assembles these policies, not their rules.

### Layer rules

- Agent Task operations use the existing Credential Proxy and authenticated
  HTTPS connection. Task parsing/wire contracts belong to protocol and CLI;
  the Daemon applies the existing attention/model-visible preflight to claim and
  status update, then forwards without storing Task state or interpreting claims,
  status transitions or human approval. Reviewer-isolation holds expose counts
  only. Amend is not a local preflight action in the reference CDN 1.0.31 client.
  `code-agent/agent-instructions.ts`
  states the claim-before-work and conversational acceptance workflow.

- Weekly-report assistant reads use the same Credential Proxy and Agent HTTPS
  connection (`POST /api/agent/v1/weekly-reports`). Daemon forwards `coforge weekly-report`
  context/list/read without interpreting report bodies or widening authorization.
  Web/backend re-checks the assistant owner User's existing Records visibility.

- Weekly-report Collect Run pack submit uses Credential Proxy + Agent HTTPS
  (`POST /api/agent/v1/weekly-report-collect`) and `coforge weekly-report-collect
submit-pack|submit-empty|submit-failure`. Daemon injects the Agent API key and
  forwards the body; Web/backend accepts the pack against the collector Agent's
  Collect Slot (ADR 0032).

- `daemon-runtime/agent-message-attention-index.ts` owns full-target thread
  attention, model-visible positions, and the accepted-Message observation hook.
  After successful current-generation `notify`, ordinary live Message delivery
  and concrete wake/resume batches report `Message received` with
  `message_received` (ADR 0021; previously the generic
  `model_request_started`), matching Raft Computer 1.0.32's
  `broadcastMessageReceivedActivity` (re-verified present in the 1.0.32 daemon bundle; see
  `docs/agents/reference-cli-research.md`). Summary-only recovery and deduplicated
  inputs do not report it. `runtime.ts` assigns launch/sequence metadata and
  publishes best-effort Activity before live delivery ACK; observer failure
  must not reject accepted input.
  `runtime.ts` routes those targets to
  the existing Agent session and canonicalizes short channel/DM thread targets.
  Thread follow state remains cloud-persisted; Daemon only forwards the Agent's
  explicit unfollow operation. Threads never create sessions or processes.

- `main.ts` only assembles dependencies and starts the daemon. It does not
  contain Workspace, Agent, or protocol business logic.
- `supervisor/machine-supervisor.ts` owns the approved per-Workspace restart
  state machine: durable stopping/starting progress, completed or cancelled
  request receipts, and explicit stop precedence. It knows OS instance identities,
  not provider sessions. `supervisor/binding-store.ts` is the sole Coordinator
  adapter for validating and atomically persisting `bindings.json`; Workspace
  Daemons never write that registry. `run-supervisor.ts` composes this seam with
  platform Workspace instances and local RPC, retaining application handshake identity separately from
  the OS invocation identity used for crash recovery.
  Workspace systemd units restart on failure after cgroup cleanup; recovery adopts
  an already-replaced invocation through the same readiness validation. Explicit
  disabled state still wins. Session create/resume selection belongs to cloud and
  the Workspace runtime, never to the machine registry.
- `supervisor/launchd-workspace-instance.ts` implements the macOS instance seam;
  `platform/launchd-job.ts` owns user-job registration and native observations.
  `platform/launchd-process.ts` adapts external Agent stdio and cleanup to a
  separate launchd job through the existing process-tree interface. Its internal
  runner is embedded in Computer, never another installed product. Workspace
  startup reconciles only its own Agent job prefix before accepting new work.
- `platform/daemon-logging.ts` configures the shared LogTape sinks once per
  Daemon-role process. Entrypoints own logging context and disposal; modules use
  LogTape category loggers directly, without a logger facade.
- `daemon-host/` owns login-session startup behavior (launchd, systemd user,
  and Windows task integration). It never falls back to a detached process when
  the manager is unavailable; Computer exposes foreground supervision explicitly.
  It does not own Computer commands.
- `local-rpc/` owns the local Unix socket/named-pipe server, framing, request
  validation, and RPC dispatch. It must not contain Daemon cloud connection logic.
- `daemon-runtime/` owns one Workspace child's cloud connection and Agent
  runtime operations. For held Message sends it retains only draft text and an
  opaque Web/backend token; it never decides freshness, counts hold stages, or
  authorizes `--anyway`. It does not model runtime busy/idle turns, and
  The machine Coordinator owns no Agent runtime pool; each Workspace has an
  independent OS-managed child instance.
- `connection/` owns the daemon's long-lived WSS connection, ordered
  replay, reconnect, and protocol transport mechanics. Every initial ready,
  reconnect ready, and ready retry obtains a fresh request and current running
  Agent ID snapshot from the runtime. Domain decisions remain above it.
  `sendSessionInvalidate` (ADR 0040) is fire-and-forget over `client.rpc(...)`, never awaited
  by its caller: sent immediately when connected, buffered latest-per-agent while disconnected,
  and flushed on reconnect _before_ pending Activity. A pending or new invalidate is dropped
  only when its `launchId` differs from the latest launch `#observeLaunchIdentity` has seen —
  learned exclusively from another outbound message that carries launch identity
  (`reportAgentSession`'s `launchId`; `AgentStatus` carries none today), never from Activity and
  never from an invalidate itself (Raft's `observeLaunchIdentity` rule); Activity's own
  `#supersededActivityLaunches` replay bookkeeping is unrelated and untouched. A rejected RPC is
  logged (`agent_session:invalidate_rejected`), never thrown or retried; an old server's
  "unknown RPC method" rejection logs at most once per connection lifetime, other rejections log
  every time.
  `sendAgentContextUsage` (ADR 0050, Claude Code only) is a sibling fire-and-forget message with
  the same buffer-while-disconnected/flush-on-reconnect and unknown-method log-once behavior;
  `daemon-runtime/runtime.ts` de-dupes an unchanged reading and forgets the last one sent on
  launch end/dispose, so this connection method never itself decides what has changed.
- `agent-runtime/` owns Agent lifecycle and its finite state machine.
  `daemon-runtime/` coordinates the acknowledged cloud `agent:session` report
  from the current Workspace daemon/Agent launch and retains only volatile
  acknowledged identity/launch references for already-authorized wakes. Adapters report only
  official provider identities; late Claude initialization does not block the
  first cloud prompt. Neither runtime nor machine Coordinator scans transcripts
  to autonomously start Agents.
  Agent lifecycle status values are `active` and `inactive`. `starting`, `stopping`, tool use,
  turns, commands, file operations, warnings, and provider errors are activity
  records, not additional statuses.
  `activity-trajectory.ts` owns launch-local 350ms display-delta coalescing,
  boundary flushing, bounded retention and assembled-text redaction; adapters
  supply only official display events and explicit lineage, never raw reasoning.
- `agent-runtime/agent-process-manager.ts`'s `AgentRestartConfig` remembers, per Agent and for
  exactly its own lifetime (set on a managed launch or a rebind, forgotten on `stop()`/
  `shutdown()`), the last server-supplied launch identity (`serverLaunch`: requestId/controlEpoch/
  launchId) and the Activity `clientSeq` last sent for it (a separate map, since `start()` replaces
  the whole restart-config entry). `daemon-runtime/runtime.ts`'s `#launchAgent` reuses that
  identity — never mints a fresh `launchId` — for any launch it initiates itself (an idle,
  exited-but-wakeable Agent woken by a message delivery or an App Inbox item), continuing the
  `clientSeq` counter instead of restarting it (the server's Activity idempotency key is
  `(agentId, launchId, clientSeq)`, `docs/observability.md`) and sending no `previousLaunchId`
  hand-over for the unchanged identity. An Agent with no remembered identity (never brought under
  `AgentControl`, or forgotten by an explicit Stop) still mints, unchanged. `AgentControl.wake()`
  is the mirror image of `stopped()`: it makes the on-disk record truthful (`phase: "running"`)
  again after such a reused-identity launch, so a later server Start correctly rebinds instead of
  finding a stale `"stopped"` record (ADR 0042).
- `agent-runtime/agent-control.ts` owns request/epoch-fenced stop/reset-workspace/start
  and control completion, not Session delivery. A managed Start launches under the
  server-supplied `launchId` (ADR 0041), never a locally minted one; a Start that meets an
  already-running process under an older, terminal operation rebinds it through the single
  injected `Runtime.rebind(intent, launchId)` hook instead of rejecting — no second process, no
  new launch config — and a running process without a matching `running` record answers with a
  `failed` result (`agent_already_running`) so the server operation terminates. Its `start()` catch branch (ADR 0040) reports
  a stored native Session it could not resume — `AgentSessionRecoveryError`'s `session_missing`/
  `provider_replay_rejected` codes only, never `session_in_use` (a retry signal, not evidence
  the session is gone) — via the injected `Runtime.invalidateSession` before the fresh retry
  `Runtime.launch(...)` call it precedes, passing the same reason as that call's own
  `invalidateReason` argument so `daemon-runtime/runtime.ts` can narrate the retry's cold-start
  Activity without a side-channel map. `agent-runtime/agent-session.ts`
  owns current native Session snapshots, launch-scoped updates and cloud snapshot
  replay. Unified RPC callbacks send Session reports through the Session acceptance
  path; sequenced snapshots validate their upstream launch fence before the independent
  snapshot receiver. `agent-runtime/agent-runtime-state.ts` serializes their shared atomic
  record updates so delayed Session events cannot overwrite Reset progress.
  The persisted record stays outside the Agent workspace; Full Reset never
  replays deletion after that request has completed clearing. `persistence/`
  owns atomic records and guarded workspace clearing. This is not a jobs queue,
  Message outbox, or provider parser.
- `code-agent/` exposes `CodeAgentProvider` as the sole public runtime seam.
  A Provider creates one-session `AgentSession` instances and owns its runtime
  discovery, model catalog, and usage capabilities; it may compose those
  capabilities from provider-internal modules. The registry returns Providers,
  never lifecycle wrappers or forwarding adapters. Higher layers must consume
  normalized status and activity messages and
  must not parse Claude, Codex, or Pi output. `codex/provider.ts` owns retry
  classification: structured `willRetry: true` notifications remain internal
  diagnostics, while numbered stderr reconnect lines become informational
  `runtime_reconnecting` Activity, matching Raft Computer 1.0.32's `isCodexProviderReconnectLog`
  (re-verified present in the 1.0.32 daemon bundle; see `docs/agents/reference-cli-research.md`).
  Other errors keep their existing handling. This module inventories external Codex and Claude Code
  installations from Daemon's effective PATH at startup and after reconnect.
  Pi and built-in CoForge Agent are reported from their embedded SDK/version
  rather than scanned from PATH. It also discovers the model catalog available
  to embedded Pi from the user's Pi resources,
  and Codex accounts, reports the maintained Claude Code model catalog when
  Claude Code is installed, and translates persisted model/reasoning selections
  into each provider's native startup configuration. Claude Code model
  inventory must not launch the CLI to infer a dynamic catalog because its
  machine-readable initialization does not provide a dependable list.
  Pi's Provider embeds the bundled Pi SDK and retains the user's Pi models, settings,
  packages, extensions, skills, and authentication. An explicit Agent key overrides
  host authentication only in that session's in-memory model runtime; it is never
  written or passed in process arguments. Session files remain in the Agent's
  `.pi-sessions` directory. CoForge uses its isolated bundled resources and
  `.builtin-sessions` as before.
- `code-agent/agent-skills.ts` owns bounded, read-only Global/Workspace Skills
  metadata discovery at provider-native roots. `daemon-runtime/` resolves the
  stable Agent directory and routes query/results; it does not parse skill files.
  A metadata query never launches a provider, reloads a session, copies global
  skills, or changes the established runtime environment composition.
- `code-agent/claude-code/context-report.ts` owns the one-shot Claude Code
  `/context` composition read (ADR 0051): an undocumented-headless invocation
  run against the Agent's own live session inside its own workspace directory.
  `DaemonRuntime.scanAgentContext` resolves the launch and native session from
  daemon-tracked state — never from the request — answers `no_session`/
  `unsupported`/`unparsed`/`timeout`/`error` in plain words, and refuses a
  superseded launch without running the CLI. Only the parsed structure goes on
  the wire; the raw Markdown never leaves the Computer, and format drift is a
  visible `unparsed` state, never a crash.
- Keep the standing CoForge Agent instructions in one provider-neutral source.
  `AgentProcessManager` builds them once per session and supplies them through
  the required `AgentSessionOptions.instructions` field. Every code-agent Provider
  must inject the supplied instructions through
  the provider's native system/developer-instruction mechanism: Codex uses
  app-server `developerInstructions`, Claude Code uses its system-prompt-file
  option, and CoForge Agent uses its resource-loader system-prompt override. Do
  not copy the text into each provider or write `AGENTS.md`/`CLAUDE.md` into the user's Agent workspace
  for providers that support native injection. Deliver Message recovery bodies
  directly as turn input and App Inbox wakeups separately; never append them to the standing
  instructions. A start for an already running Agent preserves its process,
  session, and config, accepts only `wakeMessage`, and ignores that start's
  `resumeMessages` and `unreadSummary`. A still-launching Agent is not reported
  as running and accepts the full recovery context on its shared launch.
  Agent lifecycle control uses separate versioned `agent:start` and
  `agent:stop` intents; there is no `agent:replace`. A stop emits no
  `stopping` activity. If a start follows a stop for the same Agent, control
  handling waits for confirmed stop completion before launching the replacement.
  When an Agent session lacks older user-referenced context, the standing
  instructions direct it to lexical `coforge message search` and then a
  target-scoped `message read --around`; restart recovery must not eagerly load
  all canonical history. `agent-runtime/agent-memory-seed.ts` seeds a starter
  `MEMORY.md` into the Agent workspace right after `AgentProcessManager.start`'s
  workspace `mkdir`, matching the standing prompt's `Workspace & Memory`/
  `Compaction safety` sections (ADR 0036). It only ever creates the file
  (`flag: "wx"`, `EEXIST` swallowed) and never overwrites one an Agent has
  already written to; a seed failure is logged and never fails the launch.
- `agent-app-inbox/` owns typed App-item identity, validation, retention, and
  acknowledgement. It is separate from canonical chat Message attention.
- `agent-reminder/` owns the authenticated cloud schedule mirror, version-fenced
  timers, bounded durable fire receipts, and exact-revision acknowledgement. It
  never persists the schedule mirror or wakes an Agent before cloud acceptance.
- `persistence/` owns durable local state and atomic App Inbox storage. A
  connection outbox is not durable storage.
- `platform/` contains OS-specific details only. Do not leak platform APIs
  into domain or application modules.
  `platform/operating-system.ts` owns OS release observation, shared by Computer
  registration and Daemon ready reporting; macOS uses product, not kernel, version.
  `platform/daemon-log-file.ts` owns
  owner-only log path preparation and symlink rejection; it does not wrap
  LogTape configuration or loggers. `platform/process-lock.ts` owns the
  reusable SQLite-backed process lock primitive. The Supervisor lifetime lock
  uses it only for foreground exclusion and safe recovery of owned children;
  Computer separately uses the primitive for a full-operation machine mutation
  lock. Lock files are permanent local-filesystem inodes with no tables or
  business data and must never be replaced or unlinked.

## Naming and abstraction

- Use domain names consistently: `DaemonRuntime`,
  `AgentProcessManager`, `RuntimeConfig`, `AgentStateMachine`, and
  `AgentActivity`. Avoid arbitrary synonyms and avoid generic `Helper`,
  `Utils`, `Service`, or `Resolver` names.
- Upper layers use intent-level methods such as `configure`, `startAgent`, and
  `recordActivity`. Lower layers use concrete operations such
  as `spawn`, `writeFrame`, `readFrame`, `flush`, and `reconnect`.
- Do not combine responsibilities in names or methods such as
  `startWorkerAndParseClaudeOutput` or `reserveCapacityAndWriteSocketFrame`.
- Keep status and activity message contracts small, versioned, and normalized
  before they cross the cloud protocol boundary. Activity is best effort and
  may be lost or reordered; preserve provider error/warning text except for
  required secret redaction.

## Tests and implementation workflow

- Establish the module's public seam before implementation and test it without
  the CLI or real provider process where possible.
- Add regression coverage for state transitions, best-effort activity isolation,
  status reconnect/replay, IPC request
  validation, and provider adapter close/failure paths.
- Use Bun and the repository's `mise` tasks. Do not introduce Node runtime
  APIs or a second process framework. Run daemon tests, checks, and build before
  review.
- Read official provider protocol documentation before changing an adapter;
  undocumented provider internals are not a stable contract.
