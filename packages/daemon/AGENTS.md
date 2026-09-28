# coforge-daemon instructions

These rules extend the repository root `AGENTS.md` for `packages/daemon`.
Directories with their own `AGENTS.md` add rules for that directory only.

## Product boundary

- `coforge-daemon` owns the long-lived machine supervisor and the isolated
  per-Workspace Daemon processes it starts. Each Workspace child owns one
  Workspace configuration, its Agent process lifecycle, provider adapters, and
  one cloud WSS/RPC connection.
- It is not a public CLI and must not become a second user-installed product.
  Release builds embed it in the sole `coforge-computer` executable, which
  starts it through the internal `__daemon` dispatch; it still runs as an
  independent OS process.
- `__agent-cli` dispatches to `@lrm/coforge/runner` before any Daemon logging,
  socket, or Workspace recovery starts. Agent command parsing and transport
  belong to `packages/coforge`, not this package.
- Computer's updater installs the version-local launcher. Daemon startup must
  not mutate the installation or supply missing files for older installers.

## Package-wide rules

- `index.ts` only assembles dependencies and starts the daemon. It holds no
  Workspace, Agent, or protocol business logic, and it assembles policies from
  their owning modules rather than restating their rules.
- `src/local-rpc.ts` owns the local socket server, framing, request validation,
  and dispatch. It must not contain cloud connection logic.
- `src/agent-proxy.ts` is the local Agent capability boundary. It forwards only
  approved Agent HTTPS routes through the Credential Proxy and never widens the
  authorization the cloud grants.
- Protocol codecs and wire contracts live in `@lrm/coforge-sdk`; do not add a
  second codec in this package.
- `platform/daemon-logging.ts` configures the LogTape sinks once per
  Daemon-role process. Entrypoints own logging context and disposal; modules
  use LogTape category loggers directly, without a logger facade.
- Keep OS-specific APIs in `platform/` (and the platform instance adapters in
  `supervisor/`); do not leak them into domain or application modules.

## Naming and abstraction

- Use domain names consistently: `DaemonRuntime`, `AgentProcessManager`,
  `RuntimeConfig`, `AgentStateMachine`, and `AgentActivity`. Avoid arbitrary
  synonyms and generic `Helper`, `Utils`, `Service`, or `Resolver` names.
- Upper layers use intent-level methods such as `configure`, `startAgent`, and
  `recordActivity`. Lower layers use concrete operations such as `spawn`,
  `writeFrame`, `readFrame`, `flush`, and `reconnect`.
- Do not combine responsibilities in names or methods such as
  `startWorkerAndParseClaudeOutput` or `reserveCapacityAndWriteSocketFrame`.
- Keep status and Activity message contracts small, versioned, and normalized
  before they cross the cloud protocol boundary. Activity is best effort and
  may be lost or reordered; preserve provider error/warning text except for
  required secret redaction.

## Tests and workflow

- Establish the module's public seam before implementation and test it without
  the CLI or a real provider process where possible.
- Add regression coverage for state transitions, best-effort Activity
  isolation, status reconnect/replay, IPC request validation, and provider
  adapter close/failure paths.
- Use Bun and the repository's `mise` tasks. Do not introduce Node runtime APIs
  or a second process framework.
- Run `mise run test:daemon`, `mise run check:daemon`, and
  `mise run build:daemon` before review.
- Read official provider protocol documentation before changing an adapter;
  undocumented provider internals are not a stable contract.

## Module map

| Path                   | Single responsibility                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `index.ts`             | Process entrypoint and package exports; dependency assembly only                      |
| `src/daemon-host/`     | Login-session startup through launchd, systemd user, and Windows tasks                |
| `src/supervisor/`      | Machine Coordinator: Workspace binding registry and per-Workspace process lifecycle   |
| `src/daemon-runtime/`  | One Workspace child's runtime: cloud use cases, Message attention, delivery to Agents |
| `src/connection/`      | The Workspace's WSS connection, ordered replay, reconnect, and Agent HTTPS transport  |
| `src/agent-runtime/`   | Agent lifecycle state machine, control, native Session state, and Activity            |
| `src/code-agent/`      | `CodeAgentProvider` seam, provider adapters, runtime inventory, standing instructions |
| `src/agent-app-inbox/` | Typed Agent App items, kept separate from chat Message attention                      |
| `src/agent-reminder/`  | Cloud reminder schedule mirror, version-fenced timers, and fire receipts              |
| `src/credentials/`     | Daemon credential store and Agent API keys                                            |
| `src/persistence/`     | Durable local daemon state and configuration validation                               |
| `src/platform/`        | OS primitives: process trees, launchd jobs, Job Objects, locks, log files, OS release |
| `src/local-rpc.ts`     | Computer↔Daemon local socket server, framing, validation, and dispatch                |
| `src/agent-proxy.ts`   | Local Agent capability boundary and approved HTTPS forwarding                         |

Do not create a new directory or rename a module solely for aesthetics. First
state the responsibility that needs the boundary, then update this map in the
same change.

## Directory instructions

Read the matching file before changing code in that directory:

- [`src/supervisor/AGENTS.md`](src/supervisor/AGENTS.md)
- [`src/daemon-host/AGENTS.md`](src/daemon-host/AGENTS.md)
- [`src/daemon-runtime/AGENTS.md`](src/daemon-runtime/AGENTS.md)
- [`src/connection/AGENTS.md`](src/connection/AGENTS.md)
- [`src/agent-runtime/AGENTS.md`](src/agent-runtime/AGENTS.md)
- [`src/code-agent/AGENTS.md`](src/code-agent/AGENTS.md)
- [`src/agent-reminder/AGENTS.md`](src/agent-reminder/AGENTS.md)
- [`src/persistence/AGENTS.md`](src/persistence/AGENTS.md)
- [`src/platform/AGENTS.md`](src/platform/AGENTS.md)

## Weekly-report collect (owned by another contributor)

- Weekly-report assistant reads use the same Credential Proxy and Agent HTTPS
  connection (`POST /api/agent/v1/weekly-reports`). Daemon forwards `coforge weekly-report`
  context/list/read without interpreting report bodies or widening authorization.
  Web/backend re-checks the assistant owner User's existing Records visibility.

- Weekly-report Collect Run pack submit uses Credential Proxy + Agent HTTPS
  (`POST /api/agent/v1/weekly-report-collect`) and `coforge weekly-report-collect
submit-pack|submit-empty|submit-failure`. Daemon injects the Agent API key and
  forwards the body; Web/backend accepts the pack against the collector Agent's
  Collect Slot.
