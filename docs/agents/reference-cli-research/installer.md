# The separate installer

Upgrade, and first install, run a native installer that is not in the
Computer binary. `packages/computer/src/externalInstaller.ts` fetches it at
each upgrade.

## Locating and verifying it

- `https://hands.build/dl/raft-computer-installer/<channel>/<target>` answers
  302 to `/dl/raft-computer-installer/releases/<release_id>/<target>`. The
  release URL serves the binary; `?kind=sha256sums` on it serves a
  `SHA256SUMS` list with one `native/<target>/raft-computer-installer` line.
  Targets: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`,
  `win32-x64`. The default channel is `main`; `latest` resolved to the same
  release. The Computer verifies the hash and caches the file under
  `<home>/computer/installer/bin/<target>/<sha256>/`.
- Recover it the same way: follow the 302, fetch the release URL and its
  `SHA256SUMS`, compare. On 2026-09-30 `main` resolved to release
  `eb24e9b1-d458-4660-b208-dec838ac4c47`; the `darwin-arm64` file is 2,961,168
  bytes, sha256
  `24e2b09da31ed657b08f19f128b97db6c82fde2ded16f8f851b7afee9a5346bf`. It
  follows the channel, not the Computer version, so this will drift; record
  the release id and hash you actually used.
- It is a Rust executable with no recoverable source. Only `strings` reveals
  its protocol tag (`raft-computer-installer/v3`), subcommands (`install`
  or `upgrade`, `repair`, `status`, `recover`), flags (`--version`,
  `--channel`, `--yes`, `--allow-downgrade`, `--json`), exit codes (0
  succeeded, 1 failed or rolled back, 2 held, 3 unresolved; the Computer maps 2
  and 3 to `held` and `unresolved`), and the Hands `updates/check` query it
  builds. Treat its release-selection and rollback logic as unverified.

## How the Computer drives it

- `installerArgs` builds the installer arguments: an explicit target version
  becomes `upgrade --version <v>` (plus `--allow-downgrade` when asked); a
  saved `pinned:<v>` channel becomes `--version <v>`; `latest` becomes
  `--channel main`; any other channel keeps its name.
- The CLI `upgrade` runs it attached. The resident service's `upgradeStart`
  in `service.ts` launches it detached and non-interactive, logging to
  `<home>/computer/installer/launches/`.
- Its receipt, `<home>/computer/installer/receipts/<sha256(requestId)>.json`,
  is what `residentLifecycleBridge.ts` reads to build the ready
  acknowledgement; only outcome `promoted` counts. The other outcomes the
  Computer knows are `rolled_back`, `held`, `unresolved`, and `failed`.
