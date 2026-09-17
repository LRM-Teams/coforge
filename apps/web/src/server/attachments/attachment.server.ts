import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";
import { getFileStorage, type FileStorage, type StoredFile } from "../files/file-storage.server";

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
 * Stores a file an Agent uploaded through the Agent HTTP API, mirroring `storeAttachment` but
 * writing `uploaderAgentId` instead of `uploaderId`. `conversationId` is already resolved and
 * membership-checked by the caller (the Agent target grammar), so no further authorization
 * happens here.
 */
export async function storeAgentAttachment(
  db: PrismaClient,
  input: {
    agentId: string;
    conversationId: string;
    workspaceId: string;
    file: File;
    contentType: string;
  },
  storage: () => Promise<FileStorage> = getFileStorage,
) {
  if (input.file.size === 0 || input.file.size > ATTACHMENT_MAX_BYTES)
    throw new AppError("INVALID_INPUT");
  const id = crypto.randomUUID();
  const objectKey = `workspaces/${input.workspaceId}/attachments/${id}/original`;
  const files = await storage();
  await files.put(objectKey, input.file, input.contentType);
  try {
    return await db.attachment.create({
      data: {
        id,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        uploaderId: null,
        uploaderAgentId: input.agentId,
        objectKey,
        fileName: input.file.name || "attachment",
        contentType: input.contentType,
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
 * conversation access; the storage backend only ever sees the stable object key. The one
 * exception is an Agent downloading its own not-yet-linked upload (`uploaderAgentId ===
 * agentId`): every other Agent still needs the attachment linked to a message first.
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
  if (!attachment) throw new AppError("NOT_FOUND");
  const isOwnUpload = Boolean(input.agentId) && attachment.uploaderAgentId === input.agentId;
  if (!attachment.messageId && !isOwnUpload) throw new AppError("NOT_FOUND");
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
