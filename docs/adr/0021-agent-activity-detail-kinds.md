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
| `thinking_end` | Claude: `content_block_stop` closing a top-level thinking content block (tracked via `content_block_start`); Codex: `item/completed` for a `reasoning` item. Kiro and Pi have no equivalent signal in this codebase's providers today and are skipped | working | same as `tool_end` |
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

## Rollback

Revert the daemon provider/runtime changes and the web reducer/presentation
changes together; the new `AGENT_ACTIVITY_DETAIL_KIND` values are additive
strings with no protocol or schema migration, so removing them is a plain
code revert with no data cleanup.
