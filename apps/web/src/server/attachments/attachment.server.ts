import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PrismaClient } from "../../../generated/client";
import { AppError } from "../../lib/app-error";

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

function storageRoot() {
  return process.env.COFORGE_ATTACHMENT_STORAGE_DIR ?? join(process.cwd(), ".data", "attachments");
}

export async function storeAttachment(
  db: PrismaClient,
  input: {
    userId: string;
    conversationId: string;
    file: File;
  },
) {
  if (input.file.size > ATTACHMENT_MAX_BYTES) throw new AppError("INVALID_INPUT");
  const conversation = await db.conversation.findFirst({
    where: { id: input.conversationId, members: { some: { userId: input.userId } } },
    select: { id: true, workspaceId: true },
  });
  if (!conversation) throw new AppError("ACCESS_DENIED");
  const id = crypto.randomUUID();
  const objectKey = `workspaces/${conversation.workspaceId}/attachments/${id}/original`;
  await mkdir(join(storageRoot(), conversation.workspaceId, "attachments", id), {
    recursive: true,
  });
  await Bun.write(
    join(storageRoot(), conversation.workspaceId, "attachments", id, "original"),
    input.file,
  );
  try {
    return await db.attachment.create({
      data: {
        id,
        workspaceId: conversation.workspaceId,
        conversationId: conversation.id,
        uploaderId: input.userId,
        objectKey,
        fileName: input.file.name || "attachment",
        contentType: input.file.type || "application/octet-stream",
        sizeBytes: input.file.size,
      },
      select: { id: true, fileName: true, contentType: true, sizeBytes: true },
    });
  } catch (error) {
    await rm(join(storageRoot(), conversation.workspaceId, "attachments", id), {
      recursive: true,
      force: true,
    });
    throw error;
  }
}

export async function readAuthorizedAttachment(
  db: PrismaClient,
  input: {
    attachmentId: string;
    userId?: string;
    agentId?: string;
    conversationId?: string;
  },
) {
  const attachment = await db.attachment.findUnique({ where: { id: input.attachmentId } });
  if (!attachment || !attachment.messageId) throw new AppError("NOT_FOUND");
  const allowed = input.userId
    ? Boolean(
        await db.conversationMember.findFirst({
          where: { conversationId: attachment.conversationId, userId: input.userId },
        }),
      )
    : Boolean(
        input.agentId &&
        (await db.conversationMember.findFirst({
          where: { conversationId: attachment.conversationId, agentId: input.agentId },
        })),
      );
  if (!allowed || (input.conversationId && input.conversationId !== attachment.conversationId))
    throw new AppError("ACCESS_DENIED");
  return {
    attachment,
    path: join(storageRoot(), attachment.workspaceId, "attachments", attachment.id, "original"),
  };
}
