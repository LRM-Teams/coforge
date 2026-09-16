import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readEnvSecret } from "./env-secret.server";

/**
 * Private user-file storage behind chat attachments and profile avatars. PostgreSQL keeps only
 * the stable object key; this port maps that key to bytes. docs/architecture.md ("Alibaba Cloud
 * OSS：私有用户文件数据面") fixes the object-key layout and requires that switching the backing
 * store never changes the key, the database rows, or the client contract.
 */
export interface FileStorage {
  /** Writes one immutable object. Keys are server-generated UUID paths, so they never collide. */
  put(objectKey: string, file: Blob, contentType: string): Promise<void>;
  /** Opens one object for a response body, or `null` when it does not exist. */
  open(objectKey: string): Promise<StoredFile | null>;
  /** Removes one object; missing objects are not an error. */
  remove(objectKey: string): Promise<void>;
}

export interface StoredFile {
  body: Blob | ReadableStream<Uint8Array>;
  contentType: string | null;
  sizeBytes: number | null;
}

export class FileStorageConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileStorageConfigError";
  }
}

export type FileStorageConfig =
  | { kind: "local"; root: string }
  | {
      kind: "oss";
      bucket: string;
      region: string;
      /** Overrides the region endpoint as a custom domain (tests). */
      endpoint: string | null;
      /** Use the region's internal endpoint (only reachable from Alibaba Cloud hosts). */
      internal: boolean;
      /** Long-term AccessKey pair, or `null` to use the Alibaba Cloud default credential
       * chain (environment, OIDC, ECS instance RAM role). */
      accessKey: { accessKeyId: string; accessKeySecret: string } | null;
    };

/**
 * Reads the storage selection from the environment. `COFORGE_FILE_STORAGE` is `local` (default,
 * bytes under `COFORGE_FILE_STORAGE_DIR`) or `oss` (private Alibaba Cloud OSS bucket named by
 * `COFORGE_OSS_BUCKET` in `COFORGE_OSS_REGION`; `COFORGE_OSS_INTERNAL=1` on an Alibaba Cloud
 * host uses the region's internal endpoint). Credentials for `oss` come from
 * `ALIBABA_CLOUD_ACCESS_KEY_ID`/`ALIBABA_CLOUD_ACCESS_KEY_SECRET` (each also readable from a
 * `*_FILE` Docker secret) or, when neither is set, from the SDK's default credential chain.
 */
export function readFileStorageConfig(env: NodeJS.ProcessEnv): FileStorageConfig {
  const kind = env.COFORGE_FILE_STORAGE?.trim() || "local";
  if (kind === "local") {
    return {
      kind,
      root: env.COFORGE_FILE_STORAGE_DIR?.trim() || join(process.cwd(), ".data", "files"),
    };
  }
  if (kind !== "oss") {
    throw new FileStorageConfigError(`COFORGE_FILE_STORAGE must be "local" or "oss"`);
  }
  const bucket = required(env, "COFORGE_OSS_BUCKET");
  const region = required(env, "COFORGE_OSS_REGION");
  const accessKeyId = optional(env, "ALIBABA_CLOUD_ACCESS_KEY_ID");
  const accessKeySecret = optional(env, "ALIBABA_CLOUD_ACCESS_KEY_SECRET");
  if (Boolean(accessKeyId) !== Boolean(accessKeySecret)) {
    throw new FileStorageConfigError(
      "ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET must be set together",
    );
  }
  return {
    kind,
    bucket,
    region: region.replace(/^oss-/, ""),
    endpoint: env.COFORGE_OSS_ENDPOINT?.trim() || null,
    internal: env.COFORGE_OSS_INTERNAL?.trim() === "1",
    accessKey: accessKeyId && accessKeySecret ? { accessKeyId, accessKeySecret } : null,
  };
}

let current: Promise<FileStorage> | undefined;

/** The process-wide storage selected by the environment, created on first use. */
export function getFileStorage(): Promise<FileStorage> {
  current ??= createFileStorage(readFileStorageConfig(process.env));
  return current;
}

export async function createFileStorage(config: FileStorageConfig): Promise<FileStorage> {
  if (config.kind === "local") return new LocalFileStorage(config.root);
  const { createOssFileStorage } = await import("./oss-file-storage.server");
  return createOssFileStorage(config);
}

/**
 * Bytes under one private directory on the Web/backend host. Verification-only: no sharing
 * between backends, no orphan cleanup, no direct upload.
 */
export class LocalFileStorage implements FileStorage {
  constructor(private readonly root: string) {}

  path(objectKey: string) {
    return join(this.root, ...objectKey.split("/"));
  }

  async put(objectKey: string, file: Blob, _contentType?: string) {
    const path = this.path(objectKey);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, file);
  }

  async open(objectKey: string) {
    const file = Bun.file(this.path(objectKey));
    if (!(await file.exists())) return null;
    return { body: file, contentType: null, sizeBytes: file.size };
  }

  async remove(objectKey: string) {
    // Every key ends in `<id>/original`, so the object's own directory goes with it.
    await rm(dirname(this.path(objectKey)), { recursive: true, force: true });
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = optional(env, name);
  if (!value) throw new FileStorageConfigError(`${name} is required when COFORGE_FILE_STORAGE=oss`);
  return value;
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return readEnvSecret(env, name, (message) => {
    throw new FileStorageConfigError(message);
  });
}
