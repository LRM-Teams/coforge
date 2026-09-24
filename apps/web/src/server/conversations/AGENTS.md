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
- `conversation-history.server.ts` owns browser message index and
  around-window reads. They are scoped by `conversationId` for both direct
  conversations and public channels; this module owns Conversation-type
  visibility checks and bounded history mapping.
- A thread uses its root Message identity, never a separate conversation or
  Agent runtime.
- A member's pins share one order across all their channels and DMs in the
  Workspace. Change pins only through `conversation-pins.server.ts`; find a
  user's pins with `member: { userId }`, never by `memberId` (a
  per-conversation membership).
- A transaction that writes pins takes `lockMemberPins` before any
  conversation lock, and several conversation locks in id order. The other
  order deadlocks a menu pin against a drag.

## `#general`

- Every Workspace has a `#general` that every human member and every public,
  live Agent is in. Workspace creation creates it with its creator in it;
  accepting an invitation, creating a public Agent, and making an Agent public
  enroll through `enrollGeneralChannel` (or the visibility store), so reads
  never enroll. A private Agent is never in it.
- Nobody can be a channel admin of `#general`; its members always keep
  `channelRole: "member"`. No one leaves or is removed from `#general`, no role
  changes apply to it, and it is never archived. The only admin-derived
  capability on it is `update`, for a Workspace owner or admin, and only its
  description can change: its name is fixed.

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
  one `softLeaveMember` helper. Never hard-delete a membership row;
  `Message.sender` is `onDelete: Restrict`.
- Active-membership reads filter through `ACTIVE_MEMBER_WHERE`
  (`active-member.server.ts`). Adding a soft-left member clears `leftAt`
  instead of skipping the row.
- Any active member may leave a channel. Removing a member requires the
  `remove_member` capability; changing a stored `channelRole` requires
  `manage_roles`.

## Channel authority

- `channel-authority.server.ts` is the single authority seam for channel
  administration on both the human and Agent sides. Do not add
  `Agent.role`-only or Workspace-role-only channel checks.
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
