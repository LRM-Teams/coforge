# Feed hosting and installation entry points

The feed is served beneath `https://releases.coforge.cn/` from a private
release bucket. Attachments and releases use two separate accelerated domains: `releases.coforge.cn`
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
