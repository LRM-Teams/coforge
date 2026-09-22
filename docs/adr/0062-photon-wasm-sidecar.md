# ADR 0062: photon_rs_bg.wasm ships as a release sidecar, not embedded in the executable

Status: accepted
Date: 2026-09-22

## Context

Pi Agents on installed Computers could not see any image: Pi's `read` tool reported
`[Image omitted: could not be resized below the inline image size limit.]` for every image,
including a 3.5 KB JPEG. The Pi SDK (`@earendil-works/pi-coding-agent` 0.84.3, a `packages/agent`
dependency) is compiled into `coforge-computer`. Its image path (`dist/utils/photon.js`) loads
`@silvia-odwyer/photon-node`, which reads `photon_rs_bg.wasm` relative to the build machine's
`__dirname`, falling back to `dirname(process.execPath)/photon_rs_bg.wasm`,
`…/photon/photon_rs_bg.wasm`, and `cwd/photon_rs_bg.wasm`. None of those paths exist in a published
release: the wasm file is not bundled by `Bun.build({ compile })`, and this repository never ships
it. With the wasm missing, `@silvia-odwyer/photon-node` fails to load, `resizeImageInProcess`
returns `null`, and Pi reports the misleading "resize" message instead of the real cause.

Reproduced with a Bun-compiled probe: without `photon_rs_bg.wasm` present → exactly that failure;
with the file placed in the same directory as the executable (including through a symlinked
directory such as `install/active/`) → `ok: true`. This confirms photon-node's own fallback chain
already checks `dirname(process.execPath)`, so placing the file next to the installed binary is
sufficient with no code change inside the vendored dependency.

Raft Computer 1.0.32 ships the same upstream `@silvia-odwyer/photon-node` dependency and solves
this the same way: its release manifest (`https://cdn.raft.build/computer/1.0.32/manifest.json`)
carries a top-level `"photonWasm": { "file": "photon_rs_bg.wasm", "sha256": …, "size": 1881634 }`
entry, the object is published at `<version>/photon_rs_bg.wasm` (one object per version, not per
platform - the wasm itself is architecture-independent), and it is installed at
`~/.local/bin/photon_rs_bg.wasm` next to `raft-computer` with a saved identity checked offline.
Raft's installer prints no separate progress line for the sidecar: only "Checking the Raft
Computer release..." and the final Installed/Upgraded line. Frank asked CoForge's installer output
to match that (2026-09-22): no new step/progress line for the wasm download; it rides along inside
the existing "Downloading CoForge Computer" step, and only a failure ever mentions it.

## Decision

Ship `photon_rs_bg.wasm` as a release sidecar next to `coforge-computer`, verified the same way the
executable is - a manifest-recorded size and SHA-256 checksum, checked online at install/upgrade
time and offline at every `#assertInstalled` call.

1. **Manifest / build** (`scripts/release/build-release.ts`): `ReleaseInputs` gains a required
   `photonWasm: Uint8Array`. `buildReleaseTree` writes `<version>/photon_rs_bg.wasm` uncompressed
   (it is already ~1.8 MB and gains nothing from gzip transport framing), adds it to the returned
   `files` list, and adds a top-level manifest field `photonWasm: { file, size, checksum }` using
   this repository's own identity naming (`size`/`checksum`, not Raft's `sha256`).
   `schema_version` stays `2`: the field is additive, so an old updater that has never heard of it
   simply never reads it.
2. **Resolution** (`scripts/release/photon-wasm.ts`, new module): `resolvePhotonWasmBytes()` walks
   the real installed dependency chain - `@earendil-works/pi-coding-agent` resolved from
   `packages/agent`, then `@silvia-odwyer/photon-node` resolved from that package's own directory -
   and reads `photon_rs_bg.wasm` next to its `package.json`. It never reads a hardcoded
   `node_modules/.bun/...` path and the file is never committed to this repository, so the shipped
   bytes can never drift from what Pi's own code actually loads at runtime. `publish.ts` calls it
   once per publish (the wasm is platform-independent, so this happens outside the per-target
   compile loop) and threads the bytes into `buildReleaseTree`.
3. **Publish** (`scripts/release/publish.ts`): the wasm object uploads alongside the other release
   objects, verified by read-back the same way; the manifest still uploads last, as the version's
   completion marker. `putObject` gives `.wasm` objects the real
   [`application/wasm`](https://www.iana.org/assignments/media-types/application/wasm) media type
   instead of the generic `application/octet-stream` every other release object gets.
4. **Updater** (`packages/computer/src/updater.ts`): `#assertManifest` requires a valid
   `photonWasm` entry (`file === "photon_rs_bg.wasm"`, valid identity) with no fallback -
   `UPDATE_FEED_INVALID` otherwise, the same fail-closed policy already applied to a missing
   platform or gzip entry. `#prepareArtifact` downloads and verifies the candidate
   `photon_rs_bg.wasm` the same way it verifies the gzip download - exact recorded size checked
   before the bytes are read into memory, then checksum - raising `UPDATE_INTEGRITY_FAILED` on
   mismatch. `#installVersion` writes the verified bytes into the staging version directory (mode
   `0o600`: data, not an executable) so it lands at `versions/<v>/photon_rs_bg.wasm` beside
   `coforge-computer`, and bumps `installation.json` to `schema_version: 4` with a `photonWasm`
   identity alongside the existing `computer`/`agentCli`/`githubCli` identities.
   `#assertInstalled` checks it offline only when the installed schema is 4; schemas 2 and 3 stay
   valid as offline rollback targets for versions installed before this field existed - they are
   never rewritten to schema 4 retroactively. Failure messages stay in CoForge's own voice
   ("installed image library failed its offline integrity check"); nothing in code, tests, or
   user-visible text names Raft.
5. **Install scripts** (`install.sh`, `install.ps1`): in both the `--prepare-directory` phase and a
   full install, fetch `$feed_url/$version/photon_rs_bg.wasm` into the temporary/prepare directory
   with a fixed 16 MiB cap and no redirects, using the same no-redirect `fetch`/`Get-CoforgeObject`
   helper the manifest and checksum sidecar already use - not the binary-progress helper the
   multi-tens-of-MB computer download uses, and with no `step`/`Write-CoforgeStep` call of its own,
   matching Raft's output. The updater (via `__install-local --directory`) performs the real
   manifest-based verification; the install scripts only place the bytes.
6. **Local/e2e paths**: `scripts/e2e/build-computer-fixture.ts` resolves the real wasm through the
   same `photon-wasm.ts` module and writes it alongside its fixture manifest/gzip;
   `scripts/e2e/run-computer-setup.sh` and `scripts/reload-local-computer.sh` consume that fixture
   directory unchanged. `packages/computer/test/machine-lifecycle.integration.ts` and
   `packages/computer/test/compiled-cli.test.ts`, which call `buildReleaseTree` directly, supply a
   small fixture `photonWasm` buffer.

## Rejected alternative: embed the wasm in the compiled executable

`Bun.build({ compile })` can embed arbitrary files as assets, which would avoid a second release
object and a second download entirely. Rejected because:

- It would require patching or wrapping `@silvia-odwyer/photon-node`'s own `__dirname`/
  `process.execPath` resolution to look inside Bun's embedded-asset virtual filesystem instead -
  exactly the kind of change to a vendored upstream dependency this repository avoids making, and
  fragile against a future photon-node version changing that resolution order.
- The probe evidence already shows the existing fallback chain (`dirname(process.execPath)`) works
  unmodified once the file is placed next to the installed binary - a sidecar gets the fix with no
  vendored-dependency patch at all.
- A sidecar keeps the wasm's identity independently checkable (size/checksum in the manifest,
  offline-verified on every `#assertInstalled`) the same way the executable itself already is,
  rather than folding it into the executable's own checksum, where a wasm-only corruption would be
  indistinguishable from a corrupted binary.
- This is the path Raft Computer 1.0.32 already ships and is known to work in production.

## Consequences

- A version published without `scripts/release/photon-wasm.ts` finding the real dependency fails
  the publish outright (no silent fallback), so a broken or missing `@silvia-odwyer/photon-node`
  install is caught at publish time, not discovered by a user whose Pi Agent still cannot see
  images.
- Every future publish resolves the wasm from whatever `@silvia-odwyer/photon-node` version
  `packages/agent`'s `@earendil-works/pi-coding-agent` pin currently depends on; bumping that pin
  changes the shipped wasm automatically, with no separate version to track.
- Installed versions predating this change (schema 2/3) remain valid rollback targets but were
  never fixed retroactively; a user who rolls back to one of them will see the original "resize"
  failure again until they upgrade forward.

## Validation

- `scripts/release/build-release.test.ts`, `scripts/release/photon-wasm.test.ts`,
  `scripts/release/publish.test.ts`, `packages/computer/test/updater.test.ts`,
  `packages/computer/test/installer-scripts.test.ts`, `packages/computer/test/compiled-cli.test.ts`
  cover manifest assembly, dependency-chain resolution, upload content type, candidate/installed
  integrity verification (including tampered and oversized wasm), and the real compiled
  install.sh/updater round trip.
- Manual: `packages/computer/AGENTS.md`'s `mise run test:computer` / `check:computer` /
  `build:computer`, plus a staging Computer publish and Pi image-tool smoke test, remain the
  release-readiness evidence per `docs/release.md`.
