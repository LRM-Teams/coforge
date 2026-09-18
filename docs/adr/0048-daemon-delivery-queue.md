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
- `#observeRuntimeEvent` marks busy on every event except `"session"`, `"usage"`, and `"completed"`
  (activity, tool-start/-end, compaction-*, a content-free `"progress"` ping, `"error"`,
  `"reconnecting"` — i.e. anything meaning the runtime is mid-turn), and marks idle exactly on
  `"completed"`, then flushes whatever was held.

**Wiring in `AgentMessageAttentionIndex`:** a new, optional constructor collaborator
(`{ shouldHold, enqueue }`, defaulting to "never hold" so every existing caller and test is
unaffected) and a new `flush(agentId, held)` method.

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

This PR does **not** wire an automatic flush of surviving held deliveries at the next launch — that
is the crash-restart PR's job, via `pending`/`hasQueued`. Today, a delivery that survives a crash
this way is redundant with (not yet load-bearing over) the server's own unread-based recovery,
since it was never ACKed; it is kept, not discarded, purely so the later PR can consult it without
this module needing to change again.

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
- **Busy is derived from provider events, not marked synchronously at send time.** Raft calls
  `commitApmIdleState(..., false)` at every send site. This PR instead marks busy from the next
  provider event (`progress`, `activity`, `tool-start`, …) after `#launchAgent` subscribes. This
  leaves a narrow gap: a delivery that lands in the window between a fresh launch's first turn
  starting (the launch's own instructions-as-first-prompt, which is not a `session.sendMessage`
  call this daemon core ever issues today — see below) and that turn's first observed event would
  still be delivered immediately even for a `queue_until_idle` provider. This is a real, known,
  narrower version of the bug this PR fixes (it only affects the launch-bootstrap window, not every
  busy period), left open deliberately rather than instrumented ad hoc; closing it fully would mean
  marking busy the moment a provider spawns/bootstraps, which no current call site in `runtime.ts`
  does explicitly (every provider's first turn is embedded in its own spawn/bootstrap, not sent
  through a `sendMessage`/`notify` call this module observes).
- **Explicit `hold`/`release` do not themselves schedule expiry.** Raft's backoff/fence machinery
  computes and enforces its own deadlines; this PR's seam only stores an opaque `until` marker for
  a later PR to interpret.
- **No local durable queue persistence.** Held deliveries live in memory only, exactly like the
  rest of `runtime.ts`'s per-Agent state; a full daemon restart (not just an Agent relaunch) loses
  them, same as the attention index already does. This matches the existing architecture invariant
  that there is no local durable message inbox/outbox — canonical unread state remains the
  recovery boundary.

## Consequences

- A busy Kiro Agent no longer has its running turn cancelled by an ordinary channel message or DM
  arriving mid-turn; deliveries collect and produce exactly one coalesced notice at turn end,
  identical in wording to what a single immediate delivery would have produced.
- Every other provider's delivery behavior is unchanged — same call, same timing, same ACK.
- `AgentDeliveryQueue`'s `hold`/`release`/`pending`/`hasQueued` are unused by any wiring outside the
  busy-gating path in this PR; they exist so the error-backoff, 3-strike-fence, crash-restart, and
  stall-recovery PRs in this series have one already-reviewed place to attach to instead of adding
  a fourth ad hoc per-Agent map to `runtime.ts`.

## Validation and rollback

- `packages/daemon/test/agent-delivery-queue.test.ts`: the queue's own contract in isolation
  (mode/busy/idle, explicit hold/release, `onProcessExit` vs `clearAgent`, per-Agent isolation).
- `packages/daemon/test/agent-message-attention-index.test.ts`: the `hold`/`flush` wiring — a held
  delivery updates attention but does not notify/ACK, a coalesced flush notifies once and ACKs
  every held delivery, `flush` with nothing held is a no-op, and a not-yet-notified resend while
  held stays held instead of notifying again. All prior tests in this file are unchanged and still
  pass (the new constructor argument defaults to never holding).
- `packages/daemon/test/daemon-runtime.test.ts` (`describe("Agent delivery queue (ADR 0048)")`): a
  busy Kiro-mode Agent holds two deliveries and flushes exactly one coalesced notice with both ACKs
  at turn end; an idle Kiro-mode Agent still delivers immediately; a busy steer-mode (Pi) Agent is
  delivered to immediately, unchanged.
- `bun run --cwd packages/daemon check` (format/lint/typecheck) and the daemon test suite; see the
  PR body for exact commands and results, including pre-existing unrelated flakiness on this
  machine.
- Rollback is reverting the commit(s): the new constructor argument on
  `AgentMessageAttentionIndex` defaults to today's immediate-notify behavior, so removing the
  `AgentDeliveryQueue` wiring in `runtime.ts` alone is sufficient to fully restore prior behavior.
