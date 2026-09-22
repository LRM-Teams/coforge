#!/usr/bin/env bun
/**
 * Publishes one unified Computer release version to the local-distribution feed on Alibaba Cloud
 * OSS: compile every target, assemble the version tree (build-release.ts), upload every object
 * it lists, read each one back and compare bytes, and only then write the feed's mutable
 * `latest` pointer - in that fixed order. docs/release.md ("Local Computer distribution model"):
 * "`latest` is the feed's only mutable object, and it is written last - every object under the
 * new `<version>/` it will point to is uploaded and verified first. A publish that fails partway
 * through therefore leaves at most an unreferenced version directory; `latest` never points at
 * incomplete or missing objects."
 *
 * Published versions are also immutable: the publish refuses to start if `<version>/manifest.json`
 * already exists. The feed's CDN caches `<version>/*` for 365 days, so overwriting a live version
 * would leave different bytes on different edge nodes for up to a year.
 *
 * Upload happens through the official `ali-oss` SDK with V4 request signing - Alibaba Cloud is
 * retiring V1 (Authorization-header HMAC-SHA1) for buckets created after 2025-09-01, which is
 * this script's `coforge-releases-staging` bucket. Credentials come from `@alicloud/credentials`'s
 * default provider chain, the same pattern already established for `apps/web`'s OSS file storage
 * (`apps/web/src/server/files/oss-file-storage.server.ts`): GitHub Actions federates a short-lived
 * STS token through GitHub OIDC (see `.github/workflows/release-staging.yml`), and a local run can
 * instead export a long-term `ALIBABA_CLOUD_ACCESS_KEY_ID`/`ALIBABA_CLOUD_ACCESS_KEY_SECRET` pair.
 * No long-term AccessKey is stored for CI.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Credential from "@alicloud/credentials";
import OSS from "ali-oss";

import {
  buildReleaseTree,
  isValidReleaseVersion,
  type ReleaseInputs,
  type ReleaseTree,
} from "./build-release";
import { compileTargetArtifacts, isReleaseTarget, type ReleaseTarget } from "./compile-targets";
import { resolvePhotonWasmBytes } from "./photon-wasm";

/* -------------------------------------------------------------------------------------------- */
/* OSS client and credentials                                                                    */
/* -------------------------------------------------------------------------------------------- */

export interface OssCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
}

/** Where the object store lives. Production always uses the real bucket over HTTPS
 * (virtual-hosted-style: `https://<bucket>.<endpoint>/<key>`); tests override `endpoint` to a
 * local fixture server and set `cname: true` (so the SDK talks to that host directly instead of
 * prefixing it with the bucket name) and `secure: false`. */
export interface OssConnection {
  bucket: string;
  endpoint: string;
  /** The bucket's region id (`oss-cn-beijing`), which V4 signing writes into every request's
   * credential scope. ali-oss does not derive it from `endpoint` and silently defaults to
   * `oss-cn-hangzhou`, and OSS rejects a scope for the wrong region with `InvalidArgument`.
   * Defaults to the region named by a public `oss-<region>.aliyuncs.com` endpoint. */
  region?: string;
  cname?: boolean;
  secure?: boolean;
}

/** The region id a public OSS endpoint names (`oss-cn-beijing.aliyuncs.com` -> `oss-cn-beijing`),
 * or undefined for any other host (a fixture server, a custom domain, or a global transfer
 * acceleration endpoint such as `oss-accelerate.aliyuncs.com`, which names no region). */
export function regionFromEndpoint(endpoint: string): string | undefined {
  const host = endpoint.replace(/^https?:\/\//i, "").replace(/[/:].*$/, "");
  if (/^oss-accelerate(?:-overseas)?\.aliyuncs\.com$/i.test(host)) return undefined;
  const match = /^(oss-[a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com$/i.exec(host);
  return match?.[1];
}

/** Builds the ali-oss client this script uploads through, with V4 signing (`authorizationV4:
 * true`) - see the file banner for why V1 is no longer an option for this bucket. `credentials`,
 * when given, is used as-is; this is how tests point the client at a local fixture server with
 * static test credentials. Without it, credentials come from the `@alicloud/credentials` default
 * chain, and `refreshSTSToken` re-reads that chain whenever the resolved credential carries a
 * security token - the same pattern `apps/web`'s OSS file storage uses - so a client built from a
 * federated STS token does not start signing with an expired one partway through a publish that
 * compiled six targets before it ever made a network call. */
export async function createOssClient(
  connection: OssConnection,
  credentials?: OssCredentials,
): Promise<OSS> {
  const region = connection.region ?? regionFromEndpoint(connection.endpoint);
  if (!region) {
    throw new Error(
      `cannot derive the OSS region from endpoint ${connection.endpoint}; pass --region (V4 ` +
        "signing needs the bucket's region in every request)",
    );
  }
  const base = {
    bucket: connection.bucket,
    endpoint: connection.endpoint,
    region,
    cname: connection.cname ?? false,
    secure: connection.secure ?? true,
    authorizationV4: true,
    // Transient transport errors (-1/-2: reset, connect timeout) retry at the SDK level. A response
    // timeout carries no status, so it is putObject's own retry loop that rescues it.
    retryMax: 2,
  };
  if (credentials) {
    return new OSS({ ...credentials, ...base });
  }
  const chain = new Credential();
  const readCredential = async (): Promise<OssCredentials> => {
    const credential = await chain.getCredential();
    if (!credential.accessKeyId || !credential.accessKeySecret) {
      throw new Error(
        "Alibaba Cloud credential chain returned no AccessKey; set ALIBABA_CLOUD_ROLE_ARN, " +
          "ALIBABA_CLOUD_OIDC_PROVIDER_ARN and ALIBABA_CLOUD_OIDC_TOKEN_FILE for GitHub OIDC, or " +
          "ALIBABA_CLOUD_ACCESS_KEY_ID/ALIBABA_CLOUD_ACCESS_KEY_SECRET locally (or pass --dry-run).",
      );
    }
    return {
      accessKeyId: credential.accessKeyId,
      accessKeySecret: credential.accessKeySecret,
      stsToken: credential.securityToken ?? undefined,
    };
  };
  const initial = await readCredential();
  return new OSS({
    ...initial,
    ...base,
    ...(initial.stsToken ? { refreshSTSToken: readCredential } : {}),
  });
}

/** The request URL for an object, built the same way the SDK itself would route the request
 * (bucket-prefixed host unless `cname` is set) - used only for the unauthenticated
 * `verifyPrivateOrigin` probe below, which deliberately does not go through the signed client. */
function objectOrigin(connection: OssConnection, objectKey: string): string {
  const secure = connection.secure ?? true;
  const withScheme = /^https?:\/\//i.test(connection.endpoint)
    ? connection.endpoint
    : `${secure ? "https" : "http"}://${connection.endpoint}`;
  const url = new URL(withScheme);
  if (!connection.cname) {
    url.hostname = `${connection.bucket}.${url.hostname}`;
  }
  url.pathname = `/${objectKey}`;
  url.search = "";
  return url.toString();
}

/** Resolves true when the error is ali-oss's "object not found" shape (a HEAD/GET 404, reported
 * as `code: "NoSuchKey"`), false otherwise. Mirrors `apps/web`'s `isMissingObject`. */
function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return code === "NoSuchKey" || status === 404;
}

/** The only diagnostic a failed OSS call is allowed to surface: an HTTP status, OSS's own code, the
 * error's *class name*, the object key, and OSS's request id. It deliberately excludes the SDK
 * error's `message` and any response body/header - a real OSS `SignatureDoesNotMatch` error echoes
 * the `StringToSign`, the supplied `Signature`, and the `AccessKeyId` back to the caller, so
 * surfacing that text would leak exactly the material this function exists to protect. See
 * publish.test.ts's credential-leak test, which fails if this function is changed to include either.
 *
 * The class name is in because it is the one part of an SDK error that is a *kind* rather than
 * content: a transport failure reports no status at all (`HTTP unknown`), and `ResponseTimeoutError`
 * versus `ConnectionTimeoutError` is the whole diagnosis. */
export function ossError(action: string, objectKey: string, error: unknown): Error {
  const { status, code, requestId, name } =
    typeof error === "object" && error !== null
      ? (error as { status?: unknown; code?: unknown; requestId?: unknown; name?: unknown })
      : {};
  const statusText = typeof status === "number" ? status : "unknown";
  const codeText = typeof code === "string" && code.length > 0 ? ` code=${code}` : "";
  // `Error` itself says nothing; a class name that differs from it is the interesting case.
  const nameText =
    typeof name === "string" && name.length > 0 && name !== "Error" ? ` ${name}` : "";

  const requestIdText =
    typeof requestId === "string" && requestId.length > 0 ? requestId : "unknown";
  return new Error(
    `OSS ${action} failed: HTTP ${statusText}${codeText}${nameText} ${objectKey} request-id=${requestIdText}`,
  );
}

/* -------------------------------------------------------------------------------------------- */
/* Upload primitives                                                                             */
/* -------------------------------------------------------------------------------------------- */

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Objects at or above this size are uploaded as several parts so a slow link cannot blow one
 * request's timeout on the whole multi-megabyte object. The staging feed's largest object - the
 * darwin-arm64 computer binary, ~28 MiB and the first one uploaded - exceeded ali-oss's default
 * 60 s per-request timeout when the GitHub-runner-to-OSS path slowed below ~0.5 MB/s, and the SDK
 * killed it with a `ResponseTimeoutError` (a `name`-only error, no status/code/request-id).
 * Parts use ali-oss's documented defaults (1 MiB, 5 in parallel), so each 60 s request carries
 * one megabyte rather than a whole binary. */
const MULTIPART_MIN_BYTES = 20 * 1024 * 1024;
/** Whole-multipart attempts before giving up. ali-oss's own retry never fires for a response
 * timeout: its guard only retries errors carrying status -1/-2, and a `ResponseTimeoutError`
 * carries none — so a timed-out part fails the whole call no matter what `retryMax` says. The
 * outer retry below is the only thing that rescues it. Without a checkpoint, each attempt starts a
 * new multipart upload (a new uploadId) and re-sends the whole object. */
const MULTIPART_ATTEMPTS = 3;

/** Every other release object (the computer binary, its gzip, checksum sidecars, the manifest) is
 * served as opaque bytes; only photon_rs_bg.wasm has a real registered media type
 * (https://www.iana.org/assignments/media-types/application/wasm), so it is the one object key
 * this needs to special-case rather than a lookup table nothing else would ever hit. */
function contentTypeFor(objectKey: string): string {
  return objectKey.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
}

async function putObject(
  client: OSS,
  objectKey: string,
  bytes: Uint8Array,
  requestTimeoutMs?: number,
): Promise<void> {
  const buffer = Buffer.from(bytes);
  const contentType = contentTypeFor(objectKey);
  // `requestTimeoutMs` is a test-only hook so the stalled-server fixture can pin the
  // `ResponseTimeoutError` reporting path; production uses ali-oss's 60 s default.
  const requestOptions = requestTimeoutMs ? { timeout: requestTimeoutMs } : {};
  try {
    if (buffer.byteLength >= MULTIPART_MIN_BYTES) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await client.multipartUpload(objectKey, buffer, {
            ...requestOptions,
            headers: { "Content-Type": contentType },
          });
          return;
        } catch (error) {
          // Only a timeout is worth re-attempting from here; anything else is either a
          // configuration fault (a 403) or a real server error, and ossError already names it.
          const name =
            typeof error === "object" && error !== null
              ? (error as { name?: unknown }).name
              : undefined;
          if (
            attempt >= MULTIPART_ATTEMPTS ||
            typeof name !== "string" ||
            !name.endsWith("TimeoutError")
          )
            throw error;
        }
      }
    }
    await client.put(objectKey, buffer, {
      ...requestOptions,
      headers: { "Content-Type": contentType },
    });
  } catch (error) {
    throw ossError("upload", objectKey, error);
  }
}

async function getObject(client: OSS, objectKey: string): Promise<Uint8Array> {
  try {
    const result = await client.get(objectKey);
    return new Uint8Array(result.content as Buffer);
  } catch (error) {
    throw ossError("read-back", objectKey, error);
  }
}

export const LATEST_OBJECT_KEY = "latest";

/** The object that marks a version as fully uploaded. It is written last (see
 * `uploadReleaseTree`), so its presence means every other object under `<version>/` is already
 * there - which is what lets `assertVersionIsUnpublished` use it as a completion marker. */
export function manifestObjectKey(version: string): string {
  return `${version}/manifest.json`;
}

/** Resolves true when the object exists, false on a 404, and throws on anything else - an
 * ambiguous status (403, 5xx) must not be read as "absent", or the caller would overwrite a
 * published version on a transient error. */
async function objectExists(client: OSS, objectKey: string): Promise<boolean> {
  try {
    await client.head(objectKey);
    return true;
  } catch (error) {
    if (isMissingObject(error)) return false;
    throw ossError("probe", objectKey, error);
  }
}

/** Refuses to republish a version that already completed. Published versions are immutable: the
 * feed's CDN caches `<version>/*` for 365 days (docs/operations/aliyun-oss-cdn.md), so a second
 * publish under the same version would leave different bytes on different edge nodes for up to a
 * year - `install.sh` verifying an old sidecar against an old binary would silently install the
 * older build. A publish that failed partway through never wrote the manifest, so retrying that
 * is still allowed; only a completed version is protected. */
export async function assertVersionIsUnpublished(
  version: string,
  options: { client: OSS },
): Promise<void> {
  const key = manifestObjectKey(version);
  if (await objectExists(options.client, key)) {
    throw new Error(
      `Release version ${version} is already published (${key} exists). Published versions are ` +
        `immutable - publish a new version instead of overwriting this one.`,
    );
  }
}

export interface UploadOptions {
  client: OSS;
  connection: OssConnection;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Per-request upload timeout in ms. Production publishes set none (human directive
   * 2026-09-21: uploads just take as long as the link needs). Tests pass a small value so a
   * deliberately slow fixture server can prove that a stalled link reports the timeout's name
   * instead of hanging the publish. */
  requestTimeoutMs?: number;
  /** Tolerate objects that are already up, verifying them against the freshly compiled bytes instead
   * of refusing the version. This is the finalize half of a split publication: a version whose
   * per-platform jobs have already uploaded their objects is re-compiled once on a single job, every
   * object is read back and compared, the manifest is written, and only then does `latest` move. */
  allowExisting?: boolean;
  /** Whether to move the feed's `latest` pointer once the objects are up. `false` uploads and
   * verifies this version's objects only — what a per-platform job must do, because `latest` is the
   * feed's only mutable object and docs/release.md requires it to be written last, never pointing at
   * an incomplete version. The finalize job moves it once every platform's objects are up. */
  activate?: boolean;
}

export interface UploadResult {
  uploaded: string[];
  latestKey: string;
}

/** Uploads every object under the new version tree, reads each one back and compares its bytes
 * to the local copy, and only then writes the mutable `latest` pointer - see the file banner for
 * why that order matters. Any failure (an upload, a read-back mismatch) throws before `latest`
 * is ever written, and stops uploading/verifying the objects after it. */
/**
 * What every phase of a publication shares: the OSS client, the feed origin it probes, and the
 * progress line sink. Threading this one object keeps the phases below to their own arguments.
 */
type UploadContext = {
  client: OSS;
  connection: OssConnection;
  fetchImpl: typeof fetch;
  log: (line: string) => void;
  outputDirectory: string;
  requestTimeoutMs?: number;
};

/** What this publication is responsible for, settled before any network call is made. */
type UploadPlan = {
  allowExisting: boolean;
  /** An objects-only job leaves `latest` — and the manifest — to the finalize pass. */
  objectsOnly: boolean;
  /** Every object this job covers; an objects-only job excludes the manifest. */
  files: string[];
  /** The order objects go up: everything but the manifest, then the manifest itself, last. */
  uploads: string[];
};

/**
 * The manifest is pinned last explicitly rather than relying on `tree.files` being sorted:
 * `build-release.ts` sorts the whole list, so "manifest.json" only happens to sort after the POSIX
 * targets, but before Windows. Relying on that order would silently break the completion marker
 * `assertVersionIsUnpublished` depends on.
 *
 * An objects-only job must not write the manifest either, even though the ordinary path pins it
 * last. The manifest is the version's completion marker *and* a hash of every object, so a
 * per-platform job - which compiles only its own target - would race five others and leave an
 * incomplete manifest behind as the marker. The finalize job writes the one true manifest after
 * every platform is up.
 */
function planUpload(
  tree: ReleaseTree,
  options: Pick<UploadOptions, "activate" | "allowExisting">,
): UploadPlan {
  const manifestKey = manifestObjectKey(tree.version);
  if (tree.files.filter((file) => file === manifestKey).length !== 1) {
    throw new Error(`Release tree does not contain exactly one ${manifestKey} to upload last`);
  }
  const uploadOrder = [...tree.files.filter((file) => file !== manifestKey), manifestKey];
  const objectsOnly = options.activate === false;
  const files = objectsOnly ? tree.files.filter((file) => file !== manifestKey) : tree.files;
  return {
    // A normal publication refuses a version the feed has already seen; a finalize pass is exactly
    // that version, so it verifies the objects that are up instead (see `UploadOptions.allowExisting`).
    allowExisting: options.allowExisting === true,
    objectsOnly,
    files,
    uploads: objectsOnly ? uploadOrder.filter((file) => file !== manifestKey) : uploadOrder,
  };
}

/** Phase 1: put every object up, verifying — rather than re-uploading — the ones a finalize pass finds. */
async function uploadObjects(context: UploadContext, plan: UploadPlan): Promise<void> {
  for (const relativePath of plan.uploads) {
    const bytes = await readFile(join(context.outputDirectory, relativePath));
    if (plan.allowExisting && (await objectExists(context.client, relativePath))) {
      const remote = await getObject(context.client, relativePath);
      if (!bytesEqual(bytes, remote)) {
        throw new Error(
          `OSS object mismatch: ${relativePath} is up but does not match the freshly compiled bytes`,
        );
      }
      context.log(`already present, verified ${relativePath}`);
      continue;
    }
    await putObject(context.client, relativePath, bytes, context.requestTimeoutMs);
    context.log(`uploaded ${relativePath}`);
  }
}

/** Phase 2: every object must read back byte-for-byte identical to what was compiled. */
async function verifyUploadedBytes(
  context: UploadContext,
  files: readonly string[],
): Promise<void> {
  for (const relativePath of files) {
    const local = await readFile(join(context.outputDirectory, relativePath));
    const remote = await getObject(context.client, relativePath);
    if (!bytesEqual(local, remote)) {
      throw new Error(`OSS read-back mismatch: ${relativePath} does not match the uploaded bytes`);
    }
    context.log(`verified ${relativePath}`);
  }
}

/**
 * Phase 3: the public origin must refuse an anonymous GET — the bytes are reachable only through the
 * signed CDN URL. `redirect: "manual"` separates a real refusal from a redirect to a public copy.
 */
async function verifyPrivateOrigin(context: UploadContext, key: string): Promise<void> {
  try {
    const response = await context.fetchImpl(objectOrigin(context.connection, key), {
      method: "GET",
      credentials: "omit",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    await response.body?.cancel();
    if (response.status !== 403 || response.headers.has("location"))
      throw new Error("Origin is not private");
  } catch {
    throw new Error(`Private origin verification failed: ${key}`);
  }
  context.log(`verified private origin ${key}`);
}

/** Phase 4: move `latest`, and put the previous selector back if the move cannot be verified. */
async function activateLatest(context: UploadContext, version: string): Promise<void> {
  const previous = (await objectExists(context.client, LATEST_OBJECT_KEY))
    ? await getObject(context.client, LATEST_OBJECT_KEY)
    : null;
  if (previous) await verifyPrivateOrigin(context, LATEST_OBJECT_KEY);
  context.log(
    previous
      ? `previous latest sha256=${new Bun.CryptoHasher("sha256").update(previous).digest("hex")}`
      : "previous latest: empty bootstrap",
  );

  const writeLatest = async (bytes: Uint8Array): Promise<void> => {
    await putObject(context.client, LATEST_OBJECT_KEY, bytes);
    const readback = await getObject(context.client, LATEST_OBJECT_KEY);
    if (!bytesEqual(bytes, readback)) throw new Error("OSS latest read-back mismatch");
    await verifyPrivateOrigin(context, LATEST_OBJECT_KEY);
  };

  try {
    await writeLatest(new TextEncoder().encode(`${version}\n`));
  } catch {
    try {
      if (previous) {
        await writeLatest(previous);
      } else {
        try {
          await context.client.delete(LATEST_OBJECT_KEY);
        } catch (error) {
          throw ossError("delete", LATEST_OBJECT_KEY, error);
        }
        if (await objectExists(context.client, LATEST_OBJECT_KEY)) {
          throw new Error("could not restore empty selector");
        }
      }
    } catch {
      throw new Error(
        "Release activation failed; rollback could not be verified. Inspect staging before another publish.",
      );
    }
    throw new Error("Release activation failed; previous latest restored and verified.");
  }
}

export async function uploadReleaseTree(
  outputDirectory: string,
  tree: ReleaseTree,
  options: UploadOptions,
): Promise<UploadResult> {
  const context: UploadContext = {
    client: options.client,
    connection: options.connection,
    fetchImpl: options.fetchImpl ?? fetch,
    log: options.log ?? ((): void => undefined),
    outputDirectory,
    ...(options.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
  };
  const plan = planUpload(tree, options);
  // A finalize pass is publishing a version the feed has already seen, so it must not assert.
  if (!plan.allowExisting)
    await assertVersionIsUnpublished(tree.version, { client: context.client });

  await uploadObjects(context, plan);
  await verifyUploadedBytes(context, plan.files);
  for (const key of plan.files) {
    await verifyPrivateOrigin(context, key);
  }
  // Objects-only publication: stop before touching `latest`. See `UploadOptions.activate`.
  if (plan.objectsOnly) {
    context.log(
      `uploaded ${plan.files.length} objects; manifest and latest left to the finalize job`,
    );
    return { uploaded: [...plan.files], latestKey: LATEST_OBJECT_KEY };
  }

  await activateLatest(context, tree.version);
  return { uploaded: [...tree.files], latestKey: LATEST_OBJECT_KEY };
}

/* -------------------------------------------------------------------------------------------- */
/* Orchestration: compile every target, build the tree, upload it (or dry-run it)                */
/* -------------------------------------------------------------------------------------------- */

export const DEFAULT_BUCKET = "coforge-releases-staging";
export const DEFAULT_ENDPOINT = "oss-cn-beijing.aliyuncs.com";

/** Routine publications include every supported OS/architecture. Explicit --targets remains
 * available for local build fixtures; the staging workflow uses this complete default. */
export const DEFAULT_TARGETS: ReleaseTarget[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
  "windows-arm64",
];

export type CompileFn = typeof compileTargetArtifacts;

export interface PublishOptions {
  version: string;
  commit: string;
  feedUrl: string;
  targets: ReleaseTarget[];
  bucket: string;
  endpoint: string;
  /** Finalize an already-uploaded version (see `UploadOptions.allowExisting`). */
  allowExisting?: boolean;
  /** Objects-only publication (see `UploadOptions.activate`): upload and verify this version's
   * objects, leave `latest` alone. What each per-platform job does when the publication is split so
   * a slow link no longer has to move ~186 MB inside one job's timeout. */
  activate?: boolean;
  /** Overrides the region derived from `endpoint`; required for endpoints that do not name one. */
  region?: string;
  dryRun: boolean;
}

export type ResolvePhotonWasmFn = typeof resolvePhotonWasmBytes;

export interface PublishDependencies {
  compile?: CompileFn;
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  /** Static credentials for tests; a real publish resolves them from the Alibaba Cloud default
   * credential chain instead (GitHub OIDC in CI, an AccessKey pair locally) - see
   * `createOssClient`. Ignored for `--dry-run`, which needs no credentials at all. */
  credentials?: OssCredentials;
  /** Overrides `cname`/`secure` (and, for tests, `endpoint`) so requests hit a local fixture
   * server instead of the real bucket; `bucket`/`endpoint` otherwise default to
   * `options.bucket`/`options.endpoint` over HTTPS. */
  connection?: Partial<OssConnection>;
  /** Resolves Pi's photon_rs_bg.wasm bytes; defaults to the real installed-dependency walk in
   * photon-wasm.ts. Tests override this with a fixture so they never depend on the exact
   * installed @silvia-odwyer/photon-node version. */
  resolvePhotonWasm?: ResolvePhotonWasmFn;
}

export interface PublishOutcome {
  version: string;
  dryRun: boolean;
  /** Every object published (or, for a dry run, that would be published) under `<version>/`,
   * excluding `latest`. */
  files: string[];
  latestKey: string;
}

export async function runPublish(
  options: PublishOptions,
  deps: PublishDependencies = {},
): Promise<PublishOutcome> {
  const compile = deps.compile ?? compileTargetArtifacts;
  const resolvePhotonWasm = deps.resolvePhotonWasm ?? resolvePhotonWasmBytes;
  const log = deps.log ?? ((): void => undefined);

  // Resolve credentials before compiling. In CI the credential chain exchanges a GitHub OIDC
  // token for an STS token, and that OIDC token is only valid for minutes, while compiling six
  // targets takes longer than that; the STS token it yields lasts the role's session (1 hour),
  // which comfortably covers the rest of the publish. A dry run never touches the network.
  const connection: OssConnection = {
    bucket: options.bucket,
    endpoint: options.endpoint,
    region: options.region,
    cname: false,
    secure: true,
    ...deps.connection,
  };
  const client = options.dryRun ? null : await createOssClient(connection, deps.credentials);

  const workDirectory = await mkdtemp(join(tmpdir(), "coforge-release-publish-"));
  try {
    const artifacts: Record<string, { computer: Uint8Array }> = {};
    // Compile sequentially to bound memory use across targets.
    for (const target of options.targets) {
      log(`compiling ${target}...`);
      artifacts[target] = await compile({
        target,
        version: options.version,
        feedUrl: options.feedUrl,
        outputDirectory: join(workDirectory, "compile", target),
      });
    }

    log("resolving Pi's image library (photon_rs_bg.wasm)...");
    const photonWasm = await resolvePhotonWasm();

    const inputs: ReleaseInputs = {
      version: options.version,
      commit: options.commit,
      buildDate: new Date().toISOString(),
      photonWasm,
      artifacts,
    };
    const treeDirectory = join(workDirectory, "tree");
    const tree = await buildReleaseTree(inputs, treeDirectory);

    if (options.dryRun || client === null) {
      log("dry run: no network calls made. Objects that would be published:");
      for (const file of tree.files) log(`  ${file}`);
      log(`  ${LATEST_OBJECT_KEY} (-> ${tree.version})`);
      return {
        version: tree.version,
        dryRun: true,
        files: tree.files,
        latestKey: LATEST_OBJECT_KEY,
      };
    }

    const result = await uploadReleaseTree(treeDirectory, tree, {
      client,
      connection,
      fetchImpl: deps.fetchImpl,
      log,
      ...(options.activate === false ? { activate: false } : {}),
      ...(options.allowExisting === true ? { allowExisting: true } : {}),
    });
    log(`published ${result.uploaded.length} objects and ${result.latestKey} -> ${tree.version}`);
    return {
      version: tree.version,
      dryRun: false,
      files: result.uploaded,
      latestKey: result.latestKey,
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------------------------- */
/* CLI                                                                                            */
/* -------------------------------------------------------------------------------------------- */

interface ParsedArgs {
  version?: string;
  commit?: string;
  feedUrl?: string;
  targets?: string;
  bucket?: string;
  endpoint?: string;
  region?: string;
  dryRun: boolean;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgv(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--no-activate":
        result.activate = false;
        break;
      case "--allow-existing":
        result.allowExisting = true;
        break;
      case "--version":
        result.version = requireValue(argv, (index += 1), flag);
        break;
      case "--commit":
        result.commit = requireValue(argv, (index += 1), flag);
        break;
      case "--feed-url":
        result.feedUrl = requireValue(argv, (index += 1), flag);
        break;
      case "--targets":
        result.targets = requireValue(argv, (index += 1), flag);
        break;
      case "--bucket":
        result.bucket = requireValue(argv, (index += 1), flag);
        break;
      case "--endpoint":
        result.endpoint = requireValue(argv, (index += 1), flag);
        break;
      case "--region":
        result.region = requireValue(argv, (index += 1), flag);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return result;
}

export function parseTargets(raw: string | undefined): ReleaseTarget[] {
  const values = (raw ?? DEFAULT_TARGETS.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    throw new Error("--targets must name at least one release target");
  }
  for (const value of values) {
    if (!isReleaseTarget(value)) throw new Error(`unsupported release target: ${value}`);
  }
  return values as ReleaseTarget[];
}

async function currentGitCommit(): Promise<string> {
  const result = Bun.spawnSync({ cmd: ["git", "rev-parse", "HEAD"] });
  const sha = result.stdout.toString().trim();
  if (result.exitCode !== 0 || sha.length === 0) {
    throw new Error("could not determine the current git commit; pass --commit explicitly");
  }
  return sha;
}

export type CliDependencies = Omit<PublishDependencies, "log">;

export async function runCli(argv: string[], deps: CliDependencies = {}): Promise<number> {
  try {
    const args = parseArgv(argv);
    if (!args.version) throw new Error("--version is required");
    if (!isValidReleaseVersion(args.version)) {
      throw new Error(`--version must be a valid version string: ${args.version}`);
    }
    if (!args.feedUrl) throw new Error("--feed-url is required");
    if (!args.feedUrl.startsWith("https://")) {
      throw new Error("--feed-url must be an https:// URL");
    }
    const commit = args.commit ?? (await currentGitCommit());
    const options: PublishOptions = {
      version: args.version,
      commit,
      feedUrl: args.feedUrl,
      targets: parseTargets(args.targets),
      bucket: args.bucket ?? DEFAULT_BUCKET,
      endpoint: args.endpoint ?? DEFAULT_ENDPOINT,
      region: args.region,
      dryRun: args.dryRun,
    };
    // console.log/console.error, not the injected `deps`, are the actual "script stdout/stderr":
    // this is what publish.test.ts's credential-leak test captures and asserts against.
    await runPublish(options, { ...deps, log: (line) => console.log(line) });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`publish failed: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
