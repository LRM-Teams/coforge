# ADR 0021: Agent activity detail-kind vocabulary

Status: amended
Date: 2026-09-16

> **Amendment (2026-09-17):** the Activity log is a complete chronological work log, not a
> liveness-only display. `tool_end`, `thinking_end` and `compaction_finished` are reclassified
> from "liveness only: never stored in history, dropped from the popover" to ordinary status
> observations: persisted to `agent_activities` and shown live in the Agent detail Activity tab
> and profile panel, one single-line row each — primary label from the existing activity-kind
> classification (all three read as "Working"), secondary muted text naming what finished ("Tool
> finished", "Thinking finished", "Compaction finished") — the daemon's own `detail` wins when it
> sends one (current daemons send "Tool finished"/"Thinking finished" directly), falling back to
> that wording only for an empty `detail` (older daemons, and rows stored before this amendment).
> They stay excluded from the avatar's short recent-activity popover
> (`POPOVER_EXCLUDED_DETAIL_KINDS`, `apps/web/src/features/agents/agent-activity.ts`) — a tool or
> thinking phase ends often enough that showing every one there would crowd out genuinely
> noteworthy events in that 5-row view. Separately, `thinking_started`/`model_response_started`
> are each reported twice: once as a content-free "run-start marker" (no `entries`, empty
> `detail`) whose only job is flipping the display status the instant a run begins, and again with
> real `entries` once there is text to flush. Only the marker is filtered from history and the
> timeline (`isRunStartMarker`, same file); the real flush is an ordinary Thinking/Output row,
> unaffected. `runtime_progress` is unchanged by this amendment: it is still a content-free
> liveness filler,
> never persisted and never shown anywhere, because the daemon sends it with no renderable text at
> all (unlike the other three, which now carry real completion semantics worth recording). The
> display/lease reducer (`agent-display.server.ts`'s `LIVENESS_ONLY_DETAIL_KINDS`, the busy
> heartbeat every 60s, and the liveness-sweep probe) is untouched by this amendment — only history
> persistence and list visibility changed, not what renews the display lease or what is a
> heartbeat/probe reply. The two "liveness only" table rows below for `tool_end`/`thinking_end`/
> `compaction_finished` describe the original decision; see `apps/web/src/features/agents/
> agent-activity-presentation.ts`'s `STATUS_SECONDARY_LABEL` and `docs/observability.md`'s Web
> 展示契约 for the current behavior.

## Context

`AGENT_ACTIVITY_DETAIL_KIND` (`packages/coforge-sdk/src/internal/index.ts`) held
13 values. `apps/web/src/server/agents/agent-display.server.ts` already
referenced six detail kinds the daemon never emitted: `message_received`,
`checking_messages`, `compacting_context`, `runtime_starting`,
`turn_completed`, and the literal string `working`. Because of that gap, the
recent-activity popover had no way to show when a tool or a thinking phase
ended, when context compaction was running, or when a subagent was working;
an unexpectedly-exited process and a turn cut by a requested stop both looked
like an ordinary `stopped`/`idle` record.

Several of the daemon's `AgentRuntimeEvent` signals were already flowing
through the providers unconsumed: `tool-end` (Claude, Codex, Kiro, and Pi all
already emit it) and the `completed` event's `interrupted` status (emitted by
all four providers, but never triggered because nothing in
`daemon-runtime/runtime.ts` calls `AgentSession.interrupt()` — a stop instead
waits for the current launch and then disposes the session directly).

## Decision

Add eight new `AGENT_ACTIVITY_DETAIL_KIND` values, wire each one from the
daemon only where a provider has a real, already-parsed signal for it,
and teach the web reducer/presentation/history layers about them. Do not
invent a signal a provider does not already surface, and do not add a kind
nothing will ever emit.

| kind | daemon emits when | display kind | popover / history |
| --- | --- | --- | --- |
| `tool_end` | Claude: `tool_result` block; Codex: `item/completed` for a `commandExecution` item; Kiro: `tool_call_update` reaching `completed`/`failed`; Pi: `tool_execution_end` — all four providers already emitted the underlying `tool-end` `AgentRuntimeEvent`, unconsumed by `runtime.ts` until this change | working | liveness only: never stored in history, dropped from the popover, filler for the display lease like `runtime_progress` |
| `thinking_end` | **Amended, see below.** Derived by the daemon from the normalized event stream (`ActivityTrajectory`, `packages/daemon/src/agent-runtime/activity-trajectory.ts`) for every provider, not signaled by individual providers | working | same as `tool_end` |
| `compacting_context` | Claude: the `system`/`status` "compacting" notification (previously misreported as `runtime_progress`); Kiro: ACP `CompactionUpdate.status === "in_progress"`. Codex has no compaction notification and is skipped | working | visible, label "Compacting context…", stored |
| `compaction_finished` | Claude: `compact_boundary`; Kiro: `CompactionUpdate.status` transitioning away from `in_progress`. Both wired providers have an explicit end signal, so no generic "next non-compaction event" fallback was implemented in `runtime.ts` | working | liveness only, like `tool_end` |
| `subagent_activity` | Any `activity` event whose entries carry a subagent scope (Claude `parent_tool_use_id`); only Claude ever sets that field, so this kind is Claude-only in practice even though the reclassification itself is provider-agnostic | working | visible, label "Subagent working…", stored |
| `message_received` | The existing `AgentMessageAttentionIndex` observer that already reports "Message received" after a delivery/wake now uses this kind instead of the generic `model_request_started` it used before | working | visible, stored |
| `runtime_crashed` | Claude and Codex: the process exits unexpectedly (the shared `JsonlProcess` wrapper's `"code agent process exited unexpectedly"` failure, observed outside the session's own `dispose()`) — same `errorClass`/`errorReason`/`fingerprint` fields as before, only the kind changes. Kiro and Pi have no provider-level crash signal distinct from an ordinary process exit and keep reporting `stopped`; they are skipped | error | visible, stored |
| `runtime_interrupted` | A requested stop/restart (`stopAgent`/`#abandonLaunch`) cuts a turn that was busy (working/thinking) at the moment the stop was requested. Also mapped from a `completed` event's `interrupted` status for forward compatibility, though that path is unreachable today per the Context section | online | visible, stored |

Added later, following this same discipline (ADR 0040, "An explicit `agent:session:invalidate` RPC replaces implicit-only session-loss reporting"):

| kind | daemon emits when | display kind | popover / history |
| --- | --- | --- | --- |
| `runtime_unavailable` | The daemon detects a stored native Session it cannot resume — missing (kiro/pi's classified `session_missing`, or Claude Code/Codex's own in-driver replacement, both reported as reason `missing`) or rejected on replay (kiro/pi's `provider_replay_rejected`) — reports it once via `agent:session:invalidate`, then cold-starts a fresh session under the same `launchId` | working | visible, label "Stored `<Runtime>` session missing/replay rejected; cold-starting a new session…", stored |

`runtime_starting` is **not** added to the enum: the daemon has exactly one
spawn moment (`#launchAgent` emits `starting` once the process is up; there is
no separate "launch intent" activity), so the reducer's dead `runtime_starting`
string was dropped from `workingKinds` and `starting` was kept as the single
source of truth, exactly as the brief's own fallback instructed. `working` and
`turn_completed` were dropped from the reducer outright — a repository-wide
grep confirmed the daemon never emits either. `checking_messages` stays; a
sibling branch owns wiring it.

### Rejected

- Importing Raft Computer 1.0.32's full 43-value vocabulary, including its
  computer/external/review-only kinds. Nothing in this codebase emits a
  signal for those; adding them would be dead vocabulary, and no Raft code,
  identifiers, or prose were read or copied to reach this list — only its
  publicly observable behavior (an activity vocabulary richer than this
  codebase's) motivated the comparison.
- A generic `runtime.ts`-level "close any open compaction on the next
  non-compaction activity" fallback. Both providers wired for
  `compacting_context` (Claude, Kiro) already have an explicit, already-parsed
  end signal, so the fallback would be unexercised complexity.
- Wiring `AgentSession.interrupt()` into the stop/restart control flow so the
  provider-level `completed: "interrupted"` status becomes reachable. That is a
  control-flow behavior change (should a stop cut a turn short instead of
  waiting for it?) outside this record's scope; `runtime_interrupted` is
  instead sourced from the daemon's own knowledge that a stop was requested
  while a turn was busy.

## Consequences

- `packages/coforge-sdk/src/internal/index.ts` gains eight `AGENT_ACTIVITY_DETAIL_KIND`
  values. `detail_kind` is a plain string field in
  `packages/coforge-sdk/proto/coforge/rpc/v1/workspace.proto`, so no protobuf
  schema change was needed; the codec already treats it as an opaque string.
- `packages/daemon/src/daemon-runtime/runtime.ts`: `BUSY_ACTIVITY_DETAIL_KINDS`
  gains `tool_end`, `thinking_end`, `compaction_finished` (filler),
  `compacting_context`, `subagent_activity`, `message_received`;
  `TERMINAL_ACTIVITY_DETAIL_KINDS` gains `runtime_crashed`,
  `runtime_interrupted`. `#observeRuntimeEvent` now consumes `tool-end`
  events, reclassifies subagent-scoped activity, and maps a `completed`
  event's `interrupted` status. `stopAgent`/`#abandonLaunch` report
  `runtime_interrupted` before clearing the remembered busy activity, and the
  stopping-guard in `#emitAgentActivity` allows it through the same way it
  already allows `stopped`.
- Each provider's changes are additive to its existing event dispatch; none
  required a new `AgentRuntimeEvent` variant in `packages/agent/src/contract.ts`
  because `tool-end` already existed and `thinking_end`/`compacting_context`/
  `compaction_finished` are authored directly as `activity` events, the same
  way `runtime_progress` already was.
- `apps/web/src/server/agents/agent-display.server.ts`: `workingKinds` drops
  `working`/`runtime_starting` and gains the five new working-classified
  kinds; a shared `LIVENESS_ONLY_DETAIL_KINDS` set replaces the single
  `runtime_progress` check for the lease's filler/history classification.
  `apps/web/src/server/agents/agent-activity-publish.server.ts` reuses that
  set for history exclusion. `apps/web/src/features/agents/agent-activity.ts`
  keeps its own copy (it is bundled for the browser and cannot import a
  `.server.ts` module) for the popover drop and the `mergeAgentActivity`
  defense-in-depth skip. `agent-activity-presentation.ts` gains a dedicated
  `subagent_activity` row and a `compacting_context` label.
- Not verified here: no live end-to-end run against a real Claude Code/Codex/
  Kiro/Pi process exercising the new branches — the adapter test suites that
  would cover this are documented as flaky on process-cleanup grounds on this
  host, independent of this change; they were run in isolation instead (see
  the change's validation report).

## Validation

- SDK: codec round-trip test for each new `detailKind` value.
- Daemon: provider tests asserting the new kinds appear for the corresponding
  provider events and are absent where a provider has no signal;
  `activity-heartbeat.test.ts` for filler/terminal classification;
  `daemon-runtime.test.ts` for crash vs. interrupted classification and for
  `message_received`/`subagent_activity` reclassification.
- Web: `agent-display.test.ts` for the reducer mapping and the three
  liveness-only kinds' filler behavior; `agent-activity-publish.test.ts` for
  history exclusion; `agent-activity.test.ts` for the popover drop;
  `agent-activity-presentation.test.ts` for the new labels/tones.
- `bun run check` at the root, the touched package suites, and `bun run
  build` in `apps/web`.

## Amendment (2026-09-18): `thinking_end` moves to the daemon, for every provider

The original `thinking_end` row above ("only where providers signal") left
Kiro and Pi's Activity log without a "Thinking finished" line, since neither
provider's adapter had a matching native signal to translate. Plainly: this
was a gap in Kiro and Pi's logs, not a deliberate limit — "thinking
finished" is a fact about the model's own turn, not a provider-specific
capability, so every provider should report it the same way.

Decision: stop asking each provider to notice when its own thinking phase
ends, and instead derive it once, centrally, from the already-normalized
`AgentRuntimeEvent` stream that every provider already produces. Every
provider's adapter emits `thinking-delta` events while the model is
thinking (Claude, Codex, Kiro and Pi all already did, for their own
`thinking_started` trajectory entries); `ActivityTrajectory`
(`packages/daemon/src/agent-runtime/activity-trajectory.ts`, one instance
per launch, already watching this exact stream to coalesce/flush
`thinking_started`/`model_response_started` trajectory entries) is the one
place that can tell, provider-agnostically, when a thinking run has ended.

- **Trigger set.** A thinking run is open once its first `thinking-delta`
  has been accepted (tracked via `#lastAnnounced === thinking_started`, the
  detail kind of the last activity actually forwarded). It closes, emitting
  exactly one `thinking_end`, the moment one of these arrives: a
  `text-delta` (the model started talking), a `tool-start` or `tool-end`
  (it's using a tool), a `compacting_context`/`compaction_finished` activity
  (context compaction), `completed` (the turn ended), or an error-level
  activity. `runtime_progress`, `session` and `usage` events never close it,
  and neither does another `thinking-delta` — the 350ms idle flush can
  empty the pending buffer without ending the run, so a thought split across
  several idle flushes still gets exactly one `thinking_end`, emitted the
  moment the triggering event arrives (not deferred to the next flush).
- **Detail text.** `thinking_end` now carries `"Thinking finished"` (not
  empty); the daemon's own `tool_end` (`runtime.ts`, on the raw `tool-end`
  `AgentRuntimeEvent`) is amended the same way to carry `"Tool finished"`.
  Both are stored and shown as one-line status rows in the Activity log,
  which uses this text as the row's secondary text. `safeRuntimeActivityMessage`
  (`runtime.ts`) is amended to pass `thinking_end`'s text through unscrubbed-
  format the same way `tool_started`/`runtime_reconnecting` already do,
  instead of falling through to its generic "Agent activity observed."
- **Run-start announcement.** A second, related gap: because entries are
  batched until a flush (debounced 350ms, or triggered by the next event),
  an Agent that had just started thinking or responding could sit without
  any Activity signal for that whole window. `ActivityTrajectory` now emits
  one additional, content-free `thinking_started`/`model_response_started`
  activity the instant a fresh run starts (no `entries`, empty detail), so
  the Agent's status flips immediately; the existing debounced flush still
  follows with the same detail kind, this time carrying the entries. It
  only re-announces when the kind actually changed since the last thing the
  launch announced — an idle-flush split continuing the same run announces
  nothing twice, but a tool call (or any other intervening activity)
  in between means the next thinking/text run announces again.
  `safeRuntimeActivityMessage` is amended to return `""` for these two
  kinds when the message is empty, instead of falling through to the
  generic sentence (the web keeps this entry-less frame out of Activity history and the
  popover; a daemon carrying this change needs a web deployment that
  already does).
- **Subagent scope.** A subagent-scoped thinking run (`event.subagent` set)
  gets `thinking_end` exactly like a top-level one — no special case. The
  emitted `thinking_end` itself carries no `entries`, so `runtime.ts`'s
  subagent reclassification (`entries?.some(entry => entry.subagent !==
  undefined)`, which turns a subagent-scoped activity into
  `subagent_activity`) never applies to it; it always surfaces as a
  top-level `thinking_end`, even when the thinking it closes happened
  inside a subagent. This is a known, accepted imprecision, not a bug.
- **Dispose.** `ActivityTrajectory.dispose()` still flushes any pending
  text but does not emit `thinking_end`: the launch itself is ending (the
  session exited), and `runtime.ts`'s own `onExit` handler reports
  `stopped`/`runtime_crashed` right after — a trailing "Thinking finished"
  for a run that never really finished would misstate what happened. This
  matches the pre-existing choice for `flush()` on `dispose()`: report what
  is known, not what would have to be inferred.
- Removed: the claude-code provider's `#thinkingBlockOpen` tracking and its
  `content_block_stop` → `thinking_end` emission, and the codex provider's
  `item/completed` (`reasoning`) → `thinking_end` emission. In claude-code,
  that branch also unconditionally set `renderedText = true`; without it, a
  thinking block's `content_block_stop` now falls through to the same
  content-free `runtime_progress` liveness ping any other partial stream
  event gets. This is harmless: `runtime.ts` already rate-limits
  `runtime_progress` to one per 10 seconds per Agent
  (`RUNTIME_PROGRESS_RATE_LIMIT_MS`), and `thinking_end` renews the same
  busy lease, so the net liveness behavior across the turn is unchanged.
- `git grep -n THINKING_END packages/daemon/src` confirms
  `packages/daemon/src/agent-runtime/activity-trajectory.ts` is the only
  emitter left; the two remaining references in `runtime.ts` are the
  `BUSY_ACTIVITY_DETAIL_KINDS` membership and the
  `safeRuntimeActivityMessage` branch above, not emission sites.

## Rollback

Revert the daemon provider/runtime changes and the web reducer/presentation
changes together; the new `AGENT_ACTIVITY_DETAIL_KIND` values are additive
strings with no protocol or schema migration, so removing them is a plain
code revert with no data cleanup. The 2026-09-18 amendment above rolls back
independently: reverting `activity-trajectory.ts`,
`daemon-runtime/runtime.ts`'s two `safeRuntimeActivityMessage` branches and
`tool_end` detail text, and restoring the claude-code/codex providers'
`thinking_end` emissions, returns to the original per-provider behavior
with no data cleanup either.
