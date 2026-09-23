# Local Computer distribution model

The local feed is a mutable pointer file plus one immutable manifest and
platform-binary tree per version:

```text
latest                                       plain text, one version string, e.g. "0.1.0"
<version>/manifest.json                      unsigned JSON: schema_version, version, commit, buildDate, platforms, photonWasm
<version>/<target>/coforge-computer.gz       gzip transport copy
<version>/<target>/coforge-computer.sha256   bare lowercase hex SHA-256 of that platform's coforge-computer, nothing else
<version>/photon_rs_bg.wasm                  Pi's image-resize WASM, one platform-independent object per version
computer/install.sh
computer/install.ps1
```

Manifests record the uncompressed artifact identity and required
`gzip: { binary, size, checksum }` metadata for each compressed download.
Updaters verify compressed size and checksum, bound decompression by the
uncompressed recorded size, then verify the uncompressed identity before
activation. Only gzip binaries are published; manifests without gzip and
missing or invalid gzip objects fail closed, without raw-download fallback.
Both bootstrap scripts download gzip and check the uncompressed checksum
sidecar after bounded expansion. POSIX bootstrap requires the gzip utility;
PowerShell uses .NET GZipStream. Compression does not reduce
installed executable size and never permits overwriting a published version.

Bootstrap and Computer install/upgrade use the same installer script source for
downloads: `curl` on POSIX and `curl.exe` on Windows. Computer embeds these scripts
at build time, pins their feed to its compiled environment, and invokes preparation
mode under the existing machine mutation lock. It does not fetch a mutable remote
script or maintain a separate binary downloader. Preparation writes bounded
manifest/gzip files without executing the candidate or configuring PATH.
Bootstrap additionally verifies the checksum sidecar before executing Computer's
hidden `__install-local` entry with that local package directory. Computer verifies
the local manifest and both artifact identities again, without downloading the
gzip a second time. The directory's owner retains it until installation completes.

Both entry points detect the platform before resolving the version. Normal output
is limited to platform/version, curl download progress, installation location, and
the final result. Bootstrap retains one setup command and, only when needed, a
current-terminal PATH instruction; upgrade prints no onboarding instructions.
Runtime switching and health checks are silent unless they fail;
rollback outcome is reported on failure. Captured output keeps stage lines without
the interactive progress bar. See curl's [progress-bar documentation](https://curl.se/docs/manpage.html#--progress-bar)
and Bun's [text loader](https://bun.com/docs/bundler/loaders#text) for these mechanisms.
New bootstrap scripts require a Computer release supporting `__install-local`;
publish that candidate before deploying the Web build that embeds the new scripts.

`<target>` is one of the existing `releaseTarget` values: `linux-x64`,
`linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`, `windows-arm64`.
`manifest.json` uses `schema_version: 2`. For every supported target,
`platforms[target]` contains only `computer` identity plus its `gzip` transport
metadata; no `daemon` member exists. Computer identity names the executable,
uncompressed byte size, and SHA-256 checksum (bare lowercase hex, no `sha256:`
prefix); its `gzip` member names `coforge-computer.gz` and records compressed
size and checksum. `commit` (the full `main` source SHA) and `buildDate` exist
to look up how a version was built after the fact; they are not themselves
verified by the installer. `schema_version` is reserved so a future payload-
signing field could be added without breaking older installers, but signing is
explicitly out of scope for this contract: **integrity comes from HTTPS in
transit plus the manifest's SHA-256 checksums, not a signed envelope.** This
mirrors how Claude Code and `@botiverse/raft-daemon` ship updates.

The top-level `photonWasm: { file, size, checksum }` manifest field is
additive to `schema_version: 2`: an older updater that has never heard of it
simply never reads it, the same reasoning that reserves `schema_version` for a
future signing field above. It names Pi's image-resize WASM
(`@silvia-odwyer/photon-node`'s `photon_rs_bg.wasm`, a `packages/agent`
transitive dependency), published once per version as a platform-independent
sidecar next to the per-platform `<target>/` directories - uncompressed, since
it is already small (~1.8 MB) and gains nothing from gzip transport framing.
`scripts/release/photon-wasm.ts` resolves its bytes from the installed
dependency chain at publish time rather than a committed or separately pinned
copy, so the shipped file can never drift from what Pi's own code loads at
runtime. This updater has no compatibility fallback: a manifest published
without a valid `photonWasm` entry is rejected (`UPDATE_FEED_INVALID`), the
same fail-closed policy the platform/gzip fields already use.

`coforge-computer.sha256` is a sidecar, not a substitute for the manifest: it
exists because `install.sh` and `install.ps1` are the bootstrap that fetches
Computer itself, before any real JSON parser is available to them, and POSIX
`sed`/`awk` cannot parse JSON correctly - an unanchored regex over the whole
manifest document can be made to extract a different value than a real parser
would, which is a real vulnerability, not a hypothetical one. The sidecar is
one line of hex and nothing else (not `sha256sum`'s two-field
`<hex>  <filename>` format), so both installers can validate it with a POSIX
`case` pattern instead of parsing anything. It must always equal the
`computer` entry's `checksum` for the same `<version>/<target>` in
`manifest.json` - the release workflow generates both from the same bytes in
the same step (see [Main to staging](main-to-staging.md#local-computer-distribution)) - and the two are never allowed to
drift apart. `updater.ts`, which has a real `JSON.parse`, reads the locally
prepared `manifest.json` and never reads the sidecar; only bootstrap does.

Every publication ships the unified executable under one version identity;
there is no mechanism to change only Computer or only Daemon while reusing
prior executable bytes. The two source packages are built, tested, and
promoted as one release unit.

All objects beneath a `<version>/` prefix are write-once: once published,
changing any byte requires a new version string. `latest` is the feed's only
mutable object, and it is written **last** - every object under the new
`<version>/` it will point to is uploaded and verified first. A publish that
fails partway through therefore leaves at most an unreferenced version
directory; `latest` never points at incomplete or missing objects.

A version string is opaque to the client: the updater and both installers
accept any value matching `[A-Za-z0-9.+-]{1,100}`, further rejecting a `..`
segment, a bare `.` on its own (which as a directory name means "the versions
directory itself" and would let a payload land outside any per-version
directory), and a leading `-` (which could be mistaken for a flag by a tool
that later receives the value on a command line) - the same rule the `latest`
pointer's own content must satisfy. Enforcing a SemVer or prerelease-label
discipline on top of that is a publishing-workflow policy, not a wire-format
requirement, and is out of scope here.
