# Deploy the realtime gateway to Aliyun ECS

This runbook deploys the first CoForge test environment onto the ECS host that
already runs Multica. CoForge uses its own rootless Docker daemon and Compose
project. It shares only the existing Caddy listener on port 443; it does not
join Multica's Compose project, Docker network, volumes, container names, or
application ports.

A push to `main` tests the repository, builds the gateway image once, pushes it
to GHCR under the commit SHA, records its immutable digest, deploys that digest
to `test`, verifies `GET /coforge/readyz` over trusted public HTTPS, and proves
that `/coforge/v1/connect` completes a WSS upgrade. A later production
environment must promote the same digest rather than rebuild it.

## Isolation and security model

- CI logs in as the dedicated `deploy` user. The account has no password,
  `sudo`, or membership in the host's `docker` group.
- `deploy` runs a rootless Docker daemon. Membership in the host `docker` group
  is deliberately forbidden because access to the rootful Docker socket is
  root-equivalent and could affect Multica.
- The CoForge container is non-root, drops all capabilities, has a read-only
  root filesystem, and receives no host volume mounts.
- The rootless port binds only to the host-side address reachable from the
  existing Caddy container. The ECS security group must not expose port 18180.
- The ECS security group must not expose TCP port 80. Public HTTP must fail to
  connect rather than redirect; 443 is the only public web ingress. The
  workflow verifies this directly from the deployment runner.
- SSH uses a deployment-only key and a trusted pinned host key. Password and
  root SSH are not supported by the workflow.
- The deploy job runs only on a dedicated runner labelled
  `coforge-test-deploy` in the repository-restricted `coforge-deploy` runner
  group, with a stable egress IPv4. Keep this runner outside the target ECS and
  its private VPC path so its HTTPS/WSS/TCP probes exercise the public IP.
  Port 22 permits only that `/32`; do not
  allowlist GitHub-hosted runners' broad, changing IP ranges.
- The existing Caddy configuration is never replaced. An administrator adds
  one reviewed import, validates the complete configuration with the running
  Caddy image, and performs a graceful reload with a tested rollback.

## One-time rootless Docker provisioning

An administrator performs these steps. The commands shown target the Ubuntu
`docker.io` packaging already present on the first ECS host; use the equivalent
official package procedure on a different distribution.

1. Create `deploy` with a locked password and install the CI public key in
   `/home/deploy/.ssh/authorized_keys`. Keep `.ssh` mode `0700` and the file
   mode `0600`, both owned by `deploy`.
2. Install the rootless prerequisites from the configured Ubuntu repositories:

   ```sh
   apt-get update
   apt-get install --yes uidmap rootlesskit dbus-user-session
   loginctl enable-linger deploy
   ```

   Confirm `/etc/subuid` and `/etc/subgid` each assign at least 65,536 IDs to
   `deploy`.
3. Ubuntu installs the rootless helpers under the package's `contrib`
   directory. Add stable command links, open a login shell as `deploy`, then
   install and start the rootless daemon:

   ```sh
   ln -s /usr/share/docker.io/contrib/dockerd-rootless.sh /usr/local/bin/dockerd-rootless.sh
   ln -s /usr/share/docker.io/contrib/dockerd-rootless-setuptool.sh /usr/local/bin/dockerd-rootless-setuptool.sh
   su - deploy
   dockerd-rootless-setuptool.sh install --force
   systemctl --user enable --now docker
   docker info
   ```

   `docker info` must list `rootless` under Security Options. Do not add
   `deploy` to the `docker` group. Rootless Docker's own user service is the
   only new systemd unit; CoForge applications remain Compose-managed. Also
   verify `docker compose version`; install the distribution's Compose plugin
   if that command is unavailable.
4. Determine an address on the host that the existing Caddy container can
   reach but the public network cannot. On the first host this is the gateway
   of Caddy's existing Docker network. Record it as the GitHub `test`
   Environment variable `ECS_EDGE_BIND_IP`. Confirm the rootless daemon can
   publish `ECS_EDGE_BIND_IP:18180` before enabling deployment.

## Static-egress deployment runner

Provision a dedicated Linux x86-64 GitHub Actions runner outside the ECS host,
put it in a `coforge-deploy` runner group restricted to this repository, give
it the custom label `coforge-test-deploy`, and assign it a stable egress IPv4.
The runner needs the normal SSH client, `curl`, and Python 3; the ECS deploy
user also needs standard `flock` and `sha256sum` utilities. The runner receives the test
Environment secrets at job time, and the workflow removes its temporary SSH
directory in an `always()` cleanup step. Restrict the ECS security group's port
22 rule to this runner's `/32`. Keep the runner patched and unavailable to fork
pull requests or unrelated workflows.

The build job remains on `ubuntu-latest`; only the deploy job uses this runner.
This avoids granting a large, changing GitHub-hosted address range SSH access
to the shared Multica host.

## Additive Caddy route

The current Caddy container owns ports 80 and 443 and mounts the Multica
Caddyfile read-only. An administrator, not `deploy`, performs this one-time
shared-edge change:

1. Back up the live Multica Caddyfile and Caddy data volume.
2. Copy [`deploy/ecs/Caddyfile`](../../deploy/ecs/Caddyfile) into the existing
   persistent Caddy data volume as `/data/coforge.caddy` inside the container.
3. Merge `default_sni <public-ipv4>` into the live Caddyfile's existing global
   options block. If it has no global block, create the single global block at
   the start of the file. Caddy permits only one global options block, so do not
   add a second one.
4. Import the site fragment after the global block, substituting the verified
   public and internal addresses:

   ```caddyfile
   import /data/coforge.caddy <public-ipv4> <edge-bind-ip>
   ```

5. Run validation with the exact running Caddy image, then gracefully reload:

   ```sh
   docker exec multica-caddy caddy validate --config /etc/caddy/Caddyfile
   docker exec multica-caddy caddy reload --config /etc/caddy/Caddyfile
   ```

6. Verify every existing Multica health route after the reload. Before the
   first CoForge container exists, `/coforge/readyz` may return `502`; confirm
   only that the new route is selected and that existing routes remain healthy.
   The deployment workflow performs the first required `200` check without
   `--insecure` after Compose starts the gateway. If validation, reload, or an
   existing application's verification fails, restore the backup and reload it
   immediately.
7. Remove any public ingress rule for TCP port 80 and confirm from outside the
   VPC that `http://<public-ipv4>/` cannot connect. Keep 443/tcp as the only
   public web ingress; do not weaken this to provide an HTTP redirect.

The fragment uses Let's Encrypt's `shortlived` ACME profile for an IP
certificate. Caddy currently marks ACME profile selection experimental. Keep
the Caddy data volume persistent, monitor renewal, and replace the IP endpoint
with the approved domain after DNS and ICP setup without changing image data.

## GitHub `test` environment

Restrict the `test` Environment to `main` and configure:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `ECS_HOST` | Public IPv4 address; routing data, not a credential |
| Secret | `ECS_SSH_USER` | `deploy` |
| Secret | `ECS_SSH_PRIVATE_KEY` | Deployment-only private key |
| Secret | `ECS_SSH_HOST_KEY` | Trusted complete `known_hosts` line |
| Variable | `ECS_EDGE_BIND_IP` | Host-side address reachable by Caddy only |
| Variable | `ECS_SHARED_INGRESS_HEALTH_PATH` | Existing non-CoForge HTTPS health path, beginning with `/` |

`ECS_HOST` must be a globally routable IPv4 address. If it was previously
stored as a Secret, create the Variable first, verify that the workflow reads
the Variable, and then remove the obsolete Secret; the public address is
routing data rather than a credential.

The build job publishes with the repository-scoped `GITHUB_TOKEN`. The deploy
job pipes that same short-lived workflow token over the pinned SSH connection
to `docker login --password-stdin`, pulls immediately, and never places the
token in a command argument or log. Never write it to the repository, Issue
comments, or chat.

### SSH key and host-key rotation

Rotate the deployment key with an overlap so a failed update cannot lock out
CI:

1. Generate a new deployment-only key and add its public half as a second line
   in `~deploy/.ssh/authorized_keys` through the ECS administrative console.
2. Replace `ECS_SSH_PRIVATE_KEY` in the `test` Environment, trigger a deployment,
   and confirm the pinned SSH connection and all health gates pass.
3. Remove the old public key from `authorized_keys`. Securely destroy the old
   private key and record the rotation owner/date outside the repository.

When the ECS SSH host key legitimately changes, obtain the new fingerprint
from the ECS console, update `ECS_SSH_HOST_KEY`, verify one deployment, then
retire the old line. A mismatch without an approved rotation is an incident;
never bypass it with `StrictHostKeyChecking=no` or an unverified
`ssh-keyscan` result.

## Deployment and rollback behavior

The workflow drives one transactional remote deployment seam:

```text
COFORGE_DEFER_COMMIT=true compose_release.sh \
  ghcr.io/lrm-teams/coforge-realtime-gateway@sha256:<digest>
compose_release.sh --commit
compose_release.sh --rollback
compose_release.sh --finalize-rollback
compose_release.sh --record-failed-rollback
```

It rejects root, a rootful Docker daemon, and mutable tags; pulls the requested
digest; starts the isolated `coforge-test` Compose project; waits for the
container healthcheck; and checks the internal `/readyz` route. The candidate
remains pending until the workflow verifies public IP HTTPS, a WSS `101`
upgrade, an existing shared ingress route, and the running container's exact
image reference, then invokes `--commit`. All network probes use bounded connect
and total timeouts. No candidate becomes `current-image` before all those
checks pass.
An internal or external failure restores and verifies the previously recorded
digest with its previous Compose definition, then `--finalize-rollback` writes
the durable rollback outcome. If the first deployment has no previous digest,
rollback stops the Compose project instead of leaving an unverified container
running. Each healthy deployment and completed rollback appends a redacted
JSONL release record under the deploy user's application state directory.
The workflow also uploads that redacted history as a 90-day run artifact. A
rollback that cannot be verified records `failed_rollback` and retains its
pending recovery files for operator diagnosis.

If an interruption audit itself cannot be appended, the controller exits 74,
retains the staged evidence, and creates `pending-audit-write-failed`. Every
successor operation then fails closed. Restore writable storage and escalate
with the retained files; do not delete the marker or start another release
until the missing interrupted outcome has been reconstructed in the JSONL
history. An `.pre-marker-active` sentinel left by hard process or host loss is
handled by the same fail-closed rule and must be investigated rather than
discarded when no formal `pending-image` exists. If the formal marker and all
sidecars were already published, a successor removes only the stale active
sentinel and resumes the normal adopt/rollback/finalize path.

Compose uses Docker's `local` logging driver with bounded rotation. Inspect
runtime logs with `docker compose --project-name coforge-test logs gateway`;
never add secrets to application environment variables or image layers.

Manual rollback uses the transaction's recorded previous healthy digest; do
not edit Compose state, pass an arbitrary image, or use `latest`:

```sh
COFORGE_EDGE_BIND_IP=<internal-address> \
  ~/.local/share/coforge/realtime-gateway/compose_release.sh \
  --rollback
```

`--rollback` creates a pending manual transaction without rewriting the
recorded current/previous digests. Repeat container, internal, public HTTPS,
public WSS, shared-ingress, TCP/80-closed, and running-digest verification.
The TCP gate is an actual connect probe, not an HTTP response check:

```sh
curl --fail --proto '=https' --tlsv1.2 --connect-timeout 5 --max-time 20 \
  https://<public-ip>/coforge/readyz
python3 scripts/deploy/wss_smoke.py \
  wss://<public-ip>/coforge/v1/connect --timeout 10
curl --fail --proto '=https' --tlsv1.2 --connect-timeout 5 --max-time 20 \
  https://<public-ip>/<existing-shared-health-path>
python3 scripts/deploy/tcp_closed.py <public-ip> 80 --timeout 5
ssh -F <pinned-ssh-config> coforge-ecs \
  'export XDG_RUNTIME_DIR=/run/user/$(id -u); \
   export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock; \
   docker compose --project-name coforge-test \
     --file ~/.local/share/coforge/realtime-gateway/compose.yaml \
     ps --quiet gateway'
```

Resolve that container with `docker inspect --format '{{.Config.Image}}'` and
compare it byte-for-byte with `compose_release.sh --rollback-target-image`.
Run the public probes from the same external static-egress runner, not from the
ECS host or its private network.

For a non-empty target, finalize only after every result above passes:

```sh
COFORGE_PUBLIC_HEALTH_RESULT=passed \
COFORGE_SHARED_INGRESS_HEALTH_RESULT=passed \
COFORGE_WSS_HEALTH_RESULT=passed \
COFORGE_TCP80_RESULT=passed \
COFORGE_RUNNING_DIGEST_RESULT=passed \
  ~/.local/share/coforge/realtime-gateway/compose_release.sh \
  --finalize-rollback
```

For an empty-state target, set the public, WSS, and running-digest results to
`not-applicable`; shared ingress and TCP/80-closed must still be `passed`.
Only successful finalization atomically switches the authoritative
`release-state` manifest, whose digest pair references immutable Compose
generations, and appends the durable `rolled_back` outcome. Compatibility
`current-image`/`previous-image` files are views, not transaction pointers.
Every mode takes the same host lock, and a CI-owned pending transaction can be
continued only with its matching owner token; a manual command cannot consume
it.
Before activating a new `main` candidate, the workflow uses the same recovery
helper to detect, adopt, verify, and finalize a transaction left by an earlier
runner loss. After successful recovery, the successor run continues deploying
its own already-built digest instead of silently dropping that `main` commit.
When rollback restores the verified pre-deployment empty state, the absent
CoForge public/WSS/running-image checks are recorded explicitly as
`not-applicable`; shared ingress must still pass. If any applicable rollback
check fails, run `--record-failed-rollback` and escalate with the retained
pending evidence; never mark the target healthy manually.

## Future production promotion

Do not create a long-lived `dev` branch. When a separate production environment
exists, promote the exact digest already verified in `test` through a manually
approved GitHub Environment deployment. Production must not check out or
rebuild the commit. Keep environment secrets, Compose project names, databases,
domains, concurrency locks, and deployment records separate.

## References

- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
- [Docker Compose in production](https://docs.docker.com/compose/how-tos/production/)
- [Compose service healthchecks](https://docs.docker.com/reference/compose-file/services/)
- [Compose trust model](https://docs.docker.com/compose/trust-model/)
- [GitHub publishing Docker images](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub-hosted runner networking](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
- [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)
- [Caddy `tls` directive](https://caddyserver.com/docs/caddyfile/directives/tls)
- [Let's Encrypt IP certificate availability](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability.html)
