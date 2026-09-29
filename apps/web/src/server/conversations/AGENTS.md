# Conversation server modules

These rules apply to `src/server/conversations/`.

## Ownership

- `PublicChannels` (`public-channels.server.ts`) owns Workspace
  authorization, default-channel enrollment, channel membership, canonical
  read/write and ordering, human read positions, persistent follow state, and
  mute/mention delivery eligibility. `channelAgentRecipients` is the one rule
  for which Agents a sent channel message wakes, whether a person or an Agent
  sent it; the Agent send path in the direct-conversation repository calls it
  too. A Task and an action card keep their own rules.
- `DirectConversations` (`direct-conversations.server.ts`) owns the viewer's
  direct conversations by id: opening one by who it is with (only their own
  live Agent, or a Workspace member), `authorize` (who may use a conversation
  id and who it is with: a DM with an Agent is its creator's alone, and a
  deleted Agent's DM is read-only), every page operation (read a window,
  updates, read cursors, reactions, send) and the viewer's Direct messages
  list (`list`, `unreadCounts`, pin, mark unread, close). A DM with an Agent
  and one between members share each operation; only a send branches, to
  `SendDirectMessage` or `UserDirectConversations`. Server Functions call it
  and stay thin; do not key a new DM operation by Agent.
- `viewerDirectConversationWhere` (`viewer-direct-conversations.server.ts`)
  is the one filter for the DMs a viewer's list holds (the ones `authorize`
  lets them open, less a deleted Agent's); the list and a pin drag both use
  it, and the Activity inbox lists exactly these DMs through its raw SQL twin
  `viewerDirectConversationSql` in the same file. Change the two together.
  A DM the viewer closed comes back when someone other than them posts a
  top-level message after the close.
- `direct-conversation-peer.server.ts` owns who a DM is with as every DM
  surface shows it (the sidebar, the Activity inbox): an Agent, or a member by
  the DM's key, still named after they leave the Workspace.
- `UserDirectConversations` (`user-direct-conversations.server.ts`) owns
  direct conversations between Workspace members (and a member with
  themself): one per pair and sending in it. It never delivers to an
  Agent; its list signal goes only to the other member, never the sender.
- `server/db/repositories/direct-conversation.repositories.server.ts` owns
  thread root validation, target-scoped ranges, Agent read positions, Agent
  target-scoped reads, and eligible-notification recovery. The Agent HTTPS
  functions enforce the authenticated Agent identity before calling it. Which
  messages an Agent still owes attention to is stated once, in
  `server/db/repositories/agent-attention.repositories.server.ts`; its reads
  use that module and do not restate the rule.
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
- `mention-deliveries.server.ts` owns tracked @mention outcomes: issuing each
  push's envelope, the daemon's reports on it, and when an Agent can be woken.
- `channel-agent-control.server.ts` (`ChannelAgentControl`) owns a channel's
  "Stop all Agents" and "Resume all": which Agents each acts on, who may ask,
  and the resume prompt built from the member's guidance. The control itself
  goes through `AgentControl.stopMany` and `startMany`.
- `human-unread.server.ts` owns a person's unread rule and their read and Done
  cursor SQL. The sidebar badges and the Activity inbox (`server/inbox/`) both
  use it; do not write another unread predicate or cursor update.
- `conversation-history.server.ts` owns browser message index and around-window
  reads. They are scoped by `conversationId` for both direct conversations and
  public channels; this module owns Conversation-type visibility checks and
  bounded history mapping. Its `browserMessageFields` and `mapBrowserMessage`
  are the one browser-facing message shape: channel pages and updates, saved
  messages, search, and the Activity inbox all select and render through them.
- `message-search.server.ts` owns human message search: a Workspace member
  searches every channel (joined or not, archived too, never one hidden from the
  Workspace) and only their own direct conversations, the same rule as `ConversationHistory.authorize`. Its SQL lives in
  `server/db/repositories/message-search.repositories.server.ts`; body matching is
  `ILIKE` served by the `pg_trgm` GIN index on `messages.body`. Agent search keeps
  its own Agent-membership rule in the direct-conversation repository.
- A thread uses its root Message identity, never a separate conversation or
  Agent runtime.
- A write that changes a person's own place in a channel or DM (read cursor, membership, start, close, mute, pins) or their Saved list announces a `ViewerEvent` to that person through `announceViewerEvent` after it commits; a write that changed nothing announces nothing. A read cursor moves only through `human-unread.server.ts` (`markHumanRead`, the Activity Done and read-all SQL), and every move announces the count it left; closing a chat always restamps `hiddenAt`, since a newer message may have brought it back.
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
  live Agent is in. Workspace creation creates it with its creator in it; joining
  the Workspace (an accepted invitation or a join link, both through
  `admitWorkspaceMember`), creating a public Agent, and making an Agent public
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
- Leaving and removal are soft: they set `ConversationMember.leftAt`, filtered
  by `ACTIVE_MEMBER_WHERE`, and never hard-delete a membership row on its own
  (only deleting the whole channel does); `Message.sender`, `Task.owner` and
  `Task.creator` are `onDelete: Restrict`. Web UI channel leave and removal
  go through `softLeaveMember`; the Agent CLI's channel commands, an Agent
  going private, deleting an Agent and leaving the Workspace write `leftAt`
  in their own module.
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

## Leaving and returning to the Workspace

- Leaving or being removed soft-leaves every conversation (channels and direct
  conversations) in one write; coming back (`admitWorkspaceMember`, by an
  invitation or a join link) makes the person's direct conversations and
  `#general` active again on the same rows, read positions kept. Other channels
  stay left until they join.
- A direct conversation whose person left stays readable to the other side (a
  person, or an Agent that still reads it and marks it read) and takes no new
  message. An Agent posting to it, a message or an attachment, resolves the
  target with `resolveAgentSendTarget`, which refuses with
  `DM_PEER_NOT_IN_WORKSPACE` (403 with that `code`) before anything is written.

## Channel authority

- `channel-authority.server.ts` is the single authority seam for channel
  administration on both the human and Agent sides. Do not add `Agent.role`-only
  or Workspace-role-only channel checks elsewhere. The three Workspace-level
  channel actions, hiding `#general`, deleting a channel and listing every
  archived channel in Workspace settings, are decided there by server role alone
  (`canHideGeneralChannel`, `canDeleteChannel`, `canListArchivedChannels`) and
  stay out of the capability matrix, which Agents also receive.
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
