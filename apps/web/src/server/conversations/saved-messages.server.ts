import type { Prisma, PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import { browserMessageFields, mapBrowserMessage } from "./conversation-history.server";

/**
 * A signed-in user's own Saved list (#120), one `SavedMessage` row per saved message. The row
 * hangs off the message exactly like `Task` does — compound `(messageId, conversationId)` FK to
 * the message plus the member's `(memberId, conversationId, workspaceId)` FK — so saving never
 * invents a second addressing scheme for messages.
 *
 * Conversation-scope authorization is settled by those two lookups rather than by a separate
 * access helper: the message must exist in the conversation given, and saving requires an
 * *active* membership — the same seam `toggleUserMessageReaction` applies (the compound member
 * FK makes it structural: no member row, no save). Reading is scoped through the viewer's own
 * member rows instead, and like pins it is independent of leave: a soft-left member still sees
 * (and can clear) the bookmarks made while they were active — `leftAt` only blocks new saves.
 *
 * Conversation-scope ownership for DMs/channels beyond membership stays with the caller, next
 * to its send paths, exactly as the reaction repository documents.
 */
export async function saveUserMessage(
  db: PrismaClient,
  input: {
    workspaceId: string;
    conversationId: string;
    userId: string;
    messageId: string;
  },
): Promise<void> {
  const { workspaceId, conversationId, userId, messageId } = input;
  const message = await db.message.findFirst({
    where: { id: messageId, conversationId, workspaceId },
    select: { id: true },
  });
  if (!message) throw new AppError("NOT_FOUND");
  const member = await db.conversationMember.findFirst({
    where: { conversationId, workspaceId, userId, ...ACTIVE_MEMBER_WHERE },
    select: { id: true },
  });
  if (!member) throw new AppError("ACCESS_DENIED");
  // Saving twice is a no-op: the PK is (messageId, memberId), and an empty update keeps the
  // original savedAt instead of bumping it.
  await db.savedMessage.upsert({
    where: { messageId_memberId: { messageId: message.id, memberId: member.id } },
    create: {
      messageId: message.id,
      conversationId,
      workspaceId,
      memberId: member.id,
    },
    update: {},
  });
}

/**
 * Removes the viewer's own bookmark; idempotent like the reaction un-toggle (an absent row
 * succeeds). Deliberately *not* `ACTIVE_MEMBER_WHERE`: bookmarks outlive a soft leave (see the
 * module note), so a member who left must still be able to clear their list.
 */
export async function unsaveUserMessage(
  db: PrismaClient,
  input: {
    workspaceId: string;
    conversationId: string;
    userId: string;
    messageId: string;
  },
): Promise<void> {
  const { workspaceId, conversationId, userId, messageId } = input;
  const message = await db.message.findFirst({
    where: { id: messageId, conversationId, workspaceId },
    select: { id: true },
  });
  if (!message) throw new AppError("NOT_FOUND");
  const member = await db.conversationMember.findFirst({
    where: { conversationId, workspaceId, userId },
    select: { id: true },
  });
  if (!member) throw new AppError("ACCESS_DENIED");
  await db.savedMessage.deleteMany({
    where: { messageId: message.id, memberId: member.id },
  });
}

const savedMessageSelect = {
  createdAt: true,
  conversation: { select: { id: true, channelName: true, directKey: true } },
  // The exact row shape the message stream renders with, so the Saved view reuses the same
  // projection (sender, attachments, mentions, reactions) instead of a near-copy.
  message: { select: browserMessageFields },
} as const;

export type SavedMessageRow = Prisma.SavedMessageGetPayload<{ select: typeof savedMessageSelect }>;

export type SavedMessageView = {
  /** When the viewer saved it; the list orders by this, newest first. */
  savedAt: Date;
  /** Enough conversation context to label the card; the jump target is `message.conversationId`. */
  conversation: { id: string; channelName: string | null; directKey: string | null };
  message: ReturnType<typeof mapBrowserMessage>;
};

/** Pure projection of one saved row (unit-tested without a database), like `mapBrowserMessage`. */
export function savedMessageView(row: SavedMessageRow, workspaceId: string): SavedMessageView {
  return {
    savedAt: row.createdAt,
    conversation: row.conversation,
    message: mapBrowserMessage(row.message, workspaceId),
  };
}

/**
 * The viewer's bookmarks across every conversation in the Workspace, newest save first. The
 * `member` relation filter reduces the query to the viewer's own member rows (one per
 * conversation), so cross-conversation saves need no manual member-id list and can never leak
 * another member's list. Unpaginated for now — personal bookmark lists are small; add a
 * `(workspaceId, memberId, createdAt)` cursor when a view asks for pages.
 */
export async function listUserSavedMessages(
  db: PrismaClient,
  input: { workspaceId: string; userId: string },
): Promise<SavedMessageView[]> {
  const { workspaceId, userId } = input;
  const rows = await db.savedMessage.findMany({
    where: { workspaceId, member: { workspaceId, userId } },
    select: savedMessageSelect,
    orderBy: { createdAt: "desc" },
  });
  return rows.map((row) => savedMessageView(row, workspaceId));
}
