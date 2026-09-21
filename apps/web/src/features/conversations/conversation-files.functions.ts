import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppError } from "../../lib/app-error";
import { workspaceUserMiddleware } from "../../server/auth/function-auth";

export type ConversationFile = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  sender: string;
  /** The sequence of the message this file was sent on, for scroll-to-message links; threads
   * link through their root, orphaned files (message deleted) have none. */
  messageSequence: number | null;
};

/** Every file ever sent in one conversation, newest first, for the chat page's Files tab. */
export const loadConversationFiles = createServerFn({ method: "GET" })
  .middleware([workspaceUserMiddleware])
  .validator(z.object({ conversationId: z.string().uuid() }))
  .handler(async ({ context, data }) => {
    const { user, db, workspaceId } = context;
    // Files carry no per-attachment ACL of their own: the visibility boundary is the
    // conversation's membership, the same one that gates the messages the files ride on.
    const member = await db.conversationMember.findUnique({
      where: {
        conversationId_userId: { conversationId: data.conversationId, userId: user.id },
      },
      select: { id: true },
    });
    if (!member) throw new AppError("ACCESS_DENIED");
    const attachments = await db.attachment.findMany({
      where: { conversationId: data.conversationId, workspaceId },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true,
        fileName: true,
        contentType: true,
        sizeBytes: true,
        createdAt: true,
        message: { select: { sequence: true } },
        uploader: { select: { username: true, displayName: true } },
        uploaderAgent: { select: { displayName: true, name: true } },
      },
    });
    return {
      files: attachments.map((attachment) => ({
        id: attachment.id,
        fileName: attachment.fileName,
        contentType: attachment.contentType,
        sizeBytes: attachment.sizeBytes,
        createdAt: attachment.createdAt.toISOString(),
        sender:
          attachment.uploader?.displayName ||
          attachment.uploader?.username ||
          attachment.uploaderAgent?.displayName ||
          attachment.uploaderAgent?.name ||
          "",
        messageSequence: attachment.message?.sequence ?? null,
      })),
    };
  });
