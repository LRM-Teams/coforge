import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { getFileStorage, type FileStorage, type StoredFile } from "../files/file-storage.server";
import { ACTIVE_MEMBER_WHERE } from "../conversations/active-member.server";

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_SESSION_SECONDS = 900;

export type AttachmentCapabilities = {
  maxBytes: number;
  directUploadEnabled: false;
  directUploadThresholdBytes: number;
  sessionExpiresInSeconds: number;
};

export function attachmentCapabilities(): AttachmentCapabilities {
  return {
    maxBytes: ATTACHMENT_MAX_BYTES,
    directUploadEnabled: false,
    directUploadThresholdBytes: 0,
    sessionExpiresInSeconds: ATTACHMENT_SESSION_SECONDS,
  };
}

export async function storeAttachment(
  db: PrismaClient,
  input: {
    userId: string;
    conversationId: string;
    file: File;
  },
  storage: () => Promise<FileStorage> = getFileStorage,
) {
  if (input.file.size > ATTACHMENT_MAX_BYTES) throw new AppError("INVALID_INPUT");
  const conversation = await db.conversation.findFirst({
    where: {
      id: input.conversationId,
      members: { some: { userId: input.userId } },
      OR: [{ channelName: null }, { workspace: { members: { some: { userId: input.userId } } } }],
    },
    select: { id: true, workspaceId: true },
  });
  if (!conversation) throw new AppError("ACCESS_DENIED");
  const id = crypto.randomUUID();
  const objectKey = `workspaces/${conversation.workspaceId}/attachments/${id}/original`;
  const contentType = input.file.type || "application/octet-stream";
  const files = await storage();
  await files.put(objectKey, input.file, contentType);
  try {
    return await db.attachment.create({
      data: {
        id,
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        uploaderId: input.userId,
        objectKey,
        fileName: input.file.name || "attachment",
        contentType,
        sizeBytes: input.file.size,
      },
      select: { id: true, fileName: true, contentType: true, sizeBytes: true },
    });
  } catch (error) {
    await files.remove(objectKey);
    throw error;
  }
}

/**
 * Resolves an attachment the requester may download and hands back a lazy `open` for its
 * bytes. Authorization happens here, against the committed message and the requester's
 * conversation access; the storage backend only ever sees the stable object key.
 */
export async function readAuthorizedAttachment(
  db: PrismaClient,
  input: {
    attachmentId: string;
    userId?: string;
    agentId?: string;
    conversationId?: string;
  },
  storage: () => Promise<FileStorage> = getFileStorage,
) {
  const attachment = await db.attachment.findUnique({
    where: { id: input.attachmentId },
  });
  if (!attachment || !attachment.messageId) throw new AppError("NOT_FOUND");
  const allowed = input.userId
    ? Boolean(
        await db.conversation.findFirst({
          where: {
            id: attachment.conversationId,
            OR: [
              {
                channelName: null,
                members: { some: { userId: input.userId } },
              },
              {
                channelName: { not: null },
                workspace: { members: { some: { userId: input.userId } } },
              },
            ],
          },
          select: { id: true },
        }),
      )
    : Boolean(
        input.agentId &&
        (await db.conversationMember.findFirst({
          where: {
            conversationId: attachment.conversationId,
            agentId: input.agentId,
            ...ACTIVE_MEMBER_WHERE,
          },
        })),
      );
  if (!allowed || (input.conversationId && input.conversationId !== attachment.conversationId))
    throw new AppError("ACCESS_DENIED");
  return {
    attachment,
    async open(): Promise<StoredFile> {
      const file = await (await storage()).open(attachment.objectKey);
      if (!file) throw new AppError("NOT_FOUND");
      return file;
    },
  };
}
