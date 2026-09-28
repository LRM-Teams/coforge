import type { Prisma } from "#src/generated/prisma/client";
import { AppError } from "#src/lib/app-error";

type ClaimedAttachment = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  objectKey: string;
};

/**
 * The uploads a person's new message carries, in send order: each must be theirs, in this
 * conversation, and not yet part of a message. Call before creating the message, then
 * `attachToMessage` once it exists, in the same transaction.
 */
export async function claimUploadedAttachments(
  tx: Pick<Prisma.TransactionClient, "attachment">,
  scope: { workspaceId: string; conversationId: string; uploaderId: string },
  attachmentIds: readonly string[],
): Promise<ClaimedAttachment[]> {
  if (!attachmentIds.length) return [];
  const available = await tx.attachment.findMany({
    where: { id: { in: [...new Set(attachmentIds)] }, ...scope, messageId: null },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, objectKey: true },
  });
  const byId = new Map(available.map((attachment) => [attachment.id, attachment]));
  return attachmentIds.map((attachmentId) => {
    const attachment = byId.get(attachmentId);
    if (!attachment) throw new AppError("ACCESS_DENIED");
    return attachment;
  });
}

/** Links claimed uploads to their message, keeping send order as `position`. */
export async function attachToMessage(
  tx: Pick<Prisma.TransactionClient, "attachment">,
  messageId: string,
  attachments: readonly { id: string }[],
) {
  await Promise.all(
    attachments.map((attachment, position) =>
      tx.attachment.update({ where: { id: attachment.id }, data: { messageId, position } }),
    ),
  );
}
