# ADR 0042: Daemon-initiated launches reuse the server-supplied `launchId`

Status: accepted
Date: 2026-09-17

## Context

[ADR 0041](0041-server-supplied-launch-id-and-start-rebind.md) moved `launchId` minting to the
server for every *server*-initiated launch, but left one case open under "Known remaining
difference from Raft": a launch the Daemon initiates by itself — an idle, exited-but-wakeable
Agent woken by a message delivery — still mints its own `launchId` with `crypto.randomUUID()` and
hands over with `previousLaunchId`. Raft Computer 1.0.32 never does this: every daemon-initiated
restart reuses the `launchId` from its restart snapshot (VERIFIED in the shipped bundle,
`docs/agents/reference-cli-research.md`; the snapshot's `launchId` field and its use in
`startAgent(..., restartSnapshot.launchId)`/`cached.launchId` for both the recoverable-error
restart and the idle auto-restart).

### 1. Every caller of `#startAgent` / `#launchAgent`, and whether `control` (a server `launchId`) is present

All in `packages/daemon/src/daemon-runtime/runtime.ts`:

| Call site | Line | `control` present? | Classification |
| --- | --- | --- | --- |
| `AgentControl`'s `launch` hook | 504–519 | yes (`{ controlEpoch: intent.controlEpoch, launchId }`) | server-initiated (managed Start/Restart/Reset/Full-reset, driven by `AgentControl.start()`) |
| `AgentControl`'s `wake` hook | 522–529 | **no** | only reached when `AgentControl.start()`'s equal-epoch replay branch already found `this.runtime.running(agentId)` true; `#startAgent` takes the "already active, queue wake via recovery" branch (line 1100–1108) and returns without reaching `#launchAgent` in the ordinary case. A same-tick race where the process exits between that check and this call is the one path here that could reach `#launchAgent` with no `control` — pre-existing, not widened by this record, and correctly treated as daemon-initiated by the fix below since it has no scope of its own to carry. |
| `startAgent()` public method → `#startAgent` | 1053–1072 | caller-supplied `control?: { controlEpoch?: number; launchId: string }` | depends on caller (see next row) |
| `handleAgentStart` (RPC `agent:start`) | 1702–1724 | **no**, when `!intent.controlEpoch` and the Agent is not yet `managed()` | **legacy/unmanaged path**: an Agent that has never gone through `AgentControl`. This is the "unmanaged legacy" case this record's decision explicitly keeps minting for. |
| `handleAgentStart` (RPC `agent:start`) | 1707–1712 | goes through `#agentControl.start(intent)`, not `#startAgent` directly | server-initiated, managed |
| `handleAgentMessage` (message delivery to an idle, wakeable Agent) | 1824–1832 | **no** | **daemon-initiated** ("wake") |
| `#notifyAppItem` (App Inbox item delivered to an idle, wakeable Agent) | 2754–2769 | **no** | **daemon-initiated** ("wake") — the "queued-input relaunch" the task brief refers to |

Two call sites mint a fresh `launchId` for an Agent the server has previously managed:
`handleAgentMessage`'s wake branch and `#notifyAppItem`'s wake branch. Both funnel through the
same `#launchAgent` (line 1274), which is where `launch.launchId = control?.launchId ??
crypto.randomUUID()` (line 1296) lives — one seam, one fix.

### 2. When does `AgentProcessManager.restartConfig(agentId)` exist?

`packages/daemon/src/agent-runtime/agent-process-manager.ts`: `#restartConfigs` is set in
`start()` (line 85, `this.#restartConfigs.set(agentId, { config, sessionId })`) the moment a
process is created — regardless of provider — and deleted only in `stop()` (lines 101, 109) or
`shutdown()` (line 140), i.e. only on an explicit `AgentProcessManager.stop(agentId)` call. It is
**not** deleted when the process exits on its own: `start()`'s `session.onExit(...)` callback
(lines 88–93) removes the entry from `#runtimes` (`this.#runtimes.delete(agentId)`) but leaves
`#restartConfigs` untouched. So "exited but wakeable" is exactly "the provider's `AgentSession`
called its own exit callback (idle timeout, natural turn-end exit, crash) without
`AgentProcessManager.stop()` ever running" — and since every provider's session is wired through
the same `AgentProcessManager.start()`/`onExit` path, this is a **generic, provider-independent**
condition, not something only some providers exhibit. `handleAgentMessage` (line 1819–1828) and
`#notifyAppItem` (line 2760–2763) both detect it the same way: `#agentProcessManager.session(id)`
is now empty but `#agentProcessManager.restartConfig(id)` still returns the last config.

### 3. Is a self-initiated launch for a managed Agent currently accepted or refused?

The launch-config request: `#requestLaunchConfig` (runtime.ts, 1254–1272) calls
`this.#transport.requestAgentLaunchConfig({ agentId, workspaceId, ...(control ? {
controlEpoch, requestId, launchId } : {}) })` — for a self-initiated wake, `control` is
`undefined`, so the request carries **no** `controlEpoch`/`requestId`/`launchId` at all.

Server side, `apps/web/src/routes/api/agent-api-keys.ts` (POST handler, lines 73–152) **always**
calls `AgentControl.authorizeLaunch({ ...input, computerId: principal.computerId })` (line
112–116) — `controlEpoch`/`requestId`/`launchId` are optional in `createAgentApiKeyInputSchema`,
not conditionally skipped. `AgentControl.authorizeLaunch` (`apps/web/src/server/agents/
agent-control.server.ts`, 613–639, pre-existing code) is:

```
if (!state) { if (input.controlEpoch || input.requestId || input.launchId) throw …; return; }
if (!current(agent, state) || state.phase !== "starting" || state.requestId !== input.requestId
    || state.epoch !== input.controlEpoch || !input.launchId || state.launchId !== input.launchId)
  throw new Error("Stale Agent launch");
```

Any Agent that has ever completed a managed Start has `agent.state` set with `phase: "completed"`
(the terminal value `commands.start.completed` writes, line ~47) — not `"starting"`. So for
**every** previously-managed Agent, a self-initiated wake's launch-config request hits `state.phase
!== "starting"` and throws `"Stale Agent launch"`, which the route's `catch` (line 117–119) turns
into a bare `403 forbidden`. **Proven** by a new test added in this commit,
`apps/web/test/agent-wake-launch-id.test.ts` → `"authorizeLaunch refuses a self-initiated launch
for a managed Agent whose last operation completed (today, pre-fix)"`, which constructs exactly
this state (`phase: "completed"`) and calls `authorizeLaunch({ agentId, workspaceId, computerId })`
with no control fields, asserting it throws `"Stale Agent launch"`. This is not a hypothetical: the
daemon's own wake path cannot obtain a fresh Agent API key for any Agent the server has ever
managed, so — **before this record's fix** — a wake for a managed Agent fails at the
credential-issuing step, before a process is even spawned.

This is exactly the fact the task brief anticipated ("This answer decides the server-side part of
the design") and is why Decision C below changes `authorizeLaunch` rather than leaving it as pure
verification of an already-working path.

### 4. Every server-side consumer of launch identity a reused `launchId` would touch

- **`AgentSessions.prepare/verify/accept`** (`apps/web/src/server/agents/agent-sessions.server.ts`,
  the plural class, a *different* persisted reference — `RuntimeSessionReference`, `Agent.
  runtimeSession` — from `AgentControlState`). `prepare()` is called only from `AgentControl`'s own
  publish path (`agent-control.server.ts` line 535, `this.sessions.prepare(intent)`) for a
  server-initiated Start; a self-initiated wake never calls it, so `old.launchId` on that reference
  keeps whatever the last managed `prepare()` stored (line 99–113: `intent.launchId` when managed).
  `verify()` (lines 125–147) accepts when `report.launchId === old.launchId` **or**
  `report.previousLaunchId === old.launchId` — an *exact* match on the reused id already satisfies
  this without `previousLaunchId`. **No change needed here** as long as the daemon reuses the exact
  same id (Decision A/B).
- **`AgentSessionReceiver`** (`apps/web/src/server/agents/agent-session.server.ts`). `authorize()`
  (lines 20–34) accepts when `current.state.launchId === report.launchId` and `state.phase` is
  `"starting"` **or `"completed"`** — the latter already covers a wake's session report against a
  managed Agent whose last operation finished, again by exact `launchId` match. **No change
  needed.**
- **`agent-display.server.ts` fences and the Activity idempotency key.** Two independent fences
  key on `(launchId, sequence)`/`(agentId, launchId, clientSeq)`:
  - PostgreSQL: `AgentActivity` has `@@unique([agentId, launchId, clientSeq])`
    (`apps/web/prisma/schema.prisma` line 284) and `docs/observability.md` line 224 states the
    accepted-observation write is idempotent on `(agent_id, launch_id, client_seq)`. Reusing
    `launchId` while restarting `clientSeq` at its initial value (today's `ActivityLaunch.clientSeq
    = 0` at `#launchAgent` line 1297) would collide with — and be silently dropped as duplicates
    against — rows already written under the same `(agentId, launchId)` pair from before the exit.
  - Redis: the `OBSERVE_ACTIVITY` Lua script (`agent-display.server.ts` lines 191–229) rejects a
    new observation under the *same* `launchId` unless its `sequence` (`ARGV[10]`, the daemon's
    `clientSeq`) is **strictly greater** than the stored `previous.sequence` (line 208–209). A
    clientSeq reset to a low value after a wake would be silently rejected by this fence until the
    new count naturally climbs back past the old high-water mark — the Agent's live display would
    appear stuck for however many turns that takes.

  Both fences are satisfied by the same fix: **continue the `clientSeq` counter across the process
  gap** (Decision D below) instead of resetting it — this is required, not optional, for a reused
  `launchId` to work at all.
- **`AgentControl.result`** (web, `agent-control.server.ts` lines 641–685). Only reachable from a
  daemon `agent:control:result` RPC, which only `AgentControl.start()`/`.stop()`/
  `.resetWorkspace()` (daemon side) send — a self-initiated wake never calls any of those and never
  sends a control result. **Untouched, not reachable from a wake.**
- **Daemon `AgentControl.stopped(agentId, launchId, identity)`**
  (`packages/daemon/src/agent-runtime/agent-control.ts` lines 484–492). Called today only from the
  process-exit handler in `#launchAgent` (runtime.ts line 1452–1457) **gated on `if (control)`** —
  i.e. only for a launch that was itself server-initiated. A self-initiated wake's own exit is
  **never reported** to `AgentControl` today, so the on-disk `AgentRuntimeRecord` is never told the
  process (re-)exited after a wake — see Decision E/Rule 5 below; this is the concrete mechanism
  behind "does the record go back to running?".
- **`daemon-connection.ts` superseded-launch / observed-launch bookkeeping.** `#observeLaunchIdentity`
  (lines 1127–1131) is driven only by `reportAgentSession`'s own `launchId` (line 1900) and simply
  records "the latest launch this daemon has told the server about" — reusing the same id on every
  report is a no-op write to that map, not a "different launch" transition, so it never drops a
  pending invalidate or supersedes anything of its own. `#supersededActivityLaunches` (line
  1084–1090) only marks a launch superseded when a *different* `launchId` is observed for the same
  agent — reusing one id never triggers it. **No change needed.**

## Decision

**A. The daemon remembers the last server-supplied launch identity per Agent, for exactly the
restart config's lifetime.** `packages/daemon/src/agent-runtime/agent-process-manager.ts` gains a
`ServerLaunchIdentity = Readonly<{ requestId: string; controlEpoch: number; launchId: string }>`
and an optional `serverLaunch?: ServerLaunchIdentity` field on `AgentRestartConfig`, plus
`rememberServerLaunch(agentId, identity)` / `serverLaunch(agentId)`. It is set right after a
managed launch or a rebind commits (never inside `start()` itself, which replaces the whole
`AgentRestartConfig` entry and would otherwise wipe it), and is implicitly forgotten the moment
`stop()`/`shutdown()` deletes the `#restartConfigs` entry — "set on a managed launch and on a
rebind, deleted on explicit Stop / deactivate" falls out of already deleting the same map entry,
with no separate lifecycle to maintain.

**B. `#launchAgent` (runtime.ts) reuses it instead of minting.** `launch.launchId = control?.launchId
?? this.#agentProcessManager.serverLaunch(agentId)?.launchId ?? crypto.randomUUID()`. When a
remembered identity is used, the launch-config request (`#requestLaunchConfig`) now sends that
identity's `requestId`/`controlEpoch`/`launchId` exactly as if it were a `control` scope — this is
what Decision C's server change authorizes against. The daemon's `reportAgentSession` call omits
`previousLaunchId` whenever it would equal the launch's own (new) `launchId` — a guard on the
existing `previousLaunchId` field (`previousLaunchId && previousLaunchId !== launch.launchId`), not
a new field — because a hand-over is meaningless when the identity did not change. An Agent with no
remembered `serverLaunch` (never brought under `AgentControl`, or already forgotten by a Stop) keeps
minting exactly as today — this is the "unmanaged legacy" path from question 1's table.

**C. `authorizeLaunch` gains one additional acceptance branch; still verify-only, zero writes.**
Per question 3, self-initiated launches for a managed Agent are refused today, so this is a
required change, not an optional one. The new rule: accept when the scope is current
(`current(agent, state)`, unchanged) **and** either the existing `phase === "starting"` branch, or
a new branch — `state.phase === "completed"` (which, per the `commands` table, is only ever reached
by a chain step whose command is `start`, so this already implies "the last operation's chain ended
in a start"; no separate `action` check is needed) **and** `state.requestId === input.requestId`
**and** `state.epoch === input.controlEpoch` **and** `input.launchId` is present **and**
`state.launchId === input.launchId` **and** the Agent is not user-stopped (`!agent.stoppedAt`, ADR
0038; `AgentControlAgent.stoppedAt` is already populated by `PrismaAgentControlStore.get()`, no
repository change needed). A superseded operation (different `requestId`/`epoch`), a failed or
stopped operation (`phase` is neither `"starting"` nor `"completed"`), and a stopped Agent are each
refused by a different one of these conjuncts, so each has its own test.

**D. Activity `clientSeq` continues across the process gap.** `AgentProcessManager` gains a second,
independently-lifetimed counter, `#launchClientSeq: Map<agentId, number>`
(`recordClientSeq(agentId, seq)` / `lastClientSeq(agentId)`, default `0`), cleared alongside
`#restartConfigs` in `stop()`/`shutdown()` — deliberately a *separate* map from `AgentRestartConfig`
(not embedded in it) because `start()` fully replaces the `AgentRestartConfig` entry on every call,
which would otherwise erase a counter the whole point is to survive that replacement.
`#emitAgentActivity` (runtime.ts) records the just-sent `clientSeq` into it on every emission.
`#launchAgent` seeds a reused launch's `ActivityLaunch.clientSeq` from `lastClientSeq(agentId)`
instead of `0`; a rebind (`#rebindAgent`) resets it to `0` in lockstep with
`activityLaunch.clientSeq = 0` (a rebind is a genuinely new `launchId`, so a fresh counter is
correct there, matching ADR 0041). This is what makes the PostgreSQL unique constraint and the
Redis `OBSERVE_ACTIVITY` sequence fence (question 4) both accept the first post-wake activity.

**E. The daemon's on-disk `AgentRuntimeRecord` becomes truthful across a wake.**
`AgentControl` (daemon) gains a `wake(agentId, launchId, identity?)` method, the mirror image of
the existing `stopped(agentId, launchId, identity)`: inside the same per-agent `state.run` mutex, a
no-op unless `record.phase === "stopped" && record.launchId === launchId`, in which case it flips
`phase` to `"running"` and captures `identity` — never touching `scope`/`requestId`/`epoch`, so the
existing fence in `start()`/`stop()` is unaffected. `#launchAgent` calls it (fire-and-forget,
`.catch(() => {})`) right after a reused-launchId self-initiated launch succeeds, mirroring where
`#sendAgentStatus(agentId, "active")` already runs. The process-exit handler's existing `if
(control) … this.#agentControl.stopped(...)` (line 1452) is widened to also fire when this launch
reused a remembered `serverLaunch` — both are "this launch's identity is known to `AgentControl`"
the same way. This directly fixes the three scenarios in the task brief:

- **wake → server Start (rebind).** Before this record: the record stays `"stopped"` (or, worse,
  under the old random-minting behavior, `record.launchId` would not even match the process's real
  launch), so `AgentControl.start()`'s rebind precondition (`record.phase === "running" &&
  record.launchId && …`, `agent-control.ts` line 326–333) fails and the server's new operation
  receives `agent_already_running` with **no** result — the exact failure ADR 0041 introduced
  rebind to avoid, reintroduced by the wake gap. After: `wake()` already flipped the record to
  `"running"` under the reused `launchId`, so the rebind precondition holds and the Start correctly
  rebinds to the woken process.
- **wake → server Stop.** `AgentControl.stop()`'s fence only reads `scope`/`phase`/`daemonInstanceId`
  (`agent-control.ts` lines 113–129), none of which `wake()` touches, so a Stop after a wake fences
  and stops exactly as it does for a never-exited process; `AgentProcessManager.stop()` then deletes
  the restart config (and, with it, the remembered `serverLaunch`/`clientSeq` state from Decisions
  A/D), so a later Start mints fresh, matching "explicit Stop forgets it."
- **wake → idle exit again.** The widened exit-handler condition calls `stopped()` with the reused
  `launchId`, which matches `record.launchId` (still `"running"` from `wake()`), so the record
  correctly returns to `"stopped"` — ready for another wake or a fresh managed Start.

**F. One log line per self-initiated launch.** `agent_control:wake_launch` (info), fields
`agent_id`, `launch_id`, `request_id`, `epoch`, `outcome` (`"reused"` when a remembered identity was
used, `"minted"` for the unmanaged-legacy fallback), emitted once from `#launchAgent` alongside the
existing launch bookkeeping.

## Rejected alternatives

- **Keep minting and `previousLaunchId`.** The status quo before this record; rejected because it
  diverges from Raft for no compensating benefit and, per question 3's finding, self-initiated
  launches for managed Agents do not even reach the point of using the minted id today — they are
  refused outright, so the divergence is not merely cosmetic.
- **Ask the server for a Start instead of self-launching.** Would turn every wake into a
  request/response round trip before the Agent can see its own queued message, adding latency and a
  new failure mode (Computer offline) to a path that today only needs local state; Raft's daemon
  does not do this either (it restarts locally from its own snapshot).
- **Mint on the daemon but register the new id via a new RPC before launching.** Adds a wire
  message and a round trip for something the server already knows (the last `launchId` it gave this
  Agent) — reusing that id needs no new information to flow from daemon to server at all, only a
  server-side acceptance rule (Decision C).

## Consequences and migration plan

- Additive: `AgentProcessManager`'s new fields/methods and `AgentControl.wake()` (daemon) have no
  wire format; `authorizeLaunch`'s new branch (web) only widens acceptance, never narrows it — no
  existing accepted launch becomes refused.
- No wire/proto change: the launch-config HTTP body already accepts `controlEpoch`/`requestId`/
  `launchId` as optional fields (`createAgentApiKeyInputSchema`); this record only changes when the
  daemon populates them and how the server evaluates them.
- Computers older than this record keep today's behavior end to end (mint + refused wake for a
  managed Agent); no explicit compatibility branch is needed because the server's new acceptance
  branch is purely additive and an old daemon never sends the fields it depends on.

## Validation and rollback criteria

- Daemon: a wake reuses the remembered `launchId` and sends no `previousLaunchId`; `clientSeq`
  continues past the pre-exit high-water mark; an explicit Stop forgets the remembered identity
  (next managed Start mints fresh); a rebind updates the remembered identity; an unmanaged Agent
  still mints; the three `AgentControl.wake()`/`stopped()` record scenarios (wake → Start rebind,
  wake → Stop, wake → idle exit again).
- Web: `authorizeLaunch`'s accept/refuse matrix (starting-phase unchanged; completed-phase reuse
  accepted; superseded requestId/epoch refused; failed/stopped-phase refused; stopped Agent
  refused) with zero writes in every case; a session report after a wake is accepted by
  `AgentSessions.verify`/`AgentSessionReceiver.authorize` by exact `launchId` match with no code
  change to either.
- Roll back by reverting this record's daemon and web changes together; both sides are additive, so
  reverting either alone only returns that side to today's (working, if divergent-from-Raft)
  behavior.

## VERIFIED vs INFERRED (Raft comparison)

**VERIFIED** (shipped 1.0.32 bundle, design reference only, never copied):
`restartSnapshot`/`cached` objects carry a `launchId` field; both the recoverable-error restart and
the idle auto-restart call `startAgent(..., restartSnapshot.launchId)` / `cached.launchId`, i.e.
reuse rather than mint.

**INFERRED** (Raft's server is not available to inspect): that Raft's server accepts a
daemon-initiated launch under a previously-issued `launchId` the same way Decision C's new
`authorizeLaunch` branch does, and that it also conditions acceptance on the Agent not being
user-stopped. CoForge's own ADR 0038 (`stoppedAt`) has no known Raft equivalent to compare against
directly; the `!agent.stoppedAt` conjunct here is this record's own application of ADR 0038's
already-established rule ("nothing may start or wake it except an explicit user Start") to this new
acceptance path, not a claim about Raft's implementation.
