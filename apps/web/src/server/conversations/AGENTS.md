# Conversation server modules

These rules apply to `src/server/conversations/`.

## Ownership

- `PublicChannels` (`public-channels.server.ts`) owns Workspace
  authorization, default-channel enrollment, channel membership, canonical
  read/write and ordering, human read positions, persistent follow state, and
  mute/mention delivery eligibility.
- `server/db/repositories/direct-conversation.repositories.server.ts` owns
  thread root validation, target-scoped ranges, Agent read positions, Agent
  target-scoped reads, and eligible-notification recovery. The Agent HTTPS
  functions enforce the authenticated Agent identity before calling it.
- `unresolved-mentions.server.ts` owns which `@handle`s of a sent message named
  nobody the sender can see (no Workspace human, no visible Agent). It reads the
  stored body, so a replay reads the same `@handle`s.
- `pending-mention-actions.server.ts` owns a sent message's mentions of people
  outside its channel (Workspace humans, public Agents): the row written in the
  send's transaction, what the sender may still do about it (7 days), and the
  claim that lets an action run once. `notify` has the target read that one
  message: a non-member Agent through its own delivery and unread source (never
  channel membership); a person through an Activity item with its own read and
  Done state on the row (`server/inbox/activity-inbox.server.ts`).
  `PublicChannels.executeMentionActions` carries out a person's `add` through
  `addMembers`; an Agent's `add` is refused (`add_requires_human_member_authority`).
- `channel-agent-control.server.ts` (`ChannelAgentControl`) owns a channel's
  "Stop all Agents" and "Resume all": which Agents each acts on, who may ask,
  and the resume prompt built from the member's guidance. The control itself
  goes through `AgentControl.stopMany` and `startMany`.
- `human-unread.server.ts` owns a person's unread rule and their read and Done
  cursor SQL. The sidebar badges and the Activity inbox (`server/inbox/`) both
  use it; do not write another unread predicate or cursor update.
- `conversation-history.server.ts` owns browser message index and
  around-window reads. They are scoped by `conversationId` for both direct
  conversations and public channels; this module owns Conversation-type
  visibility checks and bounded history mapping.
- `message-search.server.ts` owns human message search: a Workspace member
  searches every channel (joined or not, archived too, never one hidden from the
  Workspace) and only their own direct conversations, the same rule as `ConversationHistory.authorize`. Its SQL lives in
  `server/db/repositories/message-search.repositories.server.ts`; body matching is
  `ILIKE` served by the `pg_trgm` GIN index on `messages.body`. Agent search keeps
  its own Agent-membership rule in the direct-conversation repository.
- A thread uses its root Message identity, never a separate conversation or
  Agent runtime.
- A member's pins share one order across all their channels and DMs in the
  Workspace. Change pins only through `conversation-pins.server.ts`; find a
  user's pins with `member: { userId }`, never by `memberId` (a
  per-conversation membership). The order rules live in `src/lib/pin-order.ts`,
  which the Chat sidebar applies before the server answers.
- A transaction that writes pins takes `lockMemberPins` before any
  conversation lock, and several conversation locks in id order. The other
  order deadlocks a menu pin against a drag.

## `#general`

- Every Workspace has a `#general` that every human member and every public,
  live Agent is in. Workspace creation creates it with its creator in it;
  accepting an invitation, creating a public Agent, and making an Agent public
  enroll through `enrollGeneralChannel` or `joinGeneralChannel`, so reads never
  enroll. A private Agent is never in it.
- Nobody can be a channel admin of `#general`; its members always keep
  `channelRole: "member"`. No one leaves or is removed from `#general`, no role
  changes apply to it, and it is never archived. The only admin-derived
  capability on it is `update`, for a Workspace owner or admin, and only its
  description can change: its name is fixed.

- A Workspace owner or admin can hide `#general` from the whole Workspace
  (`Conversation.hiddenFromWorkspaceAt`) and restore it. While hidden it is gone
  for everyone, themselves included: every channel read filters through
  `VISIBLE_CONVERSATION_WHERE` (raw SQL: `"hiddenFromWorkspaceAt" IS NULL`), so a
  new channel read must too. Enrollment keeps running, so a restore is whole.

- Only a Workspace owner or admin deletes a channel (`deleteChannel`), never
  `#general`; a channel admin cannot, and no Agent command does. Deletion is
  hard and whole: everything in the channel goes, Reminders aimed at it or its
  threads are canceled, and its stored files are removed best effort. Purge its
  Agents' inboxes before the delete, while the publisher can still read the
  channel's name.

## Channel membership

- Any Workspace member may create or join a channel. Only a channel member may
  add Workspace humans or Agents to it; a non-member is rejected with
  `ACCESS_DENIED`.
- An archived channel is read-only: posting, joining, adding members and
  changing its name or description are refused with `CONFLICT` until it is
  unarchived. Its members keep reading it.
- Human (Web UI) and Agent (CLI) channel operations take a
  `ChannelActor = { userId } | { agentId }` and share one authorization and
  write path. Do not add a parallel Agent-only path.
- Leaving and removal are soft: set `ConversationMember.leftAt` through the
  one `softLeaveMember` helper. Never hard-delete a membership row on its own
  (only deleting the whole channel does); `Message.sender` is
  `onDelete: Restrict`.
- When an Agent leaves or is removed from a channel, after the write commits,
  publish an inbox purge through `AgentInboxPurgePublisher`
  (`server/agents/agent-inbox-purge.server.ts`) so its daemon drops that
  channel's pending messages; channel deletion does too. Channel archive,
  Agent deletion, and Workspace member removal send none.
- Active-membership reads filter through `ACTIVE_MEMBER_WHERE`
  (`active-member.server.ts`). Adding a soft-left member clears `leftAt`
  instead of skipping the row.
- Any active member may leave a channel. Removing a member requires the
  `remove_member` capability; changing a stored `channelRole` requires
  `manage_roles`.

## Channel authority

- `channel-authority.server.ts` is the single authority seam for channel
  administration on both the human and Agent sides. Do not add
  `Agent.role`-only or Workspace-role-only channel checks elsewhere. The two
  Workspace-level channel actions, hiding `#general` and deleting a channel,
  are decided there by server role alone (`canHideGeneralChannel`,
  `canDeleteChannel`) and stay out of the capability matrix, which Agents also
  receive.
- `ConversationMember.channelRole` (`admin | member`, default `member`) is
  stored on the membership. A channel's creator, human or Agent, gets
  `admin` on their own row.
- The admin basis is computed, never stored: `"server_role"` when the actor's
  Workspace or Agent server role is owner/admin, else `"channel_role"` when
  their stored `channelRole` is `admin`, else none.
- `deriveChannelCapabilities` derives exactly eight capabilities from active
  membership and admin basis: `post`, `leave`, `add_member`, `update`,
  `archive`, `unarchive`, `remove_member`, `manage_roles`. `manage_roles` is
  human-only; there is no Agent CLI or API route for it.

## Action cards

- `ActionCards.prepare` resolves every handle in a `channel:create`,
  `agent:create`, or `channel:add_member` action to a UUID, reuses the Agent
  message-send target resolver and membership rule, and creates the posted
  Message and the `ActionCard` row in the same conversation-locked transaction.
- `ActionCards.viewsFor(workspaceId, viewerUserId, messageIds)` is one batched
  lookup per message page. Never look up action cards per message.
- Every commit path runs the real operation first, under the committing
  human's identity and that operation's own authorization
  (`PublicChannels.create`/`addMembers`, or `createAgent` with
  `assertCanCreateAgents`), then marks the card `executed` with a conditional
  update. A double commit fails on the operation's own uniqueness rule or is a
  harmless `addMembers` no-op.
- `ActionCards.cancel` is allowed for the preparing Agent's owner or a
  Workspace owner/admin, and only moves `pending → cancelled`.
- Card state changes publish the existing
  `ConversationRealtime.messageAvailable`; do not add a card-specific realtime
  channel.
- Agent-facing message reads append ` [action card: <state>]` to a card
  message's body so an Agent never claims a resource exists before a human
  commits it.
