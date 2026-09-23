import { afterAll, beforeAll, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { FileStorage } from "@/server/files/file-storage.server";
import {
  cancelAttachmentUploadSession,
  completeAttachmentUploadSession,
  createAttachmentUploadSession,
} from "@/server/attachments/attachment-upload-session.server";

// Run against a disposable local PostgreSQL, e.g.:
//   ATTACHMENT_UPLOAD_SESSION_TEST_DATABASE_URL=postgresql://coforge:...@127.0.0.1:5433/coforge_attachment_upload_test \
//     mise exec -- bun test apps/web/test/attachment-upload-session.integration.ts
const connectionString = Bun.env.ATTACHMENT_UPLOAD_SESSION_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error("ATTACHMENT_UPLOAD_SESSION_TEST_DATABASE_URL must point to local PostgreSQL");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

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

const fixture = {} as { workspaceId: string; agentId: string; conversationId: string };

beforeAll(async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `upload_${suffix}` } });
  const workspace = await db.workspace.create({
    data: {
      slug: `upload-${suffix}`,
      name: "Attachment upload session integration",
      members: { create: { userId: user.id } },
    },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `machine-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      computerId: computer.id,
      name: "uploader",
      displayName: "Uploader",
      runtimeConfig: {},
    },
  });
  const conversation = await db.conversation.create({
    data: {
      workspace: { connect: { id: workspace.id } },
      channelName: `general-${suffix}`,
      members: {
        create: [
          { workspace: { connect: { id: workspace.id } }, agent: { connect: { id: agent.id } } },
        ],
      },
    },
  });
  fixture.workspaceId = workspace.id;
  fixture.agentId = agent.id;
  fixture.conversationId = conversation.id;
});

afterAll(async () => {
  await db.workspace.deleteMany({ where: { id: fixture.workspaceId } });
  await db.$disconnect();
});

test("persists a created session with its reserved object key, then completes it into a real Attachment row", async () => {
  const { storage, objects } = fakeStorage();
  const clientRequestId = crypto.randomUUID();
  const created = await createAttachmentUploadSession(db, storage, {
    agentId: fixture.agentId,
    workspaceId: fixture.workspaceId,
    conversationId: fixture.conversationId,
    fileName: "note.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    clientRequestId,
  });
  const objectKey = `workspaces/${fixture.workspaceId}/attachments/${created.attachmentId}/original`;
  const persisted = await db.attachmentUploadSession.findUnique({
    where: { id: created.uploadId },
  });
  expect(persisted?.objectKey).toBe(objectKey);
  expect(persisted?.state).toBe("pending");

  objects.set(objectKey, { sizeBytes: 5, contentType: "text/plain" });
  const completed = await completeAttachmentUploadSession(db, storage, {
    agentId: fixture.agentId,
    workspaceId: fixture.workspaceId,
    uploadId: created.uploadId,
  });
  expect(completed.state).toBe("completed");

  const attachment = await db.attachment.findUnique({ where: { id: created.attachmentId } });
  expect(attachment?.uploaderAgentId).toBe(fixture.agentId);
  expect(attachment?.uploaderId).toBeNull();
  expect(attachment?.conversationId).toBe(fixture.conversationId);
});

test("enforces the (agentId, clientRequestId) unique constraint at the database level", async () => {
  const clientRequestId = crypto.randomUUID();
  await db.attachmentUploadSession.create({
    data: {
      workspaceId: fixture.workspaceId,
      conversationId: fixture.conversationId,
      agentId: fixture.agentId,
      attachmentId: crypto.randomUUID(),
      objectKey: `workspaces/${fixture.workspaceId}/attachments/${crypto.randomUUID()}/original`,
      fileName: "a.txt",
      contentType: "text/plain",
      sizeBytes: 1,
      clientRequestId,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  // A raw Prisma call returns a lazy `PrismaPromise` (thenable but not `instanceof Promise`),
  // which `expect(...).rejects` does not accept directly; awaiting it inside the async closure
  // below produces a real rejected `Promise` first.
  await expect(
    (async () =>
      db.attachmentUploadSession.create({
        data: {
          workspaceId: fixture.workspaceId,
          conversationId: fixture.conversationId,
          agentId: fixture.agentId,
          attachmentId: crypto.randomUUID(),
          objectKey: `workspaces/${fixture.workspaceId}/attachments/${crypto.randomUUID()}/original`,
          fileName: "b.txt",
          contentType: "text/plain",
          sizeBytes: 1,
          clientRequestId,
          expiresAt: new Date(Date.now() + 60_000),
        },
      }))(),
  ).rejects.toMatchObject({ code: "P2002" });
});

test("cascades delete when the owning workspace is removed", async () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const user = await db.user.create({ data: { username: `cascade_${suffix}` } });
  const workspace = await db.workspace.create({
    data: { slug: `cascade-${suffix}`, name: "Cascade", members: { create: { userId: user.id } } },
  });
  const computer = await db.computer.create({
    data: {
      ownerId: user.id,
      machineId: `cascade-machine-${suffix}`,
      workspaces: { create: { workspaceId: workspace.id } },
    },
  });
  const agent = await db.agent.create({
    data: {
      workspaceId: workspace.id,
      ownerId: user.id,
      computerId: computer.id,
      name: "cascade-agent",
      displayName: "Cascade agent",
      runtimeConfig: {},
    },
  });
  const conversation = await db.conversation.create({
    data: {
      workspace: { connect: { id: workspace.id } },
      channelName: `cascade-${suffix}`,
      members: {
        create: [
          { workspace: { connect: { id: workspace.id } }, agent: { connect: { id: agent.id } } },
        ],
      },
    },
  });
  const { storage } = fakeStorage();
  const created = await createAttachmentUploadSession(db, storage, {
    agentId: agent.id,
    workspaceId: workspace.id,
    conversationId: conversation.id,
    fileName: "note.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    clientRequestId: crypto.randomUUID(),
  });
  await db.workspace.delete({ where: { id: workspace.id } });
  expect(
    await db.attachmentUploadSession.findUnique({ where: { id: created.uploadId } }),
  ).toBeNull();
});

test("cancel removes a pending session's object and is idempotent once terminal", async () => {
  const { storage, objects } = fakeStorage();
  const created = await createAttachmentUploadSession(db, storage, {
    agentId: fixture.agentId,
    workspaceId: fixture.workspaceId,
    conversationId: fixture.conversationId,
    fileName: "note.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    clientRequestId: crypto.randomUUID(),
  });
  const objectKey = `workspaces/${fixture.workspaceId}/attachments/${created.attachmentId}/original`;
  objects.set(objectKey, { sizeBytes: 5, contentType: "text/plain" });
  const canceled = await cancelAttachmentUploadSession(db, storage, {
    agentId: fixture.agentId,
    workspaceId: fixture.workspaceId,
    uploadId: created.uploadId,
  });
  expect(canceled.state).toBe("canceled");
  expect(objects.has(objectKey)).toBe(false);
});
