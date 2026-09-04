#!/usr/bin/env bun
/**
 * Publishes one Computer/Daemon release version to the local-distribution feed on Alibaba Cloud
 * OSS: compile every target, assemble the version tree (build-release.ts), upload every object
 * it lists, read each one back and compare bytes, and only then write the feed's mutable
 * `latest` pointer - in that fixed order. docs/release.md ("Local Computer distribution model"):
 * "`latest` is the feed's only mutable object, and it is written last - every object under the
 * new `<version>/` it will point to is uploaded and verified first. A publish that fails partway
 * through therefore leaves at most an unreferenced version directory; `latest` never points at
 * incomplete or missing objects."
 *
 * Upload happens over OSS's plain HTTP API, signed by hand (Authorization-header V1 signature),
 * deliberately without the `ossutil` CLI or the Alibaba Cloud SDK - see AGENTS.md's "no new
 * runtime dependency" and the CR description for why a ~40-line HMAC-SHA1 signer was preferred
 * over a new dependency for two verbs (PUT, GET).
 */
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildReleaseTree,
  isValidReleaseVersion,
  type ReleaseInputs,
  type ReleaseTree,
} from "./build-release";
import { compileTargetArtifacts, isReleaseTarget, type ReleaseTarget } from "./compile-targets";

/* -------------------------------------------------------------------------------------------- */
/* Alibaba Cloud OSS V1 "Authorization header" signature                                         */
/* -------------------------------------------------------------------------------------------- */
// https://www.alibabacloud.com/help/en/oss/developer-reference/include-signatures-in-the-authorization-header
//   StringToSign = VERB + "\n" + Content-MD5 + "\n" + Content-Type + "\n" + Date + "\n"
//                + CanonicalizedOSSHeaders + CanonicalizedResource
// This script never sends Content-MD5 or any x-oss-* request header, so the Content-MD5 slot and
// CanonicalizedOSSHeaders are always empty - only Content-Type, Date, and the resource vary.
// CanonicalizedResource is "/" + bucket + "/" + objectKey regardless of whether the request URL
// itself is virtual-hosted or path style, which is what lets the URL-building step below stay
// swappable for tests without touching the signature at all.

export interface OssCredentials {
  accessKeyId: string;
  accessKeySecret: string;
}

/** OSS's StringToSign "Date" component is an RFC 1123 / HTTP-date string, exactly what
 * `Date.prototype.toUTCString()` already produces (e.g. "Tue, 01 Sep 2026 00:00:00 GMT").
 * Verified empirically against Bun 1.4.0's `fetch`: unlike a browser's `fetch`, it does not
 * silently drop a hand-set `Date` request header (the WHATWG Fetch forbidden-header list, which
 * would strip it, applies to browser contexts) - see the CR description for the reproduction. */
function ossDate(now: Date): string {
  return now.toUTCString();
}

function canonicalizedResource(bucket: string, objectKey: string): string {
  return `/${bucket}/${objectKey}`;
}

export function ossStringToSign(options: {
  method: "PUT" | "GET";
  bucket: string;
  objectKey: string;
  date: string;
  contentType: string;
}): string {
  return [
    options.method,
    "", // Content-MD5: never sent by this script.
    options.contentType,
    options.date,
    canonicalizedResource(options.bucket, options.objectKey),
  ].join("\n");
}

export function ossSignature(accessKeySecret: string, stringToSign: string): string {
  return createHmac("sha1", accessKeySecret).update(stringToSign, "utf8").digest("base64");
}

export function ossAuthorizationHeader(credentials: OssCredentials, stringToSign: string): string {
  return `OSS ${credentials.accessKeyId}:${ossSignature(credentials.accessKeySecret, stringToSign)}`;
}

/** The only diagnostic a failed OSS call is allowed to surface: an HTTP status, the object key,
 * and OSS's own request id. It deliberately excludes every request header (Authorization above
 * all) and the response body - a real OSS `SignatureDoesNotMatch` error body echoes back
 * `StringToSign`, the supplied `Signature`, and the `AccessKeyId`, so printing it would leak
 * exactly the material this function exists to protect. See publish.test.ts's credential-leak
 * test, which fails if this function is changed to include either. */
function ossError(action: string, objectKey: string, response: Response): Error {
  const requestId = response.headers.get("x-oss-request-id") ?? "unknown";
  return new Error(
    `OSS ${action} failed: HTTP ${response.status} ${objectKey} request-id=${requestId}`,
  );
}

/* -------------------------------------------------------------------------------------------- */
/* Upload primitives                                                                             */
/* -------------------------------------------------------------------------------------------- */

export interface OssTarget {
  bucket: string;
  /** Builds the request URL for one object key. Production always uses Alibaba Cloud OSS's
   * virtual-hosted-style endpoint (`https://<bucket>.<endpoint>/<key>`) - OSS's own domain-name
   * documentation describes only this style, not a path-style alternative, so this script does
   * not treat the two as interchangeable. Tests instead point this at a local fixture server;
   * `canonicalizedResource` above is identical either way, so nothing about the signature
   * depends on which URL shape is in play. */
  objectUrl: (objectKey: string) => string;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

async function putObject(
  target: OssTarget,
  objectKey: string,
  bytes: Uint8Array,
  credentials: OssCredentials,
  date: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const contentType = "application/octet-stream";
  const stringToSign = ossStringToSign({
    method: "PUT",
    bucket: target.bucket,
    objectKey,
    date,
    contentType,
  });
  const response = await fetchImpl(target.objectUrl(objectKey), {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      Date: date,
      Authorization: ossAuthorizationHeader(credentials, stringToSign),
    },
    body: bytes,
  });
  await response.body?.cancel();
  if (!response.ok) throw ossError("upload", objectKey, response);
}

async function getObject(
  target: OssTarget,
  objectKey: string,
  credentials: OssCredentials,
  date: string,
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  const stringToSign = ossStringToSign({
    method: "GET",
    bucket: target.bucket,
    objectKey,
    date,
    contentType: "",
  });
  const response = await fetchImpl(target.objectUrl(objectKey), {
    method: "GET",
    headers: { Date: date, Authorization: ossAuthorizationHeader(credentials, stringToSign) },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw ossError("read-back", objectKey, response);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export const LATEST_OBJECT_KEY = "latest";

export interface UploadOptions {
  target: OssTarget;
  credentials: OssCredentials;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
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
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((): void => undefined);

  for (const relativePath of tree.files) {
    const bytes = await readFile(join(outputDirectory, relativePath));
    await putObject(
      options.target,
      relativePath,
      bytes,
      options.credentials,
      ossDate(now()),
      fetchImpl,
    );
    log(`uploaded ${relativePath}`);
  }

  for (const relativePath of tree.files) {
    const local = await readFile(join(outputDirectory, relativePath));
    const remote = await getObject(
      options.target,
      relativePath,
      options.credentials,
      ossDate(now()),
      fetchImpl,
    );
    if (!bytesEqual(local, remote)) {
      throw new Error(`OSS read-back mismatch: ${relativePath} does not match the uploaded bytes`);
    }
    log(`verified ${relativePath}`);
  }

  const latestBytes = new TextEncoder().encode(`${tree.version}\n`);
  await putObject(
    options.target,
    LATEST_OBJECT_KEY,
    latestBytes,
    options.credentials,
    ossDate(now()),
    fetchImpl,
  );
  log(`uploaded ${LATEST_OBJECT_KEY}`);

  const latestReadback = await getObject(
    options.target,
    LATEST_OBJECT_KEY,
    options.credentials,
    ossDate(now()),
    fetchImpl,
  );
  if (!bytesEqual(latestBytes, latestReadback)) {
    throw new Error(
      `OSS read-back mismatch: ${LATEST_OBJECT_KEY} does not match the published version`,
    );
  }
  log(`verified ${LATEST_OBJECT_KEY}`);

  return { uploaded: [...tree.files], latestKey: LATEST_OBJECT_KEY };
}

/* -------------------------------------------------------------------------------------------- */
/* Orchestration: compile every target, build the tree, upload it (or dry-run it)                */
/* -------------------------------------------------------------------------------------------- */

export const DEFAULT_BUCKET = "coforge-releases-staging";
export const DEFAULT_ENDPOINT = "oss-cn-beijing.aliyuncs.com";

/** The default `--targets` value when the flag is omitted: the four POSIX targets. This is a
 * fixed part of this script's specification, not derived from docs/release.md, whose "Main to
 * staging" step 2 requires "the complete Windows, Linux, and macOS platform matrix" (six
 * targets, including `windows-x64`/`windows-arm64`). `.github/workflows/release-staging.yml`
 * uses this same default rather than overriding it, so a real staging publish through that
 * workflow does not yet ship Windows binaries. This is flagged as an open docs/spec mismatch in
 * the CR description, not silently resolved here - packages/daemon's control channel is a Unix
 * domain socket and its win32 behavior has not been verified in this change. */
export const DEFAULT_TARGETS: ReleaseTarget[] = [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
];

export type CompileFn = typeof compileTargetArtifacts;

export interface PublishOptions {
  version: string;
  commit: string;
  feedUrl: string;
  targets: ReleaseTarget[];
  bucket: string;
  endpoint: string;
  /** Required unless `dryRun` is set. */
  credentials?: OssCredentials;
  dryRun: boolean;
}

export interface PublishDependencies {
  compile?: CompileFn;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
  /** Overrides how an object key becomes a request URL; defaults to the real virtual-hosted OSS
   * endpoint. Tests point this at a local fixture server instead of reaching the network. */
  objectUrl?: (objectKey: string) => string;
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

  const workDirectory = await mkdtemp(join(tmpdir(), "coforge-release-publish-"));
  try {
    const artifacts: Record<string, { computer: Uint8Array; daemon: Uint8Array }> = {};
    // Sequential rather than Promise.all: see compile-targets.ts's own doc comment on why two
    // concurrent cold cross-compile toolchain downloads for the same bun-<os>-<arch> target is a
    // failure mode worth avoiding, which applies equally across targets on a runner with no warm
    // cache for any of them.
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

    if (options.dryRun) {
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

    if (!options.credentials) {
      throw new Error(
        "ALIYUN_OSS_ACCESS_KEY_ID and ALIYUN_OSS_ACCESS_KEY_SECRET are required unless --dry-run is set",
      );
    }

    const target: OssTarget = {
      bucket: options.bucket,
      objectUrl:
        deps.objectUrl ??
        ((objectKey) => `https://${options.bucket}.${options.endpoint}/${objectKey}`),
    };
    const result = await uploadReleaseTree(treeDirectory, tree, {
      target,
      credentials: options.credentials,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
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

function requireCredentials(): OssCredentials {
  const accessKeyId = process.env.ALIYUN_OSS_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_OSS_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) {
    throw new Error(
      "ALIYUN_OSS_ACCESS_KEY_ID and ALIYUN_OSS_ACCESS_KEY_SECRET must be set (or pass --dry-run)",
    );
  }
  return { accessKeyId, accessKeySecret };
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
    const credentials = args.dryRun ? undefined : requireCredentials();
    const options: PublishOptions = {
      version: args.version,
      commit,
      feedUrl: args.feedUrl,
      targets: parseTargets(args.targets),
      bucket: args.bucket ?? DEFAULT_BUCKET,
      endpoint: args.endpoint ?? DEFAULT_ENDPOINT,
      credentials,
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
