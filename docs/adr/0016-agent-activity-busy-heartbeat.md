# ADR 0016: Agent activity busy heartbeat for long silent turns

Status: accepted
Date: 2026-09-16

## Context

`apps/web/src/server/agents/agent-display.server.ts` keeps a Redis projection of
what an Agent's avatar should show (`online` / `working` / `thinking` / `error` /
`offline`). A `working` or `thinking` observation carries its own lease
(`WORKING_LEASE_MS`, 60 seconds) separate from the Agent's `active`/`inactive`
process lease; once that lease lapses the projection falls back to `online`
even though the process is still alive.

Nothing renews that lease on its own. The daemon only publishes an Activity on a
concrete event: a text/thinking delta, a tool start, idle, stopped or an error
(`#emitAgentActivity` and the runtime-event dispatch in
`packages/daemon/src/daemon-runtime/runtime.ts`, coalesced by
`ActivityTrajectory` in `packages/daemon/src/agent-runtime/activity-trajectory.ts`).
A shell command that runs longer than 60 seconds, or a provider call that stays
silent that long (no delta, no tool call), produces no Activity at all during
that window. The avatar shows `online` while the Agent is still busy, and the
browser has no way to tell the two apart.

Some providers also emit stream or system frames that carry no renderable text
at all — Claude Code's compaction status line, a raw (non-summary) Codex
reasoning delta, a Kiro compaction notification. Today these are silently
dropped; they would be reasonable evidence of liveness during an otherwise
silent turn, but nothing carries them.

## Decision

**Busy heartbeat.** The daemon remembers the last busy Activity it emitted per
launch. "Busy" detail kinds: `model_request_started`, `model_response_started`,
`thinking_started`, `tool_started`, `running_command`, and the new
`runtime_progress` (below). While the Agent stays in one of those, the daemon
re-sends that same Activity frame every `ACTIVITY_HEARTBEAT_MS` (60 seconds)
through the existing `#emitAgentActivity` path, with `is_heartbeat = true`, a
fresh `client_seq`, `observed_at_ms = Date.now()`, and empty `entries`. A
terminal kind (`idle`, `stopped`, `runtime_error`, `freshness_hold`), a launch
change, a launch stop, or the runtime stopping all clear the timer immediately;
heartbeats also respect `#activityEnabled` and `launch.stopping` the same way a
normal Activity does. The timer is a single `setTimeout` per Agent, rescheduled
on every busy emission (including its own heartbeat firing), never a
`setInterval`, and it is asserted timer-clean with fake timers in
`packages/daemon/test/activity-heartbeat.test.ts`.

**`runtime_progress`.** A new, additive `AgentActivityDetailKind` for a
provider stream/system event that carries no renderable text. It is emitted
only where a provider already parses such an event — no provider gets an event
invented for it:

- **Claude Code**: the `system`/`status` "compacting" notification, and any
  `stream_event` whose delta is neither a text nor a thinking delta (message
  start/stop, content-block start/stop, an `input_json_delta`, …).
- **Codex**: `item/reasoning/textDelta`, the raw reasoning stream Codex already
  parses but has always discarded in favor of the readable
  `summaryTextDelta` — it now surfaces as content-free progress instead of
  silence.
- **Kiro**: the ACP `compaction_update` session notification.
- **Pi** gets nothing: its SDK does not surface a comparable no-text
  progress signal today.

Because a chatty provider could turn this into a flood, the daemon runtime (not
each provider) rate-limits `runtime_progress` to at most one emission every 10
seconds per Agent, ahead of the busy-heartbeat logic.

**Protocol.** `AgentActivity` gains `bool is_heartbeat` and
`AGENT_ACTIVITY_DETAIL_KIND` gains `RUNTIME_PROGRESS`. Both are additive;
`protocol_major` does not change.

**Server.** `activityKindForObservation` already mapped `runtime_progress` to
`working`; a heartbeat is mapped by its underlying `detailKind` the same way.
`WORKING_LEASE_MS` moves from 60 to 90 seconds — 1.5× the 60-second heartbeat,
the same shape of margin `AGENT_STATUS_LEASE_MS` (90s) keeps over
`AGENT_STATUS_REFRESH_MS` (30s) for the process lease. The `OBSERVE_ACTIVITY`
Lua script always renews the lease and the stored activity on an accepted
heartbeat or `runtime_progress` observation, but only advances the display
`revision` counter (and so the realtime `agent:display` push) when the visible
state actually changed — the kind, detail kind, detail text, or whether the
activity had fallen out of the visible window. A plain re-send of an unchanged
busy state renews silently; a heartbeat that arrives after the lease had
lapsed still restores `working`/`thinking` and does bump the revision, because
that transition **is** visible. Neither a heartbeat nor a `runtime_progress`
frame is written to `agent_activities` (`handleAgentActivityPublication` skips
`observe(...)` for both) or counted as a new observation in the recent-activity
query the browser reads.

**Web client.** `decodeActivityObservation` drops a heartbeat or
`runtime_progress` frame before it reaches the recent-activity list;
`mergeAgentActivity` drops a stray `runtime_progress` entry defensively. The
status dot itself never read from that list — it already comes from
`agent:display` — so this only keeps the popover free of self-repeating,
content-free noise.

**Deferred.** A server-side liveness probe that would let the server itself
notice a stalled daemon connection (rather than relying on the daemon to keep
publishing) is out of scope here and left to a follow-up CR.

### Raft 1.0.32 as prior art

Raft Computer 1.0.32 solves the same staleness with the same shape: a periodic
re-send of the current activity frame carrying a heartbeat flag while an Agent
is busy, a content-free detail kind for opaque provider stream/system events,
and a server-side probe as a third, independent layer. This record was
designed by comparing that public product behavior against this codebase's own
constraints (its own protobuf schema, its own Redis Lua projection, its own
30s/90s status-lease precedent) — no Raft code, identifiers, or prose were
read or copied; the 60s/90s/10s numbers and the Lua revision-gating logic are
this codebase's own.

## Consequences

- `packages/coforge-sdk/proto/coforge/rpc/v1/workspace.proto`,
  `packages/coforge-sdk/src/internal/index.ts` and `codec.ts` carry the new
  field and detail kind; both are additive and round-trip tested.
- The daemon holds at most one heartbeat timer and one rate-limit timestamp per
  Agent, both cleared through every terminal/stop path
  (`packages/daemon/src/daemon-runtime/runtime.ts`); this is asserted with fake
  timers rather than real 60-second waits.
- A long-busy Agent now produces one extra Activity publication per minute
  over Centrifugo; the revision-gating in `agent-display.server.ts` keeps that
  from turning into an extra `agent:display` push whenever the visible state
  hasn't changed, but does not (in this record) suppress the underlying
  Centrifugo publish itself — that would need `observeActivity` to report
  "unchanged" back to the caller, which is not plumbed through yet.
- `apps/web/test/agent-display.test.ts` reasons about two 90-second leases
  (process and work) that can now coincide; tests that need to show the work
  lease expiring independently of the process lease renew the process status
  explicitly mid-test, mirroring the daemon's real 30-second status refresh.
- Shipping this needs a Computer release (daemon + protocol) and a web deploy
  together: the daemon must know to send `is_heartbeat`/`runtime_progress`
  before the server relies on it, and the server's 90-second lease assumes the
  60-second heartbeat is already landing.
- Not verified here: no live end-to-end run against a real Claude Code/Codex/
  Kiro process exercising the new `runtime_progress` branches (the adapter
  test suites that would cover this are known-flaky on process-cleanup
  grounds on this host, independent of this change).
