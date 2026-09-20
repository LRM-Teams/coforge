# ADR 0052: Profile images are delivered publicly from their own bucket and domain

Status: accepted
Date: 2026-09-20

## Context

A user avatar or project icon is rendered on every message row, member list, mention suggestion
and sidebar entry. Today each one is a backend route — `/api/me/avatar`,
`/api/workspaces/:workspaceId/users/:userId/avatar`,
`/api/computers/:computerId/creator-avatar`, `/api/projects/:projectId/icon` — that authenticates
the viewer, checks workspace membership, reads the object out of the private user-files bucket and
streams the bytes through the Web process. A screen with forty avatars is forty authenticated
backend requests and forty OSS reads, and the response is `private … Vary: Cookie`, so nothing is
shareable between viewers or cacheable at an edge.

Frank asked (2026-09-20) whether images go through the CDN, then asked to align with Slack and
Discord rather than invent a scheme. Both products draw the same line, and it is not the line
CoForge drew:

- Discord serves avatars from `cdn.discordapp.com/avatars/<user_id>/<hash>` and guild icons from
  `icons/<guild_id>/<icon>`. Its reference documentation states these standard CDN endpoints are
  not signed and do not expire, while *attachment* URLs carry `ex`/`is`/`hm` signing parameters
  that the client refreshes.
  ([Discord reference](https://docs.discord.com/developers/reference))
- Slack returns a member's `image_24` … `image_1024` as ordinary `avatars.slack-edge.com` links
  with no authentication material (default avatars come from `secure.gravatar.com`), while a
  file's `url_private` "requires authentication to retrieve", with a `files:read` bearer token,
  and only an explicitly shared file gets a `permalink_public`.
  ([user object](https://docs.slack.dev/reference/objects/user-object/),
  [file object](https://docs.slack.dev/reference/objects/file-object/))

So both treat a profile image as a public, permanently addressable, immutable object, and keep
signing for the content a person deliberately sent into a conversation. That is what makes the URL
stable enough for a browser and an edge to cache one copy for a long time; our signed attachment
URLs (ADR 0006 and `file-delivery.server.ts`) deliberately carry a timestamp and nonce, so reusing
them for avatars would change every avatar URL on every render and defeat caching entirely.

Two Alibaba Cloud constraints decide the shape:

- URL signing (鉴权方式 A) is a per-domain setting.
  ([Type A signing](https://help.aliyun.com/zh/cdn/user-guide/type-a-signing))
- Private-bucket origin fetch authorizes the CDN service role account-wide and, in the console's
  own words, "开启后，该加速域名将可以访问其源站私有 Bucket 内的所有资源，无法在 CDN 侧对
  Bucket 内的部分资源做访问限制".
  ([private OSS bucket origin](https://help.aliyun.com/zh/cdn/user-guide/grant-alibaba-cloud-cdn-access-permissions-on-private-oss-buckets))

A domain that serves one unsigned object key from a bucket can therefore serve every key in that
bucket. Publishing avatars from the existing user-files bucket — whether by relaxing
`files.coforge.cn` or by adding a second unsigned domain over the same origin — would publish
every chat attachment with it.

## Decision

Profile images — user avatars and project icons — become a third content class with its own
private bucket and its own accelerated domain, delivered anonymously:

```text
files.coforge.cn/<object_key>      -> ${FILES_BUCKET}      URL signing on
releases.coforge.cn/<release_path> -> ${RELEASES_BUCKET}   no client signing
images.coforge.cn/<object_key>     -> ${IMAGES_BUCKET}     no client signing
```

The bucket stays `private`; anonymity is the absence of client URL signing, not a public-read ACL,
which is also what Alibaba Cloud recommends for CDN-fronted static assets
([CDN acceleration for OSS](https://help.aliyun.com/zh/oss/user-guide/cdn-acceleration)). Paths
map one to one onto object keys, with no prefix rewrite, exactly as ADR 0006 requires of the other
two domains.

The access check moves from "is the viewer a member of this workspace?" to "does the viewer hold
the URL?". An object key contains a server-generated UUID per upload
(`users/{user_id}/avatars/{avatar_id}/original`,
`workspaces/{workspace_id}/projects/{project_id}/icons/{icon_id}/original`), so the URL is
unguessable, and because the key changes on every replacement the URL is immutable and cacheable
forever. Attachments are unaffected: they keep the signed, expiring delivery and their own bucket.

Every published URL asks for a **bucket image style**, never the stored original:
`…/users/{user_id}/avatars/{avatar_id}/original?x-oss-process=style/avatar192`. An upload may be
5 MB and an avatar is drawn at at most ~96px, so serving originals is the dominant cost on a chat
screen — both reference products serve variants instead (Slack's `image_24` … `image_1024`,
Discord's `?size=`). A style is a fixed alias defined on the bucket rather than a free-form
processing expression, which bounds how many variants an anonymous domain can ever be made to
produce and lets the bucket's source-image protection refuse anything else; on a domain with no
signature to rate-limit against, that bound is the abuse control
([image styles](https://help.aliyun.com/document_detail/44687.html),
[source image protection](https://help.aliyun.com/zh/oss/protect-source-images)). The style names
live in `PROFILE_IMAGE_STYLES` and are part of provisioning: the CDN domain must keep the
`x-oss-process` parameter rather than filtering every parameter, or the style silently degrades to
the original ([CDN image delivery](https://help.aliyun.com/zh/cdn/use-cases/use-alibaba-cloud-cdn-to-accelerate-the-delivery-of-images-in-oss)).

`COFORGE_IMAGE_DELIVERY_URL` and `COFORGE_IMAGE_OSS_BUCKET` carry this in the application. When
they are unset — local development, and any deployment before provisioning — profile images stay
in the private store and keep the authenticated routes, which is why those routes remain. Boot
fails when the two disagree: publishing image URLs without the bucket the image domain reads, or
pointing them at the signed attachment domain (which would 403 every avatar), or naming the
private files bucket as the image bucket.

## Rejected alternatives

**Sign avatar URLs like attachments.** One mechanism for everything, but Type A signing puts a
timestamp and a nonce in the URL, so the same avatar is a different URL on every response: forty
avatars become forty edge requests per page load, and browser caching never applies. It also
carries the failure mode Discord has to paper over — a URL pasted or cached past its expiry stops
working — for an image whose whole purpose is to be everywhere.

**Stable, time-bucketed signatures** (floor the timestamp to a 15-minute window, derive the nonce
from the key so the URL repeats within that window). This was the first design, and it does
restore caching. It was dropped once the reference products were checked: it invents a signing
scheme neither Slack nor Discord needs, keeps a secret in the loop, still breaks URLs at a window
boundary, and buys nothing over an unguessable key — with a 30-minute TTL, anyone holding the URL
can read the image anyway.

**Keep the proxy routes and have them 302 to the CDN.** Preserves the membership check on the
first hop, but every avatar still hits the Web process on every page load, which is the cost this
change is about.

## Consequences and migration

A user avatar or project icon becomes readable by anyone who holds its URL, including people
outside the workspace, for as long as the object exists. Membership is no longer checked on read.
Replacing an image writes a new key and unlinks the old object, so a withdrawn image stops being
served once cleanup removes it, but a URL already copied elsewhere remains valid until then.

Provisioning adds a third bucket and a third accelerated domain with its own ICP gate, CNAME
cutover, logs and certificate (see the runbook). Because the CDN role reads a whole bucket, the
image bucket must contain profile images only. Since the unsigned domain cannot be rate-limited by
a signature, the domain also gets a bandwidth cap and traffic alerts, the protection Alibaba Cloud
recommends in place of hotlink protection for an anonymously readable domain.

Existing avatars and icons live in the private files bucket. The object-key layout is identical in
both buckets, so migration is copying those two key prefixes into the image bucket and then
removing them from the files bucket; no database row, key, or client contract changes. Until the
copy runs, a deployment must keep `COFORGE_IMAGE_OSS_BUCKET` unset, which keeps the authenticated
routes.

Message attachments keep shipping their original bytes inline, which is the same
missing-variant problem on the signed domain and the reason a chat image feels slow today. It is
deliberately not in this change: that domain signs its URLs and its cache-key rules differ, so it
gets its own record.

`scripts/verify-oss-cdn.ts` takes `images_host` and an `image` probe (a styled URL, checked for an
anonymous 200 and an immutable cache policy rather than a byte hash, since the edge returns a
derivative), and adds two boundary
probes: the attachment key requested unsigned from the image domain, and the image key requested
from the attachment domain with valid signing material. The first is the one that proves the
public domain cannot reach private user files.

ADR 0006 states that "neither domain is authorized to read the other's bucket". Per the Alibaba
Cloud documentation cited above, the same-account authorization is account-wide and read-only; the
isolation that actually holds is that each domain has exactly one configured origin bucket and
rewrites no path, so a request to one domain can never be answered from another bucket. The
runbook is corrected in this change; the ADR 0006 decision itself is unchanged.

## Validation and rollback

The acceptance gate in `scripts/verify-oss-cdn.ts` must pass before the image domain serves
product traffic: anonymous direct GETs of the exact OSS keys are still rejected, image CDN bytes
match the recorded SHA-256, the image response is public, immutable and cached for at least 30
days and carries no redirect, `Set-Cookie` or OSS hostname, and both new cross-domain probes
return a non-redirecting 4xx. Source-image protection, the retained `x-oss-process` parameter and
the domain's bandwidth cap are console evidence rather than behaviour probes; whether source-image
protection holds behind a CDN private-origin fetch (which is itself a signed request) must be
measured at provisioning, not assumed.

Rollback is unsetting `COFORGE_IMAGE_DELIVERY_URL` and `COFORGE_IMAGE_OSS_BUCKET`: URLs revert to
the authenticated routes on the next response, and the objects are read from whichever bucket they
were copied back into. Already-published image URLs stay readable until the domain is removed.
