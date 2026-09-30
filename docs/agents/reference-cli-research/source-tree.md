# What the 1.0.38 tree contains

4225 module markers under the [split rule](recovering-the-binary.md) (4224
unique paths; 86 are `.json`). 4038 are vendored `node_modules/.pnpm` modules;
the other 187 are first-party code, about 6.35 MB in five packages.

| Package | Markers | Role |
| --- | --- | --- |
| `packages/computer/src` | 87 (86 files) | Human-facing CLI and resident service: login, attach, setup, status, doctor, runners, release channel, and the launcher for the [separate installer](installer.md) |
| `packages/shared/src` | 84, plus `packages/shared/feature-flag-taxonomy.ts` | Contracts shared with the server: daemon API, agent API, branded ids, permissions, tracing |
| `packages/sync-core/src` | 8 | Read-state and activity sync domain logic |
| `packages/trace-client/src` | 4 | Tracing client |
| `packages/daemon/dist` | 3 | The daemon and the agent-facing `raft` CLI, pre-bundled |

## The agent-facing CLI

The daemon package is three files whose names carry a per-build hash. Find
them by role: the `dist-*.js` file (3.4 MB) is the agent-facing CLI; the
`chunk-*.js` file (2.0 MB) is the resident daemon library, with
`DaemonCore = class`, `runBundledRaftCli`, and code for several providers;
`core.js` (5 KB) only re-exports the chunk. There are no `//` path comments,
but the CLI file wraps each module as
`__esm2({ "src/commands/<group>/<name>.ts"() {...} })`, so search for that
label to find a command's code (about 293 labels).

The CLI's top level (`program.name("raft")`) registers 18 groups, plus a
`knowledge` alias group that repeats `manual`, for 95 leaf commands counting
the alias's two:

```text
version
auth          whoami
agent         login [start|wait|status], list, bridge
server        info, update
user          info
profile       show, update
manual        get, search
channel       info, members, create, update, archive, unarchive, add-member,
              remove-member, join, leave, mute, unmute
thread        list, unfollow
inbox         check
message       send, check, read, search, resolve, react
attachment    upload, view, comments
task          list, create, claim, unclaim, assign, unassign, update, receipt,
              delete, convert, amend, history, show
mention       pending, notify, add, delivery
reminder      schedule, list, cancel, snooze, update, log, ack, dismiss, seal,
              unseal
integration   list, marketplace, login, env, invoke,
              app {prepare {register, recover-owner}, rotate-secret,
              transfer-owner, update, logo, clear-logo, share-link,
              share-link-status, revoke-share-link, request-publish,
              request-unpublish, delete, list, status}
app           config
migrate       arrived, export, import, ready, status
action        prepare
```

Registration is indirect, so two natural scans each miss some commands:

- A scan for `register<Name>Command` functions misses `reminder ack`,
  `dismiss`, `seal`, and `unseal` unless it follows calls: they are attached
  by `registerReminderAckCommand`, which `registerReminderLogCommand` calls.
- A scan for `defineCommand({ name: "..."` misses `channel mute`,
  `channel unmute`, `mention notify`, `mention add`, and the
  `integration app` management commands. Their names are variables in factory
  functions (`makeChannelMuteCommand`, `buildMentionExecuteCommand`,
  `appManageCommand`).

`inbox check` lists the unread conversations from the server
(`--view unread|mentions`, `--before <seq>`) in both managed and external
mode; a managed runner also gets the local daemon inbox rows, app items, and
seals merged in. `message check` is what drains it.

## The human-facing commands

Registered in `packages/computer/src/cli.ts`:

- `login`, `logout`, `attach`, `setup`, `start`, `stop`, `restart`,
  `status` (`--json`), `doctor` (`--fix`, `--migration-details`), `logs`,
  `runners {list, stop}`, `channel {show, set, versions}`, and `upgrade`
  (`--channel`, `--target-version`, `--allow-downgrade`).
- Hidden: `__service`, `__run`, `__supervisor retire-legacy`. `cli.ts` also
  dispatches on `argv[2]` before Commander: `__build-versions`,
  `__verify-bundled-oauth`, and `__cli` (runs the bundled agent CLI);
  `index.ts` handles `__print-env`.
- The saved release channel is `latest` (Hands `main`), `alpha`,
  `pinned:<semver>`, or a named channel (lowercase letters, digits, hyphens).

## Where to start in `packages/computer/src`

- `cli.ts` registers the commands; `index.ts` is the SEA entry (carrier-name
  stripping, supervised shell-environment capture).
- `service.ts` (`runResident`, `upgradeStart`), `serviceControl.ts`,
  `serviceReconcileLoop.ts`, `osSupervisor*.ts`, and `macosLoginCarrier.ts` are
  the resident-service lifecycle under launchd and systemd;
  `legacyOsSupervisorMigration.ts` retires the previous supervisor entry.
- `externalInstaller.ts` finds, verifies, caches, and launches the installer.
  `lifecycleOperations.ts`, `localLifecycleIntents.ts`,
  `residentLifecycleBridge.ts`, `machineServiceAttestation.ts`, and
  `restartReadiness.ts` produce the restart and upgrade acknowledgements the
  server waits for. `channel.ts` and `lib/channelState.ts` hold the saved
  channel and the Hands version listing; `releaseAuthority.ts` is constants.
- `lib/runnerStateMachine.ts`, `runners.ts`, and `runnerLockConflict.ts`
  manage agent runner processes.
- `internal/ipc-server.ts`, `internal/ipc-codec.ts`, and `lib/ipc-client.ts`
  form the local IPC seam between CLI invocations and the resident process.
- `doctor.ts` and `health.ts` show what they diagnose.

## Vendored dependencies

Notable ones, which show which providers and protocols the runner speaks:
`@anthropic-ai/sdk`, `openai`, `@google/genai`, `@modelcontextprotocol/sdk`,
`@agentclientprotocol/sdk` (ACP), `@earendil-works/pi-coding-agent` with its
`pi-agent-core`, `pi-ai`, `pi-tui`, and `pi-telemetry` siblings,
`@botiverse/kimi-code-sdk`, and `@botiverse/oar` (runtime adapters for
`claude`, `codex`, `grok`, `pi`, `kimi`). `@silvia-odwyer/photon-node` is the
image library behind the wasm sidecar.
