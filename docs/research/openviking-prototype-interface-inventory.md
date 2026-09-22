# OpenViking prototype public-runtime interface inventory

> **Context 2026-09-22:** Causal Memory is removed ([ADR 0062](../adr/0062-openviking-only-workspace-memory.md)). The pinned interface inventory and route classification below remain authoritative for the OpenViking gateway; the causal-recall analysis sections are historical.


**Status:** Stage 1 D3 evidence. Inventory findings are not a second architecture source.  
**Classification:** every route below is **unclassified**. Later G3 work must assign `data-plane | typed-control-only | denied`. Unknown future routes stay denied.  
**Inspection date:** 2026-09-21.  
**Method:** read-only local checkout plus that checkout's official docs. No project data or code was sent to a third party. Official GitHub/docs fetch was not used in this pass.

## 1. Exact revision and license

| Fact | Value | Source |
| --- | --- | --- |
| Local checkout | `/home/zhoujie22/river2_0/OpenViking` | coordinator input; read-only |
| Remote | `https://github.com/volcengine/OpenViking.git` | `git remote -v` |
| HEAD | `e44ea6e11add1c7b3d4accdbfaf16e900a6049df` | `git rev-parse HEAD` |
| Commit date | 2026-09-21 15:43:04 +0800 | `git log -1` |
| Subject | `fix(plugins): honor cloud recall compression across harnesses (#5240)` | `git log -1` |
| Working tree | clean (`git status --porcelain` empty); HEAD is a grafted `main` | `git status` / `git log -1 --format='%D'` |
| License | GNU Affero General Public License v3 | `LICENSE` preamble; `pyproject.toml` `license = "AGPL-3.0"`; router files carry `SPDX-License-Identifier: AGPL-3.0` |
| Maturity | PyPI classifier `Development Status :: 3 - Alpha` | `pyproject.toml` |
| Package name | `openviking` | `pyproject.toml` `[project]` |

This pin is the prototype contract revision for later C1/C3/V1 work. Bumping it requires a new inventory, not a silent `main` follow.

ADR 0060 already records that AGPL use is unapproved for a distributable product. This inventory confirms the local tree is AGPL-3.0; it does not change that gate.

## 2. Runtime compatibility

| Fact | Value | Source |
| --- | --- | --- |
| Language | Python 3 | `pyproject.toml` `requires-python = ">=3.10"`; classifiers list 3.10–3.14 |
| HTTP stack | FastAPI + Uvicorn | `pyproject.toml` dependencies `fastapi>=0.128.0`, `uvicorn>=0.39.0` |
| Default listen port | `1933` | official `docs/zh/guides/03-deployment.md` (`--port` default `1933`) |
| Health (liveness) | `GET /health`, unauthenticated | official `docs/zh/api/01-overview.md`, `docs/zh/api/07-system.md` |
| Readiness | `GET /ready` (AGFS, VectorDB, API Key manager), unauthenticated | official `docs/zh/api/01-overview.md` |
| Studio UI | `/studio` on the same origin when the bundle exists | official `docs/zh/guides/03-deployment.md`; source `openviking/server/app.py` |
| Vector backends | pluggable `CollectionAdapter` (`Local`, `Http`, `CuVS`, `VikingDBPrivate`, `Volcengine`) | source `openviking/storage/vectordb_adapters/` |
| LanceDB | not present as a first-class CoForge seam; later LanceDB belongs behind `CollectionAdapter` | source adapters above; ADR 0060 |

Official deployment docs also mention a compatibility Caddy listener on `1934` and hosted `ghcr.io/volcengine/openviking:latest`. Those are upstream operations notes, not CoForge default Compose. CoForge must not add OpenViking to default Compose, release, staging, or production while the license gate is open.

## 3. Auth, account, user, and ACL

Official identity model (`docs/zh/concepts/11-multi-tenant.md`, `docs/zh/guides/04-authentication.md`, `docs/zh/concepts/15-acl.md`):

- Tenant boundary is `account_id`. In-account user boundary is `user_id`.
- Built-in roles: `ROOT` (global), `ADMIN` (one account), `USER` (one account). Source also allows plugin-registered custom roles (`openviking/server/identity.py`).
- Shared resources live at `viking://resources/...` and are account-scoped. User memories, skills, and sessions are user-scoped.
- Isolation is request-context `account_id` + `user_id`, not directory naming. Physical paths are `/local/{account_id}/...`.
- ACL applies only to `viking://resources/...`. Levels: `read` < `write` < `manage`. Account `acl.enabled` defaults off.
- Auth modes: `api_key` (default), `trusted`, `oidc`, `ldap`, `dev`. Missing `root_api_key` in `api_key` mode becomes localhost-only development ROOT/`default/default`.

### Identity headers

Official HTTP identity headers (`docs/zh/api/01-overview.md`, `docs/zh/concepts/11-multi-tenant.md`, source `openviking/server/auth/__init__.py`):

| Header | Role | Notes |
| --- | --- | --- |
| `Authorization: Bearer <key>` | preferred API key | official overview |
| `X-API-Key` | alternate API key | official overview |
| `X-OpenViking-Account` | trusted-mode account assertion | ignored / must not be sent in `api_key` mode |
| `X-OpenViking-User` | trusted-mode user assertion | same |
| `X-OpenViking-Role` | trusted-mode `user` or `admin` assertion | `root` is rejected; requires configured `root_api_key` |
| `X-OpenViking-Actor-Peer` | peer-collection filter inside the current user | does not change tenant/user |

Source `openviking/server/auth/__init__.py` states that when an API key is present, spoofed `X-OpenViking-Account/User` headers are ignored. ADR 0061's gateway must still strip client-supplied identity/account headers and inject only the server-owned mapped identity.

Trusted mode can asynchronously register asserted account/user pairs (`docs/zh/guides/04-authentication.md`). CoForge typed provisioning should not rely on that side effect as the account/user source of truth.

## 4. Deterministic search and metadata round-trip

### 4.1 Can causal retrieval be deterministic without modifying OpenViking?

**Yes, for the ADR 0059 meaning of deterministic candidate retrieval, using public APIs only.**

Official `docs/zh/api/06-retrieval.md` and `docs/zh/concepts/07-retrieval.md`:

| API | Intent analysis | Session context | Query expansion | Default limit |
| --- | --- | --- | --- | --- |
| `POST /api/v1/search/find` | no | no | no | 10 |
| `POST /api/v1/search/search` | yes | yes when `session_id` set | default `query_expansion="auto"` | 10 |

Source `openviking/server/routers/search.py`:

- `FindRequest` has no `session_id` or `query_expansion`.
- `SearchRequest.query_expansion` is `Literal["off", "auto"]` with default `"auto"`.
- `mode="list"` rejects context-only fields including `query_expansion`.
- `find()` docstring: "Semantic search without session context."

Therefore the causal Fact Index adapter should call `POST /api/v1/search/find` with:

- `target_uri` locked to the Managed Causal Projection subtree
- `limit` ≤ 10
- no `session_id`
- optional `level` / `tags` / `filter`
- no `image_url` unless later explicitly approved

Do **not** use `POST /api/v1/search/search` or deprecated `POST /api/v1/search/recall` for managed causal candidate recall: those faces default to expansion and session context.

**Not claimed:** bit-identical ranking across embedding-model or index rebuilds. Official ranking is vector similarity plus hierarchical directory walk. Determinism here means "no LLM rewrite, no session memory, fixed target, bounded limit."

OpenViking long-term memory extraction is a session `commit` / `extract` Phase 2 behavior (`docs/zh/api/05-sessions.md`, source `openviking/session/session.py`). The Fact Index adapter must not invoke those endpoints for managed facts.

### 4.2 Stable metadata without modifying OpenViking?

**Partially yes. Use explicit `k=v` tags and the documented `filter`/`tags` search fields. Do not depend on arbitrary extra metadata keys.**

Official write/tag path (`docs/zh/api/12-content.md`):

- `POST /api/v1/content/write` accepts `tags: string[]` in strict `k=v` form and `tag_mode: replace | append`.
- Tags are written on the file's first vector upsert.
- `POST /api/v1/content/set_tags` and `POST /api/v1/fs/attrs/set_tags` are the dedicated tag APIs.
- `find()` / `search()` accept `tags` (AND) and `filter` (metadata filter).

Official sidecar metadata (`docs/zh/concepts/03-context-layers.md`):

- Unknown top-level or nested metadata fields are **silently dropped**.
- Protected OKF metadata on `.abstract.md` / `.overview.md` cannot be changed through the public write API.
- Public API cannot create new L0/L1 sidecars; OpenViking generates them asynchronously.

**Prototype implication:** store canonical fact id / version as explicit tags such as `cm_fact=<id>` and `cm_ver=<n>` (final key names belong to C3). Do not put those identifiers only in YAML frontmatter extras. L0/L1 summaries are retrieval aids and are eventually consistent; watermark-plus-local-delta remains a Causal Memory responsibility, not an OpenViking field.

OpenViking has no documented index watermark. The Fact Index watermark is owned by Causal Memory after an adapter search.

## 5. Health, deletion, and failure

| Operation | Official route | Notes |
| --- | --- | --- |
| Process liveness | `GET /health` | unauthenticated; may echo identity if credentials present |
| Readiness | `GET /ready` | unauthenticated; AGFS + VectorDB + API key manager |
| System status | `GET /api/v1/system/status` | authenticated |
| Delete account | `DELETE /api/v1/admin/accounts/{account_id}` | official admin; HTTP 202 in source |
| Delete user | `DELETE /api/v1/admin/accounts/{account_id}/users/{user_id}` | official admin; HTTP 202 in source |
| Delete file/dir | `DELETE /api/v1/fs` | data-plane destructive |
| Delete session | `DELETE /api/v1/sessions/{session_id}` | user-scoped |
| Delete skill | `DELETE /api/v1/skills/{skill_name}` | user-scoped |

Account deletion is the typed cleanup primitive CoForge should use for Workspace deletion, not a generic data-plane proxy. Classification remains **unclassified** until G3.

## 6. Endpoint inventory

Prefixes come from source `openviking/server/app.py` (`include_router`) and each router's `APIRouter(prefix=...)`. Official catalog is `docs/zh/api/01-overview.md` unless marked **source-only**.

**Disposition:** `unclassified` for every row.

### 6.1 System and health

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| GET | `/health` | yes | health |
| GET | `/ready` | yes | health |
| GET | `/api/v1/system/status` | yes | system |
| POST | `/api/v1/system/wait` | yes | system |
| POST | `/api/v1/system/consistency` | yes | system |
| POST | `/api/v1/system/backend/sync-status` | yes | system |
| POST | `/api/v1/system/backend/sync-retry` | yes | system |
| GET | `/api/v1/system/sync/{sync_path}` | yes | system |
| POST | `/api/v1/system/sync/{sync_path}/retry` | yes | system |
| GET | `/metrics` | yes | metrics |
| GET | `/` | source-only | studio redirect when bundle present |
| GET | `/studio` | source-only / ops docs | studio |
| GET | `/studio/{path}` | source-only / ops docs | studio |

### 6.2 Resources, filesystem, content, find/search

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| POST | `/api/v1/resources/temp_upload` | yes | resources |
| POST | `/api/v1/resources` | yes | resources |
| GET | `/api/v1/fs/ls` | yes | filesystem |
| GET | `/api/v1/fs/tree` | yes | filesystem |
| GET | `/api/v1/fs/stat` | yes | filesystem |
| GET | `/api/v1/fs/attrs` | yes | filesystem |
| POST | `/api/v1/fs/attrs/set_tags` | yes | filesystem |
| POST | `/api/v1/fs/mkdir` | yes | filesystem |
| DELETE | `/api/v1/fs` | yes | filesystem |
| POST | `/api/v1/fs/cp` | yes | filesystem |
| POST | `/api/v1/fs/mv` | yes | filesystem |
| GET | `/api/v1/content/read` | yes | content |
| GET | `/api/v1/content/abstract` | yes | content |
| GET | `/api/v1/content/overview` | yes | content |
| GET | `/api/v1/content/download` | yes | content |
| POST | `/api/v1/content/write` | yes | content |
| POST | `/api/v1/content/batch-write` | yes | content |
| POST | `/api/v1/content/set_tags` | yes | content |
| POST | `/api/v1/content/reindex` | yes | content |
| POST | `/api/v1/search/find` | yes | search |
| POST | `/api/v1/search/search` | yes | search |
| POST | `/api/v1/search/recall` | yes, deprecated | search |
| POST | `/api/v1/search/grep` | yes | search |
| POST | `/api/v1/search/glob` | yes | search |

### 6.3 Memory, skill, session, compile / evolution

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| GET | `/api/v1/skills` | yes | skill |
| POST | `/api/v1/skills` | yes (`resources` router) | skill |
| POST | `/api/v1/skills/find` | yes | skill |
| POST | `/api/v1/skills/validate` | yes | skill |
| GET | `/api/v1/skills/{skill_name}` | yes | skill |
| PUT | `/api/v1/skills/{skill_name}` | yes | skill |
| DELETE | `/api/v1/skills/{skill_name}` | yes | skill |
| POST | `/api/v1/sessions` | yes | session |
| GET | `/api/v1/sessions` | yes | session |
| GET | `/api/v1/sessions/{session_id}` | yes | session |
| PATCH | `/api/v1/sessions/{session_id}/config` | yes | session |
| GET | `/api/v1/sessions/{session_id}/tool-results` | yes | session |
| GET | `/api/v1/sessions/{session_id}/tool-results/{tool_result_id}` | yes | session |
| GET | `/api/v1/sessions/{session_id}/tool-results/{tool_result_id}/search` | yes | session |
| GET | `/api/v1/sessions/{session_id}/context` | yes | session |
| GET | `/api/v1/sessions/{session_id}/archives/{archive_id}` | yes | session |
| DELETE | `/api/v1/sessions/{session_id}` | yes | session |
| POST | `/api/v1/sessions/{session_id}/commit` | yes | session / memory extract |
| POST | `/api/v1/sessions/{session_id}/extract` | yes | memory extract |
| POST | `/api/v1/sessions/{session_id}/messages` | yes | session |
| POST | `/api/v1/sessions/{session_id}/messages/batch` | yes | session |
| POST | `/api/v1/sessions/{session_id}/used` | yes | session |
| GET | `/api/v1/agent-evolution/experiences/trajectories` | yes | evolution |
| GET | `/api/v1/agent-evolution/experiences/outcomes` | yes | evolution |
| POST | `/api/v1/compile` | yes | compile |
| GET | `/api/v1/compile/capabilities` | yes | compile |
| GET | `/api/v1/compile/submissions/{key}` | yes | compile |

There is no separate `/api/v1/memory/*` collection. Official `docs/zh/api/16-memory.md` treats memory as session commit/extract plus filesystem/search over `viking://~/memories`.

### 6.4 Task, watch, pack, snapshot, observer, stats

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| GET | `/api/v1/tasks` | yes | task |
| GET | `/api/v1/tasks/{task_id}` | yes | task |
| POST | `/api/v1/tasks/{task_id}/cancel` | yes | task |
| GET | `/api/v1/watches` | yes | watch |
| GET | `/api/v1/watches/{task_id}` | yes | watch |
| PATCH | `/api/v1/watches` | yes | watch |
| PATCH | `/api/v1/watches/{task_id}` | yes | watch |
| DELETE | `/api/v1/watches` | yes | watch |
| DELETE | `/api/v1/watches/{task_id}` | yes | watch |
| POST | `/api/v1/watches/trigger` | yes | watch |
| POST | `/api/v1/watches/{task_id}/trigger` | yes | watch |
| POST | `/api/v1/snapshot/commit` | yes | snapshot |
| GET | `/api/v1/snapshot/log` | yes | snapshot |
| POST | `/api/v1/snapshot/restore` | yes | snapshot |
| GET | `/api/v1/snapshot/show` | yes | snapshot |
| GET | `/api/v1/snapshot/diff` | yes | snapshot |
| GET | `/api/v1/snapshot/ignore` | yes | snapshot |
| PUT | `/api/v1/snapshot/ignore` | yes | snapshot |
| DELETE | `/api/v1/snapshot/ignore` | yes | snapshot |
| POST | `/api/v1/pack/export` | yes | pack |
| POST | `/api/v1/pack/import` | yes | pack |
| POST | `/api/v1/pack/backup` | yes | pack |
| POST | `/api/v1/pack/restore` | yes | pack |
| GET | `/api/v1/observer/queue` | yes | observer |
| GET | `/api/v1/observer/vikingdb` | yes | observer |
| GET | `/api/v1/observer/models` | yes | observer |
| GET | `/api/v1/observer/lock` | yes | observer |
| GET | `/api/v1/observer/retrieval` | yes | observer |
| GET | `/api/v1/observer/filesystem` | yes | observer |
| GET | `/api/v1/observer/system` | yes | observer |
| GET | `/api/v1/stats/memories` | **source-only** | stats |
| GET | `/api/v1/stats/sessions/{session_id}` | **source-only** | stats |

### 6.5 Account, user, group, key, ACL, administration

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| GET | `/api/v1/acl` | yes | acl |
| PUT | `/api/v1/acl` | yes | acl |
| DELETE | `/api/v1/acl` | yes | acl |
| POST | `/api/v1/acl/grant` | yes | acl |
| POST | `/api/v1/acl/revoke` | yes | acl |
| GET | `/api/v1/admin/configuration` | yes | admin |
| PATCH | `/api/v1/admin/configuration` | yes | admin |
| GET | `/api/v1/admin/accounts/{account_id}/configuration` | yes | admin |
| PATCH | `/api/v1/admin/accounts/{account_id}/configuration` | yes | admin |
| GET | `/api/v1/admin/agent-evolution` | yes, deprecated | admin |
| PUT | `/api/v1/admin/agent-evolution` | yes, deprecated | admin |
| GET | `/api/v1/admin/accounts/{account_id}/settings` | yes, deprecated | admin |
| PATCH | `/api/v1/admin/accounts/{account_id}/settings` | yes, deprecated | admin |
| GET | `/api/v1/admin/accounts/{account_id}/memory-templates` | yes | admin |
| GET | `/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}` | yes | admin |
| PUT | `/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}` | yes | admin |
| DELETE | `/api/v1/admin/accounts/{account_id}/memory-templates/{memory_type}` | yes | admin |
| POST | `/api/v1/admin/accounts` | yes | admin / account |
| GET | `/api/v1/admin/accounts` | yes | admin / account |
| POST | `/api/v1/admin/migrate` | yes | admin |
| DELETE | `/api/v1/admin/accounts/{account_id}` | yes | admin / destructive |
| POST | `/api/v1/admin/accounts/{account_id}/users` | yes | admin / user |
| GET | `/api/v1/admin/accounts/{account_id}/users` | yes | admin / user |
| GET | `/api/v1/admin/accounts/{account_id}/users/{user_id}/settings` | yes | admin / user |
| PATCH | `/api/v1/admin/accounts/{account_id}/users/{user_id}/settings` | yes | admin / user |
| DELETE | `/api/v1/admin/accounts/{account_id}/users/{user_id}` | yes | admin / user |
| PUT | `/api/v1/admin/accounts/{account_id}/users/{user_id}/role` | yes | admin / user |
| POST | `/api/v1/admin/accounts/{account_id}/users/{user_id}/key` | yes | admin / key |
| POST | `/api/v1/admin/accounts/{account_id}/groups` | yes | admin / group |
| GET | `/api/v1/admin/accounts/{account_id}/groups` | yes | admin / group |
| DELETE | `/api/v1/admin/accounts/{account_id}/groups/{group_id}` | yes | admin / group |
| GET | `/api/v1/admin/accounts/{account_id}/groups/{group_id}/members` | yes | admin / group |
| PUT | `/api/v1/admin/accounts/{account_id}/groups/{group_id}/members/{user_id}` | yes | admin / group |
| DELETE | `/api/v1/admin/accounts/{account_id}/groups/{group_id}/members/{user_id}` | yes | admin / group |
| GET | `/api/v1/privacy-configs` | yes | privacy |
| GET | `/api/v1/privacy-configs/{category}` | yes | privacy |
| GET | `/api/v1/privacy-configs/{category}/{target_key}` | yes | privacy |
| GET | `/api/v1/privacy-configs/{category}/{target_key}/versions` | yes | privacy |
| GET | `/api/v1/privacy-configs/{category}/{target_key}/versions/{version}` | yes | privacy |
| POST | `/api/v1/privacy-configs/{category}/{target_key}` | yes | privacy |
| POST | `/api/v1/privacy-configs/{category}/{target_key}/activate` | yes | privacy |

### 6.6 Assets, WebDAV, MCP, OAuth, bot, console, debug, user-settings

| Method | Path | Official? | Family |
| --- | --- | --- | --- |
| POST | `/api/v1/openviking-assets/resolve` | yes | assets |
| POST | `/api/v1/openviking-assets/preflight` | yes | assets |
| OPTIONS/PROPFIND/GET/HEAD/PUT/DELETE/MKCOL/MOVE | `/webdav/resources` and `/webdav/resources/{resource_path}` | yes | webdav |
| GET/POST/DELETE | `/mcp` | **source-only** (`mcp_endpoint.py`); OAuth guide mentions it | mcp |
| GET | `/.well-known/oauth-protected-resource` | official OAuth guide | oauth |
| GET | `/oauth/authorize/page` | official OAuth guide | oauth |
| GET | `/oauth/authorize/page/status` | official OAuth guide | oauth |
| GET | `/api/v1/auth/oauth/pending/{pending_id}` | **source-only** | oauth |
| POST | `/api/v1/auth/oauth-verify` | **source-only** | oauth |
| GET | `/bot/v1/health` | yes | vikingbot |
| POST | `/bot/v1/chat` | yes | vikingbot |
| POST | `/bot/v1/chat/stream` | yes | vikingbot |
| POST | `/bot/v1/feedback` | yes | vikingbot |
| POST | `/bot/v1/compile` | yes, retired | vikingbot |
| GET | `/bot/v1/compile/{task_id}` | yes, retired | vikingbot |
| POST | `/bot/v1/compile/{task_id}/cancel` | yes, retired | vikingbot |
| GET | `/api/v1/admin/bot/capabilities` | **source-only** (`bot_studio.py`, `include_in_schema=False`) | vikingbot admin |
| GET/POST/PATCH/DELETE | `/api/v1/admin/accounts/{account_id}/bot/connections[/{connection_id}]` | **source-only** | vikingbot admin |
| POST | `/api/v1/admin/accounts/{account_id}/bot/connections/{connection_id}/credentials` | **source-only** | vikingbot admin |
| POST | `/api/v1/admin/accounts/{account_id}/bot/connections/{connection_id}/verifications` | **source-only** | vikingbot admin |
| GET | `/api/v1/admin/accounts/{account_id}/bot/connections/{connection_id}/conversations` | **source-only** | vikingbot admin |
| GET | `/api/v1/admin/accounts/{account_id}/bot/connections/{connection_id}/messages` | **source-only** | vikingbot admin |
| POST/GET | `/api/v1/admin/accounts/{account_id}/bot/onboarding-runs...` | **source-only** | vikingbot admin |
| GET | `/api/v1/console/dashboard/summary` | **source-only** | console |
| GET | `/api/v1/console/tokens` | **source-only** | console |
| GET | `/api/v1/console/context-commits` | **source-only** | console |
| GET | `/api/v1/console/audit` | **source-only** | console |
| GET | `/api/v1/debug/health` | **source-only** | debug |
| GET | `/api/v1/debug/vector/scroll` | **source-only** | debug |
| GET | `/api/v1/debug/vector/count` | **source-only** | debug |
| GET | `/api/v1/user-settings/add-locations` | **source-only** | user-settings |
| PATCH | `/api/v1/user-settings/add-locations` | **source-only** | user-settings |
| DELETE | `/api/v1/user-settings/add-locations` | **source-only** | user-settings |

Official `docs/zh/guides/11-oauth.md` documents MCP OAuth discovery. Extra OAuth JSON routes and all console/debug/user-settings/bot-studio routes are marked experimental until G3 classifies them. Default disposition for unclassified/source-only routes is deny.

## 7. Known gaps and architecture conflicts

Return these to `#coforge`; do not silently turn them into code.

1. **Official overview is not the complete mount table.** Source additionally mounts MCP, OAuth JSON helpers, `/api/v1/debug/*`, `/api/v1/console/*`, `/api/v1/stats/*`, `/api/v1/user-settings/*`, and hidden `/api/v1/admin/.../bot/*`. ADR 0061 still holds: unsupported or newly introduced routes remain denied until classified.
2. **No OpenViking watermark field.** Causal watermark-plus-local-delta cannot be implemented as an upstream query parameter; it stays a Causal Memory merge after `find()`.
3. **L0/L1 generation is asynchronous and sampled.** Official freshness rules (`docs/zh/concepts/03-context-layers.md`) allow parent abstracts to lag. That matches eventually-consistent projection, not a second source of truth.
4. **Unknown metadata is dropped.** Stable adapter identifiers must use documented tags/`filter`, not unofficial frontmatter.
5. **`search()` defaults are unsafe for causal recall.** `query_expansion="auto"` and optional `session_id` would violate ADR 0059 if used as the Fact Index path. `find()` is sufficient without an OpenViking patch.
6. **Trusted-mode auto-registration** can create users as a side effect. CoForge typed provisioning should remain the account/user authority.
7. **Alpha + AGPL.** Runtime is explicitly Alpha and AGPL-3.0. This reinforces the prototype/license gate; it is not a conflict with ADR 0060.
8. **CollectionAdapter exists; LanceDB does not need a CoForge seam.** Aligns with ADR 0060.
9. **Account/user model aligns with ADR 0060** (one Workspace → one account; humans/Agents → users; projection worker → restricted identity). Directory naming is not isolation.
10. **No OpenViking source change is required** for: complete authorized access through a gateway, tag-backed fact identifiers, and deterministic `find()` against a managed subtree. A patch would only become necessary if later conformance proved tags/`filter` cannot round-trip fact id + version, or if `find()` cannot stay inside a namespace without leaking other account content.

## 8. Recommended prototype binding (non-normative)

This section is implementation guidance for later stages, not architecture.

- Run OpenViking in `trusted` mode behind the CoForge gateway, or in `api_key` mode with only server-owned user keys. Strip inbound identity headers in either case.
- Provision one account per Workspace through typed admin APIs.
- Causal Fact Index: `content/write` + tags into the managed subtree; `search/find` with `target_uri` + `limit≤10`; never `sessions/*/commit` or `extract` for managed facts.
- Cleanup: typed `DELETE /api/v1/admin/accounts/{account_id}`, not a recursive public `DELETE /api/v1/fs` from a generic proxy.

Pin for all downstream Stage 2+ work: **OpenViking `e44ea6e11add1c7b3d4accdbfaf16e900a6049df`**.
