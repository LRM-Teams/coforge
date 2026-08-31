# CoForge release contract

Status: approved workflow contract; the cloud staging deployment workflow is implemented; production stays disabled behind the human approval gate

Updated: 2026-08-26

This document is the canonical release specification for CoForge. It defines
which artifact may move between environments, who authorizes that movement,
and what evidence makes a deployment or rollback complete. The project Skill
at [`.agents/skills/coforge-release`](../.agents/skills/coforge-release/SKILL.md)
implements this contract without duplicating it.

## Release invariants

- Keep one long-lived branch, `main`. Short-lived branches open a PR into
  `main`, run CI, and do not deploy. Do not add a long-lived `dev` branch.
- Treat cloud applications and the local Computer distribution as distinct
  release tracks. Inside the local track, Computer and Daemon retain independent
  package versions and artifact identities, while users install only a Computer
  bundle assembled from one verified-compatible pair.
- Build each release candidate once for a `main` commit and give it an immutable
  identity: a registry digest for a cloud image, or a release-set digest plus
  per-bundle and per-payload checksums for the local Computer distribution.
- Publish `main` candidates to the track's isolated `staging` environment or
  `test` distribution channel. A pre-production target never pretends to be
  production.
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
| Local Computer distribution | Release-set digest, both component-manifest digests, and every platform installation-bundle checksum | Test release set selected by `channels.json` | Select the same tested release-set and bundle bytes in production |

The daemon runtime role is released inside `coforge-daemon`; it is not a third local
app package. `@coforge/agent` is independently packable for dependency and
verification purposes, but the exact installed package remains part of the
Daemon component payload rather than becoming a third user-facing component.
The local distribution deliberately separates four layers:

| Layer | Cardinality and meaning |
| --- | --- |
| App package | Two source/build units: `coforge-computer` and `coforge-daemon`; Computer declares Daemon as a package dependency, and Daemon declares an exact `@coforge/agent` runtime dependency |
| Component artifact | Two independently versioned build outputs that may be reused when the peer did not change |
| Computer installation bundle | One user download per platform/architecture containing both compatible process payloads |
| Release set | One immutable compatibility and integrity identity that pins both component artifacts and every platform bundle |

Users install, upgrade, and invoke only Computer. Daemon is not a second
user-installed product or public CLI entry point, but it still runs as an
independent OS process. A bundle may contain two executables or another reviewed
self-contained representation; the archive/embedding format remains an
implementation decision and must not collapse the runtime process boundary.

After the initial local-distribution bootstrap, one promotion transaction may
change only the Computer component digest or only the Daemon component digest.
The unchanged peer artifact is reused without rebuilding, and a new installation
bundle is assembled from the new pair. This keeps approval and evidence scoped
to one component while every user still receives an atomic compatible
installation. The bootstrap is the one exception: it establishes the first
complete pair when neither peer exists, and its approval names both component
manifests. Any later transaction that changes both components together requires
a separate architecture decision.

## Release identity and evidence

Every deployment or local-distribution publication record must identify:

| Field | Meaning |
| --- | --- |
| `source_commit` | Full Git commit SHA on `main`; host-initiated rollback uses the explicit `manual` sentinel and remains bound to immutable image digests |
| `track` | Cloud application or local Computer distribution |
| `artifact_identity` | Cloud image digest or local release-set, changed-component, and both component-manifest digests |
| `artifact_members` | Image reference or component versions plus platform installation-bundle names, sizes, SHA-256 checksums, and signatures |
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
`registry/repository@sha256:...`; a local-package channel must resolve an exact
release-set digest, whose component manifests, platform bundle, and extracted
process payloads also match their recorded digests.

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

The local feed has two reusable component-artifact trees, immutable Computer
installation release sets, and one mutable channel snapshot:

```text
releases/computer/{version}/manifest.json
releases/computer/{version}/{component-artifact}
releases/daemon/{version}/manifest.json
releases/daemon/{version}/{component-artifact}
release-sets/{id}/manifest.json
release-sets/{id}/bundles/{platform-architecture-package}
channels.json
computer/install.sh
computer/install.ps1
```

Computer and daemon manifests use independent SemVer versions and contain the
component name, full `main` source commit, platform/architecture, byte size,
SHA-256, and signing metadata for every build artifact. A release-set manifest
contains the exact Computer and Daemon manifest digests, their declared local-
protocol compatibility, and the CDN URL, size, SHA-256, and signing metadata for
each platform's Computer installation bundle. Each bundle contains both process
payloads and an internal copy or equivalent proof of the selected release-set
identity. All paths below `releases/` and `release-sets/` are write-once. Once
published, changing any byte requires a new component version or release-set
identity.

The component trees exist so an unchanged Computer or Daemon artifact can be
reused and audited; they do not create a supported second Daemon installer.
`coforge-computer` depends on `coforge-daemon` at the package/build boundary,
the Daemon artifact contains its exact installed `@coforge/agent` dependency,
and the release-set assembly is the only user distribution boundary.

`channels.json` is the only mutable selection object. Its signed payload has a
schema version, a monotonic generation, and two channel entries whose `current`
and `previous` fields are either a canonical release-set digest string or JSON
null. An initial unpublished generation therefore has this logical shape:

```json
{
  "channels": {
    "test": { "current": null, "previous": null },
    "production": { "current": null, "previous": null }
  }
}
```

The exact wire schema and signature encoding belong to the updater
implementation, but these semantics do not: consumers fetch one generation,
never combine separate mutable computer and daemon pointers, reject an unknown
schema or invalid signature, and never fall back to a legacy `latest` alias.
For an unpublished channel, both `current` and `previous` are null inside the
signed payload; this is the only empty-channel representation. Selecting a
channel whose `current` is null fails closed with a stable not-published result:
an installer or updater must not fall back to the other channel, a component
manifest, or any mutable alias.
The writer is globally serialized and replaces the complete object only after
verifying that the source generation or ETag did not change.

MVP version policy is deliberately small:

- only `x.y.z-alpha.N` and stable `x.y.z` are publishable;
- `test` may select an alpha or stable release set;
- `production` may select only a stable release set;
- beta and release-candidate labels are rejected until a later policy change;
- version comparison uses a complete SemVer parser, not custom string sorting.

The feed is served beneath `https://cdn.coforge.cn/releases/` from a private
release bucket. `cdn.coforge.cn` is the shared certificate and CDN edge, not a
shared trust zone: `/releases/` and the separately governed attachment path use
different private buckets, RAM permissions, conditional origins, cache/access
rules, and logs. An unmatched path is denied and no origin rule may fall back
from one business prefix to the other. The CDN does not accept or forward
application login cookies.

The public installation entry points are served from the main site:

```text
https://coforge.cn/computer/install.sh
https://coforge.cn/computer/install.ps1
```

These stable URLs are the user-facing bootstrap boundary and must route to the
corresponding release installer under the CDN release feed. They must not
expose an OSS bucket hostname or replace the immutable release-set and payload
verification performed by the installer. The web UI should link to these main-
site entry points rather than directly to the CDN or OSS origin.

Users never depend on or discover the OSS bucket URL. Immutable release objects
use a long immutable cache policy; `channels.json` uses revalidation/no-cache. A
publication is incomplete until the workflow refreshes affected CDN objects and
downloads the consumer-visible bytes again to compare them with its local
manifests and installation bundles. For every publication, the workflow must
also prove that an unsigned anonymous/direct GET of the exact OSS object key is
rejected, while the public CDN URL succeeds through the configured private-origin
authorization. The durable record stores only the pass/fail evidence, not the
private bucket endpoint or credentials. A redirect to OSS, an anonymously
readable origin object, or a CDN fetch that cannot be tied to the same bytes
fails publication.

The updater ships a trusted release verification key and refuses an
installation bundle, component manifest, release set, or channel snapshot whose
signature or digest does not verify. After unpacking, it also verifies both
process payloads against the selected component identities. The signing format,
protected key custody, rotation, revocation, and first-install trust bootstrap
require a separate reviewed implementation.
The `curl | bash` form is a convenience, not independent proof that its mutable
script was trustworthy; the release must also offer a download-review-execute
path and an exact immutable release-set selector.

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

The installer maintains a user-owned versioned installation directory. It downloads one Computer
installation bundle into staging, verifies the signed release set, bundle, and
both contained process payloads, activates only after the complete set passes,
preserves the prior bundle for rollback, and never relocates stable machine
identity, credentials, configuration, or user data into a versioned directory.
Only the `coforge-computer` shim enters the current user's PATH. The Daemon
payload remains inside the versioned installation directory, is never registered as its own system
or user service, and is launched by Computer through the exact path selected by
the active release set.

Both `install.sh` and `install.ps1` expose three selection modes with identical
semantics:

- omitted or `--version latest` selects `production.current`;
- `--version test` selects `test.current`;
- `--version <release-set-id>` selects one exact immutable release set.

An exact component SemVer is not enough to select an installation because
Computer and Daemon versions are independent. An implementation may offer a
friendlier exact selector only when it resolves unambiguously to a signed
release-set digest and one platform bundle.

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

Before ordinary one-component releases can run, an initial bootstrap transaction
must establish the first complete local distribution:

1. Start only from a signed channel generation in which both `test` and
   `production` have null `current` and `previous` values, and verify that no
   prior component or release-set identity is being overwritten.
2. Build the first Computer and Daemon component artifacts once for the complete
   platform matrix, create and sign both component manifests, verify their local-
   protocol compatibility, and assemble every Computer installation bundle.
3. Create one immutable initial release set that names both first component-
   manifest digests and every bundle digest. Publish it through the same private-
   origin and CDN verification gates as any later release.
4. Move only `test.current` from null to that release set, leaving
   `test.previous` null; run the complete local-distribution verification matrix,
   and record both component identities as the bootstrap candidate.
5. `production.current` and `production.previous` remain null until a human
   approves the exact stable release-set digest, both component-manifest digests,
   and the test evidence. Promotion then moves only `production.current` to those
   already tested bytes; it does not rebuild, repackage, or re-sign them.

After that bootstrap, the automated local-distribution path changes one
component at a time:

1. Run the repository gates for the exact `main` commit.
2. Build that component's required Windows, Linux, and macOS artifacts once
   with the approved Bun executable targets. Do not rebuild the unchanged peer
   or rebuild one platform after another platform passed.
3. Create and sign the immutable changed-component manifest, then publish its
   exact artifact bytes beneath its version directory.
4. Reuse the unchanged peer artifacts, verify compatibility, and assemble one
   Computer installation bundle per supported platform/architecture. Each
   bundle contains the Computer and Daemon process payload selected by the new
   pair; only Computer is exposed as the installed user command.
5. Create and sign a new immutable release-set manifest. It changes only the
   candidate component digest, retains the production peer digest, and records
   every newly assembled installation-bundle digest and size.
6. Publish the release-set manifest and bundles beneath their immutable paths.
   Prove anonymous/direct reads of their exact private-origin keys are rejected,
   then re-read them through `cdn.coforge.cn/releases/` and compare
   consumer-visible bytes with the workflow source bytes.
7. Under the global channel writer lock, move `test.previous` to the old
   `test.current` and set `test.current` to the new release-set digest. Replace
   the complete signed `channels.json` with a higher generation.
8. Refresh and re-read `channels.json` through `cdn.coforge.cn/releases/`, then
   run the local-distribution checks below using the test selector.
9. Record the component, release-set, and bundle digests as healthy only after
   every required check passes.
10. On failure, restore `test.current` from the recorded previous release set,
   verify it, and record the candidate and rollback outcomes. For a verified
   first publication, restore `test.current` to null and keep `test.previous`
   null in a newly signed higher generation; installers continue to fail closed
   for that unpublished channel.

An alpha release ends here. A stable release is not production-ready merely
because it has no prerelease suffix: the exact stable release set must pass this
test path first. The workflow must not publish a mutable production alias,
change both component digests, offer Daemon as a separate user installation, or
treat one component's evidence as approval for the entire newly assembled
bundle.

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

The local Computer distribution uses the same two-party boundary:

1. An Agent verifies `test.current` is a stable release set. When production is
   non-empty, it must differ from `production.current` in exactly one component
   digest and retain the exact production peer digest. For the initial
   production bootstrap, `production.current` and `production.previous` must
   instead both be null in the verified signed channel generation, while
   `test.current` must be the tested initial two-component release set described
   above. The Agent prepares the release-set digest, both
   component-manifest digests, every platform installation-bundle checksum,
   source commit, test run and evidence, compatibility result, known risks, and
   `production.current` / `production.previous` identities.
2. A human approves or rejects that exact release-set digest and either the one
   named changed component or the explicitly named initial two-component
   bootstrap. A component version, filename, branch, channel name, unspecified
   “latest package,” or approval that could cover an unspecified component is
   invalid.
3. After approval, the Agent verifies `test.current`, its signatures, component
   manifests, installation bundles, and extracted payload identities still
   match the approval and test evidence.
4. Under the channel writer lock, it moves `production.current` to
   `production.previous`, sets `production.current` to the already tested
   release-set digest, increments the generation, signs the complete
   `channels.json`, and publishes only that selection object.
5. The Agent refreshes and re-reads `channels.json` through the public CDN,
   verifies the production selector resolves the approved release set, runs the
   production local-distribution checks, and records the result.

Changing either component manifest, any bundle file or checksum, or the
unchanged peer digest creates a new release set and invalidates approval. Do
not rebuild, repackage, re-sign, or re-notarize a bundle during promotion.

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

A local Computer release set is healthy only when:

1. the selected channel generation is signed, monotonic, and resolves the
   requested release-set digest and no other;
2. the release set, both component manifests, the selected platform bundle, and
   both extracted process payloads match their recorded signatures, SHA-256
   checksums, and sizes;
3. an unsigned anonymous/direct GET of each exact private OSS object key is
   rejected, the CDN succeeds through private-origin authorization, the
   CDN-retrieved bytes match the workflow's source bytes, and no package URL
   exposes or redirects to the OSS bucket;
4. clean per-user Computer install and supported per-user upgrade checks pass
   without a separate Daemon install or elevation on every required target
   platform/architecture;
5. both installed processes report the expected component versions and artifact
   identities and reach their local readiness boundaries;
6. computer-to-daemon Unix-socket and protocol compatibility passes for the
   declared release set, including a workspace-child startup smoke test;
7. stable machine identity, credentials, configuration, and application data
   survive the version-store activation; and
8. the previous Computer installation bundle remains installed or recoverable
   and a rollback rehearsal can reactivate it without network access.

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

If test publication or production verification fails, atomically restore the
affected channel's `current` selection from its signed `previous` release-set
digest, increment the generation, sign the complete `channels.json`, refresh
the CDN, and verify the selector and installation again. Because an MVP
transaction changes only one component, the peer component remains unchanged.

Devices that already activated a failed release set use the local versioned installation directory
to stop the processes, reactivate the retained previous Computer installation
bundle, restart Computer and Daemon, and repeat health checks. If persisted
state or protocol changes make this unsafe, production promotion must remain
disabled until a reviewed forward-repair path exists.

Local-distribution rollback reselects and reactivates recorded immutable bytes.
It does not rebuild old source, copy an unverified file into a release path, or
assume that a lower display version is installable. An unrelated later
production rollback requires human approval of the exact target release-set
digest unless a separately approved incident policy says otherwise.

## Audit records

Keep both the platform's deployment or publication record and the durable
release record defined above for every staging or test release, production promotion,
failed attempt, and rollback. Record the human approver and exact approved
artifact identity for production, the previous and resulting identities,
verification evidence, rollback trigger and result, and the final observed
state. An interrupted release is a recorded outcome, not a missing entry. The
records must reveal the selected and next rollback identities without relying
on an Agent's private memory, and must never contain secrets. Local records also
preserve the previous and resulting `channels.json` generations, release-set
digests, both component-manifest digests, every platform bundle digest, the
single changed component, CDN verification, and signature key identifier.

## Routine release boundary

Before any mutating deployment, verify all of the following:

- the source commit is on `main` and repository checks passed;
- the requested image or local release set and installation bundle exist and
  their immutable identities resolve;
- the target has isolated secrets/credentials and a unique concurrency group;
- the track-specific configuration or channel metadata validates;
- the applicable cloud or local-package verification checks are defined;
- local distribution proves anonymous/direct reads of each exact private-origin
  object key fail while CDN private-origin retrieval returns the verified bytes
  without redirecting the client to OSS;
- the previous healthy identity is recorded, or the target is verified and
  recorded as empty for a first deployment;
- no secret will enter workflow input, command arguments, logs, or artifacts;
- production has durable human approval for the exact image or release-set
  digest and, for a local distribution, the single changed component.

Routine releases may update application containers only. Shared Caddy routes,
host firewall rules, registry credentials, deployment-user permissions,
databases, and GitHub Environment protection are infrastructure changes. Make
them through separate approved work with a backup, validation, and rollback
plan; never smuggle them into an application release.

Local Computer-bundle formats, signing/notarization keys and algorithms, update
protocols, distribution credentials, platform matrices, and compatibility wire
fields are likewise separate security or infrastructure changes. Review them
before enabling their operator interfaces; do not weaken the topology,
single-component transaction, signature, or per-user installation boundaries.

## Implementation status

The obsolete custom Go realtime-gateway, its ECS Compose deployment, and its
test workflow have been removed. The approved standalone Centrifugo, Redis,
PostgreSQL, and Backend deployment is not implemented yet. Until a focused
implementation defines immutable artifacts, verification, audit evidence, and
rollback for that complete stack, neither staging nor production cloud deployment
has a repository-supported operator path. The release Skill must stop rather
than reconstruct or invoke the removed gateway workflow.

The local feed topology and `cdn.coforge.cn/releases/` consumer boundary above
are approved, but no feed or installer exists yet. Archive formats,
platform/architecture matrices, signature key lifecycle, and updater commands
remain unimplemented. The release Skill may inspect and prepare their evidence,
but it must not invent publication, signing, or updater commands.

## Official references

- [GitHub deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [Deploying with GitHub Actions](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
- [Publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub artifact attestations for binaries and manifests](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html)
- [Bun standalone executable and cross-compilation targets](https://bun.sh/docs/bundler/executables)
- [The Update Framework specification](https://theupdateframework.github.io/specification/)
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
