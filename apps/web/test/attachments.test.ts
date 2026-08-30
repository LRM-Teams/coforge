import { expect, test } from "bun:test";
import {
  attachmentCapabilities,
  ATTACHMENT_MAX_BYTES,
  storeAttachment,
} from "../src/server/attachments/attachment.server";

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
  await expect(
    storeAttachment(fakeDb as never, {
      userId: "user-1",
      conversationId: "conversation-1",
      file: new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], "large.bin"),
    }),
  ).rejects.toThrow("attachment exceeds maximum size");
  expect(touched).toBe(false);
});
