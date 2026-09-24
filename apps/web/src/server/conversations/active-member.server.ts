import type { Prisma } from "#src/generated/prisma/client";

/**
 * A `ConversationMember` row that has not left. `leftAt` is a soft-leave marker: member rows
 * can never be deleted once they own a Message or Task (`onDelete: Restrict`), so "is this
 * agent/human currently a member of this conversation" must always be spelled with this filter
 * rather than by row existence alone. Re-joining clears `leftAt` and keeps the same row, so a
 * read boundary or mute preference set before leaving survives a later re-join.
 */
export const ACTIVE_MEMBER_WHERE = { leftAt: null } satisfies Prisma.ConversationMemberWhereInput;

/**
 * A conversation the Workspace can see: not hidden from the whole Workspace by an owner or admin
 * (only `#general` ever is, see `Conversation.hiddenFromWorkspaceAt`). A hidden channel is gone
 * from every list, page, post, search and Agent surface until it is restored, so every channel
 * read filters through this, and a raw query checks `"hiddenFromWorkspaceAt" IS NULL`.
 */
export const VISIBLE_CONVERSATION_WHERE = {
  hiddenFromWorkspaceAt: null,
} satisfies Prisma.ConversationWhereInput;

/** An active membership of a channel (a conversation with a channel name), not of a DM. */
export const ACTIVE_CHANNEL_MEMBER_WHERE = {
  ...ACTIVE_MEMBER_WHERE,
  conversation: { channelName: { not: null } },
} satisfies Prisma.ConversationMemberWhereInput;
