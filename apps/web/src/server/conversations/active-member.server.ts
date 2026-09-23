import type { Prisma } from "#src/generated/prisma/client";

/**
 * A `ConversationMember` row that has not left. `leftAt` is a soft-leave marker: member rows
 * can never be deleted once they own a Message or Task (`onDelete: Restrict`), so "is this
 * agent/human currently a member of this conversation" must always be spelled with this filter
 * rather than by row existence alone. Re-joining clears `leftAt` and keeps the same row, so a
 * read boundary or mute preference set before leaving survives a later re-join.
 */
export const ACTIVE_MEMBER_WHERE = { leftAt: null } satisfies Prisma.ConversationMemberWhereInput;
