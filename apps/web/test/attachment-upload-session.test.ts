import { expect, test } from "bun:test";
import {
  cancelAttachmentUploadSession,
  completeAttachmentUploadSession,
  createAttachmentUploadSession,
  getAttachmentUploadSession,
  AttachmentUploadSessionError,
} from "../src/server/attachments/attachment-upload-session.server";
import type { FileStorage } from "../src/server/files/file-storage.server";

type SessionRow = {
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
  createdAt: Date;
  updatedAt: Date;
};

function uniqueViolation(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

/** A minimal in-memory stand-in for the Prisma client surface this module calls. */
function fakeDb() {
  const sessions = new Map<string, SessionRow>();
  const attachments = new Map<
    string,
    { id: string; fileName: string; contentType: string; sizeBytes: number }
  >();

  const attachmentUploadSession = {
    async findUnique({ where }: { where: { id?: string; agentId_clientRequestId?: unknown } }) {
      if (where.id) return sessions.get(where.id) ?? null;
      if (where.agentId_clientRequestId) {
        const { agentId, clientRequestId } = where.agentId_clientRequestId as {
          agentId: string;
          clientRequestId: string;
        };
        return (
          [...sessions.values()].find(
            (row) => row.agentId === agentId && row.clientRequestId === clientRequestId,
          ) ?? null
        );
      }
      return null;
    },
    async findFirst({ where }: { where: { id: string; workspaceId: string; agentId: string } }) {
      const row = sessions.get(where.id);
      if (!row || row.workspaceId !== where.workspaceId || row.agentId !== where.agentId)
        return null;
      return row;
    },
    async findUniqueOrThrow({ where }: { where: { id: string } }) {
      const row = sessions.get(where.id);
      if (!row) throw new Error("not found");
      return row;
    },
    async create({ data }: { data: SessionRow }) {
      const conflict = [...sessions.values()].find(
        (row) => row.agentId === data.agentId && row.clientRequestId === data.clientRequestId,
      );
      if (conflict || sessions.has(data.id)) throw uniqueViolation();
      const row: SessionRow = {
        ...data,
        terminalReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessions.set(row.id, row);
      return row;
    },
    async update({ where, data }: { where: { id: string }; data: Partial<SessionRow> }) {
      const row = sessions.get(where.id);
      if (!row) throw new Error("not found");
      Object.assign(row, data);
      return row;
    },
    async updateMany({
      where,
      data,
    }: {
      where: { id: string; state?: string };
      data: Partial<SessionRow>;
    }) {
      const row = sessions.get(where.id);
      if (!row) return { count: 0 };
      if (where.state !== undefined && row.state !== where.state) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  };

  const attachment = {
    async create({
      data,
    }: {
      data: { id: string; fileName: string; contentType: string; sizeBytes: number };
    }) {
      const row = {
        id: data.id,
        fileName: data.fileName,
        contentType: data.contentType,
        sizeBytes: data.sizeBytes,
      };
      attachments.set(row.id, row);
      return row;
    },
    async findUnique({ where }: { where: { id: string } }) {
      return attachments.get(where.id) ?? null;
    },
  };

  type FakeDb = {
    attachmentUploadSession: typeof attachmentUploadSession;
    attachment: typeof attachment;
    $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T>;
  };
  const db: FakeDb = {
    attachmentUploadSession,
    attachment,
    async $transaction(fn) {
      return fn(db);
    },
  };
  return { db, sessions, attachments };
}

function fakeStorage() {
  const objects = new Map<string, { sizeBytes: number; contentType: string }>();
  const storage: FileStorage = {
    put: async () => {},
    open: async () => null,
    remove: async (key) => {
      objects.delete(key);
    },
    head: async (key) => objects.get(key) ?? null,
    presignPut: async (key, { contentType }) => ({
      url: `https://oss.test/${encodeURIComponent(key)}`,
      headers: { "Content-Type": contentType, "x-oss-forbid-overwrite": "true" },
    }),
  };
  return { storage, objects };
}

const input = {
  agentId: "agent-1",
  workspaceId: "workspace-1",
  conversationId: "conversation-1",
  fileName: "note.txt",
  contentType: "text/plain",
  sizeBytes: 5,
  clientRequestId: "11111111-1111-1111-1111-111111111111",
};

test("refuses to create a session when the storage backend has no presignPut", async () => {
  const { db } = fakeDb();
  const storageWithoutPresign: FileStorage = {
    put: async () => {},
    open: async () => null,
    remove: async () => {},
    head: async () => null,
  };
  await expect(
    createAttachmentUploadSession(db as never, storageWithoutPresign, input),
  ).rejects.toMatchObject({ code: "UPLOAD_FORBIDDEN", status: 403, retryable: false });
});

test("rejects a non-positive or over-limit sizeBytes as UPLOAD_TOO_LARGE", async () => {
  const { db } = fakeDb();
  const { storage } = fakeStorage();
  await expect(
    createAttachmentUploadSession(db as never, storage, { ...input, sizeBytes: 0 }),
  ).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE", status: 413 });
  await expect(
    createAttachmentUploadSession(db as never, storage, {
      ...input,
      sizeBytes: 10 * 1024 * 1024 + 1,
    }),
  ).rejects.toMatchObject({ code: "UPLOAD_TOO_LARGE", status: 413 });
});

test("creates a pending session with a presigned PUT and the reserved object key layout", async () => {
  const { db } = fakeDb();
  const { storage } = fakeStorage();
  const created = await createAttachmentUploadSession(db as never, storage, input);
  expect(created.state).toBe("pending");
  expect(created.upload).toEqual({
    method: "PUT",
    url: `https://oss.test/${encodeURIComponent(
      `workspaces/workspace-1/attachments/${created.attachmentId}/original`,
    )}`,
    headers: { "Content-Type": "text/plain", "x-oss-forbid-overwrite": "true" },
  });
  const row = await db.attachmentUploadSession.findUnique({ where: { id: created.uploadId } });
  expect(row?.objectKey).toBe(
    `workspaces/workspace-1/attachments/${created.attachmentId}/original`,
  );
});

test("replays the same session for a repeated clientRequestId with matching parameters", async () => {
  const { db } = fakeDb();
  const { storage } = fakeStorage();
  const first = await createAttachmentUploadSession(db as never, storage, input);
  const second = await createAttachmentUploadSession(db as never, storage, input);
  expect(second.uploadId).toBe(first.uploadId);
  expect(second.attachmentId).toBe(first.attachmentId);
});

test("rejects a repeated clientRequestId with different parameters as UPLOAD_IDEMPOTENCY_CONFLICT", async () => {
  const { db } = fakeDb();
  const { storage } = fakeStorage();
  await createAttachmentUploadSession(db as never, storage, input);
  await expect(
    createAttachmentUploadSession(db as never, storage, { ...input, fileName: "other.txt" }),
  ).rejects.toMatchObject({ code: "UPLOAD_IDEMPOTENCY_CONFLICT", status: 409 });
});

test("rejects a repeated clientRequestId once the existing session has completed, rather than re-signing a stale URL", async () => {
  const { db, sessions } = fakeDb();
  const { storage } = fakeStorage();
  const created = await createAttachmentUploadSession(db as never, storage, input);
  const row = sessions.get(created.uploadId)!;
  row.state = "completed";
  await expect(createAttachmentUploadSession(db as never, storage, input)).rejects.toMatchObject({
    code: "UPLOAD_IDEMPOTENCY_CONFLICT",
    status: 409,
    message:
      "clientRequestId was already used by a session that is now completed; start a new upload",
  });
});

test("rejects a repeated clientRequestId once the existing session is canceled/expired/failed, never fabricating a pending reply", async () => {
  const { db, sessions } = fakeDb();
  const { storage } = fakeStorage();
  for (const state of ["canceled", "expired", "failed", "verifying"]) {
    const created = await createAttachmentUploadSession(db as never, storage, {
      ...input,
      clientRequestId: crypto.randomUUID(),
    });
    const row = sessions.get(created.uploadId)!;
    row.state = state;
    await expect(
      createAttachmentUploadSession(db as never, storage, {
        ...input,
        clientRequestId: row.clientRequestId,
      }),
    ).rejects.toMatchObject({
      code: "UPLOAD_IDEMPOTENCY_CONFLICT",
      status: 409,
      message: `clientRequestId was already used by a session that is now ${state}; start a new upload`,
    });
  }
});

test("complete: an unknown uploadId is UPLOAD_SESSION_NOT_FOUND", async () => {
  const { db } = fakeDb();
  const { storage } = fakeStorage();
  await expect(
    completeAttachmentUploadSession(db as never, storage, {
      agentId: "agent-1",
      workspaceId: "workspace-1",
      uploadId: "missing",
    }),
  ).rejects.toMatchObject({ code: "UPLOAD_SESSION_NOT_FOUND", status: 404 });
});

test("complete: an expired session answers UPLOAD_SESSION_EXPIRED and removes the object", async () => {
  const { db } = fakeDb();
  const { storage, objects } = fakeStorage();
  const created = await createAttachmentUploadSession(db as never, storage, input, {
    now: new Date("2026-01-01T00:00:00.000Z"),
    sessionExpiresInSeconds: 1,
  });
  const objectKey = `workspaces/workspace-1/attachments/${created.attachmentId}/original`;
  objects.set(objectKey, { sizeBytes: input.sizeBytes, contentType: input.contentType });
  await expect(
    completeAttachmentUploadSession(
      db as never,
      storage,
      { agentId: "agent-1", workspaceId: "workspace-1", uploadId: created.uploadId },
      { now: new Date("2026-01-01T00:01:00.000Z") },
    ),
  ).rejects.toMatchObject({ code: "UPLOAD_SESSION_EXPIRED", status: 410 });
  expect(objects.has(objectKey)).toBe(false);
});

test("complete: a not-yet-visible object answers a retryable UPLOAD_OBJECT_NOT_FOUND and releases the claim", async () => {
  const { db } = fakeDb();
  const { storage } = fakeStorage();
  const created = await createAttachmentUploadSession(db as never, storage, input);
  await expect(
    completeAttachmentUploadSession(db as never, storage, {
      agentId: "agent-1",
      workspaceId: "workspace-1",
      uploadId: created.uploadId,
    }),
  ).rejects.toMatchObject({ code: "UPLOAD_OBJECT_NOT_FOUND", status: 404, retryable: true });
  const row = await db.attachmentUploadSession.findUnique({ where: { id: created.uploadId } });
  expect(row?.state).toBe("pending");
});

test("complete: a concurrent complete on the same session answers UPLOAD_VERIFICATION_IN_PROGRESS", async () => {
  const { db, sessions } = fakeDb();
  const { storage } = fakeStorage();
  const created = await createAttachmentUploadSession(db as never, storage, input);
  const row = sessions.get(created.uploadId)!;
  row.state = "verifying";
  await expect(
    completeAttachmentUploadSession(db as never, storage, {
      agentId: "agent-1",
      workspaceId: "workspace-1",
      uploadId: created.uploadId,
    }),
  ).rejects.toMatchObject({
    code: "UPLOAD_VERIFICATION_IN_PROGRESS",
    status: 409,
    retryable: true,
  });
});

test("complete: an object whose size does not match the reservation answers UPLOAD_OBJECT_MISMATCH and deletes it", async () => {
  const { db } = fakeDb();
  const { storage, objects } = fakeStorage();
  const created = await createAttachmentUploadSession(db as never, storage, input);
  const objectKey = `workspaces/workspace-1/attachments/${created.attachmentId}/original`;
  objects.set(objectKey, { sizeBytes: input.sizeBytes + 1, contentType: input.contentType });
  await expect(
    completeAttachmentUploadSession(db as never, storage, {
      agentId: "agent-1",
      workspaceId: "workspace-1",
      uploadId: created.uploadId,
    }),
  ).rejects.toMatchObject({ code: "UPLOAD_OBJECT_MISMATCH", status: 422 });
  expect(objects.has(objectKey)).toBe(false);
  const row = await db.attachmentUploadSession.findUnique({ where: { id: created.uploadId } });
  expect(row?.state).toBe("failed");
  expect(row?.terminalReason).toContain("6 bytes");
});

test("complete: a matching object creates the Attachment and completes the session, then is idempotent on replay", async () => {
  const { db } = fakeDb();
  const { storage, objects } = fakeStorage();
  const created = await createAttachmentUploadSession(db as never, storage, input);
  const objectKey = `workspaces/workspace-1/attachments/${created.attachmentId}/original`;
  objects.set(objectKey, { sizeBytes: input.sizeBytes, contentType: input.contentType });
  const completed = await completeAttachmentUploadSession(db as never, storage, {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    uploadId: created.uploadId,
  });
  expect(completed.state).toBe("completed");
  expect(completed.attachment).toEqual({
    id: created.attachmentId,
    fileName: input.fileName,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
  });

  const replay = await completeAttachmentUploadSession(db as never, storage, {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    uploadId: created.uploadId,
  });
  expect(replay).toEqual(completed);
});

test("cancel: a pending session is canceled and its object removed; a terminal session is left alone", async () => {
  const { db } = fakeDb();
  const { storage, objects } = fakeStorage();
  const created = await createAttachmentUploadSession(db as never, storage, input);
  const objectKey = `workspaces/workspace-1/attachments/${created.attachmentId}/original`;
  objects.set(objectKey, { sizeBytes: input.sizeBytes, contentType: input.contentType });

  const canceled = await cancelAttachmentUploadSession(db as never, storage, {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    uploadId: created.uploadId,
  });
  expect(canceled.state).toBe("canceled");
  expect(objects.has(objectKey)).toBe(false);

  // Canceling an already-terminal session is a no-op that reports the current state.
  const again = await cancelAttachmentUploadSession(db as never, storage, {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    uploadId: created.uploadId,
  });
  expect(again.state).toBe("canceled");
});

test("cancel: an unknown uploadId is UPLOAD_SESSION_NOT_FOUND", async () => {
  const { db } = fakeDb();
  const { storage } = fakeStorage();
  await expect(
    cancelAttachmentUploadSession(db as never, storage, {
      agentId: "agent-1",
      workspaceId: "workspace-1",
      uploadId: "missing",
    }),
  ).rejects.toBeInstanceOf(AttachmentUploadSessionError);
});

test("get: reports the session's attachment once completed, and null before that", async () => {
  const { db } = fakeDb();
  const { storage, objects } = fakeStorage();
  const created = await createAttachmentUploadSession(db as never, storage, input);
  const pendingView = await getAttachmentUploadSession(db as never, {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    uploadId: created.uploadId,
  });
  expect(pendingView.state).toBe("pending");
  expect(pendingView.attachment).toBeNull();

  const objectKey = `workspaces/workspace-1/attachments/${created.attachmentId}/original`;
  objects.set(objectKey, { sizeBytes: input.sizeBytes, contentType: input.contentType });
  await completeAttachmentUploadSession(db as never, storage, {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    uploadId: created.uploadId,
  });
  const completedView = await getAttachmentUploadSession(db as never, {
    agentId: "agent-1",
    workspaceId: "workspace-1",
    uploadId: created.uploadId,
  });
  expect(completedView.state).toBe("completed");
  expect(completedView.attachment?.id).toBe(created.attachmentId);
});

test("get: a session belonging to a different Agent or workspace is UPLOAD_SESSION_NOT_FOUND", async () => {
  const { db } = fakeDb();
  const { storage } = fakeStorage();
  const created = await createAttachmentUploadSession(db as never, storage, input);
  await expect(
    getAttachmentUploadSession(db as never, {
      agentId: "agent-2",
      workspaceId: "workspace-1",
      uploadId: created.uploadId,
    }),
  ).rejects.toMatchObject({ code: "UPLOAD_SESSION_NOT_FOUND" });
});
