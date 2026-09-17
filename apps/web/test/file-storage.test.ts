import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AppError } from "../src/lib/app-error";
import { storeAttachment } from "../src/server/attachments/attachment.server";
import {
  createFileStorage,
  FileStorageConfigError,
  LocalFileStorage,
  readFileStorageConfig,
  type FileStorage,
} from "../src/server/files/file-storage.server";
import { storeUserAvatar } from "../src/server/profiles/user-avatar.server";

describe("file storage configuration", () => {
  test("defaults to the local directory under the working directory", () => {
    expect(readFileStorageConfig({})).toEqual({
      kind: "local",
      root: join(process.cwd(), ".data", "files"),
    });
    expect(readFileStorageConfig({ COFORGE_FILE_STORAGE_DIR: "/data/files" })).toEqual({
      kind: "local",
      root: "/data/files",
    });
  });

  test("oss requires a bucket and region and accepts either region spelling", () => {
    expect(() => readFileStorageConfig({ COFORGE_FILE_STORAGE: "oss" })).toThrow(
      new FileStorageConfigError("COFORGE_OSS_BUCKET is required when COFORGE_FILE_STORAGE=oss"),
    );
    expect(
      readFileStorageConfig({
        COFORGE_FILE_STORAGE: "oss",
        COFORGE_OSS_BUCKET: "coforge-files-staging",
        COFORGE_OSS_REGION: "oss-cn-beijing",
      }),
    ).toEqual({
      kind: "oss",
      bucket: "coforge-files-staging",
      region: "cn-beijing",
      endpoint: null,
      internal: false,
      accessKey: null,
    });
  });

  test("oss reads an AccessKey pair inline or from Docker secret files, never half of one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coforge-oss-secrets-"));
    try {
      await Bun.write(join(directory, "id"), "AKID\n");
      await Bun.write(join(directory, "secret"), "SECRET\n");
      const config = readFileStorageConfig({
        COFORGE_FILE_STORAGE: "oss",
        COFORGE_OSS_BUCKET: "b",
        COFORGE_OSS_REGION: "cn-beijing",
        ALIBABA_CLOUD_ACCESS_KEY_ID_FILE: join(directory, "id"),
        ALIBABA_CLOUD_ACCESS_KEY_SECRET_FILE: join(directory, "secret"),
      });
      if (config.kind !== "oss") throw new Error("expected oss config");
      expect(config.accessKey).toEqual({ accessKeyId: "AKID", accessKeySecret: "SECRET" });
      expect(() =>
        readFileStorageConfig({
          COFORGE_FILE_STORAGE: "oss",
          COFORGE_OSS_BUCKET: "b",
          COFORGE_OSS_REGION: "cn-beijing",
          ALIBABA_CLOUD_ACCESS_KEY_ID: "AKID",
        }),
      ).toThrow(FileStorageConfigError);
      expect(() =>
        readFileStorageConfig({
          COFORGE_FILE_STORAGE: "oss",
          COFORGE_OSS_BUCKET: "b",
          COFORGE_OSS_REGION: "cn-beijing",
          ALIBABA_CLOUD_ACCESS_KEY_ID: "AKID",
          ALIBABA_CLOUD_ACCESS_KEY_ID_FILE: join(directory, "id"),
          ALIBABA_CLOUD_ACCESS_KEY_SECRET: "SECRET",
        }),
      ).toThrow(FileStorageConfigError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("rejects an unknown storage kind", () => {
    expect(() => readFileStorageConfig({ COFORGE_FILE_STORAGE: "s3" })).toThrow(
      FileStorageConfigError,
    );
  });
});

describe("local file storage", () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "coforge-files-"));
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  test("round-trips an object and removes its directory", async () => {
    const storage = new LocalFileStorage(root);
    const key = "workspaces/w/attachments/a/original";
    expect(await storage.open(key)).toBeNull();
    await storage.put(key, new Blob(["hello"]), "text/plain");
    const stored = await storage.open(key);
    expect(stored?.sizeBytes).toBe(5);
    expect(await new Response(stored!.body).text()).toBe("hello");
    await storage.remove(key);
    expect(await storage.open(key)).toBeNull();
    expect(await Bun.file(join(root, "workspaces/w/attachments/a")).exists()).toBe(false);
    await storage.remove(key);
  });

  test("reports an object's size on head, and has no presignPut (direct upload disabled)", async () => {
    const storage: FileStorage = new LocalFileStorage(root);
    const key = "workspaces/w/attachments/head/original";
    expect(await storage.head(key)).toBeNull();
    await storage.put(key, new Blob(["hello there"]), "text/plain");
    expect(await storage.head(key)).toEqual({ sizeBytes: 11, contentType: null });
    expect(storage.presignPut).toBeUndefined();
    await storage.remove(key);
  });
});

describe("oss file storage", () => {
  const objects = new Map<string, { bytes: Uint8Array<ArrayBuffer>; contentType: string }>();
  const requests: Array<{ method: string; key: string; headers: Headers }> = [];
  let server: ReturnType<typeof Bun.serve>;
  let storage: FileStorage;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const key = new URL(request.url).pathname.slice(1);
        requests.push({ method: request.method, key, headers: request.headers });
        const existing = objects.get(key);
        switch (request.method) {
          case "PUT":
            if (existing && request.headers.get("x-oss-forbid-overwrite") === "true")
              return ossError(409, "FileAlreadyExists");
            objects.set(key, {
              bytes: new Uint8Array(await request.arrayBuffer()),
              contentType: request.headers.get("content-type") ?? "",
            });
            return new Response(null, { headers: { etag: '"1"' } });
          case "GET":
            return existing
              ? new Response(existing.bytes, {
                  headers: { "content-type": existing.contentType, etag: '"1"' },
                })
              : ossError(404, "NoSuchKey");
          case "DELETE":
            objects.delete(key);
            return new Response(null, { status: 204 });
          case "HEAD":
            return existing
              ? new Response(null, {
                  headers: {
                    "content-type": existing.contentType,
                    "content-length": String(existing.bytes.length),
                    etag: '"1"',
                  },
                })
              : ossError(404, "NoSuchKey");
          default:
            return ossError(405, "MethodNotAllowed");
        }
      },
    });
    storage = await createFileStorage({
      kind: "oss",
      bucket: "coforge-files-test",
      region: "cn-beijing",
      endpoint: `http://127.0.0.1:${server.port}`,
      internal: false,
      accessKey: { accessKeyId: "AKID", accessKeySecret: "SECRET" },
    });
  });
  afterAll(() => server.stop(true));

  test("puts with the content type and no-overwrite guard under a V4 signature", async () => {
    const key = "users/u/avatars/1/original";
    await storage.put(key, new Blob([new Uint8Array([1, 2, 3])]), "image/png");
    const put = requests.find((r) => r.method === "PUT" && r.key === key);
    expect(put?.headers.get("content-type")).toBe("image/png");
    expect(put?.headers.get("x-oss-forbid-overwrite")).toBe("true");
    expect(put?.headers.get("authorization")).toStartWith("OSS4-HMAC-SHA256 Credential=AKID/");
    expect(objects.get(key)?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    await expect(storage.put(key, new Blob(["again"]), "image/png")).rejects.toMatchObject({
      code: "FileAlreadyExists",
    });
  });

  test("opens an existing object as a stream and reports a missing one as null", async () => {
    const key = "workspaces/w/attachments/a/original";
    await storage.put(key, new Blob(["attachment bytes"]), "text/plain");
    const stored = await storage.open(key);
    expect(stored?.contentType).toBe("text/plain");
    expect(stored?.sizeBytes).toBe(16);
    expect(await new Response(stored!.body).text()).toBe("attachment bytes");
    expect(await storage.open("workspaces/w/attachments/missing/original")).toBeNull();
  });

  test("removes an object", async () => {
    const key = "workspaces/w/attachments/b/original";
    await storage.put(key, new Blob(["x"]), "text/plain");
    await storage.remove(key);
    expect(objects.has(key)).toBe(false);
    expect(await storage.open(key)).toBeNull();
  });

  test("head reports size and content type, or null when missing", async () => {
    const key = "workspaces/w/attachments/head/original";
    expect(await storage.head(key)).toBeNull();
    await storage.put(key, new Blob(["hello there"]), "text/plain");
    expect(await storage.head(key)).toEqual({ sizeBytes: 11, contentType: "text/plain" });
  });

  test("presigns a V4 PUT with the no-overwrite header, and OSS conflicts (409) on a repeat PUT", async () => {
    if (!storage.presignPut) throw new Error("expected presignPut to be implemented");
    const key = "workspaces/w/attachments/presign/original";
    const { url, headers } = await storage.presignPut(key, {
      contentType: "text/plain",
      expiresInSeconds: 60,
    });
    expect(headers).toEqual({ "Content-Type": "text/plain", "x-oss-forbid-overwrite": "true" });
    expect(url).toContain("x-oss-signature-version=OSS4-HMAC-SHA256");
    const put = await fetch(url, { method: "PUT", headers, body: "hello" });
    expect(put.status).toBe(200);
    expect(objects.get(key)?.contentType).toBe("text/plain");
    // A second PUT to the very same object is OSS's own no-overwrite conflict: 409
    // FileAlreadyExists, not Raft 1.0.32's `If-None-Match: *` 412 — OSS has no such precondition
    // header, so `x-oss-forbid-overwrite` is what the presigned URL actually signs and OSS's own
    // conflict status is what the upload-session `complete`/CLI retry logic checks for.
    const conflict = await fetch(url, {
      method: "PUT",
      headers,
      body: "again",
    });
    expect(conflict.status).toBe(409);
  });

  function ossError(status: number, code: string) {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message><RequestId>r</RequestId></Error>`,
      { status, headers: { "content-type": "application/xml", "x-oss-request-id": "r" } },
    );
  }
});

describe("attachment and avatar services on the storage port", () => {
  class MemoryStorage implements FileStorage {
    objects = new Map<string, string>();
    async put(key: string, file: Blob, _contentType?: string) {
      this.objects.set(key, await file.text());
    }
    async open(key: string) {
      const text = this.objects.get(key);
      return text === undefined
        ? null
        : { body: new Blob([text]), contentType: null, sizeBytes: text.length };
    }
    async remove(key: string) {
      this.objects.delete(key);
    }
    async head(key: string) {
      const text = this.objects.get(key);
      return text === undefined ? null : { sizeBytes: text.length, contentType: null };
    }
  }

  test("attachment upload stores under the workspace key and rolls back when the row fails", async () => {
    const memory = new MemoryStorage();
    const storage = async () => memory;
    let created: { objectKey: string; contentType: string } | undefined;
    const db = {
      conversation: { findFirst: async () => ({ id: "c1", workspaceId: "w1" }) },
      attachment: {
        create: async ({ data }: { data: { objectKey: string; contentType: string } }) => {
          created = data;
          return { id: "a1", fileName: data.objectKey, contentType: "", sizeBytes: 0 };
        },
      },
    };
    await storeAttachment(
      db as never,
      { userId: "u1", conversationId: "c1", file: new File(["notes"], "notes.txt") },
      storage,
    );
    expect(created?.objectKey).toMatch(/^workspaces\/w1\/attachments\/[0-9a-f-]{36}\/original$/);
    expect(created?.contentType).toBe("application/octet-stream");
    expect(memory.objects.get(created!.objectKey)).toBe("notes");

    const failing = {
      ...db,
      attachment: {
        create: async () => {
          throw new Error("row failed");
        },
      },
    };
    await expect(
      storeAttachment(
        failing as never,
        { userId: "u1", conversationId: "c1", file: new File(["x"], "x.txt") },
        storage,
      ),
    ).rejects.toThrow("row failed");
    expect(memory.objects.size).toBe(1);
  });

  test("avatar replacement removes the previous object only after the row is updated", async () => {
    const memory = new MemoryStorage();
    const storage = async () => memory;
    await memory.put("users/u1/avatars/old/original", new Blob(["old"]), "image/png");
    const png = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])],
      "a.png",
      {
        type: "image/png",
      },
    );
    let updated: { avatarObjectKey: string | null } | undefined;
    const db = {
      user: {
        findUnique: async () => ({ avatarObjectKey: "users/u1/avatars/old/original" }),
        update: async ({ data }: { data: { avatarObjectKey: string | null } }) => {
          updated = data;
          return {};
        },
      },
    };
    const result = await storeUserAvatar(db as never, { userId: "u1", file: png }, storage);
    expect(result.avatarUrl).toMatch(/^\/api\/me\/avatar\?v=[0-9a-f-]{36}$/);
    expect(memory.objects.has("users/u1/avatars/old/original")).toBe(false);
    expect(memory.objects.get(updated!.avatarObjectKey!)).toBeDefined();

    const failing = {
      user: {
        findUnique: async () => ({ avatarObjectKey: updated!.avatarObjectKey }),
        update: async () => {
          throw new AppError("TEMPORARILY_UNAVAILABLE");
        },
      },
    };
    await expect(
      storeUserAvatar(failing as never, { userId: "u1", file: png }, storage),
    ).rejects.toEqual(new AppError("TEMPORARILY_UNAVAILABLE"));
    expect([...memory.objects.keys()]).toEqual([updated!.avatarObjectKey!]);
  });
});
