import type { PrismaClient, Prisma } from "../../../generated/client";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_SESSION_SECONDS } from "./attachment.server";
import type { FileStorage } from "../files/file-storage.server";

/**
 * Presigned direct-upload sessions (ADR 0028): the Agent PUTs bytes straight to storage with a
 * short-lived presigned URL this module hands out, then `complete` verifies the object and
 * creates the real `Attachment` row that `attachmentId` reserved ahead of time. Mirrors Raft
 * 1.0.32's `attachment-upload-sessions` state machine and error codes; deviations are called out
 * where they occur (see the module's own doc comments and ADR 0028).
 */
export type AttachmentUploadSessionState =
  | "pending"
  | "verifying"
  | "completed"
  | "canceled"
  | "expired"
  | "failed";

export type AttachmentUploadSessionErrorCode =
  | "UPLOAD_INVALID_REQUEST"
  | "UPLOAD_FORBIDDEN"
  | "UPLOAD_IDEMPOTENCY_CONFLICT"
  | "UPLOAD_TOO_LARGE"
  | "UPLOAD_OBJECT_NOT_FOUND"
  | "UPLOAD_VERIFICATION_IN_PROGRESS"
  | "UPLOAD_SESSION_EXPIRED"
  | "UPLOAD_OBJECT_MISMATCH"
  | "UPLOAD_SESSION_NOT_FOUND";

const STATUS_BY_CODE: Record<AttachmentUploadSessionErrorCode, number> = {
  UPLOAD_INVALID_REQUEST: 400,
  UPLOAD_FORBIDDEN: 403,
  UPLOAD_IDEMPOTENCY_CONFLICT: 409,
  UPLOAD_TOO_LARGE: 413,
  UPLOAD_OBJECT_NOT_FOUND: 404,
  UPLOAD_VERIFICATION_IN_PROGRESS: 409,
  UPLOAD_SESSION_EXPIRED: 410,
  UPLOAD_OBJECT_MISMATCH: 422,
  UPLOAD_SESSION_NOT_FOUND: 404,
};

/** Matches Raft 1.0.32's `flatError` retryable flags for the two codes it marks retryable. */
const RETRYABLE_CODES: ReadonlySet<AttachmentUploadSessionErrorCode> = new Set([
  "UPLOAD_OBJECT_NOT_FOUND",
  "UPLOAD_VERIFICATION_IN_PROGRESS",
]);

/** A default backoff hint for the two retryable codes; the CLI also applies its own schedule. */
const RETRY_AFTER_MS = 250;

export class AttachmentUploadSessionError extends Error {
  readonly code: AttachmentUploadSessionErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(code: AttachmentUploadSessionErrorCode, message: string) {
    super(message);
    this.name = "AttachmentUploadSessionError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.retryable = RETRYABLE_CODES.has(code);
    if (this.retryable) this.retryAfterMs = RETRY_AFTER_MS;
  }
}

export type AttachmentUploadSessionAttachmentView = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

export type AttachmentUploadSessionView = {
  uploadId: string;
  state: AttachmentUploadSessionState;
  expiresAt: string;
  attachment: AttachmentUploadSessionAttachmentView | null;
  terminalReason: string | null;
};

export type AttachmentUploadSessionCreated = {
  uploadId: string;
  attachmentId: string;
  state: "pending";
  expiresAt: string;
  upload: { method: "PUT"; url: string; headers: Record<string, string> };
};

export type AttachmentUploadSessionCompleted = {
  uploadId: string;
  state: "completed";
  attachment: AttachmentUploadSessionAttachmentView;
};

type AttachmentUploadSessionRow = {
  id: string;
  workspaceId: string;
  conversationId: string;
  agentId: string;
  attachmentId: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  clientRequestId: string;
  state: string;
  terminalReason: string | null;
  expiresAt: Date;
};

function toAttachmentView(attachment: {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}): AttachmentUploadSessionAttachmentView {
  return {
    id: attachment.id,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    sizeBytes: attachment.sizeBytes,
  };
}

function toSessionView(
  session: AttachmentUploadSessionRow,
  attachment: AttachmentUploadSessionAttachmentView | null,
): AttachmentUploadSessionView {
  return {
    uploadId: session.id,
    state: session.state as AttachmentUploadSessionState,
    expiresAt: session.expiresAt.toISOString(),
    attachment,
    terminalReason: session.terminalReason,
  };
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "P2002"
  );
}

/**
 * Creates (or, for a repeated `clientRequestId`, replays) a direct-upload session. The caller has
 * already authorized `conversationId` (target resolution happens one layer up, in the route —
 * see ADR 0028's deviation from Raft's `channelId` field to this repo's `#channel`/`@user`
 * target grammar) and confirmed the storage backend supports direct upload.
 */
export async function createAttachmentUploadSession(
  db: PrismaClient,
  storage: FileStorage,
  input: {
    agentId: string;
    workspaceId: string;
    conversationId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
    clientRequestId: string;
  },
  options: { now?: Date; sessionExpiresInSeconds?: number } = {},
): Promise<AttachmentUploadSessionCreated> {
  if (!storage.presignPut)
    throw new AttachmentUploadSessionError(
      "UPLOAD_FORBIDDEN",
      "direct upload is not enabled for this workspace",
    );
  if (input.sizeBytes <= 0 || input.sizeBytes > ATTACHMENT_MAX_BYTES)
    throw new AttachmentUploadSessionError(
      "UPLOAD_TOO_LARGE",
      `file must be between 1 and ${ATTACHMENT_MAX_BYTES} bytes`,
    );
  const sessionExpiresInSeconds = options.sessionExpiresInSeconds ?? ATTACHMENT_SESSION_SECONDS;
  const now = options.now ?? new Date();

  const existing = await db.attachmentUploadSession.findUnique({
    where: {
      agentId_clientRequestId: { agentId: input.agentId, clientRequestId: input.clientRequestId },
    },
  });
  if (existing) return replaySession(storage, existing, input, sessionExpiresInSeconds);

  const uploadId = crypto.randomUUID();
  const attachmentId = crypto.randomUUID();
  const objectKey = `workspaces/${input.workspaceId}/attachments/${attachmentId}/original`;
  const expiresAt = new Date(now.getTime() + sessionExpiresInSeconds * 1000);
  try {
    await db.attachmentUploadSession.create({
      data: {
        id: uploadId,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        agentId: input.agentId,
        attachmentId,
        objectKey,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        clientRequestId: input.clientRequestId,
        state: "pending",
        expiresAt,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    // Lost a create race on the same `clientRequestId`: treat it the same as finding it above.
    const raced = await db.attachmentUploadSession.findUnique({
      where: {
        agentId_clientRequestId: { agentId: input.agentId, clientRequestId: input.clientRequestId },
      },
    });
    if (!raced) throw error;
    return replaySession(storage, raced, input, sessionExpiresInSeconds);
  }
  const upload = await storage.presignPut(objectKey, {
    contentType: input.contentType,
    expiresInSeconds: sessionExpiresInSeconds,
  });
  return {
    uploadId,
    attachmentId,
    state: "pending",
    expiresAt: expiresAt.toISOString(),
    upload: { method: "PUT", url: upload.url, headers: upload.headers },
  };
}

async function replaySession(
  storage: FileStorage,
  existing: AttachmentUploadSessionRow,
  input: {
    conversationId: string;
    fileName: string;
    contentType: string;
    sizeBytes: number;
  },
  sessionExpiresInSeconds: number,
): Promise<AttachmentUploadSessionCreated> {
  const matches =
    existing.conversationId === input.conversationId &&
    existing.fileName === input.fileName &&
    existing.contentType === input.contentType &&
    existing.sizeBytes === input.sizeBytes;
  if (!matches)
    throw new AttachmentUploadSessionError(
      "UPLOAD_IDEMPOTENCY_CONFLICT",
      "clientRequestId was already used with different upload parameters",
    );
  // A session that has moved past `pending` (including mid-verification) has nothing left to
  // (re-)sign; fabricating a fresh "pending" reply with an empty upload URL would be a lie the
  // CLI would PUT to. Refuse instead — the caller must start a new upload with a new
  // `clientRequestId`.
  if (existing.state !== "pending")
    throw new AttachmentUploadSessionError(
      "UPLOAD_IDEMPOTENCY_CONFLICT",
      `clientRequestId was already used by a session that is now ${existing.state}; start a new upload`,
    );
  // `createAttachmentUploadSession` already refused to reach here without a presigning
  // backend; this only guards against a caller that bypasses that check.
  if (!storage.presignPut)
    throw new AttachmentUploadSessionError(
      "UPLOAD_FORBIDDEN",
      "direct upload is not enabled for this workspace",
    );
  const upload = await storage.presignPut(existing.objectKey, {
    contentType: existing.contentType,
    expiresInSeconds: sessionExpiresInSeconds,
  });
  return {
    uploadId: existing.id,
    attachmentId: existing.attachmentId,
    state: "pending",
    expiresAt: existing.expiresAt.toISOString(),
    upload: { method: "PUT", url: upload.url, headers: upload.headers },
  };
}

/**
 * Verifies the uploaded object and creates the reserved `Attachment` row. A concurrent complete
 * loses the race for the `pending` → `verifying` claim (a conditional update, not a separate
 * lock) and gets `UPLOAD_VERIFICATION_IN_PROGRESS`; completing an already-completed session is
 * idempotent and returns the same result.
 */
export async function completeAttachmentUploadSession(
  db: PrismaClient,
  storage: FileStorage,
  input: { agentId: string; workspaceId: string; uploadId: string },
  options: { now?: Date } = {},
): Promise<AttachmentUploadSessionCompleted> {
  const now = options.now ?? new Date();
  const session = await db.attachmentUploadSession.findFirst({
    where: { id: input.uploadId, workspaceId: input.workspaceId, agentId: input.agentId },
  });
  if (!session)
    throw new AttachmentUploadSessionError(
      "UPLOAD_SESSION_NOT_FOUND",
      "upload session does not exist",
    );
  if (session.state === "completed") {
    const attachment = await db.attachment.findUnique({ where: { id: session.attachmentId } });
    if (!attachment)
      throw new AttachmentUploadSessionError(
        "UPLOAD_SESSION_NOT_FOUND",
        "completed session's attachment no longer exists",
      );
    return { uploadId: session.id, state: "completed", attachment: toAttachmentView(attachment) };
  }
  if (session.state === "canceled" || session.state === "expired" || session.state === "failed")
    throw new AttachmentUploadSessionError(
      "UPLOAD_SESSION_NOT_FOUND",
      `upload session is already ${session.state}`,
    );
  if (session.expiresAt.getTime() <= now.getTime()) {
    await db.attachmentUploadSession.updateMany({
      where: { id: session.id, state: session.state },
      data: { state: "expired", terminalReason: "upload session expired before completion" },
    });
    await storage.remove(session.objectKey).catch(() => undefined);
    throw new AttachmentUploadSessionError("UPLOAD_SESSION_EXPIRED", "upload session expired");
  }

  const claimed = await db.attachmentUploadSession.updateMany({
    where: { id: session.id, state: "pending" },
    data: { state: "verifying" },
  });
  if (claimed.count === 0)
    throw new AttachmentUploadSessionError(
      "UPLOAD_VERIFICATION_IN_PROGRESS",
      "upload verification is already in progress",
    );

  try {
    const head = await storage.head(session.objectKey);
    if (!head) {
      await db.attachmentUploadSession.updateMany({
        where: { id: session.id, state: "verifying" },
        data: { state: "pending" },
      });
      throw new AttachmentUploadSessionError(
        "UPLOAD_OBJECT_NOT_FOUND",
        "uploaded object is not visible yet",
      );
    }
    if (head.sizeBytes !== session.sizeBytes) {
      await storage.remove(session.objectKey).catch(() => undefined);
      await db.attachmentUploadSession.updateMany({
        where: { id: session.id, state: "verifying" },
        data: {
          state: "failed",
          terminalReason: `uploaded object is ${head.sizeBytes} bytes; session reserved ${session.sizeBytes}`,
        },
      });
      throw new AttachmentUploadSessionError(
        "UPLOAD_OBJECT_MISMATCH",
        "uploaded object size does not match the reserved session",
      );
    }
    const attachment = await db.$transaction(async (tx: Prisma.TransactionClient) => {
      const created = await tx.attachment.create({
        data: {
          id: session.attachmentId,
          workspaceId: session.workspaceId,
          conversationId: session.conversationId,
          uploaderId: null,
          uploaderAgentId: session.agentId,
          objectKey: session.objectKey,
          fileName: session.fileName,
          contentType: session.contentType,
          sizeBytes: session.sizeBytes,
        },
        select: { id: true, fileName: true, contentType: true, sizeBytes: true },
      });
      await tx.attachmentUploadSession.update({
        where: { id: session.id },
        data: { state: "completed" },
      });
      return created;
    });
    return { uploadId: session.id, state: "completed", attachment: toAttachmentView(attachment) };
  } catch (error) {
    if (error instanceof AttachmentUploadSessionError) throw error;
    // An unexpected failure (e.g. a storage or database hiccup) releases the `verifying` claim
    // rather than stranding the session; the caller's own retry (or a future one) tries again.
    await db.attachmentUploadSession
      .updateMany({ where: { id: session.id, state: "verifying" }, data: { state: "pending" } })
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Cancels a not-yet-completed session and best-effort deletes its object. Canceling a session
 * that has already reached a terminal state (including `completed`) is a no-op that just
 * reports the current state — Raft 1.0.32 additionally refuses to cancel a completed upload once
 * it has been consumed by a sent message (`ATTACHMENT_ALREADY_CONSUMED`); this repo has no such
 * consumption tracking on the session row itself (a completed upload becomes an ordinary
 * `Attachment`, governed by the same message-send authorization every other attachment already
 * goes through), so cancel simply stops being able to change anything once the row is terminal.
 */
export async function cancelAttachmentUploadSession(
  db: PrismaClient,
  storage: FileStorage,
  input: { agentId: string; workspaceId: string; uploadId: string },
): Promise<AttachmentUploadSessionView> {
  const session = await db.attachmentUploadSession.findFirst({
    where: { id: input.uploadId, workspaceId: input.workspaceId, agentId: input.agentId },
  });
  if (!session)
    throw new AttachmentUploadSessionError(
      "UPLOAD_SESSION_NOT_FOUND",
      "upload session does not exist",
    );
  if (session.state === "pending" || session.state === "verifying") {
    const claimed = await db.attachmentUploadSession.updateMany({
      where: { id: session.id, state: session.state },
      data: { state: "canceled", terminalReason: "canceled by the uploading Agent" },
    });
    if (claimed.count > 0) await storage.remove(session.objectKey).catch(() => undefined);
  }
  const current = await db.attachmentUploadSession.findUniqueOrThrow({
    where: { id: session.id },
  });
  return toSessionView(current, null);
}

/** Reads a session's current state, including its `Attachment` once `complete` has succeeded. */
export async function getAttachmentUploadSession(
  db: PrismaClient,
  input: { agentId: string; workspaceId: string; uploadId: string },
): Promise<AttachmentUploadSessionView> {
  const session = await db.attachmentUploadSession.findFirst({
    where: { id: input.uploadId, workspaceId: input.workspaceId, agentId: input.agentId },
  });
  if (!session)
    throw new AttachmentUploadSessionError(
      "UPLOAD_SESSION_NOT_FOUND",
      "upload session does not exist",
    );
  const attachment =
    session.state === "completed"
      ? await db.attachment.findUnique({ where: { id: session.attachmentId } })
      : null;
  return toSessionView(session, attachment ? toAttachmentView(attachment) : null);
}
