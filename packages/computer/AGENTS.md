# coforge-computer instructions

These rules extend the repository root `AGENTS.md` for this package component.

## Product boundary

`coforge-computer` is the sole installed native executable and user-facing CLI. It is not
a desktop UI, a cloud WebSocket client, or the owner of Daemon business logic.
The Computer starts or reuses the Daemon and talks to it through the local
versioned RPC boundary. It may perform the one-time user-authorized setup
registration, but the Daemon owns ongoing Workspace and Agent operation.
The executable dispatches `__daemon` to the Daemon runtime, `__agent-cli` to
the existing `@lrm/coforge/runner`, and all normal invocations to the Computer
management CLI. These internal modes do not make Daemon or Agent CLI public
management commands.
Normal lifecycle commands request startup through the platform user process
manager. `foreground` is the explicit public mode for containers and other
external supervisors; no command implicitly detaches an unmanaged fallback.
Upgrade/rollback hands off to a short-lived coordinator outside the managed
service kill scope; foreground upgrades require the external supervisor to stop
the process first.

## Module map

Keep `src` organized by responsibility. New code belongs in the owning module;
do not grow `cli.ts` or `setup/` into an application god module. Paths are
relative to `src/`.

| Path                                 | Single responsibility                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `main.ts`                            | Binary entrypoint: dispatches `__daemon`, `__agent-cli`, or the Computer CLI  |
| `cli.ts`                             | Commander command tree and thin command actions                               |
| `cli/`                               | Human output for command results                                              |
| `errors.ts`                          | Stable user-facing CLI error stages                                           |
| `terminal-output.ts`                 | Terminal-safe text                                                            |
| `setup/`                             | Computer setup business flow                                                  |
| `workspace/`                         | Direct Workspace lookup and slug validation for setup intent                  |
| `registration/`                      | Computer registration idempotency                                             |
| `cloud-rpc-transport.ts`             | User-authenticated HTTPS RPC for `workspace:get` and `computer:register`      |
| `login.ts`, `oauth-device-client.ts` | Device-code authorization                                                     |
| `credential-store.ts`                | File-backed User credentials                                                  |
| `machine-id.ts`, `platform.ts`       | Machine identity and platform metadata                                        |
| `paths.ts`                           | Platform-native state and credential paths                                    |
| `local-config.ts`                    | Reading and validating the persisted profile                                  |
| `release-channel.ts`                 | Compiled official feed/server mapping                                         |
| `daemon-client/`                     | Daemon lifecycle requests (`start`, `stop`, `restart`) through the supervisor |
| `status/`                            | Read-only `status` report through per-platform ports                          |
| `logging/`                           | Computer LogTape configuration and the `logs` follower                        |
| `updater.ts`                         | Verified installation, launchers, and version activation                      |
| `release/`                           | Installer scripts and the independent upgrade/rollback coordinator            |
| `version.ts`                         | Build version                                                                 |

The map describes ownership, not permission to create empty layers. Keep an
existing file in place when it still has one clear responsibility; move code
only when a real boundary is needed, and update this map in the same change.

`src/updater.ts` owns verified gzip installation and the version-local
`coforge` launcher targeting the adjacent `coforge-computer __agent-cli` entry.
Computer owns writing it into staging, recording its identity and verifying
it on rollback. There is no legacy installer compatibility path.
It also owns installing and offline-verifying Pi's `photon_rs_bg.wasm`
(`docs/release.md`), staged next to `coforge-computer` in `versions/<v>/` the
same way as the launchers.
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

- `main.ts`, `cli.ts`, and `cli/` know about process arguments and terminal
  concerns only.
- Command actions in `cli.ts` translate CLI input into application calls and
  translate results/errors into friendly output. They must not list
  Workspaces, scan runtimes, build registration payloads, read config files, or
  encode RPC.
- `setup/` owns the Computer setup business flow. It coordinates domain ports
  without knowing Commander or terminal output formatting.
- `workspace/` owns the direct Workspace lookup used by setup intent. Computer
  never lists or interactively selects Workspaces; do not add a picker or a
  list-selection flow.
- Authorization, machine identity, `registration/`, and `daemon-client/` each
  own the responsibility named in the module map. Their public methods should
  express that responsibility, while transport, filesystem, and subprocess
  details remain in lower adapters.
- Computer registration does not inventory Code Agent installations. Daemon
  discovers external providers from its effective PATH and reports a complete
  snapshot after startup and reconnect, so installing a provider never requires
  Computer re-registration.
- `daemon-client/` contains the Computer-side Daemon lifecycle requests; it
  does not implement Daemon supervision or cloud WSS behavior.
- `status/` only reads through its injected ports; it never starts, stops, or
  configures anything.
- Do not add a catch-all `shared/` or utilities module. A value belongs to the
  module that owns its domain.

When a new command is added, first give its logic an owning directory (as
`status/` does) and identify the use case and reusable modules it calls. Do not add a second parser, command-specific
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
- `attach` is an additional public name for that same flow, declared through
  Commander's alias support in `src/cli.ts`. It accepts the same Workspace and
  JSON options and invokes the existing `setup/` use case. Do not create another
  registration, authentication, or startup implementation for this command.
- Setup takes the target Workspace from `--workspace <slug>`, which the Add
  Computer dialog renders with the current Workspace already filled in, so the
  user copies it rather than recalling it. `COFORGE_SETUP_INTENT` remains as the
  bypass for e2e and automation. A missing or malformed value fails stably.
- Computer has no long-lived cloud WebSocket. It communicates with Daemon over
  local RPC; each Daemon-supervised daemon owns its own cloud WSS
  connection and uses the versioned CoForge RPC/Protobuf protocol.
- User authorization may authorize the one-time Computer registration. Long-lived
  User credentials and refresh tokens must not be persisted by Daemon or exposed
  to Agent runtimes. The approved GitHub integration may supply the Agent owner's
  current short-lived user access token on demand to a Git or `gh` child process;
  it must not persist that token or install it in the general Agent environment.
  Daemon otherwise uses its Computer/Workspace credential after setup.
- Never print access tokens, refresh tokens, device codes, or stored secrets.
- Resolve state through the platform-native path module; do not hand-build a
  hidden home-directory convention at call sites.
- Run `mise run test:computer`, `mise run check:computer`, and
  `mise run build:computer` before review.
