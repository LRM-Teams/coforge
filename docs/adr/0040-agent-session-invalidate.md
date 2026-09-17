# ADR 0040: An explicit `agent:session:invalidate` RPC replaces implicit-only session-loss reporting

Status: accepted
Date: 2026-09-17

## Context

`AgentControl.start()` (`packages/daemon/src/agent-runtime/agent-control.ts`) already recovers
from a stored native Session the provider can no longer resume: on `AgentSessionRecoveryError`
with `intent.sessionId` present, it relaunches fresh and passes the old id as `replaced` into
`Runtime.launch(fresh, launchId, replaced)`. That `replacedSessionId` only ever reaches the
server as a side field on the *next successful* `AgentSessionReport` — the daemon never tells
the server "this native id is gone" on its own. Two gaps follow:

1. If the fresh launch that follows a recovered session then fails (credential error, process
   crash before the driver reports an id, anything), the server never learns the old session is
   dead. `Agent.currentSessionId`/`AgentControlState.identity` keep pointing at it, and every
   later Restart tries the same dead id again, discovering the same `AgentSessionRecoveryError`
   every time.
2. Nothing told a human why context was lost. The only existing notice (`runtime.ts`'s
   `onSessionId` callback, reached only by Claude Code/Codex's own in-driver replacement) used a
   generic "Original session history was not found…" `other`-kind Activity with no runtime name
   and no distinction between a missing session and a provider-rejected replay.

Only two of the four provider drivers throw `AgentSessionRecoveryError` today: kiro
(`session_missing`, `provider_replay_rejected`) and pi (`provider_replay_rejected`). Claude Code
and Codex detect the same two conditions ("No conversation found with session ID: …" / JSON-RPC
`-32600` "no rollout found for thread id …") but replace the session silently inside the driver,
reporting only `replacedSessionId` on the next `AgentSessionReport` — `agent-control.ts`'s catch
branch is never reached for them.

## Decision

**A. A new fire-and-forget wire message, `AgentSessionInvalidate`.** Defined next to
`AgentSessionReport` in `packages/coforge-sdk/proto/coforge/rpc/v1/workspace.proto`, with fields
`protocol_major`, `request_id`, `workspace_id`, `computer_id`, `agent_id`, `provider`,
`session_id`, `daemon_instance_id`, `launch_id`, `reason` (`"missing" |
"provider_replay_rejected"` — a plain string, matching every other enum-shaped field in this
proto, and typed by the new `AGENT_SESSION_INVALIDATE_REASONS` const), numbered contiguously 1–10
(this message never shipped, so there is nothing to reserve). The SDK type, codec
(`encodeAgentSessionInvalidate`/`decodeAgentSessionInvalidate`, with the same scope/length
validation as `AgentSessionReport`), and the `agent:session:invalidate` method constant live in
`packages/coforge-sdk/src/internal/`, with codec round-trip/negative/wire-tag-stability tests in
a new `agent-session-invalidate.test.ts` beside `agent-session.test.ts`.

**Why no control fence fields.** An earlier draft of this message also carried
`start_request_id` and `control_epoch`, mirroring `AgentSessionReport`. Both were removed:
`AgentSessionReceiver.invalidate` (decision E) never compares either — its exact match is
`AgentControlState.launchId === message.launchId` **and** `state.identity?.sessionId ===
message.sessionId`, nothing else. `launchId` is strictly finer-grained than `controlEpoch`
already: it is stored by `AgentControl.authorizeLaunch` only after the launch's own epoch and
`requestId` already matched, and `begin()`/`advance()` clear it on every phase transition away
from `starting`, so a `launchId` match implies the epoch and request were current at that
specific launch. Carrying the redundant fields would only widen the wire message without
strengthening the check. Raft's own daemon-side invalidate carries only `agentId`/`sessionId`/
`launchId`/`reason` (plus its own transport envelope), the same shape this message converges on.

**B. The daemon emits it exactly once per stale session, at every place it learns a stored
session is gone, before acting on that knowledge, never blocking or failing the launch it
precedes.**

- `agent-runtime/agent-control.ts`'s `start()`: the `AgentSessionRecoveryError` catch computes a
  `reason` once — mapping `"session_missing" → "missing"` and `"provider_replay_rejected" →
  "provider_replay_rejected"`; the third code, `"session_in_use"`, is not currently thrown by any
  driver, is not a session-loss signal, and maps to `undefined` — and, only when `reason` is set,
  calls `this.runtime.invalidateSession?.(intent, launchId, replaced, reason)` **before** calling
  `this.runtime.launch(fresh, launchId, replaced, reason)`. Because this call is synchronous and
  fire-and-forget (the `Runtime.invalidateSession` contract, like `wake`, is optional and
  untyped as a `Promise` the caller awaits), it fires even when the fresh launch that follows it
  then fails. `reason` is also threaded into `launch(...)`'s new fourth argument
  (`invalidateReason`) purely so the daemon-runtime layer can narrate the retry's cold-start
  Activity without inventing a side channel — see the next bullet.
- `daemon-runtime/runtime.ts` wires `invalidateSession` into the `Runtime` object passed to
  `AgentControl`, constructing the wire message (`#sessionInvalidateMessage`, the one helper both
  emit sites in this file use) from the intent's scope and forwarding to
  `this.#transport.sendSessionInvalidate?.(...)`. `launch(...)`'s `invalidateReason` argument
  flows straight into that one launch's request object (`LaunchRequest.invalidateReason`) and is
  read back once by `#launchAgent` to narrate the retry's cold-start Activity — replacing an
  earlier `#pendingSessionInvalidateReason` side-channel map that could, in principle, attach a
  reason to the wrong launch or outlive the one it was set for.
- The same file's `onSessionId` callback (`#launchAgent`, the Claude Code/Codex in-driver
  replacement path) also sends the invalidate — reason always `"missing"`, since both drivers'
  in-driver replacement is triggered exclusively by a "session/thread not found" condition, never
  a replay rejection — gated **only** on that callback's own second argument (the driver's own
  report of the id it replaced), **before** the session report for the new id below it, never on
  the launch request's carried-over `replacedSessionId` (which, for `AgentControl`'s own kiro/pi
  retry path, was already reported once by the bullet above): an earlier version of this callback
  read `replacedSessionId ?? request.replacedSessionId` for the *emit* decision too, which sent a
  second, always-too-late invalidate and a second cold-start Activity for AgentControl's own
  retry — including, harmlessly matching the wire message but not the intent, for
  `session_in_use`, which never sets a reason. `request.replacedSessionId` (the carried-over
  value) still feeds the session report's own `replacedSessionId` field unchanged, for compat;
  only the emit decision changed. Both the wire send and the cold-start Activity here follow the
  same condition — "a driver reported a replacement" — with no separate `controlEpoch` gate: an
  earlier draft skipped the wire send but not the Activity when `controlEpoch` was absent (an
  unmanaged legacy `AgentStart`, pre-`AgentControl` fencing, still theoretically reachable through
  the public `startAgent()` seam); since `launchId` is always present at both emit sites
  regardless of `controlEpoch`, and the server's own `!state` check (decision E) already no-ops
  an invalidate for an Agent with no control state, gating on `controlEpoch` added asymmetry
  without adding safety.

**C. Delivery matches Raft's fire-and-forget latest-per-agent semantics, including its exact
drop rule.** `connection/daemon-connection.ts` adds `#pendingSessionInvalidate: Map<agentId,
AgentSessionInvalidate>`, mirroring `#pendingActivity`: `sendSessionInvalidate` sends
immediately over `client.rpc(...)` (never awaited by its caller, rejection only logged) when
connected, or buffers the latest one per agent when not; `#flushPendingSessionInvalidate` (called
from the same `connected` handler that already calls `#flushPendingActivity`, but now *before*
it, matching Raft) replays it on reconnect. "Drop a pending invalidate once a newer launch has
been observed" is Raft's own `observeLaunchIdentity` rule, read from the shipped 1.0.32 bundle
for design comparison only (`docs/agents/reference-cli-research.md`; no Raft code was copied): "a
newer launch was observed" is learned **only** from an outbound message that is neither Activity
nor an invalidate itself — here, `reportAgentSession`'s own `launchId` (`AgentStatus` carries no
launch identity today, so it cannot contribute this signal) — tracked in a new
`#latestObservedLaunchByAgent` map via `#observeLaunchIdentity`, updated as soon as
`reportAgentSession` is called (even against a disconnected client that will reject it: the
observation is the daemon's own outbound intent, not proof of delivery). A pending invalidate is
dropped, and a new one refused queueing, only when its `launchId` differs from that map's value
for the agent. An earlier version of this rule instead reused Activity's own
`#supersededActivityLaunches` bookkeeping directly — dropping a pending invalidate on *any*
Activity for a different `launchId`, regardless of direction — which could drop a **newer**
pending invalidate on a late **older**-launch Activity arriving out of order; that mechanism
still exists, unchanged, for Activity's own replay/supersession, but no longer has anything to do
with invalidate dropping.

**D. Activity narrates the cold start with a new detail kind, `runtime_unavailable`.**
`AGENT_ACTIVITY_DETAIL_KIND` (`packages/coforge-sdk/src/internal/index.ts`) gains
`RUNTIME_UNAVAILABLE: "runtime_unavailable"`, grouped with the other working-level kinds (not
under the "Terminal detail kinds" comment it first landed under — it narrates a fallback in
progress, not a terminal state, the same way `runtime_reconnecting` does). ADR 0021 established
the rule this follows: add a
kind only when a real, already-detected signal exists for it, never an invented one. None of the
13 existing kinds fit: `starting` is a fixed-text, info-level, single-spawn-moment fact (ADR 0021
deliberately rejected splitting it further); `runtime_reconnecting` is Codex's provider-transport
reconnect narration, a different condition entirely; `runtime_crashed`/`runtime_error` are
terminal/error-level exit classifications, not a working-level narrative preceding a retry. The
daemon's own `AgentSessionRecoveryError`/in-driver-replacement detection is exactly the kind of
"real, already-parsed signal" ADR 0021 requires, so a new kind — matching Raft's own literal
`"runtime_unavailable"` for this same narrative — was added rather than overloading an existing
one. Text mirrors Raft's wording (`resumeSessionRecoveryReason`/process-close handler, read for
design only): `"Stored <Runtime> session missing; cold-starting a new session…"` /
`"…session replay rejected; cold-starting a new session…"`, with a `text` trajectory entry
spelling out the fallback and that earlier context may not be restored. `runtimeDisplayName`
(new, in `daemon-runtime/runtime.ts`) supplies the runtime label; no existing shared helper
covered daemon-side narration for all five providers (the closest, `code-agent/
runtime-inventory.ts`'s private `externalRuntimeDisplayName`, is unexported, has no `pi`/`coforge`
cases, and serves a different purpose — labelling a version-probe result). A native provider
session id is not on `docs/observability.md`'s redaction list and is included in the Activity
`detail`/entries text as a correlation id, the same way `AgentSessionReport`'s own `sessionId`
already is.

**E. The server clears the Session association with the same primitive "Reset Session" uses,
only on an exact match, and only as a no-op otherwise — and never marks anything else.** A new
`AgentSessionReceiver.invalidate` (`apps/web/src/server/agents/agent-session.server.ts`)
authorizes the trusted RPC claim against the message's own workspace/computer, re-checks the
Agent's workspace/computer/provider, and (mirroring `AgentSessions.verify`'s existing
daemon-freshness check) confirms the message's `daemonInstanceId` is still the current one for
that Workspace/Computer — through a **required** `currentDaemon` constructor argument; an earlier
version made it optional (defaulting the check away for composition/tests that never called
`invalidate`), which meant a freshness check could be skipped by omission alone rather than by an
explicit choice at every call site. It then requires an *exact* match —
`AgentControlState.launchId === message.launchId` **and** `state.identity?.sessionId ===
message.sessionId` — before calling `AgentControlStore.replace(agent, fields, { clearSession:
true })`, the same compare-and-swap `AgentControl`'s `reset-session`/`full-reset` chains already
use to detach `Agent.currentSessionId` and clear the `runtimeSession` fence while leaving the old
`AgentSession` row (native id/state, and by implication any files it references) untouched, and
`fields` (the current state minus `identity`) unaltered otherwise — no `recovered: true`, no
`updatedAtMs` restamp, nothing. The user learns of the cold start only through the daemon's own
`runtime_unavailable` Activity (decision D), matching Raft, which reports this the same way;
`AgentControl.result`'s and the Session snapshot path's own `recovered` marking (for their own,
separate implicit-replacement cases) is untouched and unrelated. Any mismatch (already replaced,
a stale/superseded launch, an unknown Agent, a foreign scope, a stale daemon instance) returns
silently — never an error, never retried by the daemon, and by construction never able to touch a
newer Session than the one it named. `AgentControlStore.replace` signals a lost compare-and-swap
by **returning** `false`, not by throwing (an earlier version wrapped the call in a blanket
`.catch(() => {})`, which also silently swallowed a genuine failure — a thrown schema-parse or
database error — as if it were the same harmless race); `invalidate` now lets `replace`'s return
value fall through as its own idempotent no-op and lets a thrown error propagate. The RPC handler
(`createAgentSessionInvalidateMethod`, `apps/web/src/server/centrifugo/
agent-session-receiver.server.ts`, registered in `rpc-composition.server.ts` next to
`agent:session`, including its `unavailableMethod` fallback entry) rejects only a malformed
payload or foreign transport principal (403), matching `createAgentSessionMethod`'s pattern —
every domain-level "no longer current" case is `invalidate`'s own idempotent no-op, not an RPC
error, since the daemon must never treat this observation as something to retry — but now also
logs a genuine (propagated) failure server-side with the same `event`/allowlisted-`reason`
convention PR #321 introduced for `agent_control:result_rejected`/`agent_session:snapshot_rejected`,
so it is diagnosable instead of silently vanishing into a bare 403; the wire response is
unchanged either way.

**F. `replacedSessionId` on `AgentSessionReport` is unchanged and stays the compatibility path.**
An old daemon never sends `agent:session:invalidate`; the server keeps accepting
`replaced_session_id` exactly as before (`AgentSessions.verify`/`accept`,
`apps/web/src/server/agents/agent-sessions.server.ts`). A new daemon talking to an old server
that does not recognize the new RPC method receives a `404 unknown RPC method` from
`CentrifugoRpcHandler.handleRequest`'s existing "unrecognized method" branch; the daemon's own
`sendSessionInvalidate`/`#publishSessionInvalidate` catches that rejection like any other RPC
failure and logs it at `warning` with a stable `event: "agent_session:invalidate_rejected"`,
`outcome: "failed"`, and `request_id` (matching the sibling `agent_session:report_failed` log),
never rethrows, and never blocks or retries — the launch it accompanied is unaffected either way.
Because an old server rejects every attempt the same way for as long as this process talks to
it, that specific "unknown RPC method" case logs at most once per connection lifetime; any other
rejection (a genuinely transient failure against a server that does support the method) still
logs every time.

## Rejected alternatives

- **Reusing `AgentSessionReport` with an extra flag instead of a new message type.** The task
  explicitly ruled this out as a "CLI-side shortcut"/reuse of an existing report, and it would
  conflate two different facts on one wire shape: a report always carries a *new* session's
  identity; an invalidate carries none — it is purely "this old one is gone," sent from a
  moment (right before, or without, a successful new session) a report cannot represent.
- **Deriving "session dead" purely from a failed launch's absence of any report.** The server has
  no reliable way to distinguish "the daemon never got far enough to report" from "the daemon is
  still trying" without an explicit signal, and doing so would require a timeout heuristic this
  ADR avoids entirely.
- **A second Activity-replay buffer with its own bookkeeping.** Considered and rejected in favor
  of a dedicated `#latestObservedLaunchByAgent` map, updated only from `reportAgentSession`
  (Raft's `observeLaunchIdentity` rule — decision C) — an earlier draft instead reused
  `sendAgentActivity`'s existing per-agent `launchId` observations directly, which had the wrong
  drop direction (any differing-launch Activity, not only a newer one) and is what decision C's
  "earlier version" paragraph describes.
- **Carrying `startRequestId`/`controlEpoch` on `AgentSessionInvalidate`, like
  `AgentSessionReport`.** Rejected: `AgentSessionReceiver.invalidate`'s exact match never compares
  either field, and `launchId` is already strictly finer-grained than `controlEpoch` (see
  decision A, "Why no control fence fields"). Raft's own invalidate carries neither.
- **Marking the control state `recovered: true` on a matching invalidate.** Rejected: this would
  report the same fact twice — once through the daemon's own `runtime_unavailable` Activity, and
  again through the UI's "recovered" presentation, which exists for a different case (an implicit
  replacement discovered through a control result or Session snapshot, decision E). Raft reports
  a session invalidate through the Activity alone.

## Consequences

- **Wire-compatible.** `AgentSessionInvalidate` is a new message and RPC method; no existing
  field, tag, or method changes. `replacedSessionId` (tag 12 of `AgentSessionReport`) keeps its
  meaning and its callers unchanged.
- **A stale Session no longer wedges every later Restart on the same dead native id** once the
  invalidate reaches the server, independent of whether the retry launch that follows it
  succeeds.
- **One new Activity detail kind** (`runtime_unavailable`) for Web/backend's activity reducer and
  presentation layers to treat like the other "working" kinds (see `apps/web/AGENTS.md`'s Agent
  status/Activity section); unknown-kind rendering already covers a browser that has not yet
  deployed the change.
- **The daemon never blocks a launch on this RPC.** A slow, failing, or (against an old server)
  unrecognized invalidate never delays or fails the retry it precedes; the daemon-side buffering
  mirrors the disconnected-Activity case exactly, so no new failure mode was introduced for the
  connection layer.
- **Uncertainty carried forward, not resolved here:** Raft's own `resumeSessionRecoveryReason`
  covers `opencode`/`gemini` drivers this codebase does not have; only the `claude`/kiro-analogue
  and `pi` conditions were compared. Raft's exact daemon-side authorization/currency checks for
  its outbound invalidate were not recoverable from the client-side bundle (only the queueing/
  drop logic is client-side); the server-side authorization and exact-match design in decision E
  is this codebase's own, built from `requireCurrentAgentScope`/`AgentSessionReceiver`'s existing
  precedent, not a mirror of an observed Raft server behavior.

## Validation and rollback

Covered by: `packages/coforge-sdk/src/internal/agent-session-invalidate.test.ts` (codec
round-trip, negative validation, contiguous wire-tag numbering with no control-fence fields);
`packages/daemon/test/agent-control.test.ts` (invalidate reported before the fresh retry launch
for both reasons; reported even when that retry then fails; `session_in_use` retries without
invoking `invalidateSession` or carrying a reason into the retry launch);
`packages/daemon/test/daemon-connection.test.ts` (sent as an RPC not a publication when
connected; buffered while disconnected and flushed exactly once, before pending Activity; kept
when only a differing-launch Activity is observed; dropped once a newer launch is observed via
the session report; refuses to queue a new invalidate for an already-stale launch; a
rejected/unrecognized RPC is logged with `request_id`/`outcome`, not thrown, and the
unknown-method case logs at most once per connection lifetime); `packages/daemon/test/
daemon-runtime.test.ts` (exactly one invalidate for a kiro/pi retry with the correct reason
including `provider_replay_rejected`; exactly one invalidate for the Claude Code/Codex in-driver
path, sent before the report, with its Activity text and detail kind; zero invalidates and zero
`runtime_unavailable` Activity for `session_in_use`); `apps/web/test/agent-session.test.ts` (a
matching invalidate clears the Session and leaves every other field — including `recovered` and
`updatedAtMs` — unchanged; a non-matching session id, launch id, Agent, or scope is an idempotent
no-op; an Agent with no server control state is a no-op; a lost `store.replace` compare-and-swap
is silently dropped while a genuine store failure propagates; an invalidate from a stale daemon
instance is ignored, not rejected; an invalidate for an old launch cannot touch a newer Session;
the RPC method authorizes the transport principal and always acknowledges a recognized, in-scope
message). Rollback is by revert: the change is additive to the wire protocol and to
`AGENT_ACTIVITY_DETAIL_KIND`, and requires no data migration in either direction.
