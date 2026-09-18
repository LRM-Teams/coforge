# ADR 0048: The rollback unit is the release, not the image

Status: accepted
Date: 2026-09-18

## Context

On 2026-09-18, PR #407 and PR #409 each independently added a top-level
`websocket:` key to `infra/centrifugo/config.yaml` and
`infra/staging/centrifugo/config.yaml`, raising the message size limit for a
different reason in each PR. Merged together, both files carried two
top-level `websocket:` mappings. Centrifugo v6.9.2 validates its
configuration on start and refuses to run against it - see
["Configuration" in the Centrifugo docs](https://centrifugal.dev/docs/server/configuration):
"Centrifugo validates configuration on start, in case the configuration is
invalid server exits with code 1" - and exited with:

```
yaml: unmarshal errors: line 29: mapping key "websocket" already defined at line 14
```

(`websocket.message_size_limit` is documented at
[centrifugal.dev/docs/transports/websocket](https://centrifugal.dev/docs/transports/websocket),
default 65536; both PRs raised it, which is why both touched the same key.)

The staging deploy workflow (`deploy-staging.yml` run 35324267912) shipped
this file, `compose up -d --wait` recreated the live Centrifugo container
straight into that exit, and health failed. Automatic rollback then also
failed, because `remote-deploy.sh` only ever restored `COFORGE_WEB_IMAGE` -
the web image digest - and reset it with `compose up -d --wait web`. Nothing
recorded or restored the Compose file, Caddyfile, or Centrifugo configuration
that were live before the deploy overwrote them, and `compose up ... web`
does not even recreate Centrifugo. The bad configuration stayed on disk and
Centrifugo stayed down until a human intervened (fix #416).

The deploy workflow's "Copy deployment assets" step (`deploy-staging.yml`)
untars `infra/staging/docker-compose.yml`, `infra/staging/caddy/Caddyfile`,
and `infra/staging/centrifugo/config.yaml` onto the host's live paths
*before* `remote-deploy.sh` runs. By the time any check could run, the
previous good copy of those files was already gone from disk. A rollback
that only restores the image digest cannot recover from this class of
failure: the regression is in a file, not in the image.

## Decision

The unit of rollback is the last healthy **release**: the exact image digest
plus the Compose file, Caddyfile, and Centrifugo configuration that were live
the last time `remote-deploy.sh` recorded a healthy deployment - not the
image digest alone.

1. **Validate the Centrifugo configuration with the binary that will run it,
   in two places, before anything is recreated:**
   - A CI gate, `scripts/deploy/check-centrifugo-config.sh`, reads the exact
     digest-pinned `centrifugo/centrifugo` image reference out of
     `infra/staging/docker-compose.yml` and runs that image's own
     `centrifugo checkconfig -c FILE` subcommand against both
     `infra/centrifugo/config.yaml` and `infra/staging/centrifugo/config.yaml`.
     It is wired into `check:deploy`, so a duplicate key like this one fails
     a pull request instead of a deployment.
   - A host pre-flight in `remote-deploy.sh` runs the same `checkconfig`
     subcommand, through the pinned image, against the file the workflow
     just shipped to the host - after the existing `compose config --quiet`
     check and before anything is recreated. The pinned Centrifugo image is
     pulled explicitly first with its own failure reason
     (`failed: Centrifugo image pull failed`), so a registry problem is never
     reported as a configuration problem. This catches a configuration that
     only breaks in the shipped-and-rendered form, not only what CI saw at
     commit time.
2. **Snapshot the release, not just the digest.** Immediately before
   `remote-deploy.sh` records a deployment healthy, it copies
   `docker-compose.yml`, `caddy/Caddyfile`, and `centrifugo/config.yaml` into
   `$REMOTE_ROOT/last-healthy/`, written atomically (temp directory, then
   swapped into place) and mode 700.
3. **Restore the release, not just the digest, on rollback.** When a
   snapshot exists, rollback restores those files into their live paths,
   recomputes `COFORGE_CENTRIFUGO_CONFIG_SHA256` from the restored file so
   Compose's change detection actually recreates Centrifugo, and runs
   `compose up -d --wait` for every service - not only `web` - because Caddy
   does not depend on `web` and would never pick up a restored Caddyfile
   otherwise, and a Centrifugo configuration change only takes effect when
   Centrifugo itself is recreated.

## Rejected alternatives

- **Only add the CI gate.** Catches this specific incident's root cause but
  not every path: the workflow could still ship a file CI never saw
  validated together with the exact digest the host currently trusts, and it
  does nothing for a Caddyfile or Compose file regression. The host
  pre-flight and the snapshot/restore are still needed.
- **Only add the host pre-flight, no CI gate.** Would have caught this
  incident too, but only after the bad file already reached the host and
  failed once; a pull request should not have to reach staging to discover a
  duplicate YAML key.
- **Snapshot the whole `$REMOTE_ROOT` tree.** Broader than necessary; the
  three files that are both shipped by the workflow and read by Compose at
  `up` time are the ones a configuration regression can hide in. Secrets and
  volumes are not part of what a "healthy release" checkpoint needs to
  restore.

## Consequences

- A duplicate or otherwise invalid Centrifugo configuration now fails a pull
  request (`check:deploy`) or, failing that, fails closed on the host before
  any service is recreated, instead of taking down the live Centrifugo
  container.
- Rollback after a configuration regression restores the working Compose
  file, Caddyfile, and Centrifugo configuration together with the image,
  instead of leaving the bad file in place with a reverted image.
- The first deployment after this change ships with no `last-healthy`
  snapshot yet. Its rollback path (if needed) falls back to today's
  image-only restore and prints `no last healthy release snapshot; rolling
  back the image only` to stderr rather than silently doing less than it
  looks like it does. The very next healthy deployment establishes the
  snapshot for all rollbacks after it.
- `state.env` is unchanged: it still records only the image digest. The
  release snapshot is a separate, host-local checkpoint, not part of the
  audited release identity.
- `check:deploy` now depends on the pinned Centrifugo image being pullable
  from the registry on an ephemeral CI runner, not only on the local Compose
  configuration being valid. `scripts/deploy/check-centrifugo-config.sh`
  reports that failure with its own message (`could not be pulled; refresh
  the digest in ...`), distinct from a configuration failure, so a stale pin
  and a bad config are never reported as the same thing. Discovered while
  validating this change: the `v6.9.2` digest pinned since PR #41 no longer
  resolved against Docker Hub (the tag had been re-published), so this change
  refreshes the pin in `infra/staging/docker-compose.yml` to the current
  `v6.9.2` manifest-list digest. The next staging deploy pulls that image and
  recreates Centrifugo with it.

## Validation and rollback criteria

- `scripts/deploy/deployment.test.ts` covers: a Centrifugo configuration the
  pinned image rejects stops the deployment before `pull` or `up` runs and
  leaves `state.env` untouched; a rollback with a snapshot restores the
  Centrifugo configuration and recomputes its SHA-256 before bringing the
  whole project back up; a healthy deployment records the shipped
  configuration as the new snapshot; the pre-existing bootstrap and
  image-only-rollback paths are unchanged when no snapshot exists.
- `scripts/deploy/check-centrifugo-config.sh` was run locally against both
  configuration files with Centrifugo v6.9.2 and against a copy with a
  duplicated `websocket:` key, confirming pass and fail respectively (see the
  PR description for the exact commands and output). The run used the refreshed
  `v6.9.2` manifest-list digest now pinned in
  `infra/staging/docker-compose.yml` (see Consequences).
- Rollback criterion: reverting this change returns to image-only rollback,
  which is safe (if incomplete) for an image regression and only reintroduces
  the gap this ADR closes for a configuration regression.
