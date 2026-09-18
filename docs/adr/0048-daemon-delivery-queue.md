# ADR 0048: Daemon-owned delivery queue with busy gating

Status: accepted
Date: 2026-09-18 (revised 2026-09-18: Kiro moved from `queue_until_idle` to its own `_session/steer`)

## Context

`packages/daemon/src/daemon-runtime/agent-message-attention-index.ts` calls `session.notify(notice)`
immediately for every accepted delivery, regardless of what the runtime is doing. Each provider's
own `AgentSession.notify` decides what "accept a notification mid-turn" means
(`packages/agent/src/contract.ts:130`, "Adapters own native steering/queued-input protocols").
Claude holds a notice until a native boundary (`claude-code/provider.ts` `#waitingNotices`/
`#flushNotices`), Codex steers the active turn (`turn/steer`), and Pi/CoForge steer the live SDK
stream (`streamingBehavior: "steer"`) — all three tolerate a delivery arriving mid-turn without
losing work. Cursor is a per-turn process; its own `#deliver` queues text at the provider layer and
joins it into the next turn once the current process exits, so it also never loses work, even
though it is not "steering" in the literal sense. Kiro (`kiro/provider.ts#notify`) had no such path:
it always sent a fresh ACP `session/prompt`, and the measured Kiro v3 behavior (observed 3× on
2026-09-18) was that this **cancelled the running turn** (`turn_end` `stopReason: "cancelled"` in the
same millisecond a second inbox notice arrived) — work in progress was lost.

This ADR's first revision fixed that by gating Kiro at the daemon layer (`queue_until_idle`: hold
every notice until the turn ends). Frank's follow-up research found Kiro CLI ships its own ACP
steering extension — `_session/steer`, undocumented but present since at least kiro-cli 2.22.0 —
matching Kiro CLI's own default steer behavior and Raft's ACP Grok adapter (interject when busy,
`session/prompt` when idle; bundle 838326–838350). The decision changed: Kiro now steers into the
running turn like every other provider, using its own native protocol, and moves to `steer` mode.
The `queue_until_idle` mode and its daemon-level hold/flush machinery stay in the codebase — no
provider needs them today, but a future one might, and the fallback path below (steer accepted but
never actually delivered) reuses this same module for a related but distinct purpose. See
"Kiro's own busy delivery" below for the full design and "Divergences" for what changed.

This PR is the spine three later PRs in the same series (error backoff, the 3-strike fence, crash
restart, stall recovery) attach to, so its queue module is designed to hold state those PRs can
read and pause, not just to fix Kiro.

### Kiro's own busy delivery: `_session/steer` (measured evidence)

Measured directly against a real, authenticated kiro-cli 2.22.0 engine on 2026-09-18 (this Mac),
using a raw ACP session built on `KiroConnection` — `initialize` → `session/new` → select the
`mode` config option → `session/prompt` with a slow shell tool (`sleep 12`) → `_session/steer`
mid-turn while the tool ran. Frank separately confirmed the same contract from the kiro-cli
2.22.0 ACP server source on another machine (`acp-server.js`); this section records what the wire
actually showed here, cross-checked against those source facts:

- Request: `_session/steer` with params `{sessionId, message}` (an optional `messageId` is
  accepted but Kiro mints its own `steer-<uuid>` when omitted, which every capture here used).
  Response on success:
  ```json
  {"queued": true, "messageId": "steer-f85e2256-4fb6-47fd-ae15-c1a48ab5982d"}
  ```
- On acceptance, Kiro immediately broadcasts a `session/update` `session_info_update` with
  `_meta.kiro`:
  ```json
  {"kind": "steering_queued", "messageId": "steer-f85e2256-…", "content": "STEER-MARKER-ONE: …"}
  ```
- Once the model reaches a turn boundary and actually reads it, a second update follows with the
  same shape, `kind: "steering_injected"` (same `messageId`, same `content`). Measured across two
  independent captures, this fired within tens of milliseconds of the request in both cases —
  Kiro injects eagerly, even right at the very start of a turn, not only at its natural end.
- At turn end (`turn_end` `stopReason: "end_turn"`), Kiro broadcasts exactly one more
  `session_info_update`:
  ```json
  {"kind": "steering_cleared", "messageIds": ["steer-f85e2256-…"]}
  ```
  `messageIds` is always an array, even for one id, and can include ids already confirmed by a
  prior `steering_injected` (both captures here injected before clearing).
- Not independently reproduced live (kept as source-derived facts from the same research, since
  forcing the exact race deterministically proved impractical within this work's time budget —
  documented honestly rather than guessed): `queued: false` with `dropped: "epoch_changed"` when a
  turn boundary races the steer request's own persistence; a `steering_cleared` for an id with no
  preceding `steering_injected`, when Kiro's own continuation-retry (up to 3 further turns,
  `imu=3`) exhausts without ever reading it or the buffer clears on `session/cancel`; and a
  JSON-RPC `-32601` "method not found" on a kiro-cli build without this extension. The fixture
  script (`packages/daemon/test/fixtures/kiro-acp.ts`) simulates all three via message-text
  keywords (`steer-queued-false`, `steer-clear-without-inject`, `steer-not-found`) built from
  these facts, not from a live capture of the race itself.
- Kiro throws on an unknown `sessionId` or an empty `message` (source fact; not separately
  re-verified live here, since triggering it deterministically added no signal beyond the
  documented contract).

### Reference behavior read (Raft Computer 1.0.32, `raft.cjs`)

- Delivery routing (845642–845823): idle writes to the runtime immediately
  (`deliverInboxUpdateViaStdin`); busy queues into `ap.inbox` (`queueAgentInboxMessage`) and, only
  for a driver with `supportsStdinNotification`, schedules a debounced stdin notification
  (`STDIN_NOTIFICATION_INITIAL_DELAY_MS` 3 s, retry `STDIN_NOTIFICATION_RETRY_DELAY_MS` 15 s,
  constants at 842548–842566); a driver without it (`busyDeliveryMode: "none"`, e.g. Cursor,
  Copilot — both per-turn-process drivers, 838650–838668) just queues, with no timer at all.
- `commitApmIdleState(agentId, ap, false)` is called at every send site (823864, 823950, 845664,
  846026, 846882, …), i.e. **busy is set synchronously at send time**, not derived from a later
  provider event; `commitApmIdleState(agentId, ap, true)` marks idle at turn end and process-exit
  recovery sites (847059, 847898, 848383, 848482, 848528).
- The busy/idle transition (`commitGatedSteeringDecisionState` → `commitApmIdleState`, 847095–847116)
  drives a much larger "gated steering" effect system (`executeApmGatedSteeringEffect`,
  `reduceApmIdleState`) that also covers compaction/review boundaries, runtime-profile control
  messages, App Inbox draining, and thread-join-context rendering — none of which this PR
  reproduces (see Divergences).
- Per-driver `busyDeliveryMode`/`supportsStdinNotification` is the shape our `AgentDeliveryMode`
  table (`steer` vs `queue_until_idle`) mirrors, at a much smaller scale (this PR only gates
  providers with no safe busy path at all).

## Decision

**New module** `packages/daemon/src/daemon-runtime/agent-delivery-queue.ts`, `AgentDeliveryQueue`:

- Per-Agent delivery mode, from a `Record<RuntimeProvider, "steer" | "queue_until_idle">` table
  (`AGENT_DELIVERY_MODE`): every provider is `steer` today, including Kiro (its own `notify` now
  steers a busy turn through its ACP `_session/steer` extension — see below). No provider is
  `queue_until_idle` any more; the mode and the daemon-level hold/flush machinery it drives stay in
  the module for a future provider that needs it, unused by this PR's own wiring — `setMode` (a new
  primitive `setProvider` now calls through) is the only way to reach it, including from this
  module's own tests, since no `RuntimeProvider` maps to it any more.
- Per-Agent busy/idle state and an explicit `shouldHold(agentId)` predicate: true only when the
  provider is `queue_until_idle` **and** the Agent is currently busy, or an explicit hold (below)
  is in effect.
- `enqueue`/`pending`/`hasQueued`: the held `AgentMessageDelivery[]` list itself, exposed read-only
  for later PRs (crash restart carrying it into a relaunch; stall recovery deciding a stuck Agent
  needs help).
- `hold(agentId, until?)`/`release(agentId)`: an **explicit** hold seam, independent of busy/idle,
  for the later error-backoff and 3-strike-fence PRs. This PR stores and clears the marker only —
  it does not schedule an automatic release; that is deliberately left to whichever later PR
  interprets `until`.
- `busy(agentId)`/`idle(agentId)`/`onProcessExit(agentId)`/`clearAgent(agentId)`: lifecycle (see
  below).

**Wiring in `daemon-runtime/runtime.ts`:**

- `#launchAgent` calls `#deliveryQueue.setProvider(agentId, config.provider)` once the launch's
  `config` is known.
- `#observeRuntimeEvent` also marks busy on every event except `"session"`, `"usage"`, and
  `"completed"` (activity, tool-start/-end, compaction-*, a content-free `"progress"` ping,
  `"error"`, `"reconnecting"`) — a backstop, not the primary mechanism; see "Busy is marked at
  every send site" below for why the primary mechanism is elsewhere. Marks idle exactly on
  `"completed"`, then flushes whatever was held (message deliveries, then held app items — see
  "App items" below).

**Wiring in `AgentMessageAttentionIndex`:** a new, optional constructor collaborator
(`{ shouldHold, enqueue, busy }`, defaulting to "never hold, no-op busy" so every existing caller
and test is unaffected) and a new `flush(agentId, held)` method.

- `receive()` still does its dedupe/attention/pendingSequences bookkeeping unconditionally for
  every delivery, held or not — only the `session.notify()` call (and therefore the ACK) is
  skipped when `shouldHold` is true; the delivery is handed to `enqueue` instead and the call
  returns without acking. This applies to both the "first time we've seen this deliveryId" path
  and the "already seen, not yet notified" resend path (a not-yet-acked delivery that the server
  retried), so a resend while held stays held rather than notifying early.
- `flush(agentId, held)` calls `#notify()` **once**, on the most recent held delivery — reusing the
  existing coalesced-notice text as-is (no new wording), which already reads live
  `pendingCount`/`totalPendingCount` off the attention state `receive()` kept updating the whole
  time it was held — then ACKs every held delivery once that single notice is accepted, never on
  failure.

**Busy is marked at every send site, synchronously, not derived from provider events.** An
earlier version of this PR only marked busy from the next provider event after a delivery, which
left a real race: `receive()`'s per-Agent input queue drains deliveries serially, but each
`#notify()` call only *awaits* until the provider *accepts* the notice (e.g. Kiro's ACP admission),
not until the turn it starts actually finishes — so a second delivery could be drained, and decided
upon, before the runtime had emitted a single event of its own, and would see a stale "not busy"
state. Matching Raft's `commitApmIdleState(agentId, ap, false)` at every send site, every place this
class (or `runtime.ts`, for app items) calls `session.notify` now calls the injected `hold.busy(agentId)`
synchronously, in the same tick, *before* constructing the notice or awaiting anything:

- `#notify()` — covers every ordinary delivery and every coalesced `flush`.
- `recover()` — covers the wake/restart summary notice (`session.notify(...)` around what was line
  218 before this change).

Because JavaScript is single-threaded and `busy()` runs synchronously as part of evaluating the
`#notify(...)`/`recover(...)` call, by the time the daemon's serialized per-Agent input queue drains
the *next* item — even microseconds later, even before the provider has said anything — `shouldHold`
already sees the Agent as busy. This closes the race for every delivery. For Kiro specifically (the
only `queue_until_idle` provider today) it also closes the previously-noted "launch bootstrap"
gap: `KiroSession#open` (`kiro/provider.ts`) never sends a turn during session creation — the
standing instructions are injected as a native profile/config selection
(`session/set_config_option`), not a prompt — so a fresh Kiro session is genuinely idle until the
first `#notify`/`recover`/app-item call this class makes, all three of which now mark busy
themselves. (A provider that *did* send an actual first turn as part of its own bootstrap, outside
any call this class makes, would still have a narrow gap here — but no `queue_until_idle` provider
does that today, so this is not a live gap; a future `queue_until_idle` provider that bootstraps
with a real first turn would need to mark busy itself, e.g. via a `session`-identity event, or this
module would need a fourth send site.)

**App items** (`DaemonRuntime#notifyAppItem`, "New app item available…") used to call
`session.notify` unconditionally, bypassing this queue entirely. It now runs the same
`shouldHold`/`busy` check as an ordinary delivery: held, it records the item id via
`AgentDeliveryQueue.holdAppItem`/`releaseAppItems` (a small separate id set, not an
`AgentMessageDelivery`, since app items are a different subsystem — `agent-app-inbox/` — with their
own identity and retention) and returns `false` (not yet delivered — `#notifyAppItem`'s existing
"not accepted, memo cleared" bookkeeping already handles a retry correctly, unchanged). Release
happens at turn end, **after** the message-delivery flush, not joined into the same notice: the
flush's own `#notify()` call marks busy again synchronously if it actually had something to send,
so checking `shouldHold` again for a held app item — inside `#notifyAppItem`'s own fresh
re-evaluation — correctly re-holds it for the *next* turn end instead of racing a second
`session.notify` call against the turn the flush just started (which would reproduce the exact bug
this PR fixes, between the flush and the app item). When the flush had nothing to send, the app
item's own `shouldHold` check sees idle and delivers immediately. This was simpler than joining app
items into the coalesced delivery notice, and app items never shared that notice's wording or
target/pendingCount shape to begin with.

**Kiro's provider-level implementation** (`kiro/provider.ts`, `KiroSession`):

- `#turn: Promise<void> | undefined` already tracked "a `session/prompt` RPC is outstanding"
  before this change (set when issued, cleared once it settles). `notify()` now reads it directly:
  idle (`#turn` undefined) sends `session/prompt` exactly as before; busy (`#turn` set) calls the
  new `#steer()` instead. `#turn` is now cleared *inside* the `session/prompt` promise's own
  `.then`/`.catch`, before emitting `"completed"`, not only in the outer `finally` block's safety
  net — a listener reacting to `"completed"` (a held fallback notice's redelivery, below) must
  already see the Agent as idle in that same synchronous handler, or it would itself steer into a
  turn that is, from the daemon's perspective, still nominally running.
- `#steer(message)` calls `_session/steer` and resolves once Kiro answers `queued: true`, recording
  `{messageId → {text: message, injected: false}}` in a new `#steeredMessages` map. It rejects —
  never resolves — on anything else (a throw, an unrelated JSON-RPC error, or `queued: false`),
  after emitting `notice-undelivered` with the exact text, so a delivery that was never truly
  accepted is never mistaken for one that was (item 3 below).
- `#update()` gained two more `_meta.kiro.kind` branches: `steering_injected` marks the matching
  map entry's `injected: true`; `steering_cleared` deletes each cleared id from the map and — only
  for one whose `injected` was still `false` — emits `notice-undelivered` with its remembered text.
  A cleared-and-already-injected id is silently dropped from the map; nothing is re-emitted for it.
- `dispose()` clears `#steeredMessages`; a session that never sees its own `steering_cleared` (a
  crash, a forced dispose) simply forgets those ids rather than leaking them.

**The fallback: `notice-undelivered` and redelivery once idle.** `AgentRuntimeEvent` gained a new
variant, `{ type: "notice-undelivered"; text }` (`packages/agent/src/contract.ts`) — provider-
neutral, not Kiro-specific, for any `steer`-mode provider whose own busy-delivery protocol can
accept a notice and later learn it never reached the model. `runtime.ts#observeRuntimeEvent` holds
the text (`AgentDeliveryQueue.holdFallbackNotice`, a small separate `string[]` per Agent — *not*
the `queue_until_idle` mode's `AgentMessageDelivery` hold list, since this text has no delivery
identity of its own to ACK) and redelivers every held text at the next `"completed"` event
(`#releaseFallbackNotices`, after the message-delivery flush and the app-item release in the same
handler) as a bare `session.notify(text)` call — never through `AgentMessageAttentionIndex`, since
whatever this text originally came from already settled its own ACK (or, for an App Inbox notice,
never had one). If the Agent has gone busy again by the time this runs (its own steer of an earlier
held text already started a fresh turn), that `notify` call steers this one into the new turn
instead of losing it, exactly as an ordinary delivery would.

Surviving fallback notices are handled exactly like held app items across a relaunch — always
released, never dropped, regardless of whether that launch's `recover()` had content — because this
module cannot tell whether a given held text came from a Message delivery `recover()`'s canonical
unread state already covers, or from an App Inbox notice it never mentions; always releasing is the
only choice that never silently drops one. `onProcessExit` keeps fallback notices, like deliveries
and app items; explicit Stop (`clearAgent`) discards them.

**ACK semantics (item 3): a notice counts as accepted exactly when `_session/steer` returns
`queued: true`.** `#steer()`'s promise is what `AgentMessageAttentionIndex.receive()`/`recover()`
(or `DaemonRuntime#notifyAppItem`) await to decide whether to ACK — resolving only on `queued: true`
means the existing "ACK only after `AgentSession.notify` accepts the notice" invariant is completely
unchanged by steering: a delivery is ACKed once, at the moment its own `notify()` call actually
succeeds, whether that landed via `session/prompt` (idle) or `_session/steer` (busy, `queued: true`).
The fallback redelivery path is the reason a second ACK for the same delivery can never happen: it
calls `session.notify` directly, bypassing `AgentMessageAttentionIndex` (and `#notifyAppItem`'s own
memo) entirely, so there is no ACK-producing code path anywhere near it to accidentally trigger
twice.

**ACK/generation semantics kept exactly as they are today**: ACK happens only after
`AgentSession.notify` accepts the notice, never before (the architecture invariant in
`AGENTS.md`/`daemon/AGENTS.md`). Holding a delivery is therefore indistinguishable, from the
server's point of view, from an ordinary slow/unacknowledged delivery — a held-but-unacked message
is safe to redeliver and does not double-count (the existing `seenDeliveryIds`/`modelSeenSequence`
dedupe already covers a redelivered, still-unacked message). This PR adds no new ACK-timing
concept; it only changes *when*, not *whether*, a delivery reaches `#notify`.

**Queue lifetime** (`runtime.ts` decision, read alongside the existing
`#messageAttention.clearAgent` call sites):

- **Explicit Stop** (`#releaseAgentRuntime`) calls `#deliveryQueue.clearAgent(agentId)` alongside
  the existing `#messageAttention.clearAgent(agentId)` — a Stop discards anything still held, same
  as it already discards attention state.
- **An unexpected process exit** (`onExit`, ~1668) calls a new `#deliveryQueue.onProcessExit(agentId)`
  instead — it clears only the busy flag (the turn that was running is gone), and deliberately does
  **not** clear held deliveries, so `pending()`/`hasQueued()` stay truthful for the next launch.
  `AgentMessageAttentionIndex.clearAgent` is still called at that same exit point, unchanged — its
  dedupe/generation bookkeeping is reset per process generation regardless, and its own recovery
  path (`recover()`, fed by the server's canonical unread state) is what actually repopulates
  attention on the next launch; that mechanism does not read this queue.
- A relaunch (the `#launch` pre-launch clear at ~1298) does **not** clear the delivery queue either
  — it only clears attention state, for the same reason.

**Surviving held deliveries are released at the next launch, not left to a later PR.** A held,
unacked delivery that survives an unexpected exit has no other trigger that would ever flush it:
`AgentDeliveryQueue.idle()` only fires on a `"completed"` event, and a Kiro session that has not yet
run any turn on its new launch never produces one. Left alone, it would sit in memory forever,
never ACKed, so the server would keep believing it undelivered indefinitely. `#recoverAttention`
(called once per launch, from the per-Agent input queue, so it only runs once the new launch's
session actually exists) now settles this queue in the same place it settles `recover()`, choosing
one of two paths per launch rather than trying to reconcile per target:

- **If this launch's recovery context had any content** (`wakeMessage`/`resumeMessages`/
  `unreadSummary` non-empty — `recover()` therefore actually sent a notice): the surviving held
  deliveries are **dropped and ACKed** (`AgentDeliveryQueue.discardPending` +
  `#ackHeldDelivery` for each), never separately flushed. The server's own unread ledger, not this
  in-memory queue, is what a crashed-and-relaunched Agent's `resumeMessages`/`unreadSummary` are
  built from (architecture.md §6.1, point 7) — since these held deliveries were never ACKed, the
  server still considered them canonically unread and this same recovery pass already carries
  them (up to its own 100-message cap and target-summary rules, identical to how it already covers
  everything else the server considers outstanding for this Agent). A second, separate notice for
  the exact same content would be redundant, and — worse — would itself be a coalesced-`flush`
  `session.notify()` call landing on a session that `recover()` may have *just* made busy, risking
  the very race this PR closes.
- **If this launch's recovery context was empty** (no wake message, no resume messages, no unread
  summary at all — `recover()` never ran): nothing else has told the Agent, so the surviving held
  deliveries are **flushed** through the ordinary `AgentMessageAttentionIndex.flush` path
  (`AgentDeliveryQueue.idle()`, treating the freshly launched, genuinely-idle session exactly like
  any other idle-to-busy transition).

The same "flush, treating the session as idle" call also runs from `#launch`'s own continuation for
the rarer case where this launch enqueued no recovery item at all (a plain `startAgent` with no
`recovery` argument), since `#recoverAttention` never runs in that case either.

Held **app items** and **fallback notices** are simpler: `recover()` only ever concerns canonical
Message unread state, never App Inbox content or a steered-but-undelivered notice's text, so both
are unconditionally released (never dropped) at the same point, regardless of which of the two
paths above was taken.

## Divergences from Raft

- **No debounced busy-delivery notification for `steer` providers.** Raft still attempts a stdin
  notification while busy for drivers with `supportsStdinNotification` (a 3 s/15 s debounced
  retry), on top of each provider's own steering. This PR's `steer` bucket leaves Claude/Codex/Pi's
  existing in-provider busy handling completely untouched and adds no daemon-level timer for them;
  moving that steering into the daemon is the explicitly deferred later cleanup this PR's scope
  note calls out.
- **No compaction/review boundary gating, no runtime-profile control messages, no thread-join
  context rendering.** Raft's gated-steering effect system covers all of these; this PR only gates
  turn busy/idle for `queue_until_idle` providers.
- **Explicit `hold`/`release` do not themselves schedule expiry.** Raft's backoff/fence machinery
  computes and enforces its own deadlines; this PR's seam only stores an opaque `until` marker for
  a later PR to interpret.
- **No local durable queue persistence.** Held deliveries live in memory only, exactly like the
  rest of `runtime.ts`'s per-Agent state; a full daemon restart (not just an Agent relaunch) loses
  them, same as the attention index already does. This matches the existing architecture invariant
  that there is no local durable message inbox/outbox — canonical unread state remains the
  recovery boundary.
- **`_session/steer` is an undocumented Kiro extension, not a published ACP method.** There is no
  spec to cite beyond the measured evidence above and the source facts Frank supplied from the
  kiro-cli 2.22.0 ACP server. A future Kiro release could rename or remove it; the `-32601`
  ("method not found") branch of `#steer()`'s fallback exists specifically to degrade gracefully
  rather than break Kiro delivery outright if that happens — every busy notice would simply fall
  back to "redeliver once idle" instead of steering, until this ADR is revisited.
- **`queued: false`/`epoch_changed` and "cleared without a prior injected" are not independently
  reproduced live for this revision.** Every other frame shape in "Kiro's own busy delivery" above
  came from a real capture on this machine; these two are taken from Frank's separately supplied
  kiro-cli 2.22.0 source research and exercised in tests only through the fixture script's
  keyword-driven simulation, not a forced real race. One live attempt to force it (steering right
  at the start of a fast text-only turn) still injected before clearing — Kiro appears to inject
  eagerly enough that forcing "cleared without injected" deterministically was impractical within
  this work's time budget. A second attempt (steer immediately followed by `session/cancel`) hit an
  unrelated bug in the capture script itself (calling `session/cancel` as a typed request instead
  of the fire-and-forget notification the real adapter already uses) and produced no evidence
  either way — recorded here so it is not mistaken for a finding.

## Consequences

- A busy Kiro Agent no longer has its running turn cancelled by an ordinary channel message, DM, or
  app item arriving mid-turn — including one decided upon before the runtime has emitted a single
  event of its own. It steers into the running turn through Kiro's own `_session/steer` extension,
  matching Kiro CLI's own default steer behavior; the running tool is never interrupted by a
  notice, only by an explicit `interrupt()`.
- Every provider's delivery behavior is now the same shape at the daemon layer (`steer`): busy or
  idle, a delivery reaches `AgentSession.notify()` immediately, and the provider decides how to
  land it safely. The daemon-level `queue_until_idle` hold/flush machinery from this ADR's first
  revision is unused today but stays in the codebase for a future provider without a safe busy
  path, and its module now also carries the unrelated (but architecturally similar) fallback-notice
  hold/release machinery below.
- A steer that Kiro accepted (`queued: true`) but never actually delivered (its own buffer cleared
  it before the model read it, per `steering_cleared` with no prior `steering_injected`) is
  redelivered exactly once, right after the turn ends, without a second ACK — whether that
  redelivery is itself a message notice or an App Inbox one. The same applies if `_session/steer`
  fails outright (an older/renamed Kiro, `-32601`, or `queued: false`).
- A fallback notice still held when the Agent's process exits unexpectedly is never silently lost:
  it is released as soon as the next launch's session is ready, exactly like a held app item.
- `AgentDeliveryQueue`'s `hold`/`release`/`pending`/`hasQueued`/`setMode`/`queue_until_idle` are
  unused by any live provider's wiring; they exist so a future provider without a safe busy path,
  and the error-backoff, 3-strike-fence, crash-restart, and stall-recovery PRs in this series, have
  one already-reviewed place to attach to instead of adding another ad hoc per-Agent map to
  `runtime.ts`.

## Validation and rollback

- `packages/daemon/test/agent-delivery-queue.test.ts`: the queue's own contract in isolation,
  including the `queue_until_idle` mode itself via the new `setMode` primitive (no live provider
  reaches it through `setProvider` any more), `discardPending` ignoring busy/hold,
  `holdAppItem`/`releaseAppItems` and `holdFallbackNotice`/`releaseFallbackNotices` as separate id
  sets, `onProcessExit` vs `clearAgent` for deliveries/app items/fallback notices, per-Agent
  isolation.
- `packages/daemon/test/agent-message-attention-index.test.ts`: the `hold`/`flush` wiring — a held
  delivery updates attention but does not notify/ACK, a coalesced flush notifies once and ACKs
  every held delivery, `flush` with nothing held is a no-op, a not-yet-notified resend while held
  stays held instead of notifying again, and `receive`, `flush`, and `recover` each mark busy
  synchronously, provably before the session's own `notify()` call resolves (a controlled, ungated
  fake `notify` that never settles during the assertion). All prior tests in this file are
  unchanged and still pass (the new constructor argument defaults to never holding and a no-op
  `busy`).
- `packages/daemon/test/daemon-runtime.test.ts` (`describe("Agent delivery queue (ADR 0048)")`,
  generic fake-session coverage, provider-agnostic): an idle Kiro-mode Agent delivers immediately; a
  busy Kiro-mode Agent is now also delivered to immediately (steer mode, mirroring Pi); a busy
  steer-mode (Pi) Agent is delivered to immediately, unchanged; a fallback notice (a provider's
  `notice-undelivered`) is held and redelivered exactly once at turn end without a second ACK; a
  fallback notice survives an unexpected exit and is redelivered exactly once on the next launch.
  The `queue_until_idle` busy-race scenario from the first revision no longer has a live provider to
  exercise it through `DaemonRuntime`'s public API and is removed from this level; it stays covered
  in `agent-message-attention-index.test.ts` and `agent-delivery-queue.test.ts`.
- `packages/daemon/test/kiro-agent-adapter.test.ts` (fixture-driven, `fixtures/kiro-acp.ts` extended
  with a `_session/steer` case and three keyword scenarios): busy notify steers through
  `_session/steer` instead of replacing the running turn (rewrite of the old "replaces busy input"
  test, which tested behavior this ADR revision removes); idle notify still sends an ordinary
  `session/prompt` even when the text matches a steer-only fixture keyword; `steer-inject-then-clear`
  produces no `notice-undelivered`; `steer-clear-without-inject` produces exactly one; `-32601` and
  `queued: false` both reject `notify()` and produce exactly one `notice-undelivered` each, with no
  spurious `"completed"`.
- `packages/daemon/test/kiro-native.integration.ts` (opt-in, requires a real authenticated Kiro v3
  engine — `mise exec -- bun test ./packages/daemon/test/kiro-native.integration.ts`; also fixed an
  unrelated pre-existing macOS tmpdir-symlink bug that made it fail before even reaching Kiro, using
  the same `realpathSync(tmpdir())` pattern every other Kiro test file already uses): its last
  scenario used to send a busy `notify()` and assert the running tool's file write never happened,
  testing the pre-steer replace-and-cancel behavior; rewritten to send a busy `notify()` with a
  distinct marker, assert the tool's file write *does* complete (steering never cancels in-flight
  work) and the completion text contains the steered marker. **Actually run against a real,
  authenticated kiro-cli 2.22.0 engine on this machine — passed** (`1 pass, 0 fail`, `37.83s`),
  confirming the implementation end to end, not only in the fixture simulation.
- `bun run --cwd packages/daemon check` (format/lint/typecheck) and the daemon test suite; see the
  PR body for exact commands and results, including pre-existing unrelated flakiness on this
  machine, compared against a clean `origin/main` worktree.
- Rollback is reverting the commit(s): the new constructor arguments on
  `AgentMessageAttentionIndex` default to today's immediate-notify, no-op-busy behavior, and
  `AGENT_DELIVERY_MODE[RUNTIME_PROVIDER.KIRO]` is a single-line change back to `queue_until_idle` if
  `_session/steer` needs to be disabled without reverting the provider code; fully reverting removes
  the `AgentDeliveryQueue`/`#notifyAppItem`/`#recoverAttention` wiring in `runtime.ts` and the
  `#steer`/`#update` additions in `kiro/provider.ts`.
