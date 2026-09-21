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
 * or undefined for any other host (a fixture server, a custom domain). */
export function regionFromEndpoint(endpoint: string): string | undefined {
  const host = endpoint.replace(/^https?:\/\//i, "").replace(/[/:].*$/, "");
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
/** A publish uploads whole platform bundles over a shared runner link; 60s (ali-oss's default) is
 * an interactive request's budget, not this job's. See `createOssClient`. */
const PUBLISH_OBJECT_TIMEOUT_MS = 10 * 60 * 1000;

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
    // ali-oss defaults every request to a 60s timeout, which is an interactive caller's budget. A
    // publish is a batch job: it compiles six targets and then pushes the largest bundles over the
    // runner's link, and the biggest of them (darwin-arm64) has now failed with `OSS upload failed:
    // HTTP unknown ... request-id=unknown` — a transport failure with no HTTP status, which is what a
    // timeout looks like — in three consecutive builds (dev.59, dev.60, dev.61). Give it room.
    timeout: PUBLISH_OBJECT_TIMEOUT_MS,
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
 * killed it with a `ResponseTimeoutError` (a `name`-only error, no status/code/request-id). */
const MULTIPART_MIN_BYTES = 20 * 1024 * 1024;
/** Per-part size for multipart uploads. A 28 MiB binary splits into ~4 parts, each of which is its
 * own signed request with its own timeout, so even a degraded link completes one part well under
 * the 60 s window and ali-oss retries a part that does time out instead of failing the whole
 * object. */
const MULTIPART_PART_BYTES = 2 * 1024 * 1024;
// 8 MiB was not small enough: dev.64 died at ~89 s with `ResponseTimeoutError` on this object's
// *first* part, i.e. a single 8 MiB request did not clear the 60 s window on that link. The objects
// that upload reliably are a few megabytes, so a part is now that size - the same 60 s window then
// covers four times less data per request.
/** Per-request timeout for each multipart part (and each read-back), in ms. Keeping it explicit
 * makes the per-part timing intent clear: a stalled network times out a single small part, not
 * the whole object, and `ossError` now records the `name` so the log can show `ResponseTimeoutError`. */
const OSS_REQUEST_TIMEOUT_MS = 60_000;

async function putObject(
  client: OSS,
  objectKey: string,
  bytes: Uint8Array,
  requestTimeoutMs: number = OSS_REQUEST_TIMEOUT_MS,
): Promise<void> {
  const buffer = Buffer.from(bytes);
  try {
    if (buffer.byteLength >= MULTIPART_MIN_BYTES) {
      await client.multipartUpload(objectKey, buffer, {
        partSize: MULTIPART_PART_BYTES,
        parallel: 1,
        timeout: requestTimeoutMs,
        headers: { "Content-Type": "application/octet-stream" },
      });
      return;
    }
    await client.put(objectKey, buffer, {
      timeout: requestTimeoutMs,
      headers: { "Content-Type": "application/octet-stream" },
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
  /** Per-request upload timeout in ms. Defaults to `OSS_REQUEST_TIMEOUT_MS` (60 s). Tests pass a
   * small value so a deliberately slow fixture server can prove that a stalled link reports the
   * timeout's name instead of hanging the publish. */
  requestTimeoutMs?: number;
}

export interface UploadResult {
  uploaded: string[];
  latestKey: string;
}

/** Uploads every object under the new version tree, reads each one back and compares its bytes
 * to the local copy, and only then writes the mutable `latest` pointer - see the file banner for
 * why that order matters. Any failure (an upload, a read-back mismatch) throws before `latest`
 * is ever written, and stops uploading/verifying the objects after it. */
export async function uploadReleaseTree(
  outputDirectory: string,
  tree: ReleaseTree,
  options: UploadOptions,
): Promise<UploadResult> {
  const { client, connection } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((): void => undefined);

  await assertVersionIsUnpublished(tree.version, { client });

  // The manifest is pinned last explicitly rather than relying on `tree.files` being sorted:
  // `build-release.ts` sorts the whole list, so "manifest.json" only happens to sort after the
  // POSIX targets, but before Windows. Relying on that order would silently break the
  // completion marker `assertVersionIsUnpublished` depends on.
  const manifestKey = manifestObjectKey(tree.version);
  const manifestFiles = tree.files.filter((file) => file === manifestKey);
  if (manifestFiles.length !== 1) {
    throw new Error(`Release tree does not contain exactly one ${manifestKey} to upload last`);
  }
  const uploadOrder = [...tree.files.filter((file) => file !== manifestKey), manifestKey];

  const requestTimeoutMs = options.requestTimeoutMs ?? OSS_REQUEST_TIMEOUT_MS;
  for (const relativePath of uploadOrder) {
    const bytes = await readFile(join(outputDirectory, relativePath));
    await putObject(client, relativePath, bytes, requestTimeoutMs);
    log(`uploaded ${relativePath}`);
  }

  for (const relativePath of tree.files) {
    const local = await readFile(join(outputDirectory, relativePath));
    const remote = await getObject(client, relativePath);
    if (!bytesEqual(local, remote)) {
      throw new Error(`OSS read-back mismatch: ${relativePath} does not match the uploaded bytes`);
    }
    log(`verified ${relativePath}`);
  }

  async function verifyPrivateOrigin(key: string): Promise<void> {
    try {
      const response = await fetchImpl(objectOrigin(connection, key), {
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
    log(`verified private origin ${key}`);
  }

  for (const key of tree.files) {
    await verifyPrivateOrigin(key);
  }

  const previous = (await objectExists(client, LATEST_OBJECT_KEY))
    ? await getObject(client, LATEST_OBJECT_KEY)
    : null;
  if (previous) await verifyPrivateOrigin(LATEST_OBJECT_KEY);
  log(
    previous
      ? `previous latest sha256=${new Bun.CryptoHasher("sha256").update(previous).digest("hex")}`
      : "previous latest: empty bootstrap",
  );

  async function writeLatest(bytes: Uint8Array): Promise<void> {
    await putObject(client, LATEST_OBJECT_KEY, bytes);
    const readback = await getObject(client, LATEST_OBJECT_KEY);
    if (!bytesEqual(bytes, readback)) throw new Error("OSS latest read-back mismatch");
    await verifyPrivateOrigin(LATEST_OBJECT_KEY);
  }

  try {
    await writeLatest(new TextEncoder().encode(`${tree.version}\n`));
  } catch {
    try {
      if (previous) {
        await writeLatest(previous);
      } else {
        try {
          await client.delete(LATEST_OBJECT_KEY);
        } catch (error) {
          throw ossError("delete", LATEST_OBJECT_KEY, error);
        }
        if (await objectExists(client, LATEST_OBJECT_KEY)) {
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
  /** Overrides the region derived from `endpoint`; required for endpoints that do not name one. */
  region?: string;
  dryRun: boolean;
}

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

    const inputs: ReleaseInputs = {
      version: options.version,
      commit: options.commit,
      buildDate: new Date().toISOString(),
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
