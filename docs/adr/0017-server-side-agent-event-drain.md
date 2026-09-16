# ADR 0017: Server-side Agent event drain, and per-route response types for new HTTP routes

Status: accepted
Date: 2026-09-16

## Context

`coforge message check` was implemented entirely inside the daemon
(`packages/daemon/src/daemon-runtime/runtime.ts` `#checkAgentMessages`): it
walked its volatile in-memory attention index and, for every target with
pending attention, back-filled it with `operation: "read"` requests using
`fromSequence`/`throughSequence` windows. This duplicated pagination and
target-scoping logic that already lives in the read route, and it broke
silently the last time that route's semantics changed, because nothing in the
daemon or the server enforced that the two stayed in sync.
`docs/reliable-message-delivery.md` already states that the cloud read
boundary (`ConversationMember.agentReadThroughSequence` / `ThreadRead`) is
authoritative and the daemon's attention index is only a volatile cache/notice
mechanism recovered from that boundary. The daemon back-fill loop did not
reflect that: it trusted its own notice index to decide *what* to read, only
using the server to fetch bodies.

Separately, a real dispatch bug was found during PR #250 review:
`DaemonConnection.agentMessage` (`packages/daemon/src/connection/daemon-connection.ts`)
only dispatched `read`/`search`/`send`/`resolve`/`react`/`unreact` over real
HTTP. `mute`, `unmute`, and `thread-unfollow` threw `unsupported Agent message
operation` when actually invoked over the daemon's HTTPS transport, even
though the CLI, local proxy, and daemon runtime all modeled these operations
end to end, and the web app already had authorized service functions
(`muteAgentChannel`, `unfollowAgentThread`) for them — reachable only through
a Centrifugo RPC handler the daemon no longer calls for Agent messaging.
`requestRead`/`requestSearch`/`requestSend` also threw a generic `Error` on a
non-2xx response and discarded the response body, so the safe validation
texts in `AGENT_MESSAGE_VALIDATION_MESSAGES` never reached the CLI for those
three operations, unlike the newer `requestResolve`/`requestReaction`, which
already used `AgentMessageRequestError.fromRpc(status, text)`.

## Decision

1. **Server-side drain, ack-on-drain.** A new HTTPS route,
   `GET /api/agent/v1/events`, asks the server for "everything this Agent
   still owes attention to" and returns one bounded page ordered by
   `(conversation, thread root, sequence)`, plus `hasMore`. In the same
   request/transaction, the server advances the Agent's canonical read
   boundary for exactly the targets it is returning (thread boundary via
   `ThreadRead`, top-level via `ConversationMember.agentReadThroughSequence`);
   boundaries only move forward. `readAgentRecoveryContext`'s "unread" rule
   (above the per-target read boundary; sent by a user, or system-authored
   with a delivery row for this Agent; channels only count with a delivery
   row) is extracted into one shared `Prisma.sql` fragment
   (`unreadAgentMessagesFragment`) so the recovery query and the drain query
   cannot drift apart again.
2. **The daemon becomes a passthrough for `check`.** `#checkAgentMessages`
   no longer walks per-target attention and issues its own `read` requests.
   It loops calling the events route (capped at `MAX_EVENT_DRAIN_ROUNDS = 50`
   rounds) until the server reports an empty page or `hasMore: false`,
   appends every returned message, and only afterward calls
   `recordModelSeen` per distinct target in the drained page so the daemon's
   notice index and freshness `modelSeenSequence` stay consistent with what
   the server actually delivered. It still reports `attentionCount`/
   `summaries` from its own volatile index (unaffected by the drain) for
   logging and CLI display. `check` no longer accepts a `target`: the local
   proxy rejects `operation: "check"` with a `target` (400), and the daemon
   ignores one if it ever arrives. `fromSequence`/`throughSequence` remain
   accepted on the existing read route (history reads still use them); the
   daemon simply no longer sends them for `check`.
3. **Per-route response types, not the shared `CloudAgentMessageResponse`
   envelope.** `CloudAgentMessageResponse` is a protobuf wire message shared
   by the WSS/Centrifugo RPC path (`rpc-handler.server.ts`,
   `encode/decodeCloudAgentMessageResponse`) and, incidentally, by the plain
   JSON HTTP routes in `messages.ts`/`messages_.$messageId.*.ts`. Reusing it
   for the *new* HTTP-only routes would grow a protobuf message with fields
   (`hasMore`, channel/thread attention state) that have no WSS RPC caller
   and no reason to ever be protobuf-encoded. Instead, `packages/coforge-sdk`
   gains three small, framework-free TS response types in
   `src/agent/messages.ts`: `AgentEventsResponse` (`{ protocolMajor, requestId,
   events, hasMore }`), `AgentChannelAttentionResponse`
   (`{ protocolMajor, requestId, target, muted }`), and
   `AgentThreadAttentionResponse` (`{ protocolMajor, requestId, target,
   followed: false }`), exported through `@lrm/coforge-sdk/agent`. The
   `apps/web` routes for events/mute/unmute/unfollow return these shapes
   directly as JSON; the existing read/search/send/resolve/reactions routes
   are unchanged. This is the first cut of a direction Frank asked for:
   per-resource response shapes (Raft-style) instead of one shared envelope
   for every Agent HTTP route; migrating the remaining routes is left to a
   later CR so this change stays scoped.
4. **`DaemonConnection` adapts, it does not re-litigate.**
   `AgentMessageHttpClient` gains `requestEvents`, `requestChannelMute`
   (its input carries `muted: boolean`; the URL alone already selects
   `/mute` vs `/unmute`), and `requestThreadUnfollow`, typed to return the
   three new SDK response types. `DaemonConnection.agentMessage` dispatches
   `check` → `requestEvents`, `mute`/`unmute` → `requestChannelMute`,
   `thread-unfollow` → `requestThreadUnfollow`, and adapts each typed
   response into the `AgentMessageTransportResponse` shape
   (`CloudAgentMessageResponse & { hasMore?: boolean }`) that
   `DaemonRuntime` already consumes for every operation — `check` carries
   `messages: events, hasMore`; mute/unmute/unfollow carry
   `accepted: true, messages: []`. This keeps the daemon-runtime/connection
   boundary's shape stable while letting the wire-level HTTP contract for
   these four routes be its own thing. `hasMore` is *not* added to the
   `CloudAgentMessageResponse` proto message; it
   is only added to `AgentMessageResponse` in `local_rpc.proto` (the
   daemon-runtime → CLI/local-proxy boundary), and to the daemon-internal
   `AgentMessageTransportResponse` TS type.
5. **Fix the dispatch gap and the swallowed error bodies together.**
   `requestRead`, `requestSearch`, `requestSend`, and the shared
   `getAgentJson` helper now throw `AgentMessageRequestError.fromRpc(status,
   text)` on a non-2xx response instead of a generic `Error`, matching
   `requestResolve`/`requestReaction`. `mute requires a channel target` and
   `unfollow requires a channel thread target` join
   `AGENT_MESSAGE_VALIDATION_MESSAGES` so those two service-level validation
   messages can also reach the CLI verbatim when the server rejects an
   invalid target.
6. **`AgentMessageRequest.operation` gains `"check"`.** The daemon now sends
   `operation: "check"` to `DaemonConnection.agentMessage`, which requires
   the cloud-facing request type (already used for encode/decode round-trips
   and, historically, only local-only for this value) to accept it as a
   targetless operation, alongside the existing `LocalAgentMessageRequest`
   union that already had it.

## Rejected alternatives

- **Keep the daemon back-fill loop and only fix the mute/unmute/unfollow
  dispatch bug.** Rejected: the back-fill loop is exactly the kind of
  daemon-side reimplementation of server read logic that broke once already:
  every future change to read pagination/target-scoping risks silently
  desynchronizing `check` again.
- **A separate acknowledgement call after the drain (read, then a second
  "ack through sequence N" request).** Rejected: two round trips per page
  invites the same lost-ack class of bug the reliable-delivery design
  already avoids elsewhere; advancing the boundary in the same transaction
  that selects the page (ack-on-drain) removes the window entirely.
- **Route `check` back through the Centrifugo RPC method the way
  mute/unmute/unfollow used to be reachable.** Rejected: Agent→Web message
  read/send is deliberately on the independently-authorized HTTPS path with
  stable `request_id` retries per the root `AGENTS.md` architecture
  invariants, not WSS; `check` is a specialization of that same read
  authority.
- **Reuse `CloudAgentMessageResponse` for the new routes and just add
  `hasMore`/attention fields to it.** This was the plan going in, and part of
  a first implementation pass. Reverted at Frank's direction mid-CR: growing
  one protobuf-shaped message with fields that only ever travel as plain
  JSON blurs the WSS-RPC wire contract with the HTTP-JSON contract and makes
  it harder to reason about what protobuf actually needs to encode. Small,
  per-route response types keep each HTTP resource's shape legible on its
  own and match the direction Frank wants for future Agent HTTP routes.

## Consequences

- `apps/web`: `direct-conversation.repositories.server.ts` gains
  `unreadAgentMessagesFragment` (shared unread rule) and `drainAgentEvents`;
  `agent-messages.service.ts` gains `drainAgentEvents`; four new routes
  (`events.ts`, `channels_.$channel.mute.ts`, `channels_.$channel.unmute.ts`,
  `threads_.$thread.unfollow.ts`) close the HTTP surface gap that the
  Centrifugo RPC handler used to cover for mute/unmute/unfollow.
- `packages/coforge-sdk`: `local_rpc.proto`'s `AgentMessageResponse` gains
  `has_more` (field 16); `AgentMessageRequest.operation` gains `"check"`;
  `messages.ts` gains `AgentEventsResponse`/`AgentChannelAttentionResponse`/
  `AgentThreadAttentionResponse` and `AgentEventsGetRequest`; `routes.ts`
  gains `cloud.events`; `client.ts` gains `events.get` and typed
  `channels.mute/unmute`/`threads.unfollow` return values.
  `workspace.proto`'s `CloudAgentMessageResponse` is unchanged.
- `packages/daemon`: `daemon-connection.ts` gains the three new HTTP client
  methods and `AgentMessageTransportResponse`; `runtime.ts`'s
  `#checkAgentMessages` is rewritten as a bounded drain loop;
  `agent-proxy.ts` rejects `check` with a `target`.
- `packages/coforge`: `formatMessageCheck` tells the Agent to run `message
  check` again when `hasMore` is true, instead of always printing "no more
  new messages".
- This is the first HTTP route pair to use a per-route response type instead
  of the shared envelope; migrating `read`/`search`/`send`/`resolve`/
  `reactions` to the same pattern is explicitly deferred to a later CR.

## Validation and rollback

Validation is `bun run check` at the root; the SDK, daemon
(`agent-proxy.test.ts`, `daemon-connection.test.ts`, `daemon-runtime.test.ts`,
`agent-instructions.test.ts`), and CLI unit suites; the `apps/web` unit suite
(`bun test`) and `bun run build`; `buf lint` for the proto change. The new
`apps/web/test/agent-events.integration.ts` (DB-backed, mise task
`test:events`, env `EVENTS_TEST_DATABASE_URL`) could not run in the
implementing session because local Postgres/Redis were not running; that gap
is called out in the CR.

Rollback is reverting the CR before merge (no schema migration is part of
this change) or, post-merge, a follow-up CR that removes the four new routes
and restores the daemon back-fill loop from version control; the `has_more`
proto field addition is additive and does not require a rollback step of its
own.
