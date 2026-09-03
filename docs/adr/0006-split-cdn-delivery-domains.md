# ADR 0006: Separate delivery domains for attachments and releases

Status: accepted (2026-09-03)

## Context

Two content classes are delivered from private Alibaba Cloud OSS buckets
through CDN, and their access requirements are opposite:

- chat attachments must be unreadable without a short-lived client signature;
- release artifacts and `channels.json` must be anonymously readable, because
  `curl … install.sh | sh` and the updater cannot present a credential. Their
  integrity comes from the release-set digests and the signed `channels.json`,
  not from access control.

The previously accepted design served both from one accelerated domain,
`cdn.coforge.cn`, splitting them by the `/files/` and `/releases/` path
prefixes. Alibaba Cloud's URL signing is configured per accelerated domain, so
keeping one domain requires scoping the signing configuration with a rule
condition, and a conditional origin sends any unmatched path to the basic
origin. Fail-closed behaviour therefore depended on an EdgeScript guard that
rejects every path outside the two prefixes before origin fetch — a feature the
account must have enabled, which the runbook made a hard gate on provisioning.

The same-account private-origin authorization grants the CDN service role
bucket-wide read access per origin bucket. On a single domain both content
buckets are authorized to the same domain, so prefix isolation is enforced by
rule correctness rather than by permission.

## Decision

Deliver each content class from its own accelerated domain, each fronting
exactly one private bucket, with no business path prefix:

```text
files.coforge.cn/<object_key>          -> ${FILES_BUCKET}      URL signing on
releases.coforge.cn/<release_path>     -> ${RELEASES_BUCKET}   no client signing
```

Paths map one to one onto object keys; no prefix is rewritten away. URL signing
is a plain per-domain setting rather than a rule condition. Neither domain is
authorized to read the other's bucket, and neither accepts or forwards
application login cookies. Application session cookies stay host-only, so a
delivery subdomain never receives them.

The public installation entry points stay on the main site
(`https://coforge.cn/computer/install.sh` and `install.ps1`) and route to the
release feed. Clients continue to treat delivery URLs as opaque values, and the
database still stores only object keys.

## Rejected alternatives

**One domain with path prefixes (the superseded design).** Workable, and its
runbook solved every mechanism, but it buys a single hostname at the cost of an
EdgeScript dependency, a rule-condition budget shared with conditional origin
(five references per domain), and isolation that holds only while the rules are
correct. Nothing in the product depends on the two classes sharing a hostname.

**A separate registrable domain for attachments.** Serving user-uploaded
content from a different site, the way GitHub uses `githubusercontent.com`, is
the stronger form of this isolation: subdomains of one registrable domain still
share a cookie namespace when a cookie is set with a `Domain` attribute. Our
session cookie is host-only, so a subdomain is sufficient today. Revisit this
if attachments ever need to be rendered inline as active content, or if any
cookie gains a `Domain=.coforge.cn` scope.

**GitHub Releases as the release feed.** Common for open-source distribution
and free, but mainland download performance and reachability are the reason the
feed is on Alibaba Cloud in the first place.

## Consequences and migration

Nothing is deployed yet: the provisioning runbook still records
`cdn.coforge.cn` as not live, and no object has been published, so there is no
data migration, no client release, and no URL to redirect. The change is
documentation and acceptance tooling only.

Provisioning now adds two accelerated domains instead of one. Each needs the
ICP filing gate satisfied before a mainland acceleration area or CNAME cutover.
EdgeScript is no longer required; if the account lacks it, provisioning
continues.

`scripts/verify-oss-cdn.ts` takes `files_host` and `releases_host` instead of a
single `cdn_host`, asserts that each CDN path equals its origin object key, and
replaces the cross-prefix probes with cross-domain ones: the attachment key
requested unsigned from the release domain, and the release key requested from
the attachment domain **with valid signing material**, so that rejection proves
bucket isolation rather than a missing signature. The `unmatched` probe is gone
because there is no longer an unmatched-path class to fall back from.

## Validation and rollback

Acceptance is unchanged in spirit and still gates publication: anonymous direct
GETs of the exact OSS keys are rejected; CDN bytes match the recorded SHA-256;
attachment responses are `private, no-store` and refuse to serve unsigned;
immutable release objects carry a long immutable cache policy while
`channels.json` revalidates; successful responses carry no redirect,
`Set-Cookie`, or OSS hostname; and both cross-domain probes return a
non-redirecting 4xx.

Rollback is deleting the two accelerated domains before CNAME cutover. After
cutover, roll back by pointing the CNAME away and re-running acceptance; the
buckets and their contents are unaffected because object keys did not change.

This record supersedes the single-domain boundary previously stated in
[`../architecture.md`](../architecture.md) and [`../release.md`](../release.md).
