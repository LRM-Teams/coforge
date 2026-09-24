# CoForge release contract

Status: approved workflow contract; the cloud staging deployment workflow and a local Computer distribution staging publish workflow are implemented; production stays disabled behind the human approval gate

Updated: 2026-09-09

This document is the canonical release specification for CoForge. It defines
which artifact may move between environments, who authorizes that movement,
and what evidence makes a deployment or rollback complete. The project Skill
at [`.agents/skills/coforge-release`](../../.agents/skills/coforge-release/SKILL.md)
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

## Topics

Read this overview first, then the topic files the task needs.

| Topic                                                               | Covers                                                                                                     |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Release tracks and immutable identities](tracks-and-identities.md) | The cloud and local tracks, their candidate identities, and the unified Computer executable                |
| [Release identity and evidence](evidence.md)                        | The fields every deployment or publication record must carry                                               |
| [Cloud environment model](cloud-environments.md)                    | `staging` versus `production` triggers, authorization, Compose projects, and secrets                       |
| [Local Computer distribution model](local-distribution.md)          | Feed layout, schema 2 manifest, gzip transport, checksum sidecar, write-once versions, and version strings |
| [Feed hosting and installation entry points](local-feed-hosting.md) | Release and file CDN domains, per-deployment installer URLs, origin privacy, and cache policy              |
| [Per-user installation](per-user-installation.md)                   | Installation paths, PATH shims, version store, launchers, selection modes, and environment-bound builds    |
| [Reading GitHub Actions](github-actions.md)                         | The CI, Web deploy, and Computer publish workflows, check selection, and version naming                    |
| [Main to staging](main-to-staging.md)                               | The automated cloud deployment and local publication paths to staging                                      |
| [Staging to production](staging-to-production.md)                   | The two-party production promotion for each track                                                          |
| [Health verification](health-verification.md)                       | Cloud health checks, diagnostics, local readiness gates, and the upgrade coordinator                       |
| [Upgrade operations and the runner hold](upgrade-operations.md)     | `UpgradeOperation` records and receipts, the runner hold, and `restart` behavior                           |
| [Rollback](rollback.md)                                             | Rollback authorization and targets for each track                                                          |
| [Audit records](audit-records.md)                                   | What every release, promotion, failure, and rollback record must preserve                                  |
| [Routine release boundary](routine-release-boundary.md)             | Pre-mutation checklist and changes that are infrastructure work rather than a release                      |
| [Implementation status](implementation-status.md)                   | What is implemented today, publisher credentials, and the remaining platform acceptance gaps               |
| [Official references](references.md)                                | Upstream documentation for GitHub Actions, Bun, Docker, Alibaba Cloud, and platform directories            |
