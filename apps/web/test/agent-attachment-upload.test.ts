import { expect, test } from "bun:test";
import { AppError } from "@/lib/app-error";
import { handleAgentAttachmentUpload } from "@/routes/api/agent/v1/attachments/index";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };

function uploadRequest(fields: Record<string, string | Blob>): Request {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields))
    // A Blob field needs an explicit filename to round-trip through multipart as a `File`
    // (matching what a real multipart request always carries); a bare `Blob` with no
    // filename decodes with `name: undefined`, which `isUploadFile` correctly rejects.
    if (value instanceof Blob) form.set(key, value, "note.txt");
    else form.set(key, value);
  return new Request("https://coforge.test/api/agent/v1/attachments", {
    method: "POST",
    body: form,
  });
}

/**
 * A minimal `Request`-shaped stub whose `.formData()` returns exactly the given entries,
 * bypassing real multipart encode/decode. Bun 1.4.2's `Request#formData()` does not preserve a
 * file part's declared `Content-Type` (it always reports `text/plain;charset=utf-8` on
 * decode — verified directly against `Bun.serve`/`fetch`), so a test of the `file.type`
 * fallback needs a `File`-like value with a `.type` this test controls directly.
 */
function fakeUploadRequest(entries: Record<string, string | File>): Request {
  return {
    formData: async () => ({
      get: (key: string) => entries[key] ?? null,
    }),
  } as unknown as Request;
}

function fakeUploadFile(name: string, type: string, size = 5): File {
  return {
    name,
    type,
    size,
    async arrayBuffer() {
      return new ArrayBuffer(size);
    },
  } as unknown as File;
}

function stubStore(
  overrides: Partial<{ id: string; fileName: string; contentType: string; sizeBytes: number }> = {},
) {
  return async () => ({
    id: "attachment-1",
    fileName: "note.txt",
    contentType: "text/plain",
    sizeBytes: 5,
    ...overrides,
  });
}

test("rejects a request with no file", async () => {
  const response = await handleAgentAttachmentUpload(
    uploadRequest({ target: "#general" }),
    principal,
    {
      resolveTarget: async () => {
        throw new Error("must not resolve a target without a file");
      },
      store: async () => {
        throw new Error("must not store");
      },
    },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "file is required" });
});

test("rejects a request with no target", async () => {
  const response = await handleAgentAttachmentUpload(
    uploadRequest({ file: new Blob(["hello"], { type: "text/plain" }) }),
    principal,
    {
      resolveTarget: async () => {
        throw new Error("must not resolve without a target");
      },
      store: async () => {
        throw new Error("must not store");
      },
    },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "target is required" });
});

test("rejects an invalid explicit mimeType before resolving the target", async () => {
  const response = await handleAgentAttachmentUpload(
    uploadRequest({
      file: new Blob(["hello"], { type: "text/plain" }),
      target: "#general",
      mimeType: "not-a-mime-type",
    }),
    principal,
    {
      resolveTarget: async () => {
        throw new Error("must not resolve target for an invalid mime type");
      },
      store: async () => {
        throw new Error("must not store");
      },
    },
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "mimeType is invalid" });
});

test("strips the thread suffix before resolving the target", async () => {
  const calls: string[] = [];
  const response = await handleAgentAttachmentUpload(
    uploadRequest({
      file: new Blob(["hello"], { type: "text/plain" }),
      target: "#general:abcd1234",
    }),
    principal,
    {
      resolveTarget: async (_workspaceId, _agentId, target) => {
        calls.push(target);
        return { conversationId: "conversation-1" };
      },
      store: stubStore(),
    },
  );
  expect(response.status).toBe(200);
  expect(calls).toEqual(["#general"]);
});

test("maps ACCESS_DENIED and INVALID_INPUT target resolution failures to 403 and 400", async () => {
  const deniedResponse = await handleAgentAttachmentUpload(
    uploadRequest({ file: new Blob(["hello"]), target: "#secret" }),
    principal,
    {
      resolveTarget: async () => {
        throw new AppError("ACCESS_DENIED");
      },
      store: async () => {
        throw new Error("must not store");
      },
    },
  );
  expect(deniedResponse.status).toBe(403);
  expect(await deniedResponse.json()).toEqual({ error: "target is not accessible" });

  const invalidResponse = await handleAgentAttachmentUpload(
    uploadRequest({ file: new Blob(["hello"]), target: "#Not Valid" }),
    principal,
    {
      resolveTarget: async () => {
        throw new AppError("INVALID_INPUT");
      },
      store: async () => {
        throw new Error("must not store");
      },
    },
  );
  expect(invalidResponse.status).toBe(400);
});

test("maps an unknown @user target and an unauthorized DM scope to 403", async () => {
  for (const message of ["target user not found", "conversation scope is not authorized"]) {
    const response = await handleAgentAttachmentUpload(
      uploadRequest({ file: new Blob(["hello"]), target: "@nobody" }),
      principal,
      {
        resolveTarget: async () => {
          throw new Error(message);
        },
        store: async () => {
          throw new Error("must not store");
        },
      },
    );
    expect(response.status).toBe(403);
  }
});

test("maps a malformed @user target grammar to 400", async () => {
  const response = await handleAgentAttachmentUpload(
    uploadRequest({ file: new Blob(["hello"]), target: "@Not Valid" }),
    principal,
    {
      resolveTarget: async () => {
        throw new Error("invalid message target");
      },
      store: async () => {
        throw new Error("must not store");
      },
    },
  );
  expect(response.status).toBe(400);
});

test("stores the file with an explicit mimeType override and returns the stored metadata", async () => {
  const calls: unknown[] = [];
  const response = await handleAgentAttachmentUpload(
    uploadRequest({
      file: new Blob(["hello"], { type: "text/plain" }),
      target: "#general",
      mimeType: "application/octet-stream",
    }),
    principal,
    {
      resolveTarget: async () => ({ conversationId: "conversation-1" }),
      store: async (input) => {
        calls.push(input);
        return {
          id: "attachment-1",
          fileName: "blob",
          contentType: "application/octet-stream",
          sizeBytes: 5,
        };
      },
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    id: "attachment-1",
    fileName: "blob",
    contentType: "application/octet-stream",
    sizeBytes: 5,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    agentId: "agent-1",
    conversationId: "conversation-1",
    workspaceId: "workspace-1",
    contentType: "application/octet-stream",
  });
});

test("falls back to the file's own content type, then to application/octet-stream", async () => {
  const calls: string[] = [];
  await handleAgentAttachmentUpload(
    fakeUploadRequest({ file: fakeUploadFile("note.txt", "image/png"), target: "#general" }),
    principal,
    {
      resolveTarget: async () => ({ conversationId: "conversation-1" }),
      store: async (input) => {
        calls.push(input.contentType);
        return {
          id: "attachment-1",
          fileName: "blob",
          contentType: input.contentType,
          sizeBytes: 5,
        };
      },
    },
  );
  await handleAgentAttachmentUpload(
    fakeUploadRequest({ file: fakeUploadFile("note.txt", ""), target: "#general" }),
    principal,
    {
      resolveTarget: async () => ({ conversationId: "conversation-1" }),
      store: async (input) => {
        calls.push(input.contentType);
        return {
          id: "attachment-2",
          fileName: "blob",
          contentType: input.contentType,
          sizeBytes: 5,
        };
      },
    },
  );
  expect(calls).toEqual(["image/png", "application/octet-stream"]);
});

test("maps a store INVALID_INPUT failure to 400 for an empty file and 413 for an oversized file", async () => {
  const emptyResponse = await handleAgentAttachmentUpload(
    uploadRequest({ file: new Blob([]), target: "#general" }),
    principal,
    {
      resolveTarget: async () => ({ conversationId: "conversation-1" }),
      store: async () => {
        throw new AppError("INVALID_INPUT");
      },
    },
  );
  expect(emptyResponse.status).toBe(400);
  expect(await emptyResponse.json()).toEqual({ error: "file must not be empty" });

  const oversizedResponse = await handleAgentAttachmentUpload(
    uploadRequest({
      file: new Blob(["not actually 10MB, but the fake store says so"]),
      target: "#general",
    }),
    principal,
    {
      resolveTarget: async () => ({ conversationId: "conversation-1" }),
      store: async () => {
        throw new AppError("INVALID_INPUT");
      },
    },
  );
  expect(oversizedResponse.status).toBe(413);
  expect(await oversizedResponse.json()).toEqual({
    error: "file exceeds the maximum attachment size",
  });
});
