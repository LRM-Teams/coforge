# Implementation slice: Computer setup registration

## Outcome

Implement one reviewable vertical slice for:

```text
coforge-computer setup
  → Device Code authorization when needed
  → computer:register RPC
  → persist the returned Computer/Workspace connection
  → start or reuse coforge-daemon automatically
```

The user must not run `login`, `coforge-daemon`, or any other helper command
manually.

## Existing behavior to preserve

- Device Code uses HTTPS OAuth endpoints only.
- The verification page is opened automatically in human mode.
- The verification URL and user code are printed when browser opening fails.
- `--json` writes exactly one JSON object to stdout; progress goes to stderr.
- `setup` is launched with a Workspace-page setup intent; the user does not
  provide a slug or choose from a list in Computer.
- Setup never presents Workspace selection, including on an interactive TTY.
- `UserAccessToken` 仅用于 Computer 注册；`WorkspaceWorkerToken` 是供 Workspace Worker 连接云端使用的 token，不假设其底层格式；`AgentToken` 是独立的 Agent credential。三者不可混用，也不得打印。

## Scope

### 1. Workspace target

- With `--workspace`, use the supplied human-readable slug.
- Without it, list accessible Workspaces only in interactive TTY mode and let
  the user choose with Up/Down/Enter. Do not ask for a Workspace ID.
- In JSON or non-TTY mode without `--workspace`, fail with the stable
  `SETUP_WORKSPACE_REQUIRED` error.
- Do not fetch a Workspace through a business HTTP endpoint. The selected slug
  is carried in the registration RPC; the server resolves it.

### 2. Registration RPC

Add the first shared protocol slice under `packages/protocol`:

- maintain the schema in `proto/coforge/rpc/v1/computer_register.proto`;
- generate the TypeScript message types using the repository-approved
  Protobuf toolchain;
- define the `computer:register` semantic request and response;
- include protocol major, request ID, workspace slug, machine ID, platform,
  OS version, Computer version, and discovered external runtime metadata;
- return the server-assigned Computer ID and Workspace ID (the composite binding identity), and the
  `WorkspaceWorkerToken` used by the Workspace Worker to connect to the cloud;
- preserve unknown fields and reject unknown protocol majors;
- make retries safe with a stable registration idempotency key;
- keep transport mechanics outside the shared package. The client must use
  the approved CoForge RPC transport, not REST or an ad-hoc JSON fallback.

Do not add delivery methods, Worker heartbeat methods, Agent operations, or
cloud WebSocket code in this slice.

### 3. Persistence

- Do not write the Workspace connection before registration succeeds.
- Store the returned registration and `WorkspaceWorkerToken` atomically using the
  existing platform-native configuration/credential boundaries.
- Do not persist the User refresh token in the Daemon credential location.
- A failed registration must leave no new registration or partial credential.

### 4. Automatic Daemon startup

Add a testable `DaemonLauncher` boundary in Computer:

- resolve the installed, verified `coforge-daemon` payload from the active
  Computer release set;
- start it if it is not running;
- reuse it if it is already running;
- communicate over the local Unix socket (Windows named-pipe equivalent);
- wait for a successful local protocol handshake before reporting success;
- pass only the Daemon-owned Computer/Workspace credential through the local
  boundary;
- never expose a TCP management port and never ask the user to start Daemon.

The Daemon process must own Worker creation. Computer must not spawn a Worker
or an Agent runtime directly.

## Public seams and tests

Test the behavior through these seams:

- `ComputerSetup.run()` for ordering and failure atomicity;
- the registration RPC client with a fake transport for request/response and
  idempotent retry behavior;
- `DaemonLauncher` with a fake process/socket boundary for start/reuse and
  handshake failure;
- the compiled CLI for help, TTY/non-TTY selection, stdout/stderr, and exit
  codes.

Required cases:

1. existing credential skips Device Code;
2. missing credential runs Device Code inline;
3. direct slug sends exactly that slug in `computer:register`;
4. interactive selection sends the selected slug;
5. JSON/non-TTY without slug fails without prompting;
6. registration failure does not write registration or credential;
7. retrying the same registration does not create a duplicate registration;
8. a running Daemon is reused;
9. a stopped Daemon is started automatically;
10. setup reports success only after the local Daemon handshake succeeds;
11. no test output contains any credential or token.

## Non-goals

- implementing the Web/backend registration handler;
- defining all CoForge RPC methods;
- implementing Worker cloud WSS or Agent runtime lifecycle;
- adding a desktop UI;
- adding a second Computer WebSocket;
- introducing a REST fallback for registration.

## Completion gate

The slice is complete only when the Computer tests, Computer check/build, and
the protocol package checks pass. The final human output must describe the
actual state, not claim registration or Worker readiness when either step has
not completed.

## Current blockers

The Computer-side cloud RPC adapter, Protobuf codec boundary, and local Unix
Socket handshake are now implemented and covered by tests. The checked-in
`.proto` remains the schema source, while the current TypeScript codec parses
that schema at runtime; it is not generated code yet. Setup still cannot
complete against a real deployment until the backend `computer:register` RPC
handler and its credential/idempotency validation exist. The Daemon currently
owns only the handshake boundary; workspace worker supervision, cloud WSS, and
runtime inventory remain later slices. No REST fallback is permitted.
