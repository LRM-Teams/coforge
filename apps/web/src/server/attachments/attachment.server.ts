import type { PrismaClient } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";
import {
  getFileStorage,
  type FileStorage,
  type StoredFile,
} from "#src/server/files/file-storage.server";
import {
  ACTIVE_MEMBER_WHERE,
  VISIBLE_CONVERSATION_WHERE,
} from "#src/server/conversations/active-member.server";

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_SESSION_SECONDS = 900;
/** `COFORGE_ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES` default: 1 MiB. */
export const ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_DEFAULT_BYTES = 1024 * 1024;

export type AttachmentCapabilities = {
  maxBytes: number;
  directUploadEnabled: boolean;
  directUploadThresholdBytes: number;
  sessionExpiresInSeconds: number;
};

/**
 * Reports server-authoritative attachment upload limits. `directUploadEnabled` is
 * `true` only when the active storage backend implements `presignPut` (currently `OssFileStorage`
 * only; `LocalFileStorage` has none, so local dev always reports direct upload disabled).
 */
export function attachmentCapabilities(
  storage: Pick<FileStorage, "presignPut">,
  env: NodeJS.ProcessEnv = process.env,
): AttachmentCapabilities {
  return {
    maxBytes: ATTACHMENT_MAX_BYTES,
    directUploadEnabled: typeof storage.presignPut === "function",
    directUploadThresholdBytes: readDirectUploadThresholdBytes(env),
    sessionExpiresInSeconds: ATTACHMENT_SESSION_SECONDS,
  };
}

function readDirectUploadThresholdBytes(env: NodeJS.ProcessEnv): number {
  const raw = env.COFORGE_ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_BYTES?.trim();
  if (!raw) return ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_DEFAULT_BYTES;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : ATTACHMENT_DIRECT_UPLOAD_THRESHOLD_DEFAULT_BYTES;
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
      ...VISIBLE_CONVERSATION_WHERE,
      members: { some: { userId: input.userId, ...ACTIVE_MEMBER_WHERE } },
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
            // A channel hidden from the Workspace keeps its files from everyone until restored.
            ...VISIBLE_CONVERSATION_WHERE,
            OR: [
              {
                channelName: null,
                members: { some: { userId: input.userId, ...ACTIVE_MEMBER_WHERE } },
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
            conversation: VISIBLE_CONVERSATION_WHERE,
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

/** Every stored file a conversation holds: its attachments' and upload sessions' object keys. A
 * finished upload keeps its session row, so a key found in both is listed once. Read it before the
 * conversation is deleted, then pass it to `removeAttachmentFiles` after the delete commits. */
export async function conversationAttachmentKeys(
  db: Pick<PrismaClient, "attachment" | "attachmentUploadSession">,
  conversationId: string,
): Promise<string[]> {
  const [attachments, uploads] = await Promise.all([
    db.attachment.findMany({ where: { conversationId }, select: { objectKey: true } }),
    db.attachmentUploadSession.findMany({ where: { conversationId }, select: { objectKey: true } }),
  ]);
  return [...new Set([...attachments, ...uploads].map(({ objectKey }) => objectKey))];
}

/** Removes stored files whose rows are already gone. Best effort: a file left behind is never
 * served again, since nothing references it. */
export async function removeAttachmentFiles(
  objectKeys: readonly string[],
  storage: () => Promise<FileStorage> = getFileStorage,
): Promise<void> {
  if (objectKeys.length === 0) return;
  try {
    const files = await storage();
    await Promise.allSettled(objectKeys.map((objectKey) => files.remove(objectKey)));
  } catch {
    /* best effort */
  }
}
