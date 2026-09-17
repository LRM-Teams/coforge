import { expect, test } from "bun:test";
import { AppError } from "../src/lib/app-error";
import { AttachmentUploadSessionError } from "../src/server/attachments/attachment-upload-session.server";
import { handleAttachmentUploadSessionCreate } from "../src/routes/api/agent/v1/attachment-upload-sessions/index";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };

function createRequest(body: unknown): Request {
  return new Request("https://coforge.test/api/agent/v1/attachment-upload-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  target: "#general",
  fileName: "note.txt",
  contentType: "text/plain",
  sizeBytes: 5,
  clientRequestId: "11111111-1111-1111-1111-111111111111",
};

const stubCreated = {
  uploadId: "upload-1",
  attachmentId: "attachment-1",
  state: "pending" as const,
  expiresAt: "2026-01-01T00:15:00.000Z",
  upload: {
    method: "PUT" as const,
    url: "https://oss.test/x",
    headers: { "Content-Type": "text/plain" },
  },
};

test("rejects a malformed JSON body", async () => {
  const request = new Request("https://coforge.test/api/agent/v1/attachment-upload-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json",
  });
  const response = await handleAttachmentUploadSessionCreate(request, principal, {
    resolveTarget: async () => {
      throw new Error("must not resolve");
    },
    create: async () => {
      throw new Error("must not create");
    },
  });
  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("UPLOAD_INVALID_REQUEST");
});

test.each([
  ["target", { ...validBody, target: "" }],
  ["fileName", { ...validBody, fileName: "" }],
  ["contentType", { ...validBody, contentType: "not-a-mime-type" }],
  ["sizeBytes", { ...validBody, sizeBytes: 0 }],
  ["sizeBytes", { ...validBody, sizeBytes: 1.5 }],
  ["clientRequestId", { ...validBody, clientRequestId: "not-a-uuid" }],
])("rejects an invalid %s before resolving the target", async (_field, body) => {
  const response = await handleAttachmentUploadSessionCreate(createRequest(body), principal, {
    resolveTarget: async () => {
      throw new Error("must not resolve an invalid request");
    },
    create: async () => {
      throw new Error("must not create");
    },
  });
  expect(response.status).toBe(400);
  expect((await response.json()).code).toBe("UPLOAD_INVALID_REQUEST");
});

test("strips the thread suffix before resolving the target", async () => {
  const calls: string[] = [];
  const response = await handleAttachmentUploadSessionCreate(
    createRequest({ ...validBody, target: "#general:abcd1234" }),
    principal,
    {
      resolveTarget: async (_workspaceId, _agentId, target) => {
        calls.push(target);
        return { conversationId: "conversation-1" };
      },
      create: async () => stubCreated,
    },
  );
  expect(response.status).toBe(201);
  expect(calls).toEqual(["#general"]);
});

test("maps ACCESS_DENIED and an unknown target to 403, and a malformed target grammar to 400", async () => {
  const denied = await handleAttachmentUploadSessionCreate(createRequest(validBody), principal, {
    resolveTarget: async () => {
      throw new AppError("ACCESS_DENIED");
    },
    create: async () => {
      throw new Error("must not create");
    },
  });
  expect(denied.status).toBe(403);

  const unknownUser = await handleAttachmentUploadSessionCreate(
    createRequest({ ...validBody, target: "@nobody" }),
    principal,
    {
      resolveTarget: async () => {
        throw new Error("target user not found");
      },
      create: async () => {
        throw new Error("must not create");
      },
    },
  );
  expect(unknownUser.status).toBe(403);

  const malformed = await handleAttachmentUploadSessionCreate(
    createRequest({ ...validBody, target: "@Not Valid" }),
    principal,
    {
      resolveTarget: async () => {
        throw new Error("invalid message target");
      },
      create: async () => {
        throw new Error("must not create");
      },
    },
  );
  expect(malformed.status).toBe(400);
});

test("creates a session and returns 201 with the presigned upload", async () => {
  const calls: unknown[] = [];
  const response = await handleAttachmentUploadSessionCreate(createRequest(validBody), principal, {
    resolveTarget: async () => ({ conversationId: "conversation-1" }),
    create: async (input) => {
      calls.push(input);
      return stubCreated;
    },
  });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(stubCreated);
  expect(calls).toEqual([
    {
      agentId: "agent-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      fileName: "note.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      clientRequestId: "11111111-1111-1111-1111-111111111111",
    },
  ]);
});

test("maps every AttachmentUploadSessionError code to its status and retryable flag", async () => {
  for (const code of [
    "UPLOAD_FORBIDDEN",
    "UPLOAD_IDEMPOTENCY_CONFLICT",
    "UPLOAD_TOO_LARGE",
  ] as const) {
    const response = await handleAttachmentUploadSessionCreate(
      createRequest(validBody),
      principal,
      {
        resolveTarget: async () => ({ conversationId: "conversation-1" }),
        create: async () => {
          throw new AttachmentUploadSessionError(code, `failed as ${code}`);
        },
      },
    );
    const body = await response.json();
    expect(body).toEqual({ error: `failed as ${code}`, code, retryable: false });
  }
});
