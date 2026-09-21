import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { AppError } from "../../lib/app-error";
import { workspaceUserMiddleware } from "../../server/auth/function-auth";
import { attachmentView } from "../../server/attachments/attachment-view.server";
import { isInlineImage } from "../../server/attachments/attachment-response.server";

export type ConversationFile = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
  sender: string;
  /** True only for the raster types `/api/attachments/:id` serves inline — an SVG "image/*"
   * must render as the generic file icon, never as an `<img>` from the app origin. */
  inlineImage: boolean;
  /** A short-lived signed CDN URL for an inline-eligible image or an off-origin-frameable PDF
   * (same signing as message attachments); its absence means the client preview falls back to
   * the authenticated route, and a PDF stays download-only. */
  previewUrl?: string;
  /** The message this file was sent on, for locate-in-chat links; the hash anchor resolves a
   * thread reply through its root, orphaned files (message deleted) have none. */
  messageId: string | null;
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
        objectKey: true,
        message: { select: { id: true } },
        uploader: { select: { username: true, displayName: true } },
        uploaderAgent: { select: { displayName: true, name: true } },
      },
    });
    return {
      files: attachments.map((attachment) => ({
        ...attachmentView(attachment),
        createdAt: attachment.createdAt.toISOString(),
        inlineImage: isInlineImage(attachment.contentType),
        sender:
          attachment.uploader?.displayName ||
          attachment.uploader?.username ||
          attachment.uploaderAgent?.displayName ||
          attachment.uploaderAgent?.name ||
          "",
        messageId: attachment.message?.id ?? null,
      })),
    };
  });
