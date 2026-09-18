# ADR 0046: A per-member read cursor powers the channel unread badge

Status: proposed (awaiting approval — schema change)
Date: 2026-09-18

## Context

The Chat page's channel list had no unread indicator at all: `PublicChannels.list` returned only
`joined`/`archived`, and the only persisted read positions were thread-scoped (`thread_reads`) or
Agent-side (`agentReadThroughSequence`). A human opening a channel therefore had no way to see
that a channel had new messages without opening every channel, and nothing on the server to build
a badge from.

The product expectation follows Slack/Discord: a per-channel unread count that

- counts only messages **for the member** (not their own posts, not system messages);
- counts only the channel's main target — a thread reply consumes thread unread, never channel
  unread (the existing "message target" rule in `CONTEXT.md`);
- appears live while the list is open, without holding a per-conversation subscription for every
  channel;
- clears when the conversation is read, and never counts history that predates membership.

Two constraints bound the design:

- **No unread-truth on the client.** `docs/reliable-message-delivery.md` already fixes the rule
  that read boundaries are cloud-canonical state. A client-side "count publications since mount"
  badge would be lost on every reload and would contradict that document.
- **No per-message read rows.** A `MessageRead(memberId, messageId)` ledger would grow one row per
  member per message forever. Slack's own model (and Raft's) is a per-conversation cursor plus
  counts, not per-message receipts.

## Decision

1. **One column**: `ConversationMember.readThroughSequence` (integer, default 0) is the human
   member's read boundary over **top-level** messages in that conversation. Agents keep their own
   `agentReadThroughSequence` delivery cursor; the two never mix. This widens the
   `ConversationMember.lastReadSeq`-style read boundary that
   `docs/reliable-message-delivery.md` already reserved for the generic member read boundary, so
   no second read model is introduced.
2. **Unread = count, not difference.** The count is exactly
   `top-level messages with sequence > readThroughSequence, authored by another member`
   (system messages with no sender are already-read by definition). It is computed in one
   grouped SQL statement per `list()` call, compared against each member row's own cursor —
   sequence numbers alone cannot express this because threads consume sequence numbers without
   being top-level messages.
3. **Seeding**: joining (`join`), being added (`addMembers`), and `#general` enrollment
   (`enrollGeneralChannel`) all start the new member's cursor at the channel's current end. The
   badge counts what arrives *after* membership, never the backlog that existed before — the same
   rule Slack applies. Re-joining after a soft leave re-seeds the cursor (mute preference and the
   row itself survive as before).
4. **`PublicChannels.markRead(workspaceId, userId, channelId, throughSequence)`** advances the
   cursor. It is monotone (`lt` guard), clamped to the conversation's current maximum sequence,
   and a no-op for a non-member. A stale client cannot move the boundary backwards, and an
   over-eager client cannot swallow future messages into "already read". Exposed to the browser
   as the `markPublicChannelRead` Server Function; the open channel route calls it whenever the
   member can read (active member) and the loaded history's latest top-level sequence advances.
5. **Realtime**: the existing versioned `message.available.v1` event gains two additive fields —
   `workspaceId` (always set on new publications) and `threadRootId` (set only for a thread
   reply). `CentrifugoConversationRealtime.messageAvailable` now publishes the same event to both
   `chat:<conversationId>` (the open conversation's reconciliation, unchanged) and the new
   `chat:workspace:<workspaceId>` signal channel. The browser's Chat page holds **one** workspace
   subscription (the same pattern as `agent:status:<workspaceId>`), bumps a listed channel's
   badge when a top-level message arrives in any non-open conversation, and deduplicates by a
   per-conversation sequence high-water mark so a late or reordered event never double-counts.
   Every list fetch (loader refresh) replaces local arithmetic with the server's count.
6. **The badge is presentational**: the browser clears it optimistically on open and reconciles
   against the server's persisted count on the next list read. No new browser-persisted state.

## Rejected alternatives

- **Client-side counting only** (no schema): violates the cloud-canonical read-boundary rule;
  badges reset on reload and disagree across devices.
- **Per-message read ledger**: exact mention/read state but unbounded storage and a write per
  member per message; rejected for the same reason the MVP rejected a delivery ledger.
- **`latest − cursor` arithmetic on sequences**: wrong once thread replies consume sequence
  numbers (they are not top-level) and after soft-leave/rejoin reseeding; the count must be
  computed against the cursor, not subtracted from it.
- **Reusing `agentReadThroughSequence`** for humans: that column is the Agent delivery/recovery
  cursor advanced by ack-on-drain; overloading it would couple human reading to Agent recovery
  semantics.

## Consequences and migration

- Migration `20260918150000_member_read_cursor` adds the column and baselines every existing
  member row to its conversation's current maximum sequence, so nobody is badged for history that
  predates the feature. New member rows start at 0 but every membership write path seeds the
  cursor, so the default is only reachable for rows created outside those paths.
- `listPublicChannels` becomes two statements (channel list + one grouped count) instead of one.
  The count query is indexed by the existing `messages(conversationId, …)` indexes; channel lists
  in the MVP are small.
- `PersistedDirectMessage` and both repository send paths carry `threadRootId` so the browser
  signal can exclude thread replies. The event schema change is additive; consumers that ignore
  the new fields behave exactly as before.
- Rollback: drop the column and the workspace-channel publication. No data depends on the cursor
  surviving.

## Validation

- `apps/web/test/conversation-unread.test.ts` pins the reducer: seeding, thread exclusion, open-
  conversation suppression, duplicate/out-of-order suppression, clear-with-boundary, and
  server-count replacement.
- `apps/web/test/public-channel.integration.ts` ("channel unread (ADR 0043)") pins the service
  behavior end to end against PostgreSQL: counting, self-message exclusion, thread exclusion,
  monotone clamped `markRead`, non-member zero, and `addMembers`/`join` seeding.