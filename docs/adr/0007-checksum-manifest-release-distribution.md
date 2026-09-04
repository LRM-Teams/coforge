# ADR 0007: Distribute Computer with a checksum manifest, not a signed feed

Status: accepted (2026-09-04)

## Context

The Computer updater originally resolved a release through four nested signed
envelopes — `channels.json`, a release-set manifest, two component manifests and
a per-platform installation bundle — each verified with Ed25519 or ECDSA P-256
against a trust set compiled into the binary. A separate bootstrap tier held a
pinned copy of the installer whose SHA-256 was baked into `install.sh`.

Nothing had ever been published through it. No release key was ever provisioned
until this month, no artifact existed in any bucket, and no user had installed
anything, so the whole mechanism was untested against a real producer.

Building the producer exposed what the design cost. Because `install.sh` pinned
the bootstrap digest, every change to the bootstrap invalidated the script, which
forced a second publishing workflow, a redirect route so the site could serve a
freshly rendered script, and cache rules that had to distinguish the two tiers.
The signing itself then required key custody, rotation and revocation procedures
that `docs/release.md` had explicitly deferred to "a separate reviewed
implementation" — work that had not been done and that a single maintainer with
no users would be doing purely on speculation.

We compared against the products closest to this one, reading their published
artifacts rather than their documentation:

- **Claude Code** ships Bun-compiled binaries (its executable contains
  `bun-v1.4.1`) of roughly 205 MB per platform. `install.sh` fetches a plain-text
  `latest` pointer, then `<version>/manifest.json`, then the binary, and verifies
  a SHA-256 from that manifest. Integrity rests on TLS plus the checksum;
  payload signing sits behind a `manifestSignatureEnforcement: "flag"` field.
- **`@botiverse/raft-daemon`**, an agent-running daemon with the same shape as
  ours, ships as plain Node JavaScript on npm with no signing at all, split into
  a `raft-computer` package depending on a `raft-daemon` package.

Both are more permissive than what we had built.

## Decision

Distribute through a pointer file and an unsigned checksum manifest:

```text
latest                                 plain text version string
<version>/manifest.json                { version, commit, buildDate, platforms }
<version>/<target>/coforge-computer
<version>/<target>/coforge-daemon
```

Integrity comes from TLS to the delivery domain plus the SHA-256 recorded in the
manifest for every binary. `install.sh` pins no digest of its own: it fetches
`latest`, then the manifest, then verifies what it downloads. That single change
removes the bootstrap tier, the second workflow, the redirect route and the cache
coupling they forced.

`manifest.json` keeps a `schema_version` so a signature field can be added later
without a format break, matching how Claude Code keeps signing available behind a
flag rather than absent.

Releases are published **manually** (`workflow_dispatch`), not on merge to
`main`. The Computer distribution is **not published to npm**.

Staging and production artifacts are not interchangeable: the feed a build trusts
is compiled into it, so promotion rebuilds the same commit against the production
feed rather than copying bytes between environments.

## Rejected alternatives

**Keeping the signed feed.** Signature verification defends auto-update against a
compromised bucket, which is a real threat for a daemon that runs code agents
with the user's credentials. It was rejected because the surrounding cost — key
custody, rotation, revocation, a bootstrap tier and its publishing machinery —
had to be paid before the first release, and because the closest comparable
products carry that risk today. Reintroducing it means adding a signature to the
manifest, not restoring four envelope layers.

**Publishing as plain Node packages on npm, as `raft-daemon` does.** This would
cut an artifact from 138 MB per platform to about 8 MB and reduce releasing to
`npm publish`. It was rejected because roughly 56 call sites use Bun-specific
APIs — `Bun.spawn`, `Bun.file`, `Bun.listen`, `Bun.Glob` and others, four of them
the local IPC layer — and `bun build --target=node` fails at runtime rather than
at build time, so the route needs that port first. A zero-prerequisite installer
also matters more than artifact size for the intended audience.

**Merging Computer and Daemon into one executable** to avoid embedding the Bun
runtime twice. Rejected: `raft-daemon` and `raft-computer` keep the same split
with independent versions, and [ADR 0004](0004-computer-daemon-rpc-topology-and-protobuf.md)
fixes a process boundary, not a file count. The duplication is about 60 MB per
platform and buys nothing at present.

## Consequences

`packages/protocol/release-envelope.ts`, the envelope verification in
`packages/computer/src/updater.ts`, `channels.json`, release sets, installation
bundles, component manifests, the `test` channel, generation-based rollback
protection and `release/trusted-keys/` are all deleted. The staging signing key
was destroyed and its GitHub Environment secret removed.

Kept: versioned install directories with symlink activation, rollback through the
recorded previous version, the post-install offline integrity check, refusal of
redirects, the download size cap, and writing the pointer last so a failed
publish leaves only unreferenced objects.

The updater's selection modes narrow to `latest` or an exact version; `test` and
`sha256:` selectors are gone.

CDN cache rules must follow the new mutable paths: `latest` and
`<version>/manifest.json` revalidate on every request while `<version>/*` stays
immutable. The previous rules named `channels.json`, which no longer exists, and
leaving them would make a published release invisible until the cache expired —
silently. See [`../operations/aliyun-oss-cdn.md`](../operations/aliyun-oss-cdn.md).

This record supersedes the signed-feed distribution described in
[`../release.md`](../release.md), which is updated in the same change, and
narrows the release-feed boundary stated in
[ADR 0006](0006-split-cdn-delivery-domains.md): the domain split stands, but the
objects behind `releases.coforge.cn` are no longer signed envelopes.
