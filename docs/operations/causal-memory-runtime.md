# Causal Memory runtime operations

This runbook delivers W1-B of the approved [Causal Memory plan](../implementation-slices/causal-memory-parallel-plan.md). It applies to one deployment environment. The only runtime is the private `causal-memory` Rust HTTP service; it has one persistent SQLite volume and no Caddy route or host-public listener.

## Ownership and configuration

Web/backend is the only client of `http://causal-memory:9938` on the private `causal-memory` Docker network. Both Web replicas use that same internal DNS name. Neither browser code, `coforge-computer`, `coforge-daemon`, nor an Agent process receives any Causal Memory credential.

| Key | Consumer | Purpose | Secret? |
| --- | --- | --- | --- |
| `COFORGE_CAUSAL_MEMORY_IMAGE` | deployment Compose | immutable `registry/repository@sha256:...` runtime image | no |
| `COFORGE_CAUSAL_MEMORY_URL` | Web server | private runtime base URL; default `http://causal-memory:9938` | no |
| `COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE` | Web server | mounted tenant-token map used when Web authenticates a Workspace request | yes |
| `CAUSAL_MEMORY_TOKENS_FILE` | runtime | same mounted map; upstream-compatible bearer-token-to-tenant map | yes |
| `CAUSAL_MEMORY_DISTILL_MODEL_API_KEY_FILE` | runtime | W1-A extension’s server-owned distillation-model credential | yes |

The tenant-token secret is a JSON object mapping a bearer token (or an allowed `sha256:<hex>` token representation) to a tenant name. It is created outside Git, stored as a Docker secret, mode `0400`, and never logged, copied into `.env`, passed on a command line, or injected into a browser, Daemon, or Agent. The W1-A extension must consume the model-key file directly; it must not print it or turn it into a command argument.

`infra/staging/docker-compose.yml` intentionally omits `web.depends_on.causal-memory`: Causal Memory is availability-isolated. An unavailable runtime must put memory work into the Web-owned retry/ledger path and serve group chat normally (`memory-degraded`); it must not block message persistence, delivery, or Caddy readiness.

## Resource and network envelope

The production-shaped Compose service is limited to **1 CPU** and **1 GiB RAM**. It has `no-new-privileges`, drops Linux capabilities, writes only its `coforge_staging_causal_memory_data` volume plus a temporary filesystem, and joins only the internal `causal-memory` bridge. Caddy is not connected to that bridge and its Caddyfile has no Causal Memory route.

Capacity review starts when sustained memory use exceeds 70% of the limit, readiness failures repeat, SQLite volume use reaches 70%, or the runtime queue/latency violates the memory-ingest SLO. Do not scale this service horizontally: one environment has one SQLite-owning runtime. Raise its reviewed limits or perform a controlled replacement/restore instead.

## Build and pin procedure

The source checkout is read-only for W1-B: `/home/zhoujie22/river2_0/causal-memory`. The source baseline is fixed in [`docs/causal-memory-build-manifest.json`](../causal-memory-build-manifest.json): `9657b2414ce7c56047d8273c9c0c8ebaf63985ee`. `infra/causal-memory/Dockerfile` uses that checkout as its build context and labels both the reviewed base and the extension revision. It contains no secrets.

Before W1-A has merged, verify the local checkout is exactly the reviewed base:

```sh
checkout=/home/zhoujie22/river2_0/causal-memory
base=9657b2414ce7c56047d8273c9c0c8ebaf63985ee
[ "$(git -C "$checkout" rev-parse HEAD)" = "$base" ]
git -C "$checkout" diff --quiet
docker build \
  --build-arg "CAUSAL_MEMORY_REVIEWED_COMMIT=$base" \
  --build-arg "CAUSAL_MEMORY_EXTENSION_REVISION=$base" \
  --file infra/causal-memory/Dockerfile \
  --tag coforge-causal-memory:reviewed-9657b24 \
  "$checkout"
```

This local tag is only a development skeleton; it is not a staging or production identity. Publish a reviewed image and set `COFORGE_CAUSAL_MEMORY_IMAGE` to its immutable digest before a shared deployment.

After W1-A is complete, check out the reviewed `coforge/v1-extension` merge commit in that source checkout. Require the reviewed base to be an ancestor, require a clean tree, substitute the merged commit for `CAUSAL_MEMORY_EXTENSION_REVISION`, publish one digest, and record that digest plus the extension commit in release evidence. Do **not** change `reviewedCommit` merely because a newer upstream `main` exists. Updating the upstream base requires a separately reviewed manifest change.

## Initial provisioning and routine checks

1. Create `infra/staging/secrets/coforge_causal_memory_tenant_tokens` and `infra/staging/secrets/coforge_causal_memory_distill_model_api_key` from the approved secret manager. Set the secrets directory to `0700` and files to `0600`; never place their values in GitHub workflow output, `.env`, shell history, Docker labels, or logs.
2. Set the staging GitHub Environment variable `COFORGE_CAUSAL_MEMORY_IMAGE` to the exact image digest. Set the two corresponding GitHub Environment secrets so the deployment workflow can atomically write the Docker secret files.
3. Deploy with the normal staging release workflow. Compose checks the image reference is a digest, starts one `causal-memory` service, and waits for both `/healthz` and `/readyz`.
4. Confirm from the deployment host only: `docker compose -p coforge-staging -f infra/staging/docker-compose.yml ps causal-memory`. Do not publish port 9938 and do not add a Caddy route.
5. Verify the backend reports memory-degraded rather than a chat outage if the runtime is deliberately stopped in a non-production drill. Restore it and confirm the ingest ledger/retry worker resumes pending memory work.

`/healthz` proves the process is live; `/readyz` includes a SQLite probe and is the readiness gate. Health endpoints disclose no tenant data and remain unauthenticated by upstream design; all evidence and causal requests remain tenant-authenticated.

## Encrypted, application-consistent snapshot schedule

The SQLite volume is part of the Causal Memory data boundary and must be backed up daily, before an image replacement, and before any destructive recovery. The backup controller is an external, least-privilege host job or managed backup system—not a Web request, Agent action, or container startup hook. It must retain backup audit metadata (snapshot ID, source image digest, extension revision, volume identifier, UTC start/end, encryption-key identifier, checksum, and outcome) but never tenant data, tokens, model credentials, request bodies, or raw command output.

For each run:

1. Announce the bounded maintenance window and verify Web is operating in `memory-degraded` mode; normal group chat remains available.
2. Serialize with deployment/restore work. Stop the one runtime cleanly and wait until it is no longer running; this prevents a WAL or sidecar file from changing during capture.
3. Capture the complete `/data` volume, including `causal-memory.sqlite`, SQLite `-wal`/`-shm` files if present, and tenant databases. Because the writer is stopped, this is an application-consistent snapshot.
4. Encrypt the archive at the backup boundary with the approved KMS envelope key; integrity-protect it and store it in the private backup location with retention/immutability policy. Encryption keys are accessed by the backup controller’s identity, never by `docker compose`, runtime environment, or command arguments.
5. Record the ciphertext checksum and metadata, securely erase the plaintext staging copy, restart the same runtime, and require `/healthz` then `/readyz` before ending the maintenance window.
6. At least quarterly, restore one snapshot into an isolated recovery volume and execute the tenant-isolation smoke described below. A backup is not accepted merely because archive upload succeeded.

No live filesystem copy, raw volume copy while the runtime is running, or unencrypted SQLite artifact is a valid snapshot.

## Recovery and internal endpoint cutover

Use this exact order after data loss, failed image upgrade, or a failed SQLite integrity/readiness check:

1. Declare `memory-degraded`; stop memory ingestion/retries only. Do not stop Caddy, Web, Centrifugo, PostgreSQL, or chat traffic.
2. Select a backup by its recorded source digest, extension revision, ciphertext checksum, and timestamp. Verify the encrypted artifact integrity before decrypting into a protected temporary location.
3. Stop the failed `causal-memory` service. Preserve its volume read-only for investigation; never overwrite it in place.
4. Create a fresh recovery volume and restore the complete decrypted `/data` tree into it. The privileged backup controller removes the plaintext staging files immediately after the restore copy completes.
5. Start one replacement runtime on the private `causal-memory` network against the recovery volume, using the same reviewed image family and Docker secret mounts. Do not run the old and restored runtimes simultaneously against one volume.
6. Require `GET /healthz` and then `GET /readyz` to succeed. Run SQLite `PRAGMA integrity_check` for the default and every tenant database from the replacement container; any non-`ok` result aborts cutover.
7. Run the tenant-isolation smoke through the Web server’s internal Causal Memory test seam. It must use two pre-provisioned smoke tenants whose credentials are read from the mounted secret file in-process (never rendered into curl headers, environment dumps, logs, or command arguments): write/query a unique fixture per tenant and prove each tenant cannot retrieve the other fixture. Confirm the smoke cleanup leaves no fixture evidence.
8. Only after health, readiness, integrity, and isolation pass, bind the private `causal-memory` DNS service name to the replacement runtime (or replace the Compose service with the recovery volume) and roll Web replicas so `COFORGE_CAUSAL_MEMORY_URL` resolves to that internal endpoint. Verify both replicas target the same replacement runtime.
9. Re-enable memory retry/ingest work, monitor for duplicate-safe ledger replay, and retain the failed volume and restore evidence for the approved incident-retention period before deletion.

Never cut over solely on container start, `/healthz`, or an archive checksum. Readiness, SQLite integrity, and two-tenant isolation are all required. There is no browser or public-endpoint cutover.

## Opt-in live-LLM smoke

The live smoke is not part of `mise run test`. It requires a disposable tenant that is never a production Workspace mapping, plus:

| Variable | Purpose |
| --- | --- |
| `COFORGE_CAUSAL_LIVE_SMOKE=1` | explicit opt-in |
| `COFORGE_CAUSAL_MEMORY_URL` | private runtime base URL |
| `COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE` | token→tenant map (values are never printed) |
| `COFORGE_CAUSAL_LIVE_SMOKE_TENANT` | disposable tenant name in that map |

```sh
COFORGE_CAUSAL_LIVE_SMOKE=1 \
COFORGE_CAUSAL_MEMORY_URL=http://127.0.0.1:9938 \
COFORGE_CAUSAL_MEMORY_TENANT_TOKENS_FILE=/run/secrets/coforge_causal_memory_tenant_tokens \
COFORGE_CAUSAL_LIVE_SMOKE_TENANT=smoke-tenant \
bun apps/web/scripts/causal-memory-live-smoke.ts
```

The script checks `/readyz`, writes one identified PublicChannel-shaped turn, explicitly distills it, and requires a grounded search hit on the distilled body. On success it prints only `causal live smoke passed`. After a pass, delete the disposable tenant store (or restore from the last accepted snapshot) before the next shared-environment use.

Local evidence (2026-09-21): debug `causal-memory http` on `127.0.0.1:19938` with a disposable `smoke-tenant` token map under `/tmp/coforge-causal-smoke` printed `causal live smoke passed`. This is not production promotion evidence; a shared environment still needs the reviewed image digest and the dedicated smoke tenant cleanup above.

## Review gates

Before proposing a commit or PR, run in the Coforge worktree:

```sh
mise run test
mise run check
mise run build
```

Separately, on the pinned Causal Memory checkout (`docs/causal-memory-build-manifest.json` → `reviewedCommit` `9657b24`, patch branch `coforge/v1-extension`):

```sh
cargo test --manifest-path crates/causal-memory-cli/Cargo.toml coforge
cargo test --manifest-path crates/causal-memory/Cargo.toml coforge
```

Independent Standards and Spec review is against [ADR 0058](../adr/0058-causal-memory-workspace-tenant.md) and the [implementation plan](../implementation-slices/causal-memory-parallel-plan.md).
