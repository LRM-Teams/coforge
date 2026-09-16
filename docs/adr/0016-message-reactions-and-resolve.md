# ADR 0016: Message reactions and Agent-facing message resolve

Status: accepted
Date: 2026-09-16

## Context

The Agent CLI (`coforge message ...`) can `check`, `read`, `search`, `send`,
`mute`/`unmute` a channel, and `thread unfollow`, but it has no way to prove a
message id exists or read exactly one message by id without already knowing
its conversation target, and no way to add a lightweight, non-conversational
acknowledgement to a message. `docs/database-schema.md`'s ER diagram already
anticipated `MESSAGE_REACTION` as a future table, and `docs/architecture.md`
listed "reaction/resolve" among the capabilities CoForge intentionally lacked
relative to Raft's public instructions.

Adding these two operations touches the database schema (a new
`message_reactions` table) and the wire protocol (`LocalAgentMessageRequest`
and `AgentMessageRequest` gain `message_id`/`emoji` fields and three new
operation values), both decision gates under the repository root `AGENTS.md`.

## Decision

1. **`coforge message resolve <id>`**: `<id>` is a full message UUID or an
   unambiguous 8-hex prefix. The Web/backend repository looks the message up
   across every conversation the Agent is a member of in its workspace (not
   one conversation), reusing the existing anchor-matching/ambiguity rules
   from `resolveMessage`. The CLI prints the result with the same
   `formatMessage` line `coforge message check` uses. The Agent never
   supplies or needs to know the message's target.
2. **`coforge message react --message-id <id> --emoji <emoji> [--remove]`**:
   adds, or with `--remove` removes, the Agent's own reaction. The emoji rule
   (trimmed, one to sixteen characters, no whitespace) and the message-lookup
   rule are identical to resolve. Both add and remove are idempotent: an
   existing reaction and a missing reaction are both a no-op success.
3. **Schema**: `MessageReaction` is keyed by `(messageId, memberId, emoji)`,
   denormalizes `conversationId`/`workspaceId` for its composite foreign keys
   (the same pattern `Task` and `ThreadFollow` already use), and cascades on
   message or member deletion. There is no separate count column; the browser
   groups reactions by emoji when rendering.
4. **Wire protocol**: `resolve`, `react`, and `unreact` are added to the
   existing `LocalAgentMessageRequest`/`AgentMessageRequest` operation unions
   rather than introducing a new request/response pair, and reuse
   `CloudAgentMessageResponse`/`AgentMessageResponse` (resolve returns the one
   message in `messages`; react/unreact return `accepted: true` with
   `messageId`). This follows the existing `mute`/`unmute`/`thread-unfollow`
   shape instead of a bespoke reaction protocol message.
5. **Errors are safe, typed, and versioned.** "message not found or not
   visible to this Agent" and "reaction emoji must be one to sixteen
   characters without whitespace" join the existing
   `AGENT_MESSAGE_VALIDATION_MESSAGES` safe-error allowlist that the daemon
   proxy and CLI are already permitted to relay verbatim.
6. **Browser reactions are read-only for now.** Reactions render as a compact
   pill row under the message body; there is no browser reaction picker or
   button in this change, and no realtime channel carries reaction updates —
   a reaction shows up on the next load, consistent with the MVP's
   best-effort/no-durable-outbox posture for everything except canonical
   Message writes.

## Rejected alternatives

- **A separate `MessageReactionRequest`/`MessageReactionResponse` wire
  message.** Rejected: `resolve`/`react`/`unreact` carry no target and only
  two new scalar fields, so extending the existing Agent message envelope
  keeps one request/response shape instead of a second protocol surface for a
  small feature.
- **A `reaction_count` materialized column on `Message`.** Rejected for the
  MVP: the reaction row set is small per message, and grouping at read time
  keeps the write path a single upsert/delete with no counter-maintenance
  race.
- **Realtime reaction updates over the existing Activity/Centrifugo
  channel.** Deferred; this would add a new publish path for a cosmetic
  feature before the core read/write contract has shipped. Revisit if
  reactions become a primary acknowledgement mechanism rather than a light
  compact affordance.

## Consequences

- New Prisma model `MessageReaction` / table `message_reactions`, migration
  `20260916130000_message_reactions`, generated without a live database via
  `prisma migrate diff`.
- `packages/coforge-sdk` proto and generated code, `packages/coforge` (CLI),
  `packages/daemon` (local proxy, runtime, daemon-connection HTTP client),
  and `apps/web` (repository, service, two new Agent HTTP routes, browser
  projection) all gain the three new operations end to end.
- `docs/architecture.md`'s "capabilities CoForge lacks relative to Raft" list
  no longer includes reaction/resolve.
- Daemon standing instructions gain one bullet: resolve proves/reads by id;
  react only on explicit human request or a clear acknowledgement, never
  automatically on routine updates.

## Validation and rollback

Validation is `bun run check` and the package/unit test suites listed in the
implementing CR (SDK round-trip tests, daemon proxy/runtime/connection tests,
CLI parse/dispatch tests, and the new web repository/service/route unit
tests); the migration is reviewed as generated SQL, not hand-edited. No
database-backed integration test ran for this change (no local Postgres
available in the implementing session); that gap is called out in the CR.

Rollback is reverting the CR before merge, or a follow-up migration dropping
`message_reactions` after merge; the table has no inbound foreign keys from
outside this feature, so dropping it does not cascade into unrelated data.
