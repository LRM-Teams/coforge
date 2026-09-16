# Studying Raft Computer 1.0.32

Read this before researching how Raft Computer works. The reference is the
shipped binary **1.0.32**, installed by:

```sh
curl -fsSL https://cdn.raft.build/computer/install.sh | RAFT_COMPUTER_VERSION=1.0.32 sh
```

Do not substitute another version. The npm registry still hosts
`@botiverse/raft-computer` (last 0.0.70) and `@botiverse/raft-daemon`
(1.0.17). Those are older, differently packaged builds. Their command surface,
lifecycle code, and contracts differ from 1.0.32, so conclusions drawn from
them do not describe the product being compared. Use them for nothing except
confirming that the source is esbuild output with paths preserved.

Raft Computer is the closest shipped analogue to `coforge-computer`: one native
executable that hosts the human-facing control-plane CLI, the resident daemon,
and the agent-facing `raft` CLI, installs itself under launchd/systemd, and
self-upgrades from a release authority. The GitHub repository
(`botiverse/slock`) is private. The source is recovered from the binary as
described below.

## Recovering the source from the 1.0.32 binary

The binary is a Node.js single-executable application (SEA): a stock Node
24.15.0 binary with a JS bundle injected by postject into a `NODE_SEA`
segment. The bundle is plain text, not a V8 snapshot or code cache. Steps
verified on 2026-09-16 for `darwin-arm64`:

1. Read the version manifest for file names and expected hashes.

   ```sh
   curl -fsSL https://cdn.raft.build/computer/1.0.32/manifest.json
   ```

   It lists per-target `file`, `sha256`, `size`, a `gz` sidecar, and Apple
   signing and notarization evidence.

2. Download the gzipped binary and verify it against the manifest.

   ```sh
   curl -fsSL -o raft.gz https://cdn.raft.build/computer/1.0.32/raft-computer-darwin-arm64.gz
   gunzip raft.gz
   shasum -a 256 raft   # expect 0db97964b6f21d500629e14a88fe4d24b94476428d01de997863ad2d7545aec5
   ```

3. Locate the SEA segment and cut it out.

   ```sh
   otool -l raft | grep -A4 'segname NODE_SEA'
   ```

   Slice the file at the reported `fileoff` for `filesize` bytes. On Linux use
   `readelf -S` and the `NODE_SEA_BLOB` section; on Windows it is a resource
   of the same name.

4. Strip the SEA header. The blob begins with a magic number, flags, a
   length-prefixed build path, then the length-prefixed JS text. The JS text
   starts with a version banner, so search for it:

   ```python
   blob = open("sea.bin", "rb").read()
   start = blob.find(b"/* raft-computer SEA bundle v1.0.32 */")
   open("raft-computer-1.0.32.cjs", "wb").write(blob[start:])
   ```

   Confirm the banner says `v1.0.32` before going further.

5. Split the bundle into a directory tree using the preserved path comments.
   Lines of the form `// packages/<pkg>/src/<file>.ts` or
   `// node_modules/.pnpm/<dep>/...` mark each module boundary. Write the text
   from one marker to the next into a file at that path.

Do this in the session scratchpad. Never commit the binary or the extracted
tree to this repository.

## What the 1.0.32 tree contains

3351 module markers. First-party code is about 6 MB in five packages; the rest
is vendored dependencies.

| Package | Files | Role |
| --- | --- | --- |
| `packages/computer/src` | 105 | Human-facing CLI and resident service: login, attach, doctor, status, upgrade |
| `packages/shared/src` | 76 | Contracts shared with the server: daemon API, agent API, branded ids, permissions |
| `packages/sync-core/src` | 8 | Read-state and activity sync domain logic |
| `packages/trace-client/src` | 4 | Tracing client |
| `packages/daemon/dist` | 3 | The daemon and the agent-facing `raft` CLI, pre-bundled once, so no per-file path comments inside |

The daemon package is where the agent-facing command tree lives. It is one
large bundled file, so search it by command name rather than by path. Its top
level registers `auth`, `agent`, `channel`, `thread`, `server`, `user`,
`manual` (alias `knowledge`), `inbox`, `message`, `attachment`, `task`,
`mention`, `profile`, `integration`, `reminder`, `app`, `wiki`, `migrate`,
and `action`. Each is wired through `register<Name>Command` functions; for
example `message` registers send, check, read, search, resolve, and react.

Where to start in `packages/computer/src`:

- `cli.ts` and `index.ts` register the human-facing commands: `login`,
  `logout`, `attach`, `setup`, `status`, `start`, `stop`, `restart`, `doctor`,
  `logs`, `runners`, `channel`, `upgrade`, `versions`, `operation`,
  `acknowledge`, `retire-legacy`, plus internal `__service`, `__supervisor`,
  `__run`, `__k-upgrade`, `__installer-converge`,
  `__legacy-supervisor-takeover`.
- `service.ts`, `serviceControl.ts`, `serviceReconcileLoop.ts`, and
  `osSupervisor*.ts` are the resident-service lifecycle under launchd and
  systemd. `macosLoginCarrier.ts` handles the macOS login-item path.
- `kUpgrade*.ts`, `kReleaseSource.ts`, `releaseAuthority.ts`, and
  `computerRelease.ts` are self-upgrade. The `k` prefix marks the newer
  lifecycle design; `legacy*` files for the previous design are still present.
- `lib/runnerStateMachine.ts`, `runners.ts`, and `runnerLockConflict.ts`
  manage agent runner processes.
- `internal/ipc-server.ts`, `internal/ipc-codec.ts`, and `lib/ipc-client.ts`
  form the local IPC seam between CLI invocations and the resident process.
- `doctor.ts` and `health.ts` show what they diagnose.

Notable vendored dependencies, which show which providers and protocols the
runner speaks: `@anthropic-ai/sdk`, `openai`, `@google/genai`,
`@modelcontextprotocol/sdk`, `@earendil-works/pi-coding-agent` with its
`pi-agent-core`, `pi-ai`, and `pi-tui` siblings, `@botiverse/kimi-code-sdk`,
`@botiverse/hands-node` (release authority client), and `@botiverse/k-carrier`.

## Release authority

Which version the installer picks comes from a separate service, not the CDN:

```
https://hands.build/public/v2/apps/raft-computer-cli/latest?channel=latest&product_type=cli-binary
```

It returns build id, version, per-platform asset hashes, and download URLs.
The installer refuses to proceed when this endpoint is unreachable and no
version is pinned, and it cross-checks the Hands hash against the CDN manifest
before downloading. Compare with [`docs/release.md`](../release.md).

## Boundaries

- The repository is private and carries no license. Read for design
  comparison only. Do not copy code, identifiers, or prose into CoForge.
- Record conclusions in your own words and cite the path in the extracted
  1.0.32 tree, or the command name inside the daemon bundle, so a reviewer can
  re-derive them.
- Every offset, hash, count, and command list above was observed on
  2026-09-16 for 1.0.32 `darwin-arm64`. If the comparison target ever moves to
  a different version, update this document rather than mixing versions.
