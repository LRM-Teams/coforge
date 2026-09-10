# coforge-computer instructions

These rules extend the repository root `AGENTS.md` for this package component.

## Product boundary

`coforge-computer` is the sole installed native executable and user-facing CLI. It is not
a desktop UI, a cloud WebSocket client, or the owner of Daemon business logic.
The Computer starts or reuses the Daemon and talks to it through the local
versioned RPC boundary. It may perform the one-time user-authorized setup
registration, but the Daemon owns ongoing Workspace and Agent operation.
The executable dispatches `__daemon` to the Daemon runtime, `__agent-cli` to
the existing `@coforge/cli/runner`, and all normal invocations to the Computer
management CLI. These internal modes do not make Daemon or Agent CLI public
management commands.
Normal lifecycle commands request startup through the platform user process
manager. `foreground` is the explicit public mode for containers and other
external supervisors; no command implicitly detaches an unmanaged fallback.
Upgrade/rollback hands off to a short-lived coordinator outside the managed
service kill scope; foreground upgrades require the external supervisor to stop
the process first.

## Source layout and ownership

Keep `src` organized by responsibility. New code belongs in the owning folder;
do not grow a single `cli.ts` or `setup.ts` into an application god module.

```text
src/
├── main.ts                         # binary entrypoint only
├── cli/                            # Commander wiring, context, output, errors
├── commands/                       # thin user-facing command adapters
│   ├── login/
│   ├── setup/
│   ├── install/
│   ├── upgrade/                    # handoff to independent coordinator
│   └── rollback/
├── setup/                          # Computer setup business flow
├── auth/                           # device-code authorization and credentials
├── workspace/                      # Direct Workspace lookup for setup intent
├── registration/                   # Computer registration request/use case
├── machine/                        # machine identity and platform metadata
├── daemon/                         # scoped supervisor lifecycle and local RPC client
├── release/                        # install/update/release metadata
└── shared/                         # small app-wide primitives only
```

The layout describes ownership, not permission to create empty layers. Keep an
existing file in place when it still has one clear responsibility; move code
only when a real boundary is needed.

`src/updater.ts` owns verified gzip installation and the version-local
`coforge` launcher targeting the adjacent `coforge-computer __agent-cli` entry.
Computer owns writing it into staging, recording its identity and verifying
it on rollback. There is no legacy installer compatibility path.
`src/release/installation-source.ts` runs the embedded release installer scripts
for curl-based version resolution and package preparation. The same scripts own
bootstrap downloads; updater consumes local manifest/gzip bytes and never
implements another binary downloader. The hidden `__install-local` command
hands bootstrap packages to the existing install use case without downloading again.
Computer's user command tree does not own Agent message commands.
The full install/upgrade/rollback transaction is serialized by the machine
mutation lock; do not narrow it to activation or reuse the Supervisor lifetime
mutex as the upgrade lock.

`src/release-channel.ts` owns the compiled official feed/server mapping.
`src/local-config.ts` owns reading and validating the persisted profile against
that environment; login, setup, and lifecycle adapters share that public seam.

### Layer rules

- `main.ts` and `cli/` know about process arguments and terminal concerns only.
- `commands/` translates CLI input into application calls and translates
  results/errors into friendly output. It must not list Workspaces, scan
  runtimes, build registration payloads, read config files, or encode RPC.
- `setup/` owns the Computer setup business flow. It coordinates domain ports
  without knowing Commander or terminal output formatting.
- `workspace/` owns the direct Workspace lookup used by setup intent. Computer
  never lists or interactively selects Workspaces; do not add a picker or a
  list-selection flow.
- `auth/`, `machine/`, `registration/`, and `daemon/` each own the
  responsibility named by the folder. Their public methods should express
  that responsibility, while transport, filesystem, and subprocess details
  remain in lower adapters.
- Computer registration does not inventory Code Agent installations. Daemon
  discovers external providers from its effective PATH and reports a complete
  snapshot after startup and reconnect, so installing a provider never requires
  Computer re-registration.
- `daemon/` contains the Computer-side local RPC client and lifecycle request;
  it does not implement Daemon supervision or cloud WSS behavior.
- `shared/` must not become a dumping ground. A value belongs there only when
  it is genuinely app-wide and has no domain owner.

When a new command is added, first add its directory and identify the use case
and reusable modules it calls. Do not add a second parser, command-specific
client, or command-specific copy of an existing domain operation.

- Treat the compiled CLI as the public seam. Cover command help, arguments,
  stdout/stderr, and exit codes with tests before changing behavior.
- Use Commander for the command tree. Do not add parallel handwritten argument
  parsing.
- `login` remains available for explicit re-authentication, but the normal
  user-facing flow is `setup`. When needed, setup performs OAuth login inside
  the same flow, uses a Workspace-page setup intent, registers the Computer,
  adds one Workspace binding, and starts (or reuses) its Daemon automatically. The
  user must never be asked to run `coforge-daemon` separately.
- Setup takes the target Workspace from `--workspace <slug>`, which the Add
  Computer dialog renders with the current Workspace already filled in, so the
  user copies it rather than recalling it. `COFORGE_SETUP_INTENT` remains as the
  bypass for e2e and automation. A missing or malformed value fails stably.
  (This replaces an earlier rule against ever naming a slug on the command line:
  no mechanism was ever built to carry an intent through `curl | sh`, and two
  explicit commands also give "join a second Workspace" an obvious form.)
- Computer has no long-lived cloud WebSocket. It communicates with Daemon over
  local RPC; each Daemon-supervised daemon owns its own cloud WSS
  connection and uses the versioned CoForge RPC/Protobuf protocol.
- User authorization may authorize the one-time Computer registration, but
  User credentials must not be persisted by Daemon or exposed to Agent
  runtimes. Daemon uses its Computer/Workspace credential after setup.
- Never print access tokens, refresh tokens, device codes, or stored secrets.
- Resolve state through the platform-native path module; do not hand-build a
  hidden home-directory convention at call sites.
- Run `mise run test:computer`, `mise run check:computer`, and
  `mise run build:computer` before review.
