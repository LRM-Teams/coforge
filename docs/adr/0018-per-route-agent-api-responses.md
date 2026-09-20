# ADR 0018: Per-route Agent API responses for read/search/send/resolve/reactions, a dedicated search route, and removal of the dead Centrifugo message RPC

Status: accepted (partially superseded)
Date: 2026-09-16

Status: partially superseded by [ADR 0057](0057-message-freshness-hold-contract.md) for the freshness hold: the held/send response shape, the `holdToken`/`anywayAllowed` fields and the `denied` state described below were replaced by Raft's contract.

## Context

`CloudAgentMessageResponse` is a single protobuf-shaped envelope shared by
five HTTP routes — `GET`/`POST /api/agent/v1/messages` (read and send, plus
search dispatched off the same `GET` handler by the presence of a `query`
parameter), `messages_.$messageId.resolve.ts`, and
`messages_.$messageId.reactions.ts` — and, until now, by the Centrifugo RPC
method `createAgentMessageMethod`
(`apps/web/src/server/centrifugo/rpc-handler.server.ts`), which exposed
read/search/send/mute/unmute/thread-unfollow over WSS RPC. Each HTTP route
only ever populated a subset of the envelope's fields; the shape was shared
because the RPC path needed one protobuf message it could encode, not because
the five HTTP resources have a common shape.

ADR 0017 already established the direction and did the first cut: the four
new HTTP-only routes it added (`events`, channel mute/unmute, thread
unfollow) got their own small TS response types in
`packages/coforge-sdk/src/agent/messages.ts` instead of growing
`CloudAgentMessageResponse` further, and explicitly deferred migrating
read/search/send/resolve/reactions to a later CR "so this change stays
scoped." This ADR is that later CR.

Two more facts, established while scoping this change, push past "give the
remaining routes their own types" toward removing the shared envelope and its
RPC path entirely:

- **The Centrifugo RPC handler is dead on the daemon side.** Grepping
  `packages/daemon/src` for `AGENT_MESSAGE_READ_METHOD` /
  `AGENT_MESSAGE_SEND_METHOD` / `AGENT_MESSAGE_SEARCH_METHOD` /
  `AGENT_MESSAGE_CHECK_METHOD` finds no caller: `DaemonConnection` has spoken
  independently-authorized HTTPS for these operations since ADR 0001's
  authority split, and ADR 0017's rejected alternatives already named routing
  `check` back through Centrifugo RPC as against that invariant. The RPC
  handler and its method registrations were reachable only through Centrifugo
  RPC, which nothing in the current daemon calls for Agent messaging.
  `CloudAgentMessageResponse` existed as a *protobuf* message specifically so
  this RPC path could encode it on the wire; with the RPC path unused, nothing
  requires the remaining five HTTP routes' responses to be protobuf-shaped,
  or shared, at all.
- **Search is not really the same resource as read.** `messages.ts`'s `GET`
  handler branches on whether `query` is present to decide between a read and
  a search, behind one response shape (`AgentMessagesResponse`) that mixed
  `messages`/pagination cursor fields with `results`. Splitting search onto
  its own route removes the branch and lets each route's response type name
  its own fields (`messages` for read, `results` for search) instead of a
  union of both.

## Decision

1. **One response type per route**, added to
   `packages/coforge-sdk/src/agent/messages.ts` alongside the
   `AgentEventsResponse`/`AgentChannelAttentionResponse`/
   `AgentThreadAttentionResponse` types ADR 0017 added:

   | Route | Type | Fields |
   | --- | --- | --- |
   | `GET /api/agent/v1/messages` (read only) | `AgentHistoryResponse` | `protocolMajor: 1, requestId, messages: AgentMessage[], hasOlder, hasNewer, olderCursor?, newerCursor?` |
   | `GET /api/agent/v1/messages/search` (new route) | `AgentSearchResponse` | `protocolMajor: 1, requestId, results: AgentMessage[]` |
   | `POST /api/agent/v1/messages` (send) | `AgentSendResponse` | `protocolMajor: 1, requestId, state: "sent" \| "held" \| "denied", messageId?, holdToken?, bypass?, anywayAllowed?, context: AgentMessage[], freshnessContextMode?, withheldMessageCount?` |
   | `GET /api/agent/v1/messages/:id/resolve` | `AgentResolveResponse` | `protocolMajor: 1, requestId, message: AgentMessage` |
   | `POST`/`DELETE /api/agent/v1/messages/:id/reactions` | `AgentReactionResponse` | `protocolMajor: 1, requestId, messageId, emoji, active: boolean` |

   `state` on `AgentSendResponse` replaces the old
   `accepted`/`sideEffectDecision` pair losslessly: a `forward` side effect
   maps to `state: "sent"`; `anyway_accepted` maps to `state: "sent",
   bypass: true`; `hold` maps to `state: "held"`; `anyway_denied` maps to
   `state: "denied"`. `AgentMessage` already carries `task`
   (`MessageTaskMetadata`, re-exported from `local_rpc.proto`'s generated
   code) alongside `attachment`, so every route returning `AgentMessage[]` or
   a single `AgentMessage` relays everything the daemon already relays to the
   CLI today. The old shared `AgentMessagesResponse` public type is removed;
   `src/agent/client.ts`'s `messages.read/search/send/resolve/addReaction/
   removeReaction` return the new per-route types.

2. **Search gets its own route**, `GET /api/agent/v1/messages/search`, added
   to `agentApiRoutes.cloud.messages` in
   `packages/coforge-sdk/src/agent/routes.ts` as `search` alongside `list`
   (read), `send`, `resolve`, and `reactions` — a sibling path under
   `/api/agent/v1/messages`, one segment deep, so it cannot collide with
   `/api/agent/v1/messages/:messageId/...`, which is two segments deep.
   `messages.ts`'s `GET` handler stops branching on `query` and becomes
   read-only; a new `messages_.search.ts` route owns the search query
   parameters, with `query` itself staying optional (filter-only searches by
   `target`/`sender` remain valid, matching `searchAgentMessages` today). The
   daemon's `check`/search dispatch targets
   `agentApiRoutes.cloud.messages.search` instead of the shared `messages`
   path with a `query` parameter.

3. **The Centrifugo RPC message path is removed.** `createAgentMessageMethod`,
   its registrations (including the `unavailableMethod` fallbacks) in
   `rpc-composition.server.ts`, and the now-unused
   `AGENT_MESSAGE_READ_METHOD`/`AGENT_MESSAGE_SEND_METHOD`/
   `AGENT_MESSAGE_SEARCH_METHOD`/`AGENT_MESSAGE_CHECK_METHOD` constants are
   deleted. `AGENT_MESSAGE_METHOD` (`agent:deliver`, the unrelated
   daemon-to-server delivery push) and `AGENT_MESSAGE_ACK_METHOD` are
   untouched — they were never part of this RPC surface. The behavior the RPC
   handler's tests exercised is kept, but reached through the HTTP route
   handlers and service functions directly rather than through Centrifugo RPC
   plumbing.

4. **The proto messages that only existed for the RPC path are deleted.**
   `CloudAgentMessageResponse`, `CloudAgentMessageRecord`, and
   `AttachmentMetadata` are removed from `workspace.proto` — as of this SDK
   phase, `workspace.proto` no longer defines any of the three (confirmed by
   grep; `local_rpc.proto`'s own `Local*`-prefixed messages, which the
   daemon-to-CLI local proxy boundary uses, are unaffected and unchanged).
   The cloud-facing `AgentMessageRequest` *proto* message is also deleted:
   nothing still encodes it to bytes now that the Centrifugo RPC handler is
   gone (`packages/daemon/src/local-rpc.ts` and `agent-proxy.ts` only ever
   used `LocalAgentMessageRequest`, the local-proxy-to-daemon-runtime shape,
   which is a separate proto message and stays). `AgentMessageRequest`
   remains as a plain TS type in `packages/coforge-sdk/src/internal/index.ts`
   — it is still `DaemonConnection.agentMessage`'s internal request shape —
   and the operation allow-list, targetless-operation set, and
   messageId/emoji presence checks that `decodeAgentMessageRequest` used to
   enforce on the wire form now live in a plain `validateAgentMessageRequest`
   function in `src/internal/codec.ts`, which throws `"invalid cloud agent
   message request"` on the same conditions the decoder did.

5. **The daemon adapts per-route responses into one internal transport
   shape, unchanged in kind from ADR 0017's approach.**
   `AgentMessageHttpClient.requestRead/Search/Send/Resolve/Reaction` in
   `packages/daemon/src/connection/daemon-connection.ts` return the five new
   SDK types directly. `AgentMessageTransportResponse` — previously typed as
   `CloudAgentMessageResponse & { hasMore?: boolean }` per ADR 0017 — becomes
   its own plain TS type with exactly the fields `DaemonRuntime` consumes
   (`accepted`, `attentionCount`, `messageId`, `messages`,
   `sideEffectDecision`, `holdToken`, `anywayAllowed`,
   `hasOlder`/`hasNewer`/`olderCursor`/`newerCursor`, `freshnessContextMode`,
   `withheldMessageCount`, `hasMore`, `requestId`, `protocolMajor`), since
   there is no longer a `CloudAgentMessageResponse` type to intersect with.
   `DaemonConnection.agentMessage` adapts each route's response the same way
   it already adapts `events`/`channels.mute`/`unmute`/`threads.unfollow`:
   send's `state` maps back to `accepted`/`sideEffectDecision`; resolve's
   `message` becomes `messages: [message]`; search's `results` becomes
   `messages`. `DaemonRuntime` (`runtime.ts`) is intended to see no change
   beyond import/type adjustments — the adapter boundary absorbs the
   per-route split, same as it already absorbs `check`/mute/unmute/unfollow.

## Rejected alternatives

- **Keep the shared `CloudAgentMessageResponse` envelope and only add fields
  route-by-route.** This is the alternative ADR 0017 already rejected for
  the four routes it added, for the same reason repeated here at larger
  scope: growing one protobuf-shaped message with fields that only ever
  travel as plain JSON blurs the WSS-RPC wire contract with the HTTP-JSON
  contract. With the RPC path now confirmed dead, there is no remaining
  reason for these five responses to share a protobuf-encodable shape at
  all, so keeping the envelope "for consistency" would preserve a
  constraint (protobuf-encodability) that no caller needs.
- **Keep the Centrifugo RPC path alive "just in case" a future caller wants
  Agent messaging over WSS.** Rejected: Agent read/send authority is
  deliberately on the independently-authorized HTTPS path with stable
  `request_id` retries per the root `AGENTS.md` architecture invariants, not
  WSS — the same reasoning ADR 0017 used to reject routing `check` through
  Centrifugo RPC applies to the whole handler, not just that one operation.
  A dead code path that duplicates authorization logic is a liability
  (it must be kept correct with no caller ever exercising it), not an
  option preserved for free.
- **Keep search dispatched off the read route by `query` presence, and only
  give it a distinct response type.** Rejected: the type-only version still
  leaves one handler deciding between two unrelated queries and building a
  response that has to satisfy both shapes' fields at the call site. A
  dedicated route lets the read handler return 400 on an unexpected `query`
  parameter instead of silently reinterpreting the request, and lets the
  search route own its own query-parameter validation independent of read's
  pagination parameters.

## Consequences and migration

- `packages/coforge-sdk`: `src/agent/messages.ts` gains `AgentHistoryResponse`,
  `AgentSearchResponse`, `AgentSendResponse`, `AgentResolveResponse`,
  `AgentReactionResponse` and loses the shared `AgentMessagesResponse`;
  `src/agent/routes.ts` gains `cloud.messages.search`; `src/agent/client.ts`
  and `routes.test.ts`/`messages.test.ts` are updated for the new
  return types and route. `workspace.proto` loses `CloudAgentMessageResponse`,
  `CloudAgentMessageRecord`, `AttachmentMetadata`, and the cloud
  `AgentMessageRequest` message; `src/internal/index.ts` loses the
  corresponding encode/decode exports and the
  `AGENT_MESSAGE_READ_METHOD`/`SEND_METHOD`/`SEARCH_METHOD`/`CHECK_METHOD`
  constants, and gains `validateAgentMessageRequest` in `codec.ts` in place
  of `decodeAgentMessageRequest`'s validation; `agent-message.test.ts` is
  updated to exercise the validator instead of a byte round-trip. This SDK
  phase is complete as of this record.
- `apps/web`: `messages.ts`'s `GET` handler becomes read-only (400 on a
  `query` parameter); a new `messages_.search.ts` route owns search; each of
  the five route handlers returns its own response type with the same
  per-file error handling as before (safe validation text for
  `AgentMessageValidationError`, generic 400 otherwise);
  `createAgentMessageMethod` and its `rpc-composition.server.ts`
  registrations are deleted; `centrifugo-rpc-handler.test.ts`,
  `direct-thread.integration.ts`, and `public-channel.integration.ts` are
  rewritten to exercise the same assertions through the HTTP route handlers
  or service functions instead of Centrifugo RPC. This layer was in progress
  in parallel with this record and is not re-verified here.
- `packages/daemon`: `AgentMessageHttpClient`'s five request methods return
  the new per-route types; `AgentMessageTransportResponse` becomes its own
  plain TS type instead of `CloudAgentMessageResponse & {...}`;
  `DaemonConnection.agentMessage` gains the per-route adapters described
  above; `daemon-connection.test.ts` fixtures move to the new per-route
  shapes, and `daemon-runtime.test.ts` fixtures are adjusted for type only.
  This layer was also in progress in parallel with this record and is not
  re-verified here.
- `docs/architecture.md` is updated wherever it names the removed RPC
  methods or the shared envelope.
- Migration is additive-then-subtractive within one CR: the new SDK types
  and search route land, callers move onto them, and the envelope/RPC path
  are deleted in the same change — there is no dual-write or compatibility
  window, matching how ADR 0017's four new routes shipped directly rather
  than behind a flag, since no Agent-facing wire format changes (the daemon
  and CLI on either side of the HTTP boundary are versioned together with
  the rest of this monorepo, not released independently of the server).

## Validation and rollback

Validation is the same shape as ADR 0017's: root `bun run check`; `bun test`
in `packages/coforge-sdk` and `packages/coforge`; the daemon's
`agent-proxy.test.ts`, `daemon-connection.test.ts`, `daemon-runtime.test.ts`;
`apps/web`'s full unit suite plus the DB-backed
`direct-thread.integration.ts`, `public-channel.integration.ts`,
`workspace-members.integration.ts`, and `agent-events.integration.ts`; `bun
run build` in `apps/web` to confirm `/api/agent/v1/messages/search` is
served at its own path without colliding with
`/api/agent/v1/messages/:messageId/...`; `buf lint` for the proto removals.
This record documents the SDK-layer decision and the intended end state for
`apps/web` and `packages/daemon`, written while those two layers were being
implemented in parallel in the same worktree; it does not itself report
command output for those two layers, which is reported by the CR that lands
them.

Rollback is reverting the CR before merge (no schema migration is part of
this change), or, post-merge, a follow-up CR that restores
`CloudAgentMessageResponse`, the cloud `AgentMessageRequest` proto message,
and `createAgentMessageMethod` from version control. Because the RPC path
had no live caller at the time of removal (confirmed by the
`packages/daemon/src` grep in Context), restoring it is a pure revert with
no data or in-flight-request compatibility concern.

## See also

[ADR 0017](0017-server-side-agent-event-drain.md) established per-route
response types for the events/mute/unmute/unfollow routes and deferred
migrating read/search/send/resolve/reactions to this record.
