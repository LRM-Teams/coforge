import { expect, test } from "bun:test";
import {
  attachmentCapabilities,
  ATTACHMENT_MAX_BYTES,
  storeAttachment,
} from "../src/server/attachments/attachment.server";
import { AppError } from "../src/lib/app-error";
import { handleAttachmentUpload } from "../src/routes/api/attachments";

test("attachment upload capabilities are server authoritative", () => {
  expect(attachmentCapabilities()).toEqual({
    maxBytes: ATTACHMENT_MAX_BYTES,
    directUploadEnabled: false,
    directUploadThresholdBytes: 0,
    sessionExpiresInSeconds: 900,
  });
});

test("attachment upload rejects an oversized file before touching persistence", async () => {
  let touched = false;
  const fakeDb = {
    get attachment() {
      touched = true;
      throw new Error("must not be touched");
    },
  };
  const result = storeAttachment(fakeDb as never, {
    userId: "user-1",
    conversationId: "conversation-1",
    file: new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], "large.bin"),
  });
  await expect(result).rejects.toEqual(new AppError("INVALID_INPUT"));
  expect(touched).toBe(false);
});

test("attachment upload rejects an unauthorized conversation with a stable public error", async () => {
  const fakeDb = {
    conversation: {
      findFirst: async () => null,
    },
  };
  await expect(
    storeAttachment(fakeDb as never, {
      userId: "user-1",
      conversationId: "conversation-1",
      file: new File(["safe"], "safe.txt"),
    }),
  ).rejects.toEqual(new AppError("ACCESS_DENIED"));
});

test("attachment HTTP boundary maps expected and unexpected failures without diagnostics", async () => {
  const malformed = await handleAttachmentUpload(
    new Request("https://coforge.test/api/attachments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not multipart",
    }),
    {
      authenticate: () => ({ id: "user-1" }),
      database: () => ({}) as never,
      store: async () => {
        throw new Error("must not store malformed input");
      },
    },
  );
  expect(malformed.status).toBe(400);
  expect(malformed.headers.get("cache-control")).toBe("no-store");
  expect(await malformed.json()).toEqual({ code: "INVALID_INPUT" });

  const denied = await handleAttachmentUpload(attachmentUploadRequest(), {
    authenticate: () => ({ id: "user-1" }),
    database: () => ({}) as never,
    store: async () => {
      throw new AppError("ACCESS_DENIED");
    },
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({ code: "ACCESS_DENIED" });

  const failed = await handleAttachmentUpload(attachmentUploadRequest(), {
    authenticate: () => ({ id: "user-1" }),
    database: () => ({}) as never,
    store: async () => {
      throw new Error("database password secret at 127.0.0.1");
    },
  });
  const failure = (await failed.json()) as { code: string; errorId?: string };
  expect(failed.status).toBe(500);
  expect(failure.code).toBe("INTERNAL_ERROR");
  expect(failure.errorId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(failure)).not.toContain("secret");
  expect(JSON.stringify(failure)).not.toContain("127.0.0.1");
});

test("attachment HTTP boundary maps unavailable persistence without inventing a reference", async () => {
  const response = await handleAttachmentUpload(attachmentUploadRequest(), {
    authenticate: () => ({ id: "user-1" }),
    database: () => null,
    store: storeAttachment,
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "TEMPORARILY_UNAVAILABLE" });
});

function attachmentUploadRequest(): Request {
  const boundary = "coforge-test-boundary";
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="conversationId"',
    "",
    "conversation-1",
    `--${boundary}`,
    'Content-Disposition: form-data; name="file"; filename="safe.txt"',
    "Content-Type: text/plain",
    "",
    "safe",
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return new Request("https://coforge.test/api/attachments", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
}
