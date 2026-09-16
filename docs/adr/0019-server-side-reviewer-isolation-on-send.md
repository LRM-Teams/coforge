# ADR 0019: Server-side reviewer isolation on send

Status: accepted
Date: 2026-09-16

## Context

The documented contract (`packages/coforge/README.md`, `docs/architecture.md`
~line 1097) for `--reviewer-isolation` (`COFORGE_REVIEWER_ISOLATION=1`,
CLI-mapped to `freshnessContextMode: "withheld"`) is that a freshness hold in
this mode returns only state and a count for `message send`, `task claim`,
`task update`, and `task amend` — never message bodies, senders, metadata, or
model-seen cursors — and that any other transport failure hides upstream
detail. Task claim/update/amend holds are decided daemon-locally
(`#heldTaskResult` in `packages/daemon/src/daemon-runtime/runtime.ts`) and
already never read message bodies in withheld mode; they return `{ tasks: [],
state: "held", freshnessContextMode: "withheld", withheldMessageCount:
attention.pendingCount }` without ever calling into message transport.
`message send` is different: it is Web/backend, not the daemon, that decides
whether the send is held, via `executeAgentSendMessageWithPolicy`
(`apps/web/src/server/agents/agent-messages.service.ts`), called from the HTTP
send route (`apps/web/src/routes/api/agent/v1/messages.ts`).

The Centrifugo RPC message handler this HTTP route replaced
(`createAgentMessageMethod`, removed by ADR 0018 / PR #264) did honour the
mode for send: it read `freshnessContextMode` off the request, zeroed out the
`presentedThrough` lower bound on the pending-context lookup when withheld
(`Math.max(freshnessContextMode === "withheld" ? 0 :
(validPrior?.presentedThrough ?? 0), boundedSeenSequence)`, so a re-hold could
not silently undercount by reusing a bound the Agent was never actually
shown), returned `messages: []` on a withheld hold, and reported
`withheldMessageCount: pending?.length ?? heldMessages.length` — the full
pending count, not just the at-most-three messages a normal hold surfaces.
`executeAgentSendMessageWithPolicy`'s current `AgentSendMessageInput`/
`AgentSendMessageResult` carry no `freshnessContextMode` field at all, and
`messages.ts`'s `mapSendResult` never sets `AgentSendResponse`'s
`freshnessContextMode`/`withheldMessageCount`; a hold always returns up to
three full message bodies through `context`, regardless of the caller's mode.

The mode does reach the daemon today: the CLI's `--reviewer-isolation` flag
and `COFORGE_REVIEWER_ISOLATION` populate `freshnessContextMode` on the local
request, and `#sendAgentMessage` (`packages/daemon/src/daemon-runtime/runtime.ts`)
already redacts locally — `messages: withheld ? [] : result.messages`,
`withheldMessageCount: result.withheldMessageCount ?? result.attentionCount`
— before the CLI ever prints anything. This is why the gap did not surface in
an Agent transcript: the daemon's own redaction already hid message bodies
from what the code-agent process sees, regardless of what the server
returned. The gap is that the server itself does not know a given send wants
withheld handling and always executes the inline hold policy, so the
documented contract was enforced at exactly one layer instead of two. This is
a contract and defence-in-depth gap, not an exploitable leak: the Agent child
process cannot reach the server directly, because the Agent API key stays in
the daemon and is never handed to the CLI or the code-agent process it
spawns — every `message send` request the server sees for that Agent
identity is one the daemon itself constructed and already redacts before
relaying the response.

Separately, `docs/architecture.md`'s Raft-comparison sentence (~line 996)
listed `task/reviewer-isolation` among capabilities CoForge "currently
lacks," contradicting both the paragraph at ~line 1097 and
`packages/coforge/README.md`, which both describe reviewer isolation as
implemented for send/claim/update/amend today.

## Decision

1. **The mode travels in the send HTTP body.** `requestSend` in
   `packages/daemon/src/connection/daemon-connection.ts` sends
   `freshnessContextMode` as part of the `POST /api/agent/v1/messages` JSON
   body, the same way it already sends `holdToken`/`continueAnyway`/
   `seenUpToSequence`.
2. **The server returns count-only holds in withheld mode.**
   `executeAgentSendMessageWithPolicy` defaults `freshnessContextMode` to
   `"inline"` when absent (unchanged behaviour for every existing caller);
   when it is `"withheld"`, the `readPendingAgentContext` lower bound ignores
   `presentedThrough`, a hold result carries `messages: []` instead of the
   last-three bodies, and `withheldMessageCount` reports the full pending
   count rather than the length of the surfaced batch.
   `AgentSendResponse.freshnessContextMode`/`withheldMessageCount` — already
   optional fields on the SDK type (`packages/coforge-sdk/src/agent/messages.ts`)
   — are populated accordingly. Hold-token issuance, `stage` (1 then 2), and
   `--anyway` bypass semantics are unchanged: withheld mode changes what a
   hold *returns*, not when a hold is issued, released, or overridden.
3. **Task holds are unchanged.** `#heldTaskResult` already decides
   claim/update/amend holds daemon-locally and never reads message bodies in
   withheld mode; this change is scoped to `message send` only.
4. **The daemon keeps redacting, and prefers the server's count.**
   `#sendAgentMessage` continues to compute `messages: withheld ? [] :
   result.messages` and `withheldMessageCount: result.withheldMessageCount ??
   result.attentionCount` unchanged — the `??` already prefers a
   server-reported count when present and only falls back to the daemon's own
   `attentionCount` otherwise. Keeping the daemon's redaction is deliberate
   defence in depth: a future response-shape bug on the server should not, on
   its own, put a message body in front of a reviewer agent.

## Rejected alternatives

- **Daemon-only redaction as sufficient.** Rejected: it enforces the contract
  at exactly one layer, and that layer only works because today's Agent
  process topology happens to route every send through the daemon. The
  server not knowing a request is withheld is a latent gap against the
  documented contract independent of whether it is exploitable under the
  current topology; a second, server-side enforcement point is cheap here
  (the fields already exist on the wire types) and removes the single point
  of failure.
- **A separate withheld-send endpoint.** Rejected: `message send` already
  carries hold/anyway/stage state-machine semantics that a parallel endpoint
  would have to duplicate or delegate to, for no behavioural difference from
  a request-scoped mode flag on the existing route. It would also
  reintroduce the kind of per-purpose HTTP surface ADR 0017/0018 moved away
  from for this route family.

## Consequences

- `packages/daemon`: `daemon-connection.ts`'s `requestSend` sends
  `freshnessContextMode` in the POST body.
- `apps/web`: `agent-messages.service.ts`'s `AgentSendMessageInput` gains
  `freshnessContextMode`; `executeAgentSendMessageWithPolicy` branches on it
  for the pending-context lower bound, the held `messages` payload, and
  `withheldMessageCount`; `messages.ts`'s POST handler reads the field off
  the request body and `mapSendResult` populates it on `AgentSendResponse`.
- `docs/architecture.md`: the Raft-comparison sentence no longer lists
  `task/reviewer-isolation` among missing capabilities; the reviewer-isolation
  paragraph now notes that the send HTTP route honours the mode server-side,
  not only through daemon-side redaction.
- No wire-format addition: `freshnessContextMode`/`withheldMessageCount` were
  already optional fields on `AgentSendResponse` and on the internal request
  type; this change starts populating them for send, it does not add them.
- Reviewer-isolation agents get the same never-see-a-body guarantee they
  already had, now backed by two independent layers instead of one.

## Validation and rollback

Validation is `bun run check` at the root; the daemon's
`daemon-connection.test.ts`/`daemon-runtime.test.ts`; and `apps/web`'s
`agent-messages.service` unit tests and the relevant `messages.ts` route
tests, covering a withheld hold returning `messages: []` with a correct
`withheldMessageCount`, and confirming inline-mode behaviour (the default) is
unchanged. This record documents the decision while the daemon and web
layers were being implemented in parallel in the same worktree by other
agents; it does not itself report command output for those two layers, which
is reported by the CR that lands them.

Rollback is reverting the CR before merge (no schema migration is part of
this change), or, post-merge, a follow-up CR that stops sending
`freshnessContextMode` in the send body and drops the server-side branch; the
daemon's local redaction means reverting this change does not reintroduce a
body leak, only the single-layer enforcement this record moves away from.
