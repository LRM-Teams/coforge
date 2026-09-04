# coforge-daemon instructions

These rules extend the repository root `AGENTS.md` for this package component.

## Product boundary

`coforge-daemon` is the per-user machine process supervised by CoForge
Computer. It owns local IPC, the single Workspace configuration, Agent process
lifecycle, provider adapters, and the daemon cloud WSS/RPC connection. It is not a public CLI and it must not
become a second user-installed product.

## Source layout and ownership

Keep the daemon split by stable responsibility. The intended module map is:

```text
src/
├── main.ts                         # process entrypoint only
├── daemon-host/                    # user-session startup and host lifecycle
├── daemon-application/             # daemon use cases and orchestration
├── local-rpc/                      # Computer↔Daemon IPC server and handlers
├── daemon-runtime/                 # daemon-owned single Workspace runtime
├── logging/                        # LogTape process diagnostics and redaction
├── agent-app-inbox/                # typed Agent-scoped App items and registry
├── connection/                    # Daemon WSS connection and reconnect loop
├── protocol/                       # daemon-side protocol ports/codecs
├── agent-runtime/                  # Agent state, activity, and process control
├── code-agent/                     # provider-neutral contract and adapters
│   ├── codex/
│   ├── claude-code/
│   ├── pi/
│   └── runtime-inventory.ts        # external provider discovery
├── persistence/                    # durable spool and local daemon state
└── platform/                       # OS-specific process-tree and socket primitives
```

Some of these boundaries are represented by existing files and may be
introduced incrementally. Do not create a new directory or rename an existing
module solely for aesthetics; first state the responsibility that requires the
boundary, then update this map if the ownership changes.

### Layer rules

- `main.ts` only assembles dependencies and starts the daemon. It does not
  contain Workspace, Agent, or protocol business logic.
- `daemon-host/` owns login-session startup behavior (launchd, systemd user,
  and Windows task integration). It does not own Computer commands.
- `local-rpc/` owns the local Unix socket/named-pipe server, framing, request
  validation, and RPC dispatch. It must not contain Daemon cloud connection logic.
- `daemon-runtime/` owns the single Workspace's cloud connection and Agent
  runtime operations. For held Message sends it retains only draft text and an
  opaque Web/backend token; it never decides freshness, counts hold stages, or
  authorizes `--anyway`. It does not model runtime busy/idle turns, and
  there is no Daemon or runtime pool abstraction.
- `connection/` owns the daemon's long-lived WSS connection, ordered
  replay, reconnect, and protocol transport mechanics. Domain decisions remain
  above it.
- `agent-runtime/` owns Agent lifecycle and the finite state machine whose only
  status values are `active` and `inactive`. `starting`, `stopping`, tool use,
  turns, commands, file operations, warnings, and provider errors are activity
  records, not additional statuses.
- `code-agent/` adapts installed provider processes into the provider-neutral
  contract. Higher layers must consume normalized status and activity messages and
  must not parse Claude, Codex, or Pi output. This module inventories external
  Codex and Claude Code installations from Daemon's effective PATH at startup
  and after reconnect. Built-in Pi is neither scanned nor reported in Computer
  inventory. It also discovers the model catalogs available to the current Pi,
  and Codex accounts, reports the maintained Claude Code model catalog when
  Claude Code is installed, and translates persisted model/reasoning selections
  into each provider's native startup configuration. Claude Code model
  inventory must not launch the CLI to infer a dynamic catalog because its
  machine-readable initialization does not provide a dependable list.
- Keep the standing CoForge communication instructions in one provider-neutral
  source. Every code-agent driver must inject those same instructions through
  the provider's native system/developer-instruction mechanism: Codex uses
  app-server `developerInstructions`, Claude Code uses its system-prompt-file
  option, and CoForge Agent uses its resource-loader system-prompt override. Do
  not copy the text into each driver or write `AGENTS.md`/`CLAUDE.md` into the user's Agent workspace
  for providers that support native injection. Deliver body-free Message/App
  Inbox wakeups separately as turn input; never append them to the standing
  instructions.
- `agent-app-inbox/` owns typed App-item identity, validation, retention, and
  acknowledgement. It is separate from canonical chat Message attention.
- `persistence/` owns durable local state and atomic App Inbox storage. A
  connection outbox is not durable storage.
- `platform/` contains OS-specific details only. Do not leak platform APIs
  into domain or application modules.

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
