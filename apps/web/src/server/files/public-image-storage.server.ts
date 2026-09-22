import {
  createFileStorage,
  FileStorageConfigError,
  getFileStorage,
  readFileStorageConfig,
  type FileStorage,
  type FileStorageConfig,
} from "./file-storage.server";

/**
 * Where profile-image bytes live: user avatars and project icons, the two classes delivered
 * without an access check (`public-image-delivery.server.ts`).
 *
 * They need their own bucket because the CDN's private-origin authorization is bucket-wide per
 * origin: the domain that serves an unsigned object key can serve every key in the bucket behind
 * it. Keeping profile images in the private files bucket would therefore publish every chat
 * attachment the moment that domain exists. One bucket, one domain, one trust zone (ADR 0006).
 *
 * Env, in addition to the private store's (`file-storage.server.ts`):
 * - `COFORGE_IMAGE_OSS_BUCKET` — the profile-image bucket, in the same account and region as the
 *   private files bucket and never equal to it. Unset means this deployment has no separate
 *   bucket: profile images stay in the private store and keep their authenticated routes, which
 *   is the local-development and pre-provisioning state.
 *
 * The object-key layout is the same in either bucket, so moving a deployment onto the image
 * bucket is copying objects — no key, database row, or client contract changes.
 */
export async function readPublicImageStorageConfig(
  env: NodeJS.ProcessEnv,
): Promise<FileStorageConfig | null> {
  const bucket = env.COFORGE_IMAGE_OSS_BUCKET?.trim();
  if (!bucket) {
    // A deployment that publishes public image URLs must have the bucket the image domain reads;
    // otherwise every avatar would 404 at the edge while the bytes sit in the private bucket.
    if (env.COFORGE_IMAGE_DELIVERY_URL?.trim()) {
      throw new FileStorageConfigError(
        "COFORGE_IMAGE_OSS_BUCKET is required when COFORGE_IMAGE_DELIVERY_URL is set",
      );
    }
    return null;
  }
  const privateStore = await readFileStorageConfig(env);
  if (privateStore.kind !== "oss") {
    throw new FileStorageConfigError("COFORGE_IMAGE_OSS_BUCKET requires COFORGE_FILE_STORAGE=oss");
  }
  if (privateStore.bucket === bucket) {
    throw new FileStorageConfigError(
      "COFORGE_IMAGE_OSS_BUCKET must not be COFORGE_OSS_BUCKET: the image domain reads its whole bucket",
    );
  }
  return { ...privateStore, bucket };
}

let current: Promise<FileStorage> | undefined;

/**
 * The process-wide profile-image storage. Without its own bucket this is the private store, so
 * uploads keep working unchanged and the authenticated routes keep serving them.
 */
export function getPublicImageStorage(): Promise<FileStorage> {
  current ??= readPublicImageStorageConfig(process.env).then(createPublicImageStorage);
  return current;
}

export function createPublicImageStorage(config: FileStorageConfig | null): Promise<FileStorage> {
  return config ? createFileStorage(config) : getFileStorage();
}
