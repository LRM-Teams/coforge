import { expect, test } from "bun:test";

import { saveUserProfileInputSchema } from "../src/features/profiles/profile.schemas";
import { AppError } from "../src/lib/app-error";
import {
  PROFILE_IMAGE_MAX_BYTES,
  storeUserAvatar,
} from "../src/server/profiles/user-avatar.server";
import {
  handleAvatarDelete,
  handleAvatarDownload,
  handleAvatarUpload,
} from "../src/routes/api/me/avatar";

test("profile updates normalize editable names and reject an empty name", () => {
  expect(
    saveUserProfileInputSchema.parse({
      name: "  Frank An  ",
      description: "  Building CoForge.  ",
    }),
  ).toEqual({ name: "Frank An", description: "Building CoForge." });
  expect(
    saveUserProfileInputSchema.safeParse({ name: "   ", description: "" }).success,
  ).toBeFalse();
});

test("profile image upload rejects unsupported and oversized files before persistence", async () => {
  const db = persistenceMustNotBeTouched();

  await expect(
    storeUserAvatar(db, {
      userId: "user-1",
      file: new File(["text"], "avatar.txt", { type: "text/plain" }),
    }),
  ).rejects.toEqual(new AppError("INVALID_INPUT"));

  await expect(
    storeUserAvatar(db, {
      userId: "user-1",
      file: new File([new Uint8Array(PROFILE_IMAGE_MAX_BYTES + 1)], "avatar.png", {
        type: "image/png",
      }),
    }),
  ).rejects.toEqual(new AppError("INVALID_INPUT"));
});

test("profile image HTTP boundary uploads, serves inline, and removes the current user's image", async () => {
  const stored = {
    avatarUrl: "/api/me/avatar?v=avatar-version",
  };
  const upload = await handleAvatarUpload(avatarUploadRequest(), {
    authenticate: () => ({ id: "user-1" }),
    database: () => ({}) as never,
    store: async (_db, input) => {
      expect(input.userId).toBe("user-1");
      expect(input.file.type).toBe("image/png");
      return stored;
    },
    read: async () => {
      throw new Error("must not read during upload");
    },
    remove: async () => {
      throw new Error("must not remove during upload");
    },
  });
  expect(upload.status).toBe(200);
  expect(await upload.json()).toEqual(stored);

  const download = await handleAvatarDownload(new Request("https://coforge.test/api/me/avatar"), {
    authenticate: () => ({ id: "user-1" }),
    database: () => ({}) as never,
    store: async () => stored,
    read: async () => ({ body: Bun.file(import.meta.path), contentType: "image/png" }),
    remove: async () => {},
  });
  expect(download.status).toBe(200);
  expect(download.headers.get("content-type")).toBe("image/png");
  expect(download.headers.get("content-disposition")).toBe("inline");
  expect(download.headers.get("x-content-type-options")).toBe("nosniff");
  expect(download.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");

  let removedUserId = "";
  const removal = await handleAvatarDelete(new Request("https://coforge.test/api/me/avatar"), {
    authenticate: () => ({ id: "user-1" }),
    database: () => ({}) as never,
    store: async () => stored,
    read: async () => {
      throw new Error("must not read during removal");
    },
    remove: async (_db, userId) => {
      removedUserId = userId;
    },
  });
  expect(removal.status).toBe(204);
  expect(removedUserId).toBe("user-1");
});

test("profile image HTTP boundary rejects unauthenticated requests", async () => {
  const response = await handleAvatarDownload(new Request("https://coforge.test/api/me/avatar"), {
    authenticate: () => {
      throw new AppError("ACCESS_DENIED");
    },
    database: () => ({}) as never,
    store: async () => ({ avatarUrl: null }),
    read: async () => {
      throw new Error("must not read without authentication");
    },
    remove: async () => {},
  });

  expect(response.status).toBe(401);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

function persistenceMustNotBeTouched() {
  return new Proxy(
    {},
    {
      get() {
        throw new Error("persistence must not be touched");
      },
    },
  ) as never;
}

function avatarUploadRequest() {
  const form = new FormData();
  form.set(
    "file",
    new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "avatar.png", {
      type: "image/png",
    }),
  );
  return new Request("https://coforge.test/api/me/avatar", { method: "POST", body: form });
}
