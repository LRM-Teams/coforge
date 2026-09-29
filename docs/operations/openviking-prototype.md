# OpenViking prototype runtime operations

> **NON-PRODUCTION / LICENSE-REVIEW-REQUIRED**
>
> The local OpenViking source is AGPL-3.0 and has **not** received project-level
> approval for a distributable product integration (ADR 0060, retired to git
> history with the repository's ADR directory;
> approval ledger `AGPL license / shipping` is still **pending** and user-owned).
> This runbook is an isolated, synthetic-data-only prototype. It is not a
> release, staging, or production procedure. Do not add OpenViking to default
> Compose, release manifests, staging, or production. Do not present this
> runtime as a shippable CoForge capability.

This runbook delivers I1 of the
historical OpenViking + Causal Memory profiles plan (retired to git history with the repository's
implementation slices), superseded by [OpenViking channel memory](../memory/openviking.md).
It applies to one local development machine. The only added runtime is the
private `openviking-prototype` HTTP service declared in
[`infra/compose.openviking-prototype.yml`](../../infra/compose.openviking-prototype.yml).

Pinned inventory (D3): OpenViking
`e44ea6e11add1c7b3d4accdbfaf16e900a6049df`
([interface inventory](../research/openviking-prototype-interface-inventory.md)).
Bump that pin only with a new inventory, not a silent `main` follow.

Verified image for I1/V1.4/F6: that pin **plus** a local-embed extension layer
built from
[`infra/docker/openviking-prototype-local-embed.Dockerfile`](../../infra/docker/openviking-prototype-local-embed.Dockerfile)
(adds `llama-cpp-python` and a compile toolchain; does not patch OpenViking
source). Tag the result locally; do not substitute an official hosted
`:latest`.

This runbook records the **verified** prototype envelope (2026-09-22), not the
earlier I1 draft assumptions. Compose `secrets.mode: 0400` does not take
effect; the Docker prototype network is **not** `internal: true`; embedding
models are host-downloaded and bind-mounted. See the secrets, network, and
warmup sections below. This is still not a release procedure.

## What this override does not do

- It does **not** change [`infra/docker-compose.yml`](../../infra/docker-compose.yml),
  [`infra/docker-compose.centrifugo.yml`](../../infra/docker-compose.centrifugo.yml),
  [`infra/staging/docker-compose.yml`](../../infra/staging/docker-compose.yml),
  Caddyfiles, or any release manifest.
- It does **not** declare a Caddy service or a public reverse-proxy route.
- It does **not** start when you run the default Compose project.
- It does **not** accept production Workspace data, production credentials, or
  non-synthetic fixtures.

Web/backend remains the only intended client, through the later deny-by-default
policy gateway. Browsers, `coforge-computer`, `coforge-daemon`, Agent processes,
and CLI arguments must never receive OpenViking administration credentials.

## Default-off gates

Two independent gates keep the prototype off:

| Gate                           | Default                                                             | Enables                                                                                      |
| ------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Compose file + profile         | override file is unused; service has profile `openviking-prototype` | the container                                                                                |
| `OPENVIKING_PROTOTYPE_ENABLED` | unset / anything other than `1` or `true`                           | Web/backend prototype composition (`apps/web/src/server/workspace-memory/prototype-gate.ts`) |

Setting the Web flag without the Compose profile does not start OpenViking.
Starting the container without the Web flag must not enable production profile
behavior.

Official listen port is `1933`. Liveness is unauthenticated `GET /health`.
Readiness is unauthenticated `GET /ready` (AGFS, VectorDB, API key manager,
embedding, Ollama). Compose uses the image's `openviking-entrypoint --healthcheck`
(official Docker healthcheck).

## Ownership and secrets

| Key                                  | Consumer             | Purpose                                                                                                                 | Secret?   |
| ------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------- |
| `COFORGE_OPENVIKING_PROTOTYPE_IMAGE` | prototype Compose    | reviewed local tag built from D3 revision `e44ea6e` plus the local-embed Dockerfile                                     | no        |
| `OPENVIKING_PROTOTYPE_PORT`          | prototype Compose    | loopback publish; default `1933`                                                                                        | no        |
| `OPENVIKING_CONFIG_FILE`             | runtime              | path of the mounted ov.conf secret (`/run/secrets/openviking_prototype_ov_conf`)                                        | path only |
| `openviking_prototype_ov_conf`       | runtime              | host secret file: `auth_mode=api_key`, generated `root_api_key`, `storage.workspace=/data`, local AGFS/VectorDB         | **yes**   |
| `openviking_prototype_models/`       | runtime              | host-downloaded embedding weights bind-mounted to `/app/.cache/openviking/models`                                       | **yes**   |
| `COFORGE_OPENVIKING_URL`             | host-run Web (later) | `http://127.0.0.1:${OPENVIKING_PROTOTYPE_PORT:-1933}`                                                                   | no        |
| `OPENVIKING_PROTOTYPE_ENABLED`       | Web server           | application prototype gate                                                                                              | no        |

Create secrets outside Git. `infra/secrets/` is gitignored. Directory mode
`0700` on the host.

**Verified secret-file mode is `644`.** Compose `secrets.*.mode: 0400` (and the
current `0444` declaration) does **not** change the file mode inside the
container; the process sees the host file mode. A host-only `0600` file is
unreadable by the container user. Set the ov.conf file to `644` on the host
so the container can read it. Restrict the host directory (`0700`) and do
not put the file in a world-readable tree. Never put `root_api_key`, user
keys, or embedding provider keys in:

- this repository, fixtures, or example JSON
- Compose YAML, labels, or command arguments
- browser, Agent, or Daemon environment
- shell history, CI logs, or `docker compose config` pasted into chat with the
  real value still present

Do **not** use `OPENVIKING_CONF_CONTENT` or `OPENVIKING_ROOT_API_KEY` as
container environment values. Those would place credential plaintext in the
process environment.

`api_key` mode is the prototype default because the official image binds
`0.0.0.0` and refuses to start without `server.root_api_key`. Later gateway
work may run `trusted` mode behind CoForge; this skeleton does not enable
`dev` (unauthenticated) mode. Root keys cannot access tenant data APIs in
`api_key` mode — provision a disposable ADMIN/USER key after first boot.

## Resource and network envelope

The prototype service is limited to **2 CPU** and **2 GiB RAM**. It has
`no-new-privileges`, drops Linux capabilities, writes only
`coforge_openviking_prototype_data` plus a temporary filesystem, and joins the
`openviking` / `coforge_openviking_prototype` bridge. Caddy is not connected
to that bridge. The published port is `127.0.0.1` only and is not a public
route.

**Verified network: `internal: false`.** Docker cannot publish host ports on
an `internal: true` network, so the earlier I1 draft (`internal: true`)
blocked `127.0.0.1:1933` diagnostics and V1.4/F6. The override now uses a
non-internal bridge. Egress containment is **not** a Docker internal-network
guarantee; it is operational: local embedding (`llama-cpp` + preloaded
weights) and no remote LLM / embedding provider in ov.conf. Do not attach
Caddy or join `coforge_network`. Image pulls and model downloads happen on
the host; treat the container as offline for model fetch.

**Warmup:** after `up -d`, the process spends about **2–4 minutes** at full
CPU loading local embedding. `GET /health` may succeed before the service can
answer data-plane requests. Wait until the Compose healthcheck is healthy
**and** `/ready` reports embedding ready before V1.4, F6, or any
`/search/find`. Do not send traffic during warmup.

Capacity review starts when sustained memory exceeds 70% of the limit,
liveness/readiness failures repeat, or the volume reaches 70%. Do not scale
this service horizontally: one environment has one local-VectorDB runtime.

## Enable (explicit opt-in)

From the CoForge worktree, after the default Compose secrets already required
by [`infra/README.md`](../../infra/README.md) exist:

```sh
umask 077
mkdir -p infra/secrets
chmod 0700 infra/secrets

# Write ov.conf without printing the key. Replace the placeholder by generating
# it in the same redirected write; do not echo it.
python3 - <<'PY'
import json, os, secrets
path = "infra/secrets/openviking_prototype_ov_conf"
if os.path.exists(path):
    raise SystemExit(f"{path} already exists; refusing to overwrite")
doc = {
    "server": {
        "host": "0.0.0.0",
        "port": 1933,
        "auth_mode": "api_key",
        "root_api_key": secrets.token_hex(32),
    },
    "storage": {
        "workspace": "/data",
        "agfs": {"backend": "local"},
        "vectordb": {"backend": "local"},
    },
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(doc, fh, indent=2)
    fh.write("\n")
os.chmod(path, 0o644)
print("wrote ov.conf (root_api_key not printed)")
PY

# Host-download embedding weights. The container is treated as offline for
# model fetch; Compose bind-mounts this directory to
# /app/.cache/openviking/models.
mkdir -p infra/secrets/openviking_prototype_models
chmod 0700 infra/secrets/openviking_prototype_models
# Place the local-embed model files here on the host (do not commit them).

# Build the verified image: pinned e44ea6e base + local-embed layer
# (compile toolchain lives only in the Dockerfile build stage).
# Official hosted tags are not a substitute.
export COFORGE_CAUSAL_MEMORY_IMAGE="${COFORGE_CAUSAL_MEMORY_IMAGE:?set the default Compose image first}"
export COFORGE_OPENVIKING_PROTOTYPE_IMAGE="${COFORGE_OPENVIKING_PROTOTYPE_IMAGE:?set the local e44ea6e+local-embed tag}"

docker compose -p coforge \
  -f infra/docker-compose.yml \
  -f infra/compose.openviking-prototype.yml \
  --profile openviking-prototype \
  up -d openviking-prototype
```

Wait for warmup (about 2–4 minutes, CPU full) before any data-plane request.
Confirm from the development host only:

```sh
docker compose -p coforge \
  -f infra/docker-compose.yml \
  -f infra/compose.openviking-prototype.yml \
  --profile openviking-prototype \
  ps openviking-prototype

curl --fail --silent --show-error http://127.0.0.1:${OPENVIKING_PROTOTYPE_PORT:-1933}/health
# Require /ready after warmup. Do not treat a live /health as request-ready
# during the 2–4 minute CPU spike.
curl --fail --silent --show-error http://127.0.0.1:${OPENVIKING_PROTOTYPE_PORT:-1933}/ready
```

Do not publish port 1933 on `0.0.0.0`. Do not add a Caddy route. Do not open
`/studio` against anything except this synthetic instance.

A host-run Web server that later consumes the runtime uses
`COFORGE_OPENVIKING_URL=http://127.0.0.1:${OPENVIKING_PROTOTYPE_PORT:-1933}`
and `OPENVIKING_PROTOTYPE_ENABLED=1`. A containerized Web server would use the
internal DNS name `http://openviking-prototype:1933` only after a separately
reviewed network attachment; this override does not attach `web` or Caddy.

## Disable

Stop the prototype service without deleting the volume:

```sh
docker compose -p coforge \
  -f infra/docker-compose.yml \
  -f infra/compose.openviking-prototype.yml \
  --profile openviking-prototype \
  stop openviking-prototype
```

Remove the container but keep the volume:

```sh
docker compose -p coforge \
  -f infra/docker-compose.yml \
  -f infra/compose.openviking-prototype.yml \
  --profile openviking-prototype \
  rm -f openviking-prototype
```

Unset `OPENVIKING_PROTOTYPE_ENABLED` on Web. Default `docker compose -f infra/docker-compose.yml up`
must keep working without this override.

Deleting the volume is destruction of the synthetic workspace, not a profile
`off` transition. Profile `off` retains data (ADR 0060, retired to git history).

## First initialization

1. Create the ov.conf secret as above (`644` on the host). Do not add a remote
   embedding or LLM provider block. Local embedding uses the host-downloaded
   weights under `infra/secrets/openviking_prototype_models/`. Never put keys
   in Compose environment.
2. Set `COFORGE_OPENVIKING_PROTOTYPE_IMAGE` to the local tag built from
   `e44ea6e11add1c7b3d4accdbfaf16e900a6049df` plus
   `infra/docker/openviking-prototype-local-embed.Dockerfile`.
3. Start only `openviking-prototype` with the opt-in command above. Wait
   **2–4 minutes** for warmup, then require Compose healthy **and**
   `GET /ready` before any find/write/smoke.
4. Using a **root** key read from the secret file in-process (not pasted into
   argv), create one disposable synthetic account and an ADMIN user through
   typed admin APIs:
   - `POST /api/v1/admin/accounts` with `account_id` such as `synth-i1`
   - `POST /api/v1/admin/accounts/{account_id}/users/{user_id}/key` for the
     data-plane user
     Store issued user/admin keys in the same owner-only secrets directory.
     Official `api_key` mode: the root key cannot call tenant data APIs.
5. Do not reuse a real Workspace slug, production account, or production user
   id. Directory naming is not tenant isolation.

## Synthetic seed and cleanup

Only synthetic documents are allowed. Suggested disposable objects:

| Object                  | Synthetic value                                                   |
| ----------------------- | ----------------------------------------------------------------- |
| OpenViking account      | `synth-i1`                                                        |
| Admin / projection user | `synth-admin` / `synth-projector`                                 |
| Managed subtree         | `viking://resources/cm-projection/synth-i1/`                      |
| Fact document           | `viking://resources/cm-projection/synth-i1/facts/fact-synth-1.md` |

Seed (data-plane user or admin key, loaded in-process):

1. `POST /api/v1/fs/mkdir` for the managed subtree if needed.
2. `POST /api/v1/content/write` with synthetic markdown body, `wait=true` when
   an embedding backend can complete vector upsert, and tags
   `cm_fact=fact-synth-1`, `cm_ver=3`, `cm_gen=7`.
3. If vector upsert is unavailable, `POST /api/v1/content/set_tags` (or
   `POST /api/v1/fs/attrs/set_tags`) still records explicit `k=v` tags for
   the filesystem half of the C4 check.

Cleanup — always run, including after a failed seed:

1. `DELETE /api/v1/fs` on the synthetic document / subtree, **or**
2. typed `DELETE /api/v1/admin/accounts/synth-i1` (official account-deletion
   primitive; HTTP 202 in the pinned source). Prefer account deletion when the
   whole disposable account was created for the test.
3. Treat the accepted DELETE as cleanup success. Do **not** require the
   account to disappear from `GET /api/v1/admin/accounts` — the pinned alpha
   registry settle is unreliable (see Known issues).
4. Do not leave seed documents for the next run. V1.4 / F6 must clean up in
   `finally`.

Never seed from PublicChannel production transcripts. Never commit ovpack
archives or volume tarballs.

## Backup, restore, and reindex

The volume `coforge_openviking_prototype_data` is the prototype data boundary.
Treat it as synthetic-only. Backup is an external host job, not a Web request,
Agent action, or container startup hook.

Application-consistent volume snapshot:

1. Stop `openviking-prototype` and wait until it is not running. Local VectorDB
   uses a workspace lock; do not copy `/data` while the writer is live.
2. Capture the complete volume. Encrypt at the backup boundary. Record image
   digest, OpenViking revision, volume name, UTC timestamps, and checksum —
   never document bodies or keys.
3. Restart the same service and require `GET /health` before ending the window.

Official online pack (not an atomic snapshot; pause writes if you need
consistency):

- Backup: `POST /api/v1/pack/backup` as ROOT/ADMIN. Response is an `.ovpack`
  zip. It does not include user accounts or API keys.
- Restore: upload via `POST /api/v1/resources/temp_upload`, then
  `POST /api/v1/pack/restore`. OVPack restore does not recreate accounts; create
  the same `user_id` values and **new** keys on the target.
- Workspace snapshots (`/api/v1/snapshot/*`) are a second official tool; they
  are not a substitute for an encrypted volume snapshot.

Reindex after restore, embedding-model change, or a failed vector upsert:

```http
POST /api/v1/content/reindex
```

Body: `{ "uri": "viking://resources/cm-projection/synth-i1", "mode": "vectors_only", "wait": true }`.
There is no `/api/v1/maintenance/reindex`. Passing `tags` during reindex writes
those tags onto successfully rebuilt vector records; omit `tags` to keep
existing ones. After reindex, re-run the C4 tag/filter check below.

Restore cutover: preserve the failed volume read-only, restore into a fresh
volume, start one replacement container on the private `openviking` network,
require `/health`, then run the synthetic isolation check (two disposable
accounts must not read each other's documents). There is no public-endpoint
cutover.

## Known issues (OpenViking `e44ea6e` alpha)

These are upstream behaviors observed on the pinned alpha. They are not
CoForge product defects and they do not authorize an OpenViking source patch.

1. **Typed account DELETE returns 202, registry settle is unreliable.**
   `DELETE /api/v1/admin/accounts/{account_id}` is accepted, but the account
   may remain listed for a long time. Cleanup asserts that DELETE was
   accepted. A later `gone` observation is logged only.
2. **Account delete has crashed the process once.** After a typed delete the
   container restarted (`restart: unless-stopped`). Smoke and V1.4 treat
   that as an upstream risk: wait for health again if the process bounced;
   do not require a settled empty account list.
3. **`GET /api/v1/fs/attrs` does not echo `k=v` tags.** V1.4 verdict:
   retrieval depends on `POST /api/v1/search/find` `tags` / equivalent
   `filter`. Attrs-based scenes (recorded before Causal Memory removal) use a stable URI plus caller-side
   binding. Do not assert `attrs.tags` for fact id / version / generation.

## C4 tag / filter round-trip (V1.4 verdict)

C4 deferred this check to I1/V1.4. **V1.4 closed it** on the pinned
`e44ea6e` + local-embed runtime:

> `find()` tags and the equivalent metadata `filter` round-trip fact id /
> version / generation exactly. `GET /fs/attrs` does not echo those tags.
> V1 retrieval may rely on `find` tags/filter. Attrs-based binding must use
> stable URI + caller-side binding.

Provisional tag keys from D3 (final names belong to C3 / V1.1):

| Tag            | Meaning                                                             |
| -------------- | ------------------------------------------------------------------- |
| `cm_fact=<id>` | canonical Fact Document id                                          |
| `cm_ver=<n>`   | canonical fact version (integer ≥ 1)                                |
| `cm_gen=<n>`   | Fact Index projection generation (not Workspace profile generation) |

OpenViking normalizes tags with `.strip().lower()` and requires strict `k=v`.
Use lowercase ids and decimal versions. Do not store these identifiers only in
YAML frontmatter — unknown metadata is silently dropped.

V1.4 must load credentials from the mounted secret file **in-process**. Do not
put keys on `curl` argv, in fixtures, or in logs. The HTTP shapes below use
placeholders only.

### A. Filesystem tag write (do not use attrs for tags)

1. Write (or `set_tags`) the synthetic L2 document with
   `["cm_fact=fact-synth-1","cm_ver=3","cm_gen=7"]` and `tag_mode=replace`.
2. Do **not** require `GET /api/v1/fs/attrs` to echo those tags. On
   `e44ea6e` it does not.
3. `GET /api/v1/fs/ls?uri=<parent>&tags=cm_fact=fact-synth-1&tags=cm_ver=3&tags=cm_gen=7`
   (AND) may list the document; treat ls as supporting evidence, not the
   retrieval contract.

Pass criteria for V1: do not depend on attrs echo. Retrieval contract is
section B. Attrs scenes bind by stable URI + Causal Memory-side records.

### B. `find()` tags and equivalent `filter`

Deterministic causal recall uses `POST /api/v1/search/find` only — never
`POST /api/v1/search/search` (default `query_expansion=auto`) and never
`recall`. Requires `/ready` embedding + a completed vector upsert.

```http
POST /api/v1/search/find
Content-Type: application/json
```

Tags form (AND):

```json
{
  "query": "synthetic fact document",
  "target_uri": "viking://resources/cm-projection/synth-i1/",
  "limit": 10,
  "level": "2",
  "tags": ["cm_fact=fact-synth-1", "cm_ver=3", "cm_gen=7"]
}
```

Equivalent metadata `filter` (source `openviking/utils/tags.py`
`build_search_tags_filter`, revision `e44ea6e11add1c7b3d4accdbfaf16e900a6049df`):

```json
{
  "query": "synthetic fact document",
  "target_uri": "viking://resources/cm-projection/synth-i1/",
  "limit": 10,
  "level": "2",
  "filter": {
    "op": "and",
    "conds": [
      { "op": "must", "field": "search_tags", "conds": ["cm_fact=fact-synth-1"] },
      { "op": "must", "field": "search_tags", "conds": ["cm_ver=3"] },
      { "op": "must", "field": "search_tags", "conds": ["cm_gen=7"] }
    ]
  }
}
```

Pass criteria:

1. Both requests return the same synthetic URI and no foreign-account document.
2. Repeating the tags request with `cm_gen=8` or `cm_ver=2` returns zero hits
   for that document (stale generation / stale version rejected at retrieval).
3. `target_uri` stays inside the managed subtree; a second synthetic account
   must not see `fact-synth-1`.
4. Do not send `session_id`, `query_expansion`, or `image_url`.
5. Always delete the disposable account/document afterwards.

V1.4 ran B against local-embed on the non-internal loopback publish and
recorded a pass for tags + equivalent filter + stale rejection. Do not open
a public route. Do not reintroduce `internal: true` to “fix” egress — models
are host-mounted. If embedding is not ready (warmup or missing weights),
record that as an environment gap; fallback remains stable URI + Causal
Memory-side binding.

## F6 opt-in real OpenViking smoke

The smoke is a synthetic-only, explicit opt-in file. It is **not** named
`*.test.ts` / `*.spec.ts`, so default `bun test` and `mise run test` never
collect it. Invoke it by path after the prototype container is healthy.

```sh
export OPENVIKING_SMOKE=1
export COFORGE_OPENVIKING_URL=http://127.0.0.1:${OPENVIKING_PROTOTYPE_PORT:-1933}
export OPENVIKING_PROTOTYPE_CONF=infra/secrets/openviking_prototype_ov_conf

# Optional citation persist (P3). Without a URL the citation step skipIfs.
# export MIGRATION_TEST_DATABASE_URL=...

bun test ./apps/web/test/openviking-prototype.smoke.ts
```

The file loads `server.root_api_key` from the secret path **in-process**. Do
not export the key, put it on argv, or paste it into logs. A disposable
`smoke-<random>` account is provisioned through the typed admin channel,
exercises a real gateway find/resources round-trip, runs the F1
session→batch→commit→extract sequence, asserts `find(tags)` fact-id/version/
generation round-trip (URI + CM binding; do not use `GET /fs/attrs` for tags),
persists a citation when PostgreSQL is configured, then typed-deletes the
account in `finally`. Cleanup asserts DELETE accepted; `gone=` is logged
only.

Pinned evidence must name OpenViking
`e44ea6e11add1c7b3d4accdbfaf16e900a6049df` and the local-embed layer.

Recorded F6 run (2026-09-22, real container `http://127.0.0.1:1933`, after
warmup): `mise exec -- bun test ./apps/web/test/openviking-prototype.smoke.ts
--timeout 180000` **exit 0** (1 pass / 0 fail / 27 expect). Account
`smoke-b99079db4380`. `composeOpenVikingGatewayContext` stayed 401
fail-closed (no server-held credential ops wiring on the web splat route);
smoke used the policy-gateway + runtime-client seam and labeled that step.
Without opt-in env: 0 pass / 1 skip. Default bun discovery does not collect
`*.smoke.ts`.

## Acceptance checklist

- [ ] `docker compose -f infra/docker-compose.yml up` does not start OpenViking
- [ ] No Caddy service or public reverse-proxy route is added
- [ ] Host ov.conf is `644`; secrets directory is `0700`; Compose secret `mode`
      is not trusted
- [ ] Embedding weights exist under `infra/secrets/openviking_prototype_models/`
      before `up`; image is `e44ea6e` + local-embed
- [ ] Network is non-internal; port is `127.0.0.1` only; no remote LLM
- [ ] Warmup (2–4 min) finished and `/ready` passed before requests
- [ ] Credentials are absent from browser, Agent env, CLI args, logs, and fixtures
- [ ] Only synthetic account / document names are used
- [ ] Cleanup treats typed DELETE 202 as success; does not require registry gone
- [ ] Override `config` is additive relative to the default file (no removed
      default services, networks, or volumes)
- [ ] `OPENVIKING_PROTOTYPE_ENABLED` remains default-off on Web
- [ ] AGPL / shipping gate stays user-owned; this override is not a release claim
