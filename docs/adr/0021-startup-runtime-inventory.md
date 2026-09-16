# ADR 0021: Fast Workspace daemon readiness, with Code Agent inventory split and cached

Status: accepted
Date: 2026-09-16

## Context

Under the Coordinator (`packages/daemon/src/supervisor/run-supervisor.ts`), a
Workspace daemon has 30 seconds after being spawned to open its local
`daemon.sock`, or the Coordinator reports "failed process readiness" and the
Workspace never comes up. `packages/daemon/index.ts` opened that socket only
after `daemon.start()` resolved in the supervised path (the unsupervised path
already ran the RPC server first), and `DaemonRuntime.start`
(`packages/daemon/src/daemon-runtime/runtime.ts`) did not resolve until
`#reportCodeAgents` — full Code Agent inventory discovery — had also
resolved. `discoverCodeAgentInventory`
(`packages/daemon/src/code-agent/runtime-inventory.ts`) discovers every
provider's installed runtime version and its full model catalog in one pass:
runtime probing is cheap for Claude Code and Kiro (`--version`, ~15ms) but
Codex's probe starts `codex app-server` and completes an `initialize`
handshake (~0.6s); catalog discovery is the expensive part regardless of
provider — Kiro's ACP config round-trip runs ~3.0s, Pi's `ModelRuntime`
refresh ~1.4s, Codex's `model/list` ~0.3s. None of this is cached across
daemon restarts, so it repeats in full on every start and every reconnect
(`onReconnect`). On the reporting user's Mac the combined RPC-after-start
ordering and unbounded discovery time exceeded the Coordinator's 30s budget.

Raft Computer 1.0.32 is prior art for the shape of the fix: at `ready` it
reports only installed runtime ids and versions (no catalogs), probe results
are cached keyed by the executable's mtime+size, and model catalogs are
fetched on demand rather than at startup. We adopt that shape; no Raft code,
identifier, or wording is used here.

The server side already tolerates a runtimes-only update:
`apps/web/src/server/db/repositories/computer-runtime.repositories.server.ts`
upserts runtimes unconditionally but only writes catalogs `if
(catalogs.length)`, so a report with `catalogs: []` is a safe no-op for
catalogs already on record. This ADR changes neither the server nor the wire
protocol.

## Decision

**Open the local RPC socket before `daemon.start()` in both paths.**
`packages/daemon/index.ts` no longer calls `daemon.start()` in the supervised
branch before `startDaemonLocalRpcServer`; the socket now opens first
unconditionally, and `daemon.start()` runs afterward inside the existing
try/catch that logs `daemon:workspace_recovery_failed` rather than
propagating. The RPC handshake only reports pid/version/serverUrl, so it
never depended on the Workspace having started. One consequence: the
Coordinator (and anything else polling the socket) can now observe a
Workspace daemon as "process ready" slightly before its `DaemonRuntime` has
actually finished starting — readiness of the process and readiness of the
Workspace are no longer the same instant. `packages/daemon/test/
macos-supervisor.test.ts`, which polls the RPC socket's `identity()` and
then reads a `native-ready.json` write that only happens after `start()`
completes, needed to wait for both, not stop as soon as the socket answered.

**Split Code Agent discovery into a fast half and a slow half.**
`runtime-inventory.ts` now exposes `discoverCodeAgentRuntimes` (installed
runtimes only), `loadCachedCodeAgentCatalogs` (a disk-only read of whatever
catalogs the probe cache already has, never spawning anything, plus a
`needsRefresh` flag), and `discoverCodeAgentCatalogs` (the live, possibly
spawning catalog discovery, which also refreshes the cache).
`discoverCodeAgentInventory` is kept, composing the same two-branch behavior
it always had, for compatibility and for the tests that construct it with an
explicit fake `probe`/`commands`.

`DaemonRuntime.start` (and `onReconnect`) now await only
`#reportCodeAgentRuntimes`, which sends one `updateCodeAgents` RPC carrying
`{ runtimes, catalogs: <whatever the cache already had> }` — `[]` on a cold
cache. If `needsRefresh` is true for any provider, a second stage,
`#reportCodeAgentCatalogs`, runs in the background via `void …catch(() =>
{})`, never blocking `start()` or a reconnect, and is guarded against
`#stopping` and against the transport having been replaced by a later
reconnect before it lands its `updateCodeAgents` call — the same guard
`onSkillsList` already used for the same reason. It logs
`code_agent_catalog:summary_started` / `summary_completed` /
`summary_failed` with `elapsed_ms`, alongside the existing per-provider
`code_agent_catalog:discovery_*` events.

**Cache probe results across restarts, keyed by what they depend on.**
A small JSON file in the daemon state directory
(`<stateDirectory>/code-agent-inventory-cache.json`,
`runtime-inventory-cache.ts`) stores, per provider, a key plus the cached
runtime metadata and/or catalog. The key is the resolved executable's
mtime+size for Codex, Claude Code, and Kiro; for Pi it is the mtime+size of
`<agentDir>/models.json` and `auth.json` together, since Pi has no
executable to stat. A matching key skips the runtime version spawn entirely
(including Codex's `app-server` handshake) and lets the first
`updateCodeAgents` carry the cached catalog immediately, with no live probe
at all when every provider's key still matches. Model lists also change
server-side without the binary changing, so a cached catalog older than
`CATALOG_CACHE_TTL_MS` (24 hours) is still sent immediately but flags a
background refresh. A missing or unreadable
cache is treated as empty, and a failed cache write is swallowed — caching
is strictly an optimization and must never fail or block discovery. The
existing Codex `~/.codex/models_cache.json` fallback (used when the live
`model/list` call itself fails or times out) is unchanged and layered
underneath this cache, not replaced by it.

## Consequences

- A Workspace daemon now reports itself ready to the Coordinator without
  waiting on any Code Agent CLI, bounding daemon-start latency to local
  probing rather than the slowest installed provider's catalog fetch.
- The server briefly shows an installed-runtimes-only view (or the
  previously cached catalogs) between the first and second
  `updateCodeAgents` calls after a cold-cache restart; this is intentional
  and mirrors Raft's on-demand catalog model rather than a regression, and
  resolves itself once the background report lands.
- Process readiness and Workspace readiness are observably different
  instants now; any other test or tool that infers "the Workspace has
  started" from "the local RPC socket answered" needs the same fix applied
  to `macos-supervisor.test.ts`.
- The probe cache is best-effort local state, not a source of truth; a
  daemon that never writes to its state directory (permissions, read-only
  filesystem) simply re-probes every time, exactly as before this change.
