import { Readable } from "node:stream";

import Credential from "@alicloud/credentials";
import OSS from "ali-oss";

import type { FileStorage, FileStorageConfig, StoredFile } from "./file-storage.server";

type OssConfig = Extract<FileStorageConfig, { kind: "oss" }>;

/**
 * Private Alibaba Cloud OSS bucket behind the {@link FileStorage} port, through the official
 * `ali-oss` SDK with V4 signing (V1 is being retired for buckets created after 2025-09-01).
 * Credentials come from a long-term AccessKey pair when one is configured, otherwise from the
 * `@alicloud/credentials` default chain, which on an ECS host means the instance RAM role's
 * STS token; the chain refreshes that token itself, and `refreshSTSToken` re-reads it so the
 * OSS client never signs with an expired one.
 */
export async function createOssFileStorage(config: OssConfig): Promise<FileStorage> {
  const region = `oss-${config.region}`;
  const endpoint = config.endpoint
    ? { endpoint: config.endpoint, cname: true }
    : { internal: config.internal };
  if (config.accessKey) {
    return new OssFileStorage(
      new OSS({
        ...config.accessKey,
        bucket: config.bucket,
        region,
        authorizationV4: true,
        ...endpoint,
      }),
    );
  }
  const chain = new Credential();
  const readCredential = async () => {
    const credential = await chain.getCredential();
    if (!credential.accessKeyId || !credential.accessKeySecret) {
      throw new Error("Alibaba Cloud credential chain returned no AccessKey");
    }
    return {
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
      stsToken: credential.securityToken ?? "",
    };
  };
  const initial = await readCredential();
  return new OssFileStorage(
    new OSS({
      ...initial,
      bucket: config.bucket,
      region,
      authorizationV4: true,
      ...endpoint,
      ...(initial.stsToken ? { refreshSTSToken: readCredential } : {}),
    }),
  );
}

export class OssFileStorage implements FileStorage {
  constructor(private readonly client: OSS) {}

  async put(objectKey: string, file: Blob, contentType: string) {
    await this.client.put(objectKey, Buffer.from(await file.arrayBuffer()), {
      headers: { "Content-Type": contentType, "x-oss-forbid-overwrite": "true" },
    });
  }

  async open(objectKey: string): Promise<StoredFile | null> {
    let result: Awaited<ReturnType<OSS["getStream"]>>;
    try {
      result = await this.client.getStream(objectKey);
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
    const headers = result.res.headers as Record<string, string | undefined>;
    const length = Number(headers["content-length"]);
    return {
      body: Readable.toWeb(result.stream as Readable) as unknown as ReadableStream<Uint8Array>,
      contentType: headers["content-type"] ?? null,
      sizeBytes: Number.isFinite(length) ? length : null,
    };
  }

  async remove(objectKey: string) {
    await this.client.delete(objectKey);
  }
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return code === "NoSuchKey" || status === 404;
}
