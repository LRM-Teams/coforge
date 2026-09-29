import { expect, mock, test } from "bun:test";

import type { FileStorage } from "#src/server/files/file-storage.server";
import * as fileStorage from "#src/server/files/file-storage.server";

function memoryStorage() {
  const objects = new Map<string, Blob>();
  const storage: FileStorage = {
    put: async (key, file) => {
      objects.set(key, file);
    },
    open: async (key) => {
      const body = objects.get(key);
      return body ? { body, contentType: body.type, sizeBytes: body.size } : null;
    },
    remove: async (key) => {
      objects.delete(key);
    },
    head: async (key) => {
      const body = objects.get(key);
      return body ? { sizeBytes: body.size, contentType: body.type || null } : null;
    },
  };
  return { objects, storage };
}

// Two separate stores, as on a deployment with its own image bucket: the private one holds chat
// attachments, the public one the profile images its CDN domain serves without an access check.
const publicImages = memoryStorage();
const privateRemovals: string[] = [];
const privateFiles: FileStorage = {
  ...memoryStorage().storage,
  remove: async (key) => {
    privateRemovals.push(key);
  },
};
mock.module("#src/server/files/file-storage.server", () => ({
  ...fileStorage,
  getFileStorage: async () => privateFiles,
}));
mock.module("#src/server/files/public-image-storage.server", () => ({
  getPublicImageStorage: async () => publicImages.storage,
}));

const { ProjectImages } = await import("#src/server/projects/project-images.server");
const { ProjectSettings } = await import("#src/server/projects/project-settings.server");

// One Project row as the two classes see it; the concurrency guards are covered against
// PostgreSQL in project-images.integration.ts.
function fakeDb() {
  let iconObjectKey: string | null = null;
  return {
    project: {
      findFirst: async () => ({ iconObjectKey }),
      updateMany: async ({ data }: { data: { iconObjectKey: string } }) => {
        iconObjectKey = data.iconObjectKey;
        return { count: 1 };
      },
      deleteMany: async () => ({ count: 1 }),
    },
  } as unknown as ConstructorParameters<typeof ProjectSettings>[0];
}

test("deleting a Project removes its icon from the public image store it was uploaded to", async () => {
  const db = fakeDb();
  await new ProjectImages(db).store(
    "workspace-1",
    "user-1",
    "project-1",
    new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])], "icon.png", {
      type: "image/png",
    }),
  );
  expect(publicImages.objects.size).toBe(1);

  await new ProjectSettings(db).delete("workspace-1", "user-1", "project-1", "Launch");

  expect(publicImages.objects.size).toBe(0);
  expect(privateRemovals).toEqual([]);
});
