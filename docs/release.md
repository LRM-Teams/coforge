# CoForge release contract

Status: approved workflow contract; the cloud staging deployment workflow and a local Computer distribution staging publish workflow are implemented; production stays disabled behind the human approval gate

Updated: 2026-09-09

This document is the canonical release specification for CoForge. It defines
which artifact may move between environments, who authorizes that movement,
and what evidence makes a deployment or rollback complete. The project Skill
at [`.agents/skills/coforge-release`](../.agents/skills/coforge-release/SKILL.md)
implements this contract without duplicating it.

## Release invariants

- Keep one long-lived branch, `main`. Short-lived branches open a PR into
  `main`, run CI, and do not deploy. Do not add a long-lived `dev` branch.
- Treat cloud applications and the local Computer distribution as distinct
  release tracks. Inside the local track, Computer and Daemon are two
  independently buildable packages that are nonetheless built, tested, and
  published together under one shared release version; users install only
  the Computer entry point.
- Build each release candidate once for a `main` commit and give it an immutable
  identity: a registry digest for a cloud image, or a version string plus its
  manifest's per-platform SHA-256 checksums for the local Computer distribution.
- Publish `main` candidates to the track's isolated `staging` environment or
  release feed. A pre-production target never pretends to be production.
- When production is introduced, promote the exact artifact that passed
  staging.
  Do not rebuild, repackage, or substitute a mutable tag or channel alias.
- A human authorizes the exact production artifact identity. An Agent may
  prepare, trigger, monitor, verify, and report the promotion, but must stop if
  approval is missing, ambiguous, or names a different identity.
- Run cloud applications as Docker images in an independent Docker Compose
  project. Do not release a host binary or add an application systemd unit.
- Keep application ports private. Caddy owns the public HTTPS/WSS entry point;
  a routine application release must not rewrite shared Caddy configuration.
- Do not expose public plaintext HTTP for CoForge, including redirect-only
  listeners. The staging deployment verifies that port 80 is unreachable while
  trusted HTTPS/WSS on 443 remains healthy.

The `staging` name does not weaken security. Login, token, attachment, and WSS
traffic still require valid HTTPS, least-privilege credentials, secret
redaction, and a non-root deployment identity.

## Release tracks and immutable identities

| Track | Candidate identity | Test target | Production effect |
| --- | --- | --- | --- |
| Cloud application | Full `registry/repository@sha256:...` image reference | `staging` GitHub Environment and Compose project | Deploy the same digest to production Compose |
| Local Computer distribution | A release version plus its manifest's SHA-256 checksum for every platform's unified Computer executable | Version published behind the staging feed's `latest` pointer | Build the same commit against the production feed, publish it, then point production's `latest` at it |

The daemon runtime role is released inside `coforge-daemon`; it is not a third local
product component. `@coforge/agent` is independently packable for dependency and
verification purposes, but the exact installed package remains part of the
Daemon component payload rather than becoming a third user-facing component.

Computer and Daemon remain two independently buildable source packages -
Computer declares Daemon as a build dependency, and Daemon declares an exact
`@coforge/agent` runtime dependency - but release builds compile both roles
into one native `coforge-computer` executable under one shared version. A
standalone Daemon build may remain a test/development artifact, but it is never
published in the user distribution. Every publication records one executable's
byte size and SHA-256 checksum per target. There is no separate release-set
digest, per-component manifest, or installation-bundle archive: integrity
comes from TLS in transit plus the manifest's checksums.

Users install, upgrade, and invoke only Computer. Its main entry dispatches
`__daemon` to the Daemon runtime, `__agent-cli` to the existing
`@coforge/cli/runner`, and ordinary arguments to the Computer management CLI.
Daemon still runs as an independent OS process over the existing Unix socket;
sharing executable bytes does not collapse that runtime boundary. Build-time
release version injection must give both roles the same version.

## Release identity and evidence

Every deployment or local-distribution publication record must identify:

| Field | Meaning |
| --- | --- |
| `source_commit` | Full Git commit SHA on `main`; host-initiated rollback uses the explicit `manual` sentinel and remains bound to immutable image digests |
| `track` | Cloud application or local Computer distribution |
| `artifact_identity` | Cloud image digest or local release version and its manifest's SHA-256 |
| `artifact_members` | Image reference or, per platform, the unified Computer executable's name, size, and SHA-256 checksum |
| `environment_or_channel` | Isolated `staging` or `production` target |
| `workflow_run` | GitHub Actions run URL or stable run ID; host-initiated rollback uses the explicit `manual` sentinel |
| `previous_identity` | Last known healthy digest/manifest, or an explicit bootstrap marker; cloud JSONL names this `previous_digest` |
| `verification_result` | Track-specific internal, public, shared-ingress, running-identity, install, upgrade, and integrity evidence; cloud JSONL names this `health_result` |
| `approval` | Production-only human approval bound to the exact artifact identity |
| `executor` | Agent or human that executed the deployment |
| `started_at` / `completed_at` | UTC transaction boundaries |
| `outcome` | Healthy, failed, rolled back, or failed rollback |

Tags, versions, filenames, and channel names are useful labels, but they do not
replace immutable identity. Compose must ultimately resolve a cloud service as
`registry/repository@sha256:...`; a local `latest` pointer must resolve an
exact version whose manifest and every downloaded binary also match their
recorded SHA-256 checksums.

## Cloud environment model

| Concern | `staging` | `production` |
| --- | --- | --- |
| Trigger | Successful push to `main` | Promotion request for a tested digest |
| Authorization | Automatic | Human approves the exact digest; Agent executes |
| Artifact | Newly built immutable digest | Same digest already healthy in `staging` |
| GitHub Environment | `staging` | `production` |
| Compose project | `coforge-staging` | `coforge-production` |
| Concurrency | One deployment at a time | One deployment at a time |
| Rollback target | Previous healthy digest or empty bootstrap state | Previous healthy digest or approved bootstrap state |

GitHub Environment secrets, variables, protection, deployment history, and
concurrency are independent from the Git branch model. Staging and production
must use separate secrets, databases, volumes, networks, internal ports, and
public endpoints when both environments exist.

Every Compose invocation must pass the intended project explicitly with `-p`;
do not derive it from a checkout directory. Render and validate the effective
base-plus-environment configuration before mutation. Environment secrets must
not be committed, echoed, placed in command arguments, or copied into release
records.

The MVP provisions only `staging`. Production stays disabled until it has an
independent environment configuration and an enforceable human approval gate.
GitHub currently limits required reviewers for private repositories on some
plans; if the repository plan cannot enforce the gate, do not substitute an
informal blanket approval or enable production.

## Local Computer distribution model

The local feed is a mutable pointer file plus one immutable manifest and
platform-binary tree per version:

```text
latest                                       plain text, one version string, e.g. "0.1.0"
<version>/manifest.json                      unsigned JSON: schema_version, version, commit, buildDate, platforms
<version>/<target>/coforge-computer.gz       gzip transport copy
<version>/<target>/coforge-computer.sha256   bare lowercase hex SHA-256 of that platform's coforge-computer, nothing else
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
the same step (see "Main to staging" below) - and the two are never allowed to
drift apart. `updater.ts`, which runs after Computer is already installed and
has a real `JSON.parse`, keeps reading `manifest.json` directly and never
reads the sidecar; only the two bootstrap scripts do.

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

The feed is served beneath `https://releases.coforge.cn/` from a private
release bucket. Attachments and releases use two separate accelerated domains
(see [ADR 0006](adr/0006-split-cdn-delivery-domains.md)): `releases.coforge.cn`
fronts only the release bucket and applies no client URL signing, because
installers and updaters must fetch anonymously and integrity now comes from
TLS plus the manifest's checksums, not from any signed object; `files.coforge.cn`
fronts only the private user-files bucket and requires a signature. Each domain has its own
RAM permissions, cache/access rules, and logs, and neither is authorized to
read the other's bucket, so no origin rule can fall back from one class to the
other. A CDN path maps one to one onto its object key; no business prefix is
rewritten away. Neither domain accepts or forwards application login cookies.

The public installation entry points are served by the site itself, at a path
that is the same in every environment:

```text
https://coforge.cn/computer/install.sh                 https://coforge.cn/computer/install.ps1
https://staging.coforge.cn/computer/install.sh         https://staging.coforge.cn/computer/install.ps1
```

Each deployment serves its own pair and routes them to the release feed that
deployment trusts, because a `curl … | sh` taken from staging must install the
staging version rather than the production one. The web UI therefore
renders the command from the origin the visitor already reached; it must not
carry a fixed host, which would hand every staging visitor the production
command. Whichever origin serves it, the entry point must not expose an OSS
bucket hostname or replace the checksum verification the bootstrap scripts
perform against the sidecar (`install.sh`, `install.ps1`) or the updater
performs against `manifest.json` after Computer is installed, and the web UI
must not link to a CDN or OSS origin directly.

Users never depend on or discover the OSS bucket URL. Immutable version objects
use a long immutable cache policy; `latest` requires an evidenced, effective
every-request origin-revalidation policy. Routine publication verifies storage,
not domestic CDN reachability: the workflow performs authenticated, byte-identical
OSS read-back for every version object and `latest`, and proves that an unsigned
anonymous/direct GET of each exact private-origin key returns 403. The durable
record stores only pass/fail evidence, not the private bucket endpoint or
credentials. An anonymously readable origin object or authenticated read-back
that differs from the source bytes fails publication.

Consumer-path CDN reachability, private-origin authorization, redirects, cache
behavior, and bytes remain independent infrastructure acceptance concerns.
Their existing tooling is retained and may be run from a suitable network, but
CDN read-back is not a publication or rollback gate. A successful publication
therefore proves the release objects and selector are correctly stored and
origin-private; it does not by itself prove end-user delivery through the CDN.

Under that revalidation policy, explicit CDN purge is not a routine publication
requirement. Retain evidence of matching cache rules, completed propagation and
appropriate client cache behavior; old entries created before a policy change
must not survive under the former policy. Stale or unverifiable responses fail
the independent CDN acceptance check, and cache-busting URLs must not substitute
for consumer-path checks. Cache-policy migration or purging legacy entries is
separate operator work.
Versioned keys remain immutable, including across retries.

### Per-user installation

Installation, upgrade, background startup, and rollback run entirely as the
current user. They must not request `sudo` or administrator elevation, write to
`/usr/local`, `/opt`, `/Library`, `Program Files`, or system service locations,
reuse another user's installation, enable Linux lingering, or modify root-owned
or system-level service configuration.

Configuration, credentials, version storage, and logs live below the current
user's `~/.coforge`, split into `computer` and `daemon` roots. The one exception
is the `coforge-computer` shim, which is the single installed path that has to
be on PATH and therefore cannot live in a private directory nobody's PATH names:

- Linux and macOS place the shim in the XDG user binary directory - `XDG_BIN_HOME`
  when it is set to an absolute path, otherwise `~/.local/bin`. That directory is
  already on PATH for most users, so an install is usable in the shell that ran
  the installer, and `install.sh` writes shell configuration only when the
  directory is genuinely absent from PATH. The shim itself is only a symlink into
  the versioned installation below `~/.coforge`, so upgrade and rollback move the
  `active` link and never touch the user's PATH. Computer background startup is
  user-scoped; only Computer may register a per-user LaunchAgent on macOS.
- Windows has no comparable per-user PATH convention, so the shim - a `.cmd`
  launcher rather than a symlink - stays in `~/.coforge/computer/bin`, and
  `install.ps1` puts that directory on PATH instead. It prepends the directory to
  the current user's `Path` under `HKCU\Environment`, never the machine scope,
  which would require elevation. The value is read with
  `DoNotExpandEnvironmentNames` and written back as `ExpandString` rather than
  through `[Environment]::SetEnvironmentVariable(..., "User")`, which would
  flatten a user's `%USERPROFILE%`-style entries into today's expansion. The
  script then also prepends the directory to `$env:Path`, which reaches the
  session that ran it because the documented entry point (`irm ... | iex`)
  executes in the user's own process rather than a child - so, as on Linux and
  macOS, a Windows install is usable immediately. For the same reason the script
  must never call a top-level `exit`, which would terminate the user's session.
  No `WM_SETTINGCHANGE` broadcast is sent: consoles read the registry at launch,
  so only already-running Explorer-spawned applications miss the change. Only
  Computer may use a current-user startup mechanism.

The installer maintains a user-owned versioned installation directory. It downloads
the unified Computer executable into staging, verifies it against the
manifest's recorded size and SHA-256 checksum, activates only after it passes,
preserves the prior version for rollback, and never relocates
stable machine identity, credentials, configuration, or user data into a
versioned directory. Only the `coforge-computer` shim enters the current
user's PATH. Computer launches the adjacent executable with `__daemon` through
the exact path selected by the active version; no standalone Daemon payload or
service entry is installed.

Installation also writes a tiny version-local `coforge` launcher which invokes
that directory's `coforge-computer __agent-cli`. Daemon prepends its own
executable directory to Agent PATH. The Agent CLI implementation remains in
`packages/cli`, compiled into the unified executable; its internal entry does not initialize
logging, sockets, cloud connections or Workspace recovery. Users continue to
run only Computer management commands; Agents execute `coforge`.
This adds neither a third native payload nor a Bun/npm requirement. The
launcher is covered by the installed version's offline integrity check and
does not follow a later active-version switch underneath an existing Daemon.
The installer supplies this launcher; Daemon startup does not repair older
installations. No older-client or older-installer compatibility is maintained.
Installer identity metadata uses schema 2 and records the `computer` identity
plus the generated `agentCli` launcher identity. It contains no Daemon
identity.

Previously published rc1 through rc3 remain immutable. They are not rewritten
with schema 2 and receive no raw-artifact or two-payload fallback. Crossing
from their layout requires a fresh bootstrap install; the old updater is not
assumed to accept schema 2. Existing installations remain rollbackable to
their own retained bytes, but rollback does not translate between layouts.

Normal CLI lifecycle commands are one-shot local RPC clients. They start or
reuse the native per-user process manager and never detach an unmanaged
fallback. Environments without that manager, including containers, must run
`coforge-computer foreground` under an explicit external supervisor. That mode
does not transfer process ownership to the CLI and is not silently selected.

Both `install.sh` and `install.ps1` expose two selection modes with identical
semantics:

- omitted or `--version latest` resolves the feed's `latest` pointer;
- `--version <version>` selects one exact published version.

An exact version is enough to select an installation because it identifies the
complete unified executable; there is no independent Daemon version.

Staging and production artifacts are **not interchangeable**. The feed a build
trusts is compiled into it (`COFORGE_RELEASE_FEED_URL`, see
`packages/computer/src/release-channel.ts`), so a binary built for staging carries
the staging feed address and would keep updating itself from staging if it were
copied into the production feed. Promotion therefore rebuilds the same commit
against the production feed rather than copying bytes; what carries across
environments is the commit and the test evidence, not the artifact.

The same build selection fixes the business server: `releases-staging.coforge.cn`
maps to `https://staging.coforge.cn`, and `releases.coforge.cn` maps to
`https://coforge.cn`. Release compilation gives the bundled Daemon that same
server. Login, setup, and Daemon recovery do not offer a public `--server` or
runtime server override. Existing cross-environment configuration fails rather
than redirecting credentials. Private E2E fixture builds inject local transports
at module boundaries; they are not distributable release artifacts.

For the running local E2E stack, execute:

```sh
COFORGE_E2E_ALLOW_DEVICE_AUTH=1 \
COFORGE_E2E_WEB_URL=http://localhost:8789 \
COFORGE_E2E_WORKSPACE_SLUG=dev-user \
mise exec -- bun test ./scripts/e2e/computer-environment.e2e.ts
```

This compiles private local fixtures and the production Daemon, exercises setup
against Web/PostgreSQL/Redis/Centrifugo, checks the registered Computer's exact
online status, and rejects wrong-environment or legacy Daemon state/peers with
no Computer profile. OAuth uses the development provider. This is not evidence
of macOS launchd behavior, staging Authing login, or a published artifact's
installation on a real Mac; those remain separate release acceptance checks.

The POSIX bootstrap persists PATH setup for Bash, Zsh, or Fish without elevation
or replacing existing configuration. It prints the command needed in the current
shell (a piped installer cannot modify its parent shell) and an absolute setup
command. Metadata requests are quiet; only the binary download has a progress bar.

`install.sh` and `install.ps1` read the same `COFORGE_RELEASE_FEED_URL`
variable, but unconditionally and at runtime: any `https://` value is
accepted, not just the compiled-in default. This is deliberate, not an
oversight of the rule above: `release-channel.ts` hardens the *compiled*,
long-lived binary that auto-updates itself indefinitely, where a runtime
toggle would let it be silently redirected to an untrusted feed on every
future update. The bootstrap scripts are the opposite shape - a one-shot the
user explicitly runs (`curl … | sh` / `irm … | iex`) from a command they can
read before running it - and anyone able to set this variable in that same
invoking shell can equally set `PATH` or a proxy variable to redirect the
script's requests, so restricting the variable here would not remove an
attacker capability, only a legitimate one it may be used for: pointing a
manual or scripted install at a non-default feed (a staging or private feed).
No such use is implemented or documented today - `installCommands()` in
`apps/web/src/features/install/install-commands.ts` renders a plain
`{origin}/computer/install.sh`, not a feed URL, and `apps/web` now serves that
path with the exact bytes of `scripts/release/install.sh` (embedded at build
time; see `apps/web/src/server/install/install-script.server.ts`) unchanged -
the same script, with the same compiled-in `https://releases.coforge.cn`
default, is served from every deployment. How a staging deployment's served
copy of `install.sh` would reach the staging feed *by default* (as opposed to
a caller exporting the variable by hand) therefore remains unresolved and
belongs to a future per-environment publishing/serving decision, not to this
variable. Both scripts carry the threat-model half of this reasoning inline
as a comment.

### Reading GitHub Actions

| Workflow | When it runs | Steps |
| --- | --- | --- |
| **CI** | A pull request is opened or updated | Plan checks → validate affected packages and scripts → CI passed |
| **Deploy Web (staging)** | A commit reaches `main` | Validate → build and push Docker image → deploy and verify Web |
| **Publish Computer (staging)** | Manually started from `main` | Validate → build all six platforms → upload and verify release → update staging `latest` |

The Web workflow skips image build and deployment when the commit does not
affect Web. Computer publication is manual and its run title includes the
version. Its build, upload, integrity checks, and selector update stay together
in one publication transaction; expand that step to see each platform and object.

`Validate` reuses CI. Package jobs run tests, static checks, and a build where
applicable; separate jobs check macOS lifecycle, Windows executables, and the
Windows installer. These checks can run in parallel. `CI passed` is the final
required check and keeps its existing name for branch protection.

CI has one reusable validation definition in `.github/workflows/ci.yml`, invoked
with three scopes selected by `scripts/ci/selection.ts`:

- Pull requests validate changed modules and affected downstream consumers.
  Web-only changes run Web gates; Daemon changes also validate Computer.
  Agent changes additionally validate Web's imported Agent test contract.
  Client module changes retain native macOS and Windows smoke checks;
  PowerShell installer changes run both PowerShell parsers and lint. Both
  installers are embedded in the Web image, so changing either also validates Web.
- Each `main` push checks whether the Web image or deployment inputs changed.
  If so, the exact main commit runs Web, protocol, and deploy-script gates before
  building and deploying the image. Client-only and documentation-only pushes
  do not build an image or deploy. There is no second standalone CI workflow
  for that main push.
- Manual local publication always runs the complete local track for its exact
  selected main commit: protocol, Agent, CLI, Computer, Daemon, release scripts,
  native macOS/Windows checks, and Windows installer checks. It does not run
  unrelated Web, deployment, or OSS/CDN acceptance-verifier checks.

Shared protocol, global toolchain/configuration, lockfile, CI, and unclassified
paths select full PR coverage. Only known documentation locations are exempt;
Markdown assets inside source directories remain code inputs. Documentation-only
PRs run CI-policy tests, workflow/static lint, and changed-line whitespace checks,
not application builds. No documentation link checker is currently configured.
PR diffs use the merge base; push diffs use the before/after commits. Renames
include both old and new paths, and a missing push base expands coverage.

Every run ends with `CI passed`, which requires selection/static validation and
every selected job to succeed. An unexpectedly skipped, failed, cancelled, or
missing selected job cannot pass. Configure branch protection to require this
aggregate rather than individual conditional/matrix job names; changing that
GitHub setting requires separate authorization. PR updates cancel stale PR
checks; release-track checks do not cancel an active publication or deployment.
The cloud workflow uses GitHub's `queue: max` (up to 100 pending runs), so a
later documentation-only push cannot replace a waiting Web-changing push.
Pinned actionlint 1.7.12 does not yet recognize this documented property;
`.github/actionlint.yaml` excludes only that exact diagnostic for this workflow,
and the workflow contract test requires the valid queue/cancellation combination.

Module-owned test/check/build commands remain unchanged. Local full validation
still uses `mise run test`, `mise run check`, and `mise run build`; CI-policy
regressions can be exercised alone with `bun run test:ci` and `bun run check:ci`.
Track-specific pre-release validation is not replaced by a mutable "latest
successful CI" result. Docker image builds and version/feed-specific
cross-compilation remain independent artifact builds, not redundant gates.

Publishing a local-distribution release is **manual**. The workflow exposes only
`workflow_dispatch`; it is not triggered by merging to `main`. Continuous publish
on merge suits the cloud application, which replaces a running service, but a
client release leaves a persistent artifact set behind, and at the current user
count a build per merge is waste. Adding a trigger later is one line.

Routine staging publications use `<target-version>-dev.<workflow-run-number>`;
the current target is `0.1.0`, so leaving the workflow's version input empty
generates versions such as `0.1.0-dev.9` and `0.1.0-dev.10`. Run numbers may
have gaps and are not reset when the target version changes. Update the
workflow's default target when preparing the next release line. The source SHA
and build time remain in the manifest rather than the version string. There
is no nightly schedule or date-based version convention. Use only two routine
forms: staging builds such as `0.1.0-dev.9` and stable versions such as `0.1.0`,
selected through the explicit version input. No beta or release-candidate
stage is required. Previously published versions, including historical `rc`
versions, remain immutable and available by exact version; the next successful
publication moves `latest` without renaming or deleting them. Retrying a
partially published version must still respect the write-once rule; use a new workflow run for a fresh
default version rather than overwriting an existing version.

The Computer distribution is published to the release feed only. It is **not
published to npm**; that channel is purely additive and can be introduced later
without changing anything here.

## Main to staging

### Cloud application

The automated cloud path is:

1. Run the Web-track test, check, and build gates for the affected `main` commit.
2. Build and push the service image once, tagged with the full commit SHA.
3. Capture the pushed image digest as a workflow output and deployment record.
4. Enter the `staging` GitHub Environment and its environment-specific
   concurrency group.
5. Validate the Compose configuration, set the service image to the exact
   digest, pull it, and recreate the affected service with `--no-build`.
6. Use a bounded wait for Compose health, then run the complete verification set
   below.
7. Record the digest as healthy only after every required check passes.
8. If any check fails, restore the previous healthy digest, repeat the
   checks, and report the failed candidate and rollback result. For the first
   deployment to a verified empty environment, restore the empty state.

The deployment job must fail if it cannot identify a previous healthy digest
before mutation, unless it has verified and recorded that this is the first
deployment to an empty environment. It must not improvise a host-binary,
systemd, public-port, or manual SSH release path when the Compose workflow is
unavailable.

### Local Computer distribution

The automated local-distribution path always publishes the unified executable,
built from both source packages, to the track's own feed (a staging build trusts a different
`COFORGE_RELEASE_FEED_URL` than a production build compiles in, so the two
tracks' `latest` pointers are never the same object):

1. Run the complete local-track gates for the exact `main` commit.
2. Build the unified Computer executable once for the complete Windows, Linux,
   and macOS platform matrix, with the approved Bun executable targets and the
   same release version injected into both Computer and Daemon roles.
   Do not rebuild one platform after another platform passed.
3. Compute every platform's Computer executable byte size and SHA-256 checksum,
   assemble the schema 2 `manifest.json`, and generate each
   platform's `coforge-computer.sha256` sidecar from the same Computer binary
   bytes and the same checksum computation as the manifest entry - the two
   must never be allowed to diverge.
4. Publish `manifest.json`, every platform's `coforge-computer.sha256`
   sidecar, and every platform's sole `coforge-computer.gz` beneath the new `<version>/` prefix on
   the staging feed. Re-read every object through authenticated OSS access and
   compare it byte-for-byte with the workflow source, then prove unsigned
   anonymous/direct reads of the exact private-origin keys return 403.
5. Only after every object under `<version>/` is published and verified,
   write the staging feed's `latest` pointer to the new version. A publish
   that fails before this step leaves an unreferenced version directory that
   no installer will ever resolve.
6. Re-read `latest` through authenticated OSS access, verify its exact bytes and
   unsigned-origin 403 guard, then run the local-distribution checks below
   against the version it resolves.
7. Record the version and its manifest checksums as healthy only after every
   required check passes.
8. On failure, leave the staging feed's `latest` pointing at the last healthy
   version - do not advance it - and record the candidate and its failure.
   For a verified first publication, leave `latest` unpublished; installers
   continue to fail closed for that unpublished feed.

An alpha or prerelease-labelled version ends here. A stable version is not
production-ready merely because it carries no prerelease suffix: the exact
version must pass this staging path first. The workflow must not publish
directly to the production feed, publish an incomplete platform matrix, or
treat a partial publication as approval for the whole version.

## Staging to production

### Cloud application

Cloud production promotion is a two-party operation:

1. An Agent prepares a promotion request containing the exact digest, source
   commit, staging deployment run, staging health result, change summary, known
   risks, migration compatibility, production configuration revision, and
   previous healthy production digest.
2. A human approves or rejects that exact digest through the protected
   production deployment gate. The Agent that prepared or triggered the
   promotion cannot satisfy the human gate.
3. After approval, the Agent runs or resumes the production workflow. The job
   verifies that its digest matches the approved digest and that the same
   digest is still recorded healthy in `staging`.
4. The workflow deploys the digest with the production Compose project. It
   does not rebuild the image.
5. The Agent monitors internal and external health, records the result, and
   reports the final production digest.

Changing the digest invalidates the approval. A failed or cancelled attempt
does not authorize a different candidate. An approval of `latest`, a branch,
an unspecified future release, or a commit without its full `sha256:...` digest
is invalid.

### Local Computer distribution

The local Computer distribution uses the same two-party boundary, but what
crosses it is the **source commit and its evidence, not the artifact**. Staging
and production binaries cannot be the same bytes: the feed a build trusts is
compiled into it, so a staging binary copied into the production feed would keep
updating itself from staging. Promotion therefore rebuilds:

1. An Agent verifies the staging feed's `latest` resolves a stable version (no
   prerelease suffix). It prepares that version, the source commit it was built
   from, the staging test run and its evidence, and the production feed's
   current `latest` for comparison.
2. A human approves or rejects that exact commit and version. A filename,
   branch, channel name, or unspecified "latest build" approval is invalid.
3. After approval, the Agent builds the approved commit against the production
   feed configuration, producing a distinct set of binaries whose only intended
   difference from the staging set is the compiled-in environment (feed and
   matching business server addresses).
4. The Agent publishes the new manifest, checksum sidecars and binaries beneath
   the production feed's `<version>/` path, then performs authenticated OSS
   byte-identical read-back and verifies the unsigned-origin 403 guard for each
   object.
5. Only after that confirmation does the Agent write the production feed's
   `latest` pointer to the approved version.
6. The Agent re-reads the production feed's `latest` through authenticated OSS
   access, verifies its exact bytes and unsigned-origin 403 guard, runs the
   production local-distribution checks, and records the result.

Building a commit other than the approved one, or altering the source between
approval and build, invalidates the approval. Because the artifacts are rebuilt
rather than copied, the production checks in the next section are the evidence
that the production binaries work — the staging evidence attests to the commit,
not to those bytes.

## Health verification

### Cloud application

A release is healthy only when every applicable check passes within its
documented timeout:

1. Compose reports each required service running and healthy through a
   meaningful container health check; process existence alone is insufficient.
2. The host-local readiness endpoint passes through its intended loopback or
   internal route.
3. The public HTTPS readiness endpoint passes with normal certificate
   verification. Never use `--insecure` to make a release pass.
4. A minimal functional smoke check exercises the released path, including WSS
   connection behavior when realtime transport changes.
5. Existing routes that share host ingress remain healthy.
6. The running container resolves to the requested digest and matches the
   deployment record.

Compose health is necessary but does not replace external or functional
verification. Capture failure diagnostics without secrets.

### Local Computer distribution

Staging development publication and production readiness are separate gates.
Following the 2026-09-09 user direction to fix the release process and include
Windows, routine staging development versions publish all six targets. They
require repository gates (including native Windows x64/arm64 release identity
and environment-binding smoke tests), plus checks 1–3 below for every published
object. Missing install/upgrade/lifecycle evidence must be reported explicitly;
it is not silently counted as passing and does not prevent publishing a
development candidate for testing. No partial platform publication is allowed.
Stable-version production promotion additionally requires checks 4–8 for every
target; publishing Windows bytes does not lift the architecture's fail-closed
restriction on external Agent processes pending Job Object supervision.

A local Computer release version is production-ready only when:

1. the feed's `latest` pointer resolves the requested version and no other;
2. the version's schema 2 manifest and every downloaded platform Computer executable match their
   recorded byte sizes and SHA-256 checksums;
3. an unsigned anonymous/direct GET of each exact private OSS object key is
   rejected with 403, while authenticated OSS read-back for every version object
   and `latest` is byte-identical to the workflow's source bytes;
4. clean per-user Computer install and supported per-user upgrade checks pass
   without a separate Daemon install or elevation on every required target
   platform/architecture;
5. both installed processes report the expected version and reach their
   local readiness boundaries;
6. computer-to-daemon Unix-socket and protocol compatibility passes for the
   declared version, including a workspace-child startup smoke test;
7. stable machine identity, credentials, configuration, and application data
   survive the version-store activation; and
8. the previous Computer installation remains installed or recoverable and a
   rollback rehearsal can reactivate it without network access.

The implementation must define the required platform matrix and exact command
seams before a local distribution channel can be promoted.

An upgrade or rollback coordinator must execute outside the managed service's
kill scope. Under native management it acquires the machine mutation lock for
the complete transaction, prepares and verifies bytes, pauses launches,
snapshots the exact running Workspace set, asks `systemd --user` or per-user
`launchd` to stop the Supervisor, activates the target, restarts the manager,
and accepts health only with a new Supervisor identity, expected version, and
new identity for every previously running Workspace child. Candidate failure
automatically restores the prior immutable installation and the same running
set, then repeats those checks; failed rollback keeps launches held for explicit
recovery. A foreground externally supervised instance cannot currently be
stopped by this coordinator and must be stopped through its external supervisor
before upgrade.

## Rollback

Each release track records its own previous known-healthy identity before
mutation. A rollback in one track does not change another track implicitly.

### Cloud application

A health failure during an approved deployment transaction automatically
authorizes restoration of the recorded previous healthy digest. This is part
of the same release transaction and must not wait for a second approval while
the service is unhealthy.

For a verified first deployment, rollback restores the recorded pre-deployment
empty state by stopping and removing the failed candidate. Never treat a
missing release record on a non-empty environment as bootstrap.

An unrelated later rollback request must identify its target digest and follow
the production authorization gate unless a separately approved incident policy
explicitly says otherwise.

Rollback means redeploying a known healthy image digest. It is not a Git
revert, rebuild, or mutable retag. Database changes must be backward compatible
with the previous application digest; otherwise application rollback is not a
valid recovery plan and the release must not proceed.

### Local Computer distribution

If staging publication or production verification fails, leave the affected
feed's `latest` pointing at its last healthy version - do not advance it -
verify the restored selector through authenticated OSS read-back and its
unsigned-origin 403 guard, and verify installation again. Because both
components always publish together, there is no separately unchanged peer to
preserve.

Devices that already activated a failed version use the local versioned
installation directory to stop the processes, reactivate the retained
previous Computer installation, restart Computer and Daemon, and repeat
health checks. If persisted state or protocol changes make this unsafe,
production promotion must remain disabled until a reviewed forward-repair
path exists.

Local-distribution rollback reselects and reactivates recorded immutable bytes.
It does not rebuild old source, copy an unverified file into a release path, or
assume that a lower display version is installable. An unrelated later
production rollback requires human approval of the exact target version
unless a separately approved incident policy says otherwise.

## Audit records

Keep both the platform's deployment or publication record and the durable
release record defined above for every staging release, production promotion,
failed attempt, and rollback. Record the human approver and exact approved
artifact identity for production, the previous and resulting identities,
verification evidence, rollback trigger and result, and the final observed
state. An interrupted release is a recorded outcome, not a missing entry. The
records must reveal the selected and next rollback identities without relying
on an Agent's private memory, and must never contain secrets. Local records also
preserve the previous and resulting version strings, the manifest's per-platform
SHA-256 checksums, authenticated storage read-back evidence, and the unsigned
private-origin guard result. Independently run CDN acceptance evidence may be
linked, but is not required for routine publication or rollback.

## Routine release boundary

Before any mutating deployment, verify all of the following:

- the source commit is on `main` and repository checks passed;
- the requested image or local release version and its manifest exist and
  their immutable identities resolve;
- the target has isolated secrets/credentials and a unique concurrency group;
- the track-specific configuration or feed manifest validates;
- the applicable cloud or local-package verification checks are defined;
- local distribution proves authenticated OSS read-back of every object and
  `latest` is byte-identical and unsigned/direct reads of each exact
  private-origin object key return 403;
- the previous healthy identity is recorded, or the target is verified and
  recorded as empty for a first deployment;
- no secret will enter workflow input, command arguments, logs, or artifacts;
- production has durable human approval for the exact image digest or, for a
  local distribution, the exact version string.

Routine releases may update application containers only. Shared Caddy routes,
host firewall rules, registry credentials, deployment-user permissions,
databases, and GitHub Environment protection are infrastructure changes. Make
them through separate approved work with a backup, validation, and rollback
plan; never smuggle them into an application release.

Local Computer manifest formats, code-signing/notarization keys and algorithms
(operating-system code signing, unrelated to this contract's checksum-only
release integrity model), update protocols, distribution credentials,
platform matrices, and compatibility wire fields are likewise separate
security or infrastructure changes. Review them before enabling their
operator interfaces; do not weaken the topology or per-user installation
boundaries.

## Implementation status

The obsolete custom Go realtime-gateway, its ECS Compose deployment, and its
test workflow have been removed. The approved standalone Centrifugo, Redis,
PostgreSQL, and Backend deployment is implemented for the `staging` cloud
environment through the immutable-digest workflow above; production stays
disabled behind the human approval gate. The release Skill must stop rather
than reconstruct or invoke the removed gateway workflow.

The local feed topology and `releases.coforge.cn` consumer boundary above
are approved. `scripts/release/publish.ts`, run manually through
`.github/workflows/release-staging.yml` (`workflow_dispatch` only, `environment:
staging`), implements the "Main to staging" local-
distribution path: it runs the repository gates, cross-compiles the unified
Computer for a set of release targets, assembles the schema 2 version tree
(`build-release.ts`), uploads every object `buildReleaseTree` lists, and verifies
authenticated OSS read-back. Before updating `latest`, it verifies **every**
exact object key is byte-identical through authenticated OSS access and that an
unsigned exact-origin GET returns 403. Probe failures produce sanitized
diagnostics.
The existing `latest` bytes are saved and verified before activation. The new
selector is then checked through authenticated OSS read-back and the unsigned
origin guard; on failure the previous bytes are restored and verified, or a
first-publish selector is removed and absence checked.
Rollback verification failure is reported separately, never as a healthy release.
Object checks and the previous selector hash are retained in workflow logs.

The existing staging CDN policy revalidates `/latest` and `*.json` on each
request, while versioned binaries are immutable (see
`docs/operations/aliyun-oss-cdn.md`, Section 10). Routine publication does not
request the CDN, change CDN configuration, or issue purge requests. Independent
infrastructure CDN acceptance tooling remains available to test the exact
consumer URL without cache-busting query parameters from an appropriate network;
its result describes domestic consumer-path reachability and cache behavior, not
the storage publication result. The user authorized this release-gate change on
2026-09-09; routine publications and their automatic rollback do not require a
new human approval merely because CDN read-back is omitted.

Platform coverage and remaining acceptance gaps are explicit:

- **Platform matrix**: `publish.ts --targets` defaults to all six targets:
  Linux, macOS, and Windows, each x64 and arm64. `release-staging.yml` uses
  this default and its reusable CI gates execute the existing compiled release
  identity/environment-binding tests on `windows-latest` and `windows-11-arm`.
  These are native executable smoke checks, not installer or upgrade tests.
- **Windows lifecycle acceptance**: clean bootstrap, upgrade, Supervisor and
  Workspace readiness, retained identity, and offline rollback still require
  end-to-end evidence before production promotion. External Agent process-tree
  supervision remains fail-closed as specified in `docs/architecture.md`.
- **macOS lifecycle runtime verification**: launchd unit generation and adapter
  behavior have automated coverage, but the complete install, manager-owned
  Coordinator, upgrade, health-identity, and rollback flow has not yet run on a
  macOS host. Do not treat source-level tests as platform release evidence.

Distribution credentials (`ALIYUN_OSS_ACCESS_KEY_ID`/`ALIYUN_OSS_ACCESS_KEY_SECRET`,
see `infra/staging/README.md`) and updater commands (`packages/computer/src/
updater.ts`, `install.sh`, `install.ps1`) were already implemented before this
publish workflow. The release Skill may publish development candidates through
this workflow, but must distinguish published targets and native smoke checks
from complete platform lifecycle acceptance. A successful live publish workflow
proves authenticated OSS storage read-back and private-origin rejection, not CDN
or end-user delivery. CDN acceptance remains a separate infrastructure check.

## Official references

- [GitHub workflow syntax, reusable inputs, and job dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub concurrency and queued deployments](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [GitHub deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Deploying with GitHub Actions](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
- [Publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub artifact attestations for binaries and manifests](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
- [Bun standalone executable and cross-compilation targets](https://bun.sh/docs/bundler/executables)
- [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/)
- [Apple macOS Library directory details](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/MacOSXDirectories/MacOSXDirectories.html)
- [Microsoft known folder identifiers](https://learn.microsoft.com/en-us/windows/win32/shell/knownfolderid)
- [Alibaba Cloud CDN with a private OSS origin](https://www.alibabacloud.com/help/en/cdn/user-guide/grant-alibaba-cloud-cdn-access-permissions-on-private-oss-buckets)
- [Alibaba Cloud CDN conditional origins](https://www.alibabacloud.com/help/en/cdn/user-guide/configure-a-conditional-origin)
- [Alibaba Cloud CDN cache policy for OSS](https://www.alibabacloud.com/help/en/cdn/use-cases/cdn-acceleration-oss-faq)
- [Alibaba Cloud `RefreshObjectCaches`](https://www.alibabacloud.com/help/en/cdn/developer-reference/api-cdn-2018-05-10-refreshobjectcaches)
- [Alibaba Cloud OSS data verification](https://www.alibabacloud.com/help/en/oss/user-guide/data-verification/)
- [Docker image pulls by immutable digest](https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier)
- [Docker Compose project names](https://docs.docker.com/compose/how-tos/project-name/)
- [Docker Compose service image and health configuration](https://docs.docker.com/reference/compose-file/services/)
- [`docker compose pull`](https://docs.docker.com/reference/cli/docker/compose/pull/)
- [`docker compose up`](https://docs.docker.com/reference/cli/docker/compose/up/)
