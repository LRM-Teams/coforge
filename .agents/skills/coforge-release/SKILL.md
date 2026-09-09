---
name: coforge-release
description: Operate and verify CoForge cloud images and local Computer installation release sets across test and production. Use when an Agent needs to inspect or publish a test candidate assembled from the Computer and Daemon app packages, prepare or request a production promotion, promote an exact immutable artifact after human approval, verify release evidence, install a local Computer distribution, or roll back a failed release.
---

# CoForge release

Read [`docs/release.md`](../../../docs/release.md) completely before acting. It
is canonical; this Skill only routes and enforces its workflow. Also follow
[`AGENTS.md`](../../../AGENTS.md) for Issue, branch, review, and decision gates.

## Classify authority

- **Inspect** is strictly read-only. Report state and blockers; never update an
  Issue or another external record unless the current task separately and
  explicitly authorizes that write.
- **Publish test**: execute the documented cloud deployment or unified
  six-platform Computer development publication to staging. Computer and
  Daemon are built together under one version, not separately promoted peers.
- **Install local**: install the selected Computer installation bundle through
  the reviewed per-user installer and version store.
- **Prepare production**: assemble the exact-artifact approval packet, then
  stop before deployment or publication.
- **Promote production**: verify human approval for the cloud digest or exact
  local source commit and version, then execute the canonical promotion path.
- **Rollback**: restore the recorded previous healthy digest under the
  canonical authorization rules.

## Discover the implemented interface

1. Use `rg --files` to discover the current workflow, Compose, packaging, feed,
   installer, and version-store files; do not rely on remembered paths.
2. Compare their real operator inputs and outputs with the canonical contract.
3. If the document still says the operator interface is unimplemented, stop
   before external mutation, report the missing interface, and identify its
   tracked implementation Issue when one is discoverable. Only update that
   Issue when the current task explicitly authorizes project work. Never
   improvise SSH or Docker commands.

## Route the operation

- **Inspect**: collect the fields in **Release identity and evidence** and
  **Audit records** for the selected release track using read-only operations.
- **Publish test**: execute the matching cloud or local-package path in **Main
  to staging**, including its **Health verification** and audit record, only
  through the implemented interface.
- **Install local**: use one selection mode in **Per-user installation**, then
  apply the local **Health verification** checks.
- **Prepare production**: assemble the packet in **Staging to production**, ask a
  human to approve the track's exact identity, and stop.
- **Promote production**: re-read the durable approval, require an exact cloud
  digest or local source commit and version match, then execute the matching
  path in **Staging to production** through the implemented interface. The Agent
  may execute and monitor; it cannot supply the human approval.
- **Rollback**: follow **Rollback** for authorization and target selection, then
  verify and audit the result through the same implemented interface.

For every mutating operation, apply **Routine release boundary** before the
first mutation. Also stop when another deployment owns the environment gate or
when the implemented interface cannot provide the required evidence. Report a
blocker instead of weakening TLS, exposing secrets, guessing a target, or
changing shared infrastructure. For local distributions, stop if the schema 2
manifest or gzip/checksum identities are invalid, any of the six platforms is
missing, or the unified executable omits a required role. Manifests are unsigned
by design: HTTPS and SHA-256 provide integrity; do not impose obsolete signing
or separate-component release-set gates. Apply the canonical staging development
gate separately from full production lifecycle acceptance, and report unverified
platform behavior explicitly. Stop if installation requires elevation or a
system-wide path, or exposes a standalone Daemon on `PATH`. Also
stop if the implemented interface cannot prove that direct anonymous origin
reads return 403 and authenticated OSS read-back returns byte-identical bytes for
every version object and `latest`. Do not require CDN read-back for routine
Computer publication or rollback. Treat domestic CDN reachability and cache
behavior as independent infrastructure acceptance, retain its separate tooling,
and do not report end-user delivery as verified from storage evidence alone.

## Return

Return the compact record defined by **Release identity and evidence** and
**Audit records**, plus blockers and follow-up work. Never print credentials,
token-bearing URLs, secret values, or unredacted logs.
