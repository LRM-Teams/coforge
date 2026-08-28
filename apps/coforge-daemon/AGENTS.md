# coforge-daemon instructions

These rules extend the repository root `AGENTS.md` for this app.

## Product boundary

`coforge-daemon` is the per-user machine process supervised by CoForge
Computer. It owns local IPC, Workspace Worker supervision, Agent runtime
capacity, Agent process lifecycle, provider adapters, durable local delivery,
and the Worker cloud WSS/RPC connection. It is not a public CLI and it must not
become a second user-installed product.

## Source layout and ownership

Keep the daemon split by stable responsibility. The intended module map is:

```text
src/
├── main.ts                         # process entrypoint only
├── daemon-host/                    # user-session startup and host lifecycle
├── daemon-application/             # daemon use cases and orchestration
├── local-rpc/                      # Computer↔Daemon IPC server and handlers
├── workspace-worker/               # one supervised worker per Workspace
├── cloud-transport/                # Worker WSS connection and reconnect loop
├── protocol/                       # daemon-side protocol ports/codecs
├── agent-runtime/                  # Agent state, activity, and process control
├── agent-capacity/                 # shared AgentRuntimePool and policy
├── code-agent/                     # provider-neutral contract and adapters
│   ├── codex/
│   ├── claude-code/
│   └── pi/
├── persistence/                    # durable spool and local daemon state
└── platform/                       # OS-specific process/socket primitives
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
  validation, and RPC dispatch. It must not contain cloud transport logic.
- `workspace-worker/` owns the lifecycle of a single Workspace Worker and its
  coordination of cloud connection, local durable delivery, and Agent runtime
  operations. It does not become a generic global worker pool.
- `cloud-transport/` owns one Worker's long-lived WSS connection, ordered
  replay, reconnect, and protocol transport mechanics. Domain decisions remain
  above it.
- `agent-capacity/` owns the shared `AgentRuntimePool` and capacity policy.
  A Worker asks the pool for capacity through a domain operation; it must not
  manipulate counters or resource heuristics directly.
- `agent-runtime/` owns Agent lifecycle and the finite state machine whose only
  status values are `online` and `offline`. `starting`, `stopping`, tool use,
  turns, commands, file operations, warnings, and provider errors are activity
  records, not additional statuses.
- `code-agent/` adapts installed provider processes into the provider-neutral
  contract. Higher layers must consume normalized status/activity events and
  must not parse Claude, Codex, or Pi output. Built-in Pi is not scanned from
  PATH; user-installed Pi may be detected by the Computer external inventory.
  Runtime metadata uses `kind: builtin` for the release-provided Pi and
  `kind: external` for PATH-installed runtimes. The current registration flow
  has no Computer/Daemon metadata merge point, so the daemon-owned builtin
  metadata remains an explicit runtime seam rather than being invented into
  registration.
- `persistence/` owns durable local state and spool semantics. A connection
  outbox is not durable storage.
- `platform/` contains OS-specific details only. Do not leak platform APIs
  into domain or application modules.

## Naming and abstraction

- Use domain names consistently: `WorkspaceWorker`, `AgentRuntimePool`,
  `AgentProcessManager`, `RuntimeConfig`, `AgentStateMachine`, and
  `AgentActivity`. Avoid arbitrary synonyms and avoid generic `Helper`,
  `Utils`, `Service`, or `Resolver` names.
- Upper layers use intent-level methods such as `startWorker`, `connectWorker`,
  `startAgent`, and `recordActivity`. Lower layers use concrete operations such
  as `spawn`, `writeFrame`, `readFrame`, `flush`, and `reconnect`.
- Do not combine responsibilities in names or methods such as
  `startWorkerAndParseClaudeOutput` or `reserveCapacityAndWriteSocketFrame`.
- Keep status and activity event contracts small, versioned, ordered, and
  normalized before they cross the cloud protocol boundary. Preserve provider
  error/warning text except for required secret redaction.

## Tests and implementation workflow

- Establish the module's public seam before implementation and test it without
  the CLI or real provider process where possible.
- Add regression coverage for state transitions, ordered activity delivery,
  durable-before-send behavior, reconnect/replay, capacity policy, IPC request
  validation, and provider adapter close/failure paths.
- Use Bun and the repository's `mise` tasks. Do not introduce Node runtime
  APIs or a second process framework. Run daemon tests, checks, and build before
  review.
- Read official provider protocol documentation before changing an adapter;
  undocumented provider internals are not a stable contract.
