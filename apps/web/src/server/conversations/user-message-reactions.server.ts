import { isValidReactionEmoji } from "@lrm/coforge-sdk/internal";
import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { ACTIVE_MEMBER_WHERE } from "./active-member.server";
import {
  MESSAGE_REACTIONS_SELECT,
  reactionSummaries,
  type MessageReactionSummary,
} from "./message-reactions.server";

/**
 * A signed-in user's own emoji reaction on one conversation message. Conversation-scope
 * authorization (DM ownership, channel visibility) stays with the caller — the DM
 * repository and `PublicChannels` own those checks next to their send paths; this only
 * resolves the caller's active membership, toggles the row, and returns the message's
 * fresh reaction summaries for the browser to display.
 */
export async function toggleUserMessageReaction(
  db: PrismaClient,
  input: {
    workspaceId: string;
    conversationId: string;
    userId: string;
    messageId: string;
    emoji: string;
    active: boolean;
  },
): Promise<MessageReactionSummary[] | undefined> {
  const { workspaceId, conversationId, userId, messageId, emoji, active } = input;
  if (!isValidReactionEmoji(emoji)) throw new AppError("INVALID_INPUT");
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
  if (active)
    await db.messageReaction.upsert({
      where: { messageId_memberId_emoji: { messageId: message.id, memberId: member.id, emoji } },
      create: {
        messageId: message.id,
        conversationId,
        workspaceId,
        memberId: member.id,
        emoji,
      },
      update: {},
    });
  else
    await db.messageReaction.deleteMany({
      where: { messageId: message.id, memberId: member.id, emoji },
    });
  const rows = await db.messageReaction.findMany({
    where: { messageId: message.id },
    ...MESSAGE_REACTIONS_SELECT,
  });
  return reactionSummaries(rows);
}
