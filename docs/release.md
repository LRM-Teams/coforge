# CoForge release contract

Status: approved workflow contract; the cloud staging deployment workflow is implemented; production stays disabled behind the human approval gate

Updated: 2026-09-04

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
| Local Computer distribution | A release version plus its manifest's SHA-256 checksum for every platform's Computer and Daemon binary | Version published behind the staging feed's `latest` pointer | Copy the identical version's bytes to the production feed and point its `latest` at it |

The daemon runtime role is released inside `coforge-daemon`; it is not a third local
product component. `@coforge/agent` is independently packable for dependency and
verification purposes, but the exact installed package remains part of the
Daemon component payload rather than becoming a third user-facing component.

Computer and Daemon are two independently buildable, versioned, and packable
source units - Computer declares Daemon as a package dependency, and Daemon
declares an exact `@coforge/agent` runtime dependency - but they are released
together under one shared version identity. Every publication ships both
components' binaries for every supported platform beneath that version,
recorded in one `manifest.json` that names each binary's byte size and SHA-256
checksum. There is no separate release-set digest, per-component manifest, or
installation-bundle archive: integrity comes from TLS in transit plus the
manifest's checksums, not a signed multi-tier envelope, and a version is either
published completely or not at all.

Users install, upgrade, and invoke only Computer. Daemon is not a second
user-installed product or public CLI entry point, but it still runs as an
independent OS process. The two binaries are fetched and verified separately
per platform; an implementation must not collapse the runtime process boundary
between them.

## Release identity and evidence

Every deployment or local-distribution publication record must identify:

| Field | Meaning |
| --- | --- |
| `source_commit` | Full Git commit SHA on `main`; host-initiated rollback uses the explicit `manual` sentinel and remains bound to immutable image digests |
| `track` | Cloud application or local Computer distribution |
| `artifact_identity` | Cloud image digest or local release version and its manifest's SHA-256 |
| `artifact_members` | Image reference or, per platform, each Computer/Daemon binary's name, size, and SHA-256 checksum |
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
latest                                  plain text, one version string, e.g. "0.1.0"
<version>/manifest.json                 unsigned JSON: schema_version, version, commit, buildDate, platforms
<version>/<target>/coforge-computer
<version>/<target>/coforge-daemon
computer/install.sh
computer/install.ps1
```

`<target>` is one of the existing `releaseTarget` values: `linux-x64`,
`linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`, `windows-arm64`.
`manifest.json` names, for every supported target, the Computer and Daemon
binary's file name, byte size, and SHA-256 checksum (bare lowercase hex, no
`sha256:` prefix). `commit` (the full `main` source SHA) and `buildDate` exist
to look up how a version was built after the fact; they are not themselves
verified by the installer. `schema_version` is reserved so a future payload-
signing field could be added without breaking older installers, but signing is
explicitly out of scope for this contract: **integrity comes from HTTPS in
transit plus the manifest's SHA-256 checksums, not a signed envelope.** This
mirrors how Claude Code and `@botiverse/raft-daemon` ship updates; CoForge's
manifest nests `computer` and `daemon` per platform only because it ships two
binaries where those tools ship one.

Every publication ships both components together under one version identity;
there is no mechanism to change only Computer or only Daemon while reusing the
other's prior artifact. `coforge-computer` still depends on `coforge-daemon`
at the package/build boundary, and the Daemon artifact still carries its exact
installed `@coforge/agent` dependency, but both are built, tested, and
promoted as a single unit.

All objects beneath a `<version>/` prefix are write-once: once published,
changing any byte requires a new version string. `latest` is the feed's only
mutable object, and it is written **last** - every object under the new
`<version>/` it will point to is uploaded and verified first. A publish that
fails partway through therefore leaves at most an unreferenced version
directory; `latest` never points at incomplete or missing objects.

A version string is opaque to the client: the updater and both installers
accept any value matching `[A-Za-z0-9.+-]{1,100}` with no `..` segment - the
same rule the `latest` pointer's own content must satisfy. Enforcing a SemVer
or prerelease-label discipline on top of that is a publishing-workflow policy,
not a wire-format requirement, and is out of scope here.

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
bucket hostname or replace the manifest-checksum verification
performed by the installer, and the web UI must not link to a CDN or OSS origin
directly.

Users never depend on or discover the OSS bucket URL. Immutable version objects
use a long immutable cache policy; `latest` uses revalidation/no-cache. A
publication is incomplete until the workflow refreshes affected CDN objects and
downloads the consumer-visible bytes again to compare them with its local
manifest and binaries. For every publication, the workflow must
also prove that an unsigned anonymous/direct GET of the exact OSS object key is
rejected, while the public CDN URL succeeds through the configured private-origin
authorization. The durable record stores only the pass/fail evidence, not the
private bucket endpoint or credentials. A redirect to OSS, an anonymously
readable origin object, or a CDN fetch that cannot be tied to the same bytes
fails publication.

### Per-user installation

Installation, upgrade, background startup, and rollback run entirely as the
current user. They must not request `sudo` or administrator elevation, write to
`/usr/local`, `/opt`, `/Library`, `Program Files`, or system service locations,
or reuse another user's installation.

- Linux resolves configuration, data, state, and cache from the XDG base
  directories. Only the Computer shim may use the current user's
  `~/.local/bin` when no configured user binary directory exists; Computer
  background startup is user-scoped.
- macOS resolves support files and version storage from the current user's
  `~/Library/Application Support/CoForge`; only Computer may register a
  per-user LaunchAgent.
- Windows resolves program and application data below the current user's
  `LocalAppData`; only Computer may use a current-user startup mechanism.

The installer maintains a user-owned versioned installation directory. It downloads
the Computer and Daemon binaries into staging, verifies each against the
manifest's recorded size and SHA-256 checksum, activates only after both
payloads pass, preserves the prior version for rollback, and never relocates
stable machine identity, credentials, configuration, or user data into a
versioned directory. Only the `coforge-computer` shim enters the current
user's PATH. The Daemon payload remains inside the versioned installation
directory, is never registered as its own system or user service, and is
launched by Computer through the exact path selected by the active version.

Both `install.sh` and `install.ps1` expose two selection modes with identical
semantics:

- omitted or `--version latest` resolves the feed's `latest` pointer;
- `--version <version>` selects one exact published version.

An exact version is enough to select an installation because Computer and
Daemon are released and versioned together; there is no independent Daemon
version to disambiguate.

## Main to staging

### Cloud application

The automated cloud path is:

1. Run the repository test, check, and build gates for the `main` commit.
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

The automated local-distribution path always publishes both components
together, to the track's own feed (a staging build trusts a different
`COFORGE_RELEASE_FEED_URL` than a production build compiles in, so the two
tracks' `latest` pointers are never the same object):

1. Run the repository gates for the exact `main` commit.
2. Build the Computer and Daemon artifacts once for the complete Windows,
   Linux, and macOS platform matrix, with the approved Bun executable targets.
   Do not rebuild one platform after another platform passed.
3. Compute every platform's Computer and Daemon binary byte size and SHA-256
   checksum and assemble the version's `manifest.json`.
4. Publish `manifest.json` and every platform binary beneath the new
   `<version>/` prefix on the staging feed. Prove anonymous/direct reads of
   their exact private-origin keys are rejected, then re-read them through
   `releases.coforge.cn` and compare consumer-visible bytes with the workflow
   source bytes.
5. Only after every object under `<version>/` is published and verified,
   write the staging feed's `latest` pointer to the new version. A publish
   that fails before this step leaves an unreferenced version directory that
   no installer will ever resolve.
6. Refresh and re-read `latest` through the staging feed, then run the
   local-distribution checks below against the version it resolves.
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

The local Computer distribution uses the same two-party boundary. Promotion
copies bytes between the two tracks' feeds; it never rebuilds them:

1. An Agent verifies the staging feed's `latest` resolves a stable version
   (no prerelease suffix). It prepares that version, its manifest's SHA-256
   checksum for every platform's Computer and Daemon binary, the source
   commit, the staging test run and evidence, and the production feed's
   current `latest` for comparison.
2. A human approves or rejects that exact version. A filename, branch,
   channel name, or unspecified "latest build" approval is invalid; the
   approval must name the exact version string.
3. After approval, the Agent re-downloads the approved version's manifest and
   every platform binary from the staging feed and confirms they still match
   the checksums recorded in the approval and the staging test evidence.
4. The Agent copies the approved version's `manifest.json` and every platform
   binary, byte-for-byte, from the staging feed to the production feed
   beneath the same `<version>/` path. It does not rebuild, repackage, or
   re-derive them.
5. Only after every copied object is re-read from the production feed and
   confirmed byte-identical does the Agent write the production feed's
   `latest` pointer to the approved version.
6. The Agent refreshes and re-reads the production feed's `latest`, verifies
   it resolves the approved version, runs the production local-distribution
   checks, and records the result.

Changing any platform's checksum, or copying from anywhere other than the
already-tested staging objects, produces a different version and invalidates
approval. Do not rebuild, repackage, re-derive, or re-notarize a binary during
promotion.

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

A local Computer release version is healthy only when:

1. the feed's `latest` pointer resolves the requested version and no other;
2. the version's manifest and every downloaded platform binary match their
   recorded byte sizes and SHA-256 checksums;
3. an unsigned anonymous/direct GET of each exact private OSS object key is
   rejected, the CDN succeeds through private-origin authorization, the
   CDN-retrieved bytes match the workflow's source bytes, and no package URL
   exposes or redirects to the OSS bucket;
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
refresh the CDN, and verify the selector and installation again. Because both
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
SHA-256 checksums, and CDN verification evidence.

## Routine release boundary

Before any mutating deployment, verify all of the following:

- the source commit is on `main` and repository checks passed;
- the requested image or local release version and its manifest exist and
  their immutable identities resolve;
- the target has isolated secrets/credentials and a unique concurrency group;
- the track-specific configuration or feed manifest validates;
- the applicable cloud or local-package verification checks are defined;
- local distribution proves anonymous/direct reads of each exact private-origin
  object key fail while CDN private-origin retrieval returns the verified bytes
  without redirecting the client to OSS;
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
are approved, but no feed or publishing workflow exists yet. Platform/
architecture matrices, distribution credentials, and updater commands remain
unimplemented. The release Skill may inspect and prepare their evidence, but
it must not invent publication or updater commands.

## Official references

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
