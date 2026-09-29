import { Readable } from "node:stream";

import Credential from "@alicloud/credentials";
import OSS from "ali-oss";

import {
  assertRemovablePrefix,
  type BulkFileRemoval,
  type ManagedFileStorage,
  type FileStorage,
  type FileStorageConfig,
  type StoredFile,
} from "./file-storage.server";

/** DeleteMultipleObjects takes at most 1,000 keys per request, and ListObjectsV2 returns at most
 * 1,000 per page (https://help.aliyun.com/zh/oss/developer-reference/deletemultipleobjects,
 * https://help.aliyun.com/zh/oss/developer-reference/listobjectsv2). */
const OSS_BATCH_MAX = 1000;

type OssConfig = Extract<FileStorageConfig, { kind: "oss" }>;

/**
 * Private Alibaba Cloud OSS bucket behind the {@link FileStorage} port, through the official
 * `ali-oss` SDK with V4 signing (V1 is being retired for buckets created after 2025-09-01).
 * Credentials come from a long-term AccessKey pair when one is configured, otherwise from the
 * `@alicloud/credentials` default chain, which on an ECS host means the instance RAM role's
 * STS token; the chain refreshes that token itself, and `refreshSTSToken` re-reads it so the
 * OSS client never signs with an expired one.
 */
export async function createOssFileStorage(config: OssConfig): Promise<ManagedFileStorage> {
  const region = `oss-${config.region}`;
  // Two clients, one credential source. Server-side traffic may use the region's internal
  // endpoint (cheaper and faster from an Aliyun host); a presigned URL is handed to a browser or
  // the CLI, which can only reach the public endpoint — an internal endpoint is reachable only
  // from Aliyun products in the same region, so handing one to a browser is a guaranteed
  // connection failure. A custom domain (CNAME) is publicly routable and applies to both.
  const customDomain = config.endpoint ? { endpoint: config.endpoint, cname: true } : null;
  const serverEndpoint = customDomain ?? { internal: config.internal };
  const presignEndpoint = customDomain ?? {};
  if (config.accessKey) {
    return new OssFileStorage(
      new OSS({
        ...config.accessKey,
        bucket: config.bucket,
        region,
        authorizationV4: true,
        ...serverEndpoint,
      }),
      new OSS({
        ...config.accessKey,
        bucket: config.bucket,
        region,
        authorizationV4: true,
        ...presignEndpoint,
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
  const shared = {
    bucket: config.bucket,
    region,
    authorizationV4: true,
    ...(initial.stsToken ? { refreshSTSToken: readCredential } : {}),
  };
  return new OssFileStorage(
    new OSS({ ...initial, ...shared, ...serverEndpoint }),
    new OSS({ ...initial, ...shared, ...presignEndpoint }),
  );
}

export class OssFileStorage implements FileStorage, BulkFileRemoval {
  /** Server-side traffic (put/open/remove/head) may ride the internal endpoint; `presignPut`
   * signs on the public-endpoint client because its URL is consumed outside this server. */
  constructor(
    private readonly client: OSS,
    private readonly presignClient: OSS,
  ) {}

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

  /** `deleteMulti` in quiet mode, a thousand keys per request; authorized by `oss:DeleteObject`. */
  async removeMany(objectKeys: readonly string[]) {
    for (let start = 0; start < objectKeys.length; start += OSS_BATCH_MAX)
      await this.client.deleteMulti(objectKeys.slice(start, start + OSS_BATCH_MAX), {
        quiet: true,
      });
  }

  /** Lists the prefix a page at a time (`listV2`, which needs `oss:ListObjects` on the bucket)
   * and removes each page with one `deleteMulti`. */
  async removePrefix(prefix: string) {
    assertRemovablePrefix(prefix);
    let continuationToken: string | undefined;
    do {
      const page = await this.client.listV2({
        prefix,
        "max-keys": OSS_BATCH_MAX,
        ...(continuationToken ? { "continuation-token": continuationToken } : {}),
      });
      const keys = (page.objects ?? []).map((object) => object.name);
      if (keys.length) await this.client.deleteMulti(keys, { quiet: true });
      continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (continuationToken);
  }

  async head(objectKey: string) {
    let result: Awaited<ReturnType<OSS["head"]>>;
    try {
      result = await this.client.head(objectKey);
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
    const headers = result.res.headers as Record<string, string | undefined>;
    const length = Number(headers["content-length"]);
    return {
      sizeBytes: Number.isFinite(length) ? length : 0,
      contentType: headers["content-type"] ?? null,
    };
  }

  /**
   * V4-signs a PUT for `objectKey` that has not been written yet, guarded by
   * `x-oss-forbid-overwrite`: OSS's own no-overwrite mechanism (there is no OSS equivalent of
   * S3's `If-None-Match: *`). The caller must send back exactly the `Content-Type` and
   * `x-oss-forbid-overwrite` headers this returns. Neither needs to be listed in
   * `signatureUrlV4`'s `additionalHeaders` parameter: `ali-oss`'s V4 signer
   * (`lib/common/signUtils.js#getCanonicalRequest`) always folds `content-type` and every
   * `x-oss-*` header already present in `headers` into the canonical request, and
   * `fixAdditionalHeaders` explicitly strips those same headers back out of whatever
   * `additionalHeaders` list is passed — so passing one here would be a no-op at best. A
   * conflict on OSS answers `409 FileAlreadyExists` (confirmed against this file's own fake-OSS
   * test fixture), not the `412` Raft 1.0.32's own `If-None-Match` contract expects; the caller
   * of `presignPut` (the upload session route, and the CLI's PUT-outcome check) is where this
   * repo's "already uploaded" check lives, and it checks for 409.
   */
  async presignPut(objectKey: string, input: { contentType: string; expiresInSeconds: number }) {
    const headers = { "Content-Type": input.contentType, "x-oss-forbid-overwrite": "true" };
    // Signed on the public-endpoint client: the consumer of this URL is a browser or the CLI.
    const url = await this.presignClient.signatureUrlV4(
      "PUT",
      input.expiresInSeconds,
      { headers },
      objectKey,
    );
    return { url, headers };
  }
}

function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return code === "NoSuchKey" || status === 404;
}
