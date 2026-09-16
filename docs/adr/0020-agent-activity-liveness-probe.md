# ADR 0020: Server-side Agent activity liveness sweep and probe

Status: accepted
Date: 2026-09-16

## Context

ADR 0016 gave the daemon a busy heartbeat: while an Agent stays `working`/
`thinking`, it re-sends the last busy Activity every `ACTIVITY_HEARTBEAT_MS`
(60 seconds), and the server's `WORKING_LEASE_MS` (90 seconds,
`apps/web/src/server/agents/agent-display.server.ts`) renews on each one. That
record deliberately deferred a second layer: "a server-side liveness probe
that would let the server itself notice a stalled daemon connection … is out
of scope here and left to a follow-up CR." This is that follow-up, tracked as
PR #251 CR-B.

The gap the heartbeat alone leaves is what happens when the lease *does*
lapse — daemon crash, WSS drop, a heartbeat lost in transit. Today nothing
notices: no loop exists that walks lapsed leases, so the server has no ground
truth at that point and lazily projects the Agent back to `online` on the
next read or write, whether or not the Agent is actually still busy. Nothing
ever asks the daemon.

## Decision

**A server-side sweep, not a per-viewer probe.** A background loop owned by
the server itself finds stale busy leases and asks the daemon directly,
independent of whether any browser tab happens to be open. This is a
deliberate alignment with how Raft Computer solves the same problem (see
"Raft 1.0.32 as prior art" below): the server, not a viewer's tab, decides
when ground truth needs re-checking.

**Lease index.** `agent-display.server.ts`'s `OBSERVE_ACTIVITY` Lua script
maintains a sorted set, `<keyPrefix root>:activity-leases`, whose members are
`<workspaceId>:<computerId>:<agentId>` and whose score is the busy activity's
`expiresAt`: `ZADD` when the observed kind is `working`/`thinking`, `ZREM`
otherwise. `OBSERVE_STATUS` also `ZREM`s on an `inactive` status, so an
Agent that goes fully offline drops out of the index the same way one that
stops being busy does. Any observation — probe reply or not — clears a
pending `state.probe` on that Agent's projection, so a real Activity arriving
while a probe is in flight cancels the probe's own timeout path.

**`SWEEP_STALE`.** A new Lua script, given `now`, `probeId`, and
`probeTimeoutMs`, loads one Agent's projection state and returns one of four
outcomes: `fresh` (not busy-visible, or `activity.expiresAt > now` — `ZREM`
and move on), `probe` (busy-visible and expired, no `state.probe` recorded
yet — record `state.probe = { id, sentAt: now }` and ask the caller to send a
probe), `waiting` (a probe is already pending and its timeout has not been
reached), or `expired` (a probe is pending and `now - sentAt >=
probeTimeoutMs` — clear `activityVisible`, clear `state.probe`, bump the
display revision, `ZREM`, and return the resulting snapshot).

**`AgentActivitySweep`.** A new class
(`apps/web/src/server/agents/agent-activity-sweep.server.ts`) runs `tick()`
every `ACTIVITY_SWEEP_INTERVAL_MS` (5 seconds). Each tick first tries to
acquire a Redis lock (`SET <root>:activity-sweep:lock <instanceId> NX PX
4_500`); a web instance that does not acquire it skips the tick entirely, so
exactly one instance across the fleet sweeps at a time and a slow tick cannot
overlap the next one (the 4.5 s lock TTL is shorter than the 5 s interval on
purpose). The instance that does acquire it reads up to 200 stale members
(`ZRANGEBYSCORE activity-leases -inf <now> LIMIT 0 200`) and runs
`SWEEP_STALE` on each: a `probe` result publishes a new
`AgentActivityProbe` intent to that Agent's `daemonControlChannel` via
`CentrifugoServerApi.publish`; an `expired` result publishes the resulting
`agent:display` snapshot directly to `agentStatusChannel(workspaceId)`, so
already-connected browsers flip to `online` without waiting for their own
next refresh. `ACTIVITY_PROBE_TIMEOUT_MS` is 5 seconds. `ensureAgentActivitySweep()`
is idempotent per process and is started from the same compositions that
construct the display service for real traffic — the activity publication
handler composition and `rpc-composition.server.ts` — never by a unit test
unless that test calls it explicitly; it is stoppable (`stop()`) for tests
that do.

**Wire.** `workspace.proto` gains a server→daemon intent, `AgentActivityProbe`
(`protocol_major`, `request_id`, `workspace_id`, `computer_id`, `agent_id`,
`probe_id`, and an explicit `message_type` discriminator, `"agent:activity_probe"`,
following the same shape as `AgentStartIntent.message_type` rather than
inferring intent from payload fields), and `AgentActivity` gains `probe_id`
(field 19, the next free field after ADR 0016's `is_heartbeat`), set only on
a daemon reply to a probe. The SDK exports the method constant, the encode/
decode pair, and the codec plumbing for `AgentActivity.probeId`.

**Daemon reply, real observation.** `DaemonConnection` routes
`agent:activity_probe` publications to a new `onAgentActivityProbe` slot next
to the other intent handlers. `DaemonRuntime` answers from what it already
knows, without probing the provider process itself: if the Agent has a
current launch and a remembered last busy activity, it re-emits that activity
with `probe_id` set, `entries: []`, `is_heartbeat: false` — this also
re-arms the heartbeat timer, since a probe reply is exactly as much evidence
of liveness as a heartbeat. If the Agent is launched but idle, it replies
`idle` with `probe_id` set. If the Agent is not running at all, it emits
nothing but a structured log line: the process presence lease already tells
the server the process is gone, so a probe reply would be redundant. Raft
answers `offline` directly from its probe path in this case; CoForge
deliberately relies on the existing presence lease instead of teaching the
probe reply a second way to say the same thing.

The reply travels as an ordinary `agent:activity` frame; the server does not
special-case its transport. `handleAgentActivityPublication` passes it to
`display.observeActivity` as a **non-filler observation** — an `idle` reply
clears the busy display, a busy reply renews the lease and clears the
pending `state.probe` — unlike a heartbeat or `runtime_progress` frame, which
only renew the lease without being allowed to change visible state. The
existing `isFillerActivity` history exclusion extends to `probeId` being set,
so a probe reply is never written to `agent_activities` history, for the same
reason a heartbeat is not: it carries no new content, only a liveness
observation. `decodeActivityObservation`
(`apps/web/src/features/agents/agent-activity.ts`) drops probe replies from
the recent-activity popover the same way it already drops heartbeats.

**Browser stays passive.** The browser makes no probe call at all. In
`useAgentStatuses` (`agent-status-realtime.ts`), the refresh already scheduled
at a busy display's `expiresAt` moves out to `expiresAt +
ACTIVITY_PROBE_TIMEOUT_MS + 1_000` — a pure safety net that only matters if
the sweep's own `agent:display` push is lost, since the sweep itself already
pushes the corrected snapshot the moment its probe times out. That timing
decision is extracted into a pure, exported helper so it can be unit tested
without driving a real timer. Every other display kind (`online`, `offline`,
`error`) keeps today's timing untouched.

## Rejected alternatives

- **Browser-triggered probe.** An earlier draft of this record had a viewed
  tab call a `probeAgentActivity` server function itself when its own display
  went stale, deduped 10 seconds server-side per Agent. Rejected before
  landing: it makes an Agent's liveness depend on whether a browser tab
  happens to be open and watching it at the right moment, gives every web
  instance a per-viewer code path to authorize and rate-limit, and diverges
  from how Raft solves the identical problem for no behavioral benefit — a
  server-owned sweep answers the same question for every Agent whose lease
  lapses, watched or not, on a schedule the server itself controls.
- **Synthesize `online` immediately on lease lapse, skip probing.** This is
  today's behavior. Rejected as the sole answer: it is a guess, not an
  observation, and the daemon can usually answer within milliseconds when
  asked. It remains the state the sweep's `expired` outcome converges to
  when a probe genuinely times out.
- **Probe on every read**, independent of lease staleness. Rejected: it would
  turn every read into a daemon round trip for Agents whose lease has not
  lapsed and whose projection is already trustworthy; the sweep only spends a
  probe once a lease has actually gone stale.

## Consequences

- `packages/coforge-sdk`: `workspace.proto` gains `AgentActivityProbe` and
  `AgentActivity.probe_id`; both are additive, `protocol_major` does not
  change. The SDK gains the method constant, encode/decode functions, and the
  `probeId` field through the codec.
- `apps/web`: `agent-display.server.ts` gains the `activity-leases` sorted
  set (maintained by `OBSERVE_ACTIVITY`/`OBSERVE_STATUS`), the `SWEEP_STALE`
  Lua script, and a pending-`state.probe` field on the projection state; a
  new `AgentActivitySweep` class owns the 5-second locked tick loop and is
  started from the same compositions that wire the display service for real
  traffic. The existing `isFillerActivity` history exclusion and
  `decodeActivityObservation` popover filter each gain one more condition.
  No schema migration.
- `packages/daemon`: `DaemonConnection` gains one more routed intent;
  `DaemonRuntime` gains a probe handler that reads existing per-Agent launch
  state and reuses `#emitAgentActivity` — no new state is introduced, and a
  probe reply re-arms the same heartbeat timer ADR 0016 already owns.
- Browser: `useAgentStatuses` gains no new outbound call; its post-`expiresAt`
  refresh delay grows to `ACTIVITY_PROBE_TIMEOUT_MS + 1_000` (6 seconds) so it
  functions purely as a fallback behind the sweep's own push.
- Every web instance runs the sweep loop, but the Redis lock keeps exactly one
  instance actually sweeping per tick; a bounded batch (`LIMIT 0 200`) keeps
  one tick's Redis and Centrifugo-publish cost predictable regardless of
  fleet size.
- Shipping this needs the same three-layer coordination ADR 0016 already
  needs: SDK, daemon, and web move together, because a probe the daemon
  cannot answer (old daemon build) simply times out into the existing
  synthesize-`online` fallback rather than failing anything.

### Raft 1.0.32 as prior art

Raft Computer 1.0.32 layers a server-triggered liveness check on top of its
own busy-heartbeat mechanism, as ADR 0016 already noted when deferring this
record, and this design deliberately follows that same server-owned-sweep
shape rather than a per-viewer probe. It was arrived at by comparing that
public product's observable behavior against this codebase's own
constraints — its own Lua projection state, its own lease index, its own
lock/dedupe primitives — not by reading or copying Raft code, identifiers, or
prose. The one point of deliberate divergence is noted above: CoForge relies
on the existing presence lease rather than having a probe reply assert
`offline` on its own. The 5-second sweep interval, 5-second probe timeout,
and 200-item batch bound are this codebase's own.

## Validation and rollback

Validation is `bun run check` at the root; SDK encode/decode round-trip
tests for `AgentActivityProbe` and the extended `AgentActivity`; the daemon's
`daemon-connection.test.ts`/`daemon-runtime.test.ts` for the new intent route
and probe handler; `apps/web`'s Lua-script tests for `SWEEP_STALE` and the
`activity-leases` index, `agent-activity-sweep.server.ts` unit tests for the
lock/tick/batch behavior (using its own `stop()` rather than real 5-second
waits), and the extended `isFillerActivity`/`decodeActivityObservation`
coverage; `buf lint` for the proto addition. This record documents the
decision and the intended end state while the SDK, daemon, and web layers are
implemented in parallel in the same worktree; it does not itself report
command output for those layers.

Rollback is reverting the CR before merge (no schema migration is part of
this change), or, post-merge, a follow-up CR that removes the probe intent,
the `activity-leases` index, `AgentActivitySweep`, and restores
`useAgentStatuses`'s original refresh timing. Because a probe reply is just
an ordinary `agent:activity` frame, an old daemon that does not understand
`agent:activity_probe` cannot be sent one that breaks it — the routed-intent
dispatch simply has no handler to call for it until the daemon is upgraded,
and the sweep's own timeout path converges that Agent to `online` exactly as
it does for any other stale lease.
