# ADR 0048: Daemon-owned delivery queue with busy gating

Status: accepted
Date: 2026-09-18

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
though it is not "steering" in the literal sense. Kiro (`kiro/provider.ts#notify`) has no such path:
it always sends a fresh ACP `session/prompt`, and the measured Kiro v3 behavior (observed 3× on
2026-09-18) is that this **cancels the running turn** (`turn_end` `stopReason: "cancelled"` in the
same millisecond a second inbox notice arrived) — work in progress is lost.

This PR is the spine three later PRs in the same series (error backoff, the 3-strike fence, crash
restart, stall recovery) attach to, so its queue module is designed to hold state those PRs can
read and pause, not just to fix Kiro.

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
  (`AGENT_DELIVERY_MODE`): `steer` for CoForge, Pi, Codex, Claude Code, and Cursor (every provider
  whose own `notify`/`sendMessage` already tolerates busy delivery without losing the turn);
  `queue_until_idle` for Kiro only.
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

Held **app items** are simpler: `recover()` only ever concerns canonical Message unread state, never
App Inbox content, so a held app item is unconditionally released (never dropped) at the same point,
regardless of which of the two paths above was taken.

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

## Consequences

- A busy Kiro Agent no longer has its running turn cancelled by an ordinary channel message, DM, or
  app item arriving mid-turn — including one decided upon before the runtime has emitted a single
  event of its own. Deliveries collect and produce exactly one coalesced notice at turn end,
  identical in wording to what a single immediate delivery would have produced; a held app item is
  released as its own separate notice right after, never lost across a turn boundary.
- Every other provider's delivery behavior is unchanged — same call, same timing, same ACK.
- A delivery still held when the Agent's process exits unexpectedly is never silently lost or stuck
  forever: it is either flushed (nothing else told the Agent) or dropped-and-ACKed (the next
  launch's `recover()` already told the Agent about the same canonical unread state) as soon as the
  next launch's session is ready — never left to accumulate indefinitely waiting for a `"completed"`
  event that a never-yet-run session cannot produce.
- `AgentDeliveryQueue`'s `hold`/`release`/`pending`/`hasQueued` are unused by any wiring outside the
  busy-gating path in this PR; they exist so the error-backoff, 3-strike-fence, crash-restart, and
  stall-recovery PRs in this series have one already-reviewed place to attach to instead of adding
  a fourth ad hoc per-Agent map to `runtime.ts`.

## Validation and rollback

- `packages/daemon/test/agent-delivery-queue.test.ts`: the queue's own contract in isolation
  (mode/busy/idle, explicit hold/release, `discardPending` ignoring busy/hold,
  `holdAppItem`/`releaseAppItems` as a separate id set, `onProcessExit` vs `clearAgent` for both
  deliveries and app items, per-Agent isolation).
- `packages/daemon/test/agent-message-attention-index.test.ts`: the `hold`/`flush` wiring — a held
  delivery updates attention but does not notify/ACK, a coalesced flush notifies once and ACKs
  every held delivery, `flush` with nothing held is a no-op, a not-yet-notified resend while held
  stays held instead of notifying again, and — the fix in this revision — `receive`, `flush`, and
  `recover` each mark busy synchronously, provably before the session's own `notify()` call
  resolves (a controlled, ungated fake `notify` that never settles during the assertion). All prior
  tests in this file are unchanged and still pass (the new constructor argument defaults to never
  holding and a no-op `busy`).
- `packages/daemon/test/daemon-runtime.test.ts` (`describe("Agent delivery queue (ADR 0048)")`): a
  busy Kiro-mode Agent holds two deliveries and flushes exactly one coalesced notice with both ACKs
  at turn end; an idle Kiro-mode Agent still delivers immediately; a busy steer-mode (Pi) Agent is
  delivered to immediately, unchanged; a second delivery decided upon before the runtime has emitted
  any event still finds the Agent busy (the exact race this revision fixes); an app-item notice
  while busy is held and released at turn end; a held delivery survives an unexpected exit and is
  delivered exactly once on the next launch.
- `bun run --cwd packages/daemon check` (format/lint/typecheck) and the daemon test suite; see the
  PR body for exact commands and results, including pre-existing unrelated flakiness on this
  machine.
- Rollback is reverting the commit(s): the new constructor arguments on
  `AgentMessageAttentionIndex` default to today's immediate-notify, no-op-busy behavior, so removing
  the `AgentDeliveryQueue` wiring and the `#notifyAppItem`/`#recoverAttention` changes in
  `runtime.ts` is sufficient to fully restore prior behavior.
