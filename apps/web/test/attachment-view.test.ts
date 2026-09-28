import { expect, test } from "bun:test";

import { attachmentView } from "#src/server/attachments/attachment-view.server";

const row = {
  id: "a1",
  fileName: "shot.png",
  contentType: "image/png",
  sizeBytes: 5,
  objectKey: "workspaces/w/attachments/a1/original",
};

test("carries a signed preview URL for an inline image when delivery is configured", () => {
  const view = attachmentView(row, {
    signedUrl: (objectKey) => {
      expect(objectKey).toBe(row.objectKey);
      return {
        url: "https://files-staging.coforge.cn/workspaces/w/attachments/a1/original?auth_key=1-2-0-3",
        expiresAt: new Date(0),
      };
    },
  });
  expect(view).toEqual({
    id: "a1",
    fileName: "shot.png",
    contentType: "image/png",
    sizeBytes: 5,
    previewUrl:
      "https://files-staging.coforge.cn/workspaces/w/attachments/a1/original?auth_key=1-2-0-3",
  });
});

test("omits the preview URL for a non-image content type even when delivery is configured", () => {
  const view = attachmentView(
    { ...row, contentType: "application/pdf", fileName: "doc.pdf" },
    {
      signedUrl: () => {
        throw new Error("must not sign a URL for a non-inline-image content type");
      },
    },
  );
  expect(view).toEqual({
    id: "a1",
    fileName: "doc.pdf",
    contentType: "application/pdf",
    sizeBytes: 5,
  });
  expect(view).not.toHaveProperty("previewUrl");
});

test("omits the preview URL when delivery is not configured", () => {
  const view = attachmentView(row, null);
  expect(view).toEqual({
    id: "a1",
    fileName: "shot.png",
    contentType: "image/png",
    sizeBytes: 5,
  });
  expect(view).not.toHaveProperty("previewUrl");
});

test("never exposes objectKey on the returned view", () => {
  const view = attachmentView(row, null);
  expect(view).not.toHaveProperty("objectKey");
  const withDelivery = attachmentView(row, {
    signedUrl: () => ({
      url: "https://files-staging.coforge.cn/x?auth_key=1",
      expiresAt: new Date(0),
    }),
  });
  expect(withDelivery).not.toHaveProperty("objectKey");
});

test("omits the preview URL and keeps the row usable when signing throws", () => {
  const view = attachmentView(row, {
    signedUrl: () => {
      throw new Error("secret file unreadable");
    },
  });
  expect(view).toEqual({ id: "a1", fileName: "shot.png", contentType: "image/png", sizeBytes: 5 });
});
