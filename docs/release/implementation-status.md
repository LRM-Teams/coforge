# Implementation status

The obsolete custom Go realtime-gateway, its ECS Compose deployment, and its
test workflow have been removed. The approved standalone Centrifugo, Redis,
PostgreSQL, and Backend deployment is implemented for the `staging` cloud
environment through the immutable-digest workflow in
[Main to staging](main-to-staging.md#cloud-application); production stays
disabled behind the human approval gate. The release Skill must stop rather
than reconstruct or invoke the removed gateway workflow.

The local feed topology in [Local Computer distribution model](local-distribution.md)
and the `releases.coforge.cn` consumer boundary in
[Feed hosting and installation entry points](local-feed-hosting.md) are approved.
`scripts/release/publish.ts`, run manually through
`.github/workflows/release-staging.yml` (`workflow_dispatch` only, `environment:
staging`), implements the [Main to staging](main-to-staging.md#local-computer-distribution)
local-distribution path: it runs the repository gates, cross-compiles the unified
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
The staging workflow reaches the Beijing release bucket through the global OSS
transfer acceleration endpoint `oss-accelerate.aliyuncs.com` (with
`--region oss-cn-beijing` for V4 signing), because the public path from
GitHub-hosted runners to `oss-cn-beijing` measured 17–56 KB/s from dev.59 on.
Acceleration must be enabled on the bucket; it is billed per GB as
overseas-to-mainland accelerated traffic (`AccO2MIn`).

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
  supervision remains fail-closed.
- **macOS lifecycle runtime verification**: launchd unit generation and adapter
  behavior have automated coverage, but the complete install, manager-owned
  Coordinator, upgrade, health-identity, and rollback flow has not yet run on a
  macOS host. Do not treat source-level tests as platform release evidence.

Distribution credentials come from GitHub OIDC federation to the Alibaba Cloud
RAM role `coforge-release-publisher` (`ALIBABA_CLOUD_ROLE_ARN`/
`ALIBABA_CLOUD_OIDC_PROVIDER_ARN`, resolved through `@alicloud/credentials`'s
default chain with V4 request signing; see `infra/staging/README.md` and
`.github/workflows/release-staging.yml`) - no long-term AccessKey is stored for
this publisher. Updater commands (`packages/computer/src/updater.ts`,
`install.sh`, `install.ps1`) were already implemented before this publish
workflow. The release Skill may publish development candidates through this
workflow, but must distinguish published targets and native smoke checks from
complete platform lifecycle acceptance. A successful live publish workflow
proves authenticated OSS storage read-back and private-origin rejection, not CDN
or end-user delivery. CDN acceptance remains a separate infrastructure check.
