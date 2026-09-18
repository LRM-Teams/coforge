# ADR 0050: Display the Agent's current context-window usage in the profile panel

Status: accepted
Date: 2026-09-18

## Context

CoForge tells a human when an Agent's provider is compacting its context (`compacting_context`/
`compaction_finished`/`compaction_stale` in `AGENT_ACTIVITY_DETAIL_KIND`) but never how full that
context window actually is at any given moment. ADR 0036 gave the Agent itself a MEMORY.md
convention so it can carry working notes across a fresh session, but nothing today tells a human
*when* handing an Agent over to a fresh session would help — only the Agent's own provider (via
auto-compaction) and, indirectly, an Activity stream a human would have to read closely to infer
staleness from. Frank asked (2026-09-18) for a plain, at-a-glance signal of how full the current
Agent's context window is, purely so a human can judge when to start a fresh session; he was
explicit that this is a **manual** decision aid, not the seed of automatic handoff — nothing in
this design computes or suggests when to restart, and nothing here builds toward that.

Claude Code's `--output-format stream-json` already reports enough on every turn's top-level
`result` record to compute this (verified 2026-09-18 on Claude Code 2.1.276): `usage.iterations`
carries each iteration's own token counts, and `modelUsage` carries each model's `contextWindow`.
No other provider was found to report an equivalent signal on a real probe turn as of this date
(Kiro's `usage_update` did not appear once): this feature ships for Claude Code only, with the
wire and daemon-core surfaces left generic enough for another provider to fill in later without a
wire change.

Raft 1.0.32 has no equivalent (checked 2026-09-18) — the profile panel's own hover hover-usage
popover (ADR from the runtime-usage comparison work) reports provider *plan* usage (rate limits,
credits), an entirely different quantity from context-window fullness. This is CoForge's own
design; there is nothing to compare it against.

## Decision

**A. A new fire-and-forget wire message, `AgentContextUsage`, method `agent:context:usage`.**
Modeled directly on `AgentSessionInvalidate` (ADR 0040): defined next to it in
`packages/coforge-sdk/proto/coforge/rpc/v1/workspace.proto`, fields `protocol_major, request_id,
workspace_id, computer_id, agent_id, provider, launch_id, session_id, used_tokens (uint64),
window_tokens (uint64), observed_at_ms (uint64), daemon_instance_id, client_seq (uint64)`,
numbered contiguously 1–13 (this message never shipped, so there is nothing to reserve). The SDK
type, `encodeAgentContextUsage`/`decodeAgentContextUsage` (same scope/length validation
discipline as the sibling codecs, plus numeric bounds on the four count/time fields), and
round-trip/negative/wire-tag-stability tests live beside `agent-session-invalidate.test.ts`.

**B. Claude Code alone computes the reading, at the top-level `result` record.** `usedTokens` is
the last `iterations[]` entry with `type === "message"`: `input_tokens + cache_read_input_tokens +
cache_creation_input_tokens`. `windowTokens` is `modelUsage[model].contextWindow`, where `model`
is the entry whose key or `canonicalModel` matches the Agent's configured model when one is
configured, otherwise the entry with the largest `inputTokens + cacheReadInputTokens +
cacheCreationInputTokens` (a subagent turn adds extra models to this map). If `iterations` is
absent/empty or no matched entry carries a `contextWindow`, nothing is emitted — the window size
is never guessed. Only the daemon-core-owned `AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE` event
(`"context-usage"`) carries this out of the provider; the daemon core, not the provider, decides
what becomes a wire message, matching every other provider signal in this codebase.

Deviation from the brief that named `packages/daemon/src/code-agent/contract.ts` for the event
*shape*: that file only re-exports `AgentRuntimeEvent` from `@coforge/agent`
(`packages/agent/src/contract.ts`), which is where every other event variant (`"usage"`,
`"tool-start"`, `"compaction-started"`, …) is actually defined as part of the discriminated union.
The new `{ type: "context-usage"; usedTokens; windowTokens; occurredAt? }` variant was added there,
alongside `AGENT_RUNTIME_EVENT_TYPE.CONTEXT_USAGE = "context-usage"` in the daemon's own contract
file exactly as specified, since that constant genuinely lives there today.

**C. The daemon sends it once per changed reading, never blocking or failing the turn it
observed.** `daemon-runtime/runtime.ts`'s `#observeRuntimeEvent` routes the event to
`#sendContextUsage`, which reads the Agent's current native session id from
`#sessionReferences` (skipping, not throwing, when it is not yet known — e.g. before the first
`result` of a brand-new session has round-tripped through `reportAgentSession`), compares
`(usedTokens, windowTokens)` against `#lastContextUsage`'s last-sent value for that Agent, and, if
unchanged, does nothing. Otherwise it sends `AgentContextUsage` via
`DaemonConnectionClient.sendAgentContextUsage` — a new optional, fire-and-forget method on
`daemon-connection.ts`, buffered latest-per-agent while disconnected and flushed on reconnect
exactly like `sendSessionInvalidate`, with the same one-per-connection-lifetime "unknown RPC
method" log suppression for talking to an old server — carrying the launch's own `clientSeq`
counter (the same counter `#emitAgentActivity` advances, so ordering interleaves correctly with
Activity on the wire) and `Date.now()` as `observedAtMs`. `#lastContextUsage` is forgotten
wherever `#compactionTracker.dispose(agentId)` already is (launch end/dispose), so a new launch
always sends its first reading.

**D. The server accepts a reading only for the Agent's current launch, and stores it in the
display read model, not the control record.** `createAgentContextUsageMethod`
(`apps/web/src/server/centrifugo/agent-context-usage-receiver.server.ts`, registered in
`rpc-composition.server.ts` beside the session methods, including its `unavailableMethod`
fallback entry) authorizes the transport principal the same way
`createAgentSessionInvalidateMethod` does, then requires `AgentControlState.launchId ===
message.launchId` (via the same `AgentControlStore` the session receiver already holds) before
writing anything — a dead or superseded launch's reading never reaches Redis, let alone paints
the badge. Every domain-level mismatch (unknown Agent, foreign scope, non-matching provider, stale
launch) is its own idempotent no-op, returning success to the daemon exactly like
`AgentSessionReceiver.invalidate`'s contract; only a malformed payload or foreign transport
principal is a genuine RPC error. A genuine store failure (not a domain mismatch) propagates and is
logged with the same allowlisted-`reason` convention #321 introduced.

The reading itself lives in `agent-display.server.ts`'s Redis+Lua display state, not
`AgentControlState` — it is a live, ephemeral display fact (the same 24-hour-TTL state Activity's
`kind`/`detailKind` already live in), not part of the control record's compare-and-swap fence. A
new `PUT_CONTEXT_USAGE` script writes `state.contextUsage = { launchId, daemonInstanceId,
clientSeq, observedAt, usedTokens, windowTokens }`, guarded by the same
daemonInstanceId/clientSeq-then-observedAt ordering rule `OBSERVE_STATUS` already uses for
`state.process`, and bumps `revision(state)` only when `(usedTokens, windowTokens)` actually
changed (an advancing `clientSeq`/`observedAt` alone does not repaint the browser). The RPC handler
publishes the resulting snapshot on the status channel exactly the way `createAgentStatusMethod`
already does for its own `display.observeStatus()` write: `publishJson(agentStatusChannel(...),
{ type: "agent:display", ...snapshot })`.

**Deviation from the brief's exact Lua design.** The brief asked for `snapshot()` to gate
`contextUsage` on `state.contextUsage.launchId` equaling "the launch the process state knows,"
adding a launch id to `state.process` "where process status is written" if one is not already
there. `AgentStatus` (`packages/coforge-sdk/proto/.../workspace.proto`) carries no `launch_id`
field — ADR 0040 §C states this explicitly ("`AgentStatus` carries no launch identity today") as
the reason `#observeLaunchIdentity` must instead watch `reportAgentSession`. Adding one would be a
wire change well outside this feature's scope, and the daemon does not send one today regardless.
Following the code instead of the brief here: `snapshot()` gates on `state.contextUsage`'s own
`daemonInstanceId` matching `state.process.daemonInstanceId` (the daemon instance's identity
*is* on `AgentStatus`) and on `state.contextUsage.launchId` not being `state.retiredLaunchId` — the
same bounded, best-effort "one retired launch remembered" fence `OBSERVE_ACTIVITY` already uses to
stop a stale cross-launch Activity from resurrecting, not a database race fence. `OBSERVE_STATUS`
also clears `state.contextUsage` whenever it resets Activity visibility (process going inactive, or
a different daemon instance taking the process over); `OBSERVE_ACTIVITY` clears it when the launch
it belongs to is the one an incoming different-launch Activity just retired. Because the daemon
always emits a `starting` Activity at the very start of a new launch, this closes the practical gap
between "no launch id on the wire" and "a stale launch's reading never paints the badge" for every
real launch transition; it is not a database-level guarantee, matching every other bounded fence
`agent-display.server.ts` already relies on.

**E. `AgentDisplaySnapshot` gains an optional `contextUsage` field, tolerant of an older server.**
`packages/coforge-sdk/src/internal/agent-display.ts`: `contextUsage?: { usedTokens: number;
windowTokens: number; observedAtMs: number } | null` — `undefined` when the field is entirely
absent (an older server that has never written it), `null` once written but nothing currently
qualifies to show (offline, wrong daemon instance, retired launch), and the validated object
otherwise. `parseAgentDisplaySnapshot` never rejects a snapshot for lacking the field, only for a
malformed one when present. The profile tab (`agents/profile-panel/agent-profile-tab.tsx`) already
receives the whole snapshot through both surfaces named in the brief — the realtime status channel
(`agent-status-realtime.ts`'s `applyAgentDisplaySnapshot`, feeding `useLiveAgent`) and the initial
`getAgentProfile` load (`agent-detail.server.ts`'s `AgentDetailQuery.get`, spread into the response
at the line the brief pointed at) — so no new query or field-threading code was needed in either
seam; `agent-profile-panel.tsx` only had to read `contextUsage` off the snapshot object already in
hand, preferring the live snapshot's own value (including an explicit `null`) over the initial
load's once a live snapshot has arrived at all.

**F. Display only, and only a plain read.** A second `FactBadge` beside Runtime reads
`m.agent_context_usage_badge({ percent })` (`Context 42%`, `Math.round(used / window * 100)`
clamped 0–100) and is omitted entirely — not rendered, not disabled — when there is no reading.
Its tooltip (`m.agent_context_usage_tooltip`) shows `<used> / <window> tokens` (formatted with
`Intl.NumberFormat` in the viewer's locale) and the observed time using the exact helper
(`formatDateForDisplay`, workspace time zone) the Runtime usage popover's own `RelativeTime`
already renders through. No color threshold, no warning state, no toast, and nothing here computes
or suggests a handoff — this is purely what Frank asked for: a fact a human reads and acts on
themselves.

## Rejected alternatives

- **Piggy-backing the reading on an existing message (`AgentActivity` or `AgentSessionReport`).**
  Ruled out for the same reason ADR 0040 rejected it for session invalidation: a real, independent
  wire fact deserves its own message, not an overloaded field on a message whose own contract (an
  Activity narrative; a session-identity report) has nothing to do with token counts. It would
  also force every `AgentActivity` consumer to reason about a field that is irrelevant to activity
  narration.
- **Storing the reading in `AgentControlState` instead of the display read model.** Rejected: the
  control record's compare-and-swap fence exists to protect control operations (start/stop/reset),
  not a passively observed, frequently-changing display fact with no bearing on control state. The
  display read model already exists for exactly this kind of live, ephemeral, launch-scoped fact
  (Activity's own `kind`/`detailKind`).
- **Guessing the context window from the model's published catalog entry instead of requiring
  `modelUsage[...].contextWindow` on the wire.** Rejected: never guess a window size. A stale
  local catalog could silently misreport it; an absent `contextWindow` on the wire is a clean,
  honest "no reading" instead.
- **Adding `launch_id` to `AgentStatus` to give the Lua gate an exact launch fence.** Rejected as
  out of scope for this feature — a wire change to an existing, already-shipped message for a
  display-only convenience, when the bounded daemonInstanceId/retiredLaunchId fence already closes
  the practical gap (decision D's deviation).

## Consequences

- **The server must deploy before the Computer release that ships this daemon change.** An old
  server rejects `agent:context:usage` with an unrecognized-method 404, logged once per connection
  lifetime and otherwise harmless — no turn is blocked or delayed by it, matching ADR 0040's own
  wire-compatibility guarantee.
- **Kiro and Pi are explicit follow-ups**, not silently unsupported: the daemon-core event and Lua
  storage are provider-agnostic; only Claude Code's provider currently emits the event. A future
  provider adds its own extraction logic and nothing else changes.
- **The badge disappears after the provider's own auto-compaction runs a fresh reading through with
  a smaller `usedTokens`** — this is correct, not a bug: the display always reflects the provider's
  own current state, and a human deciding "should I hand this off" is exactly the judgment this
  feature exists to support, never automated by it.
- **Wire-compatible.** `AgentContextUsage` is a new message and RPC method; nothing existing
  changes shape or meaning.

## Validation and rollback

Covered by: `packages/coforge-sdk/src/internal/agent-context-usage.test.ts` (codec round-trip,
negative validation, contiguous wire-tag numbering); `packages/daemon/test/
claude-code-agent-adapter.test.ts` (a fixture `result` record round-trips to the correct
`usedTokens`/`windowTokens`, model selection prefers the configured model over the largest entry,
and an absent `contextWindow` emits nothing); `packages/daemon/test/daemon-runtime.test.ts` (a
changed reading is sent once and de-duplicated, and none is sent while the current session id is
unknown); `packages/daemon/test/daemon-connection.test.ts` (sent as an RPC when connected, buffered
and flushed once on reconnect, and an unrecognized-method rejection is logged at most once per
connection); `apps/web/test/agent-context-usage-receiver.test.ts` (a matching launch is accepted
and published, a stale launch/unknown Agent/foreign scope is an idempotent no-op, a genuine store
failure propagates); `apps/web/test/agent-display.test.ts` (the Lua ordering/dedup/clear rules);
`apps/web/test/agent-status-realtime.test.ts` (`parseAgentDisplaySnapshot` tolerates a missing
field and validates one present); `apps/web/test/agent-profile-tab.test.tsx` (the badge is hidden
with no reading and shows the rounded, clamped percentage otherwise). Rollback is by revert: the
change is additive to the wire protocol, the display snapshot shape, and the Lua state shape, and
requires no data migration in either direction.
