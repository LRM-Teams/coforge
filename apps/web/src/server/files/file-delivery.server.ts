import { createHash } from "node:crypto";

import { readEnvSecret } from "./env-secret.server";

/**
 * Private CDN delivery for immutable object keys (chat attachment images today). Bytes still
 * live in `FileStorage`; this port signs a short-lived HTTPS URL on a CDN domain that fronts the
 * private OSS bucket so the browser can be redirected straight to it instead of the backend
 * proxying every byte. See
 * docs/operations/aliyun-oss-cdn/cdn-domains.md (§5.3) and staging-record.md (§10). A signed URL is a bearer credential like any other
 * presigned URL: callers must never log it.
 *
 * Env:
 * - `COFORGE_FILE_DELIVERY_URL` — the CDN base origin, e.g. `https://files-staging.coforge.cn`.
 *   Must be `https:` with no path, query, or hash; exactly one trailing slash is normalised away
 *   and anything else is rejected. Unset disables delivery entirely: `getFileDelivery()` returns
 *   `null` and callers keep the existing proxy path.
 * - `COFORGE_FILE_DELIVERY_KEY` / `COFORGE_FILE_DELIVERY_KEY_FILE` — the CDN's Type A URL-auth
 *   primary key (the Alibaba Cloud CDN console's 鉴权URL设置), read with the same inline-or-
 *   Docker-secret-file convention as `file-storage.server.ts`. This is not an OSS credential. If
 *   the URL is set but the key is missing, the first use logs `file_delivery_unavailable` with the
 *   error type, `/health` reports it, and delivery degrades to the proxy path so chat keeps working.
 *
 * The signed URL's TTL is not configurable: it is the fixed {@link FILE_DELIVERY_TTL_SECONDS},
 * which must equal the Alibaba Cloud CDN console's 鉴权URL有效时长 for the delivery domain (see
 * docs/operations/aliyun-oss-cdn/staging-record.md §10); the console must stay at its default of 1800 seconds.
 */
export interface FileDelivery {
  /** Signed, short-lived HTTPS URL for exactly this object key. */
  signedUrl(objectKey: string, now?: Date): { url: string; expiresAt: Date };
}

/** The Alibaba Cloud CDN console's default 鉴权URL有效时长; the console must stay at this value. */
export const FILE_DELIVERY_TTL_SECONDS = 1800;

export type FileDeliveryConfig = { baseUrl: string; key: string } | null;

export class FileDeliveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileDeliveryConfigError";
  }
}

export async function readFileDeliveryConfig(env: NodeJS.ProcessEnv): Promise<FileDeliveryConfig> {
  const rawUrl = env.COFORGE_FILE_DELIVERY_URL?.trim();
  if (!rawUrl) return null;
  const baseUrl = normalizeBaseUrl(rawUrl);
  assertNotApplicationOrigin(baseUrl, env);
  const key = await readEnvSecret(env, "COFORGE_FILE_DELIVERY_KEY", (message) => {
    throw new FileDeliveryConfigError(message);
  });
  if (!key) {
    throw new FileDeliveryConfigError(
      "COFORGE_FILE_DELIVERY_KEY is required when COFORGE_FILE_DELIVERY_URL is set",
    );
  }
  return { baseUrl, key };
}

/**
 * Delivery must be a different origin from the application.
 *
 * Signed delivery URLs carry attachment bytes the sender chose, and some of them are rendered as
 * documents rather than images (a PDF in the browser's own viewer). On a separate origin such a
 * document reaches none of this application's cookies; on this application's own origin it would
 * reach all of them, which inverts the reason those types are refused inline from here. A
 * deployment that points delivery at the app's own host is therefore refused rather than trusted:
 * `getFileDelivery` turns this error into the disabled state, so attachments fall back to the
 * authenticated backend route, which serves every non-image as an opaque download.
 *
 * The application origin is taken from the configured OAuth redirect URI, the one setting that
 * already has to name this deployment's public origin. `AUTHING_REDIRECT_URI` is optional — the
 * auth config otherwise derives the callback from the request — so a deployment can reach here
 * with nothing to compare, and this check then permits the delivery URL. That is why it is not the
 * only gate: `isFrameableDocumentUrl` refuses a same-origin document in the browser, and refuses
 * one outright wherever no page origin is known, so the frame is never emitted on a check that did
 * not run. A same-origin misconfiguration in such a deployment loses the PDF preview (the
 * attachment stays a download) instead of framing a sender's document on the cookie-bearing host.
 */
function assertNotApplicationOrigin(baseUrl: string, env: NodeJS.ProcessEnv): void {
  const redirectUri = env.AUTHING_REDIRECT_URI?.trim();
  if (!redirectUri) return;
  let applicationOrigin: string;
  try {
    applicationOrigin = new URL(redirectUri).origin;
  } catch {
    return;
  }
  if (new URL(baseUrl).origin !== applicationOrigin) return;
  throw new FileDeliveryConfigError(
    "COFORGE_FILE_DELIVERY_URL must not be the application's own origin",
  );
}

function normalizeBaseUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FileDeliveryConfigError("COFORGE_FILE_DELIVERY_URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new FileDeliveryConfigError("COFORGE_FILE_DELIVERY_URL must use https");
  }
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new FileDeliveryConfigError(
      "COFORGE_FILE_DELIVERY_URL must not have a path, query, or hash",
    );
  }
  return `${url.protocol}//${url.host}`;
}

export type FileDeliveryStatus =
  | { state: "configured" }
  | { state: "disabled" }
  | { state: "unavailable" }
  | { state: "error"; errorType: string };

let current: { delivery: FileDelivery | null; status: FileDeliveryStatus } | undefined;
let publishedEnv: DeliveryEnvSnapshot | undefined;

/**
 * The process-wide delivery selected by the environment, memoised like `getFileStorage`.
 * A configuration error is memoised too, logged once, and reported as `error` so callers can
 * degrade; `fileDeliveryStatus()` reports it without the caller having to catch.
 *
 * Startup awaits `readFileDeliveryConfig` and `rememberFileDeliveryConfig` before accepting
 * requests. Later lookups observe that result. Inline configuration can be resolved without a
 * file read; a secret file is never read from the request path.
 */
export function getFileDelivery(): FileDelivery | null {
  return resolveFileDelivery().delivery;
}

/**
 * Whether signed CDN delivery is configured, disabled, unpublished, or failing to load
 * (no secret values). `unavailable` means a secret file is configured but startup has not
 * published it yet; it is not the same as an unset CDN URL.
 */
export function fileDeliveryStatus(): FileDeliveryStatus {
  return resolveFileDelivery().status;
}

/** Publishes a config already read at startup so request paths do not read the secret again. */
export function rememberFileDeliveryConfig(config: FileDeliveryConfig): FileDeliveryStatus {
  publishedEnv = deliveryEnvSnapshot(process.env);
  try {
    const delivery = createFileDelivery(config);
    current = { delivery, status: { state: delivery ? "configured" : "disabled" } };
  } catch (error) {
    current = { delivery: null, status: deliveryErrorStatus(error) };
  }
  return current.status;
}

function resolveFileDelivery(): { delivery: FileDelivery | null; status: FileDeliveryStatus } {
  if (current && sameDeliveryEnv(publishedEnv, process.env)) return current;
  const inline = inlineFileDeliveryConfig(process.env);
  // A `*_FILE` secret is read once at startup. Until that result is published, report it as
  // unpublished rather than as CDN-off, and do not start a second read from the request path.
  if ("pending" in inline) return { delivery: null, status: { state: "unavailable" } };
  const status = rememberFileDeliveryConfig(inline.config);
  return current ?? { delivery: null, status };
}

type DeliveryEnvSnapshot = {
  url: string | undefined;
  key: string | undefined;
  keyFile: string | undefined;
  redirectUri: string | undefined;
};

function deliveryEnvSnapshot(env: NodeJS.ProcessEnv): DeliveryEnvSnapshot {
  return {
    url: env.COFORGE_FILE_DELIVERY_URL,
    key: env.COFORGE_FILE_DELIVERY_KEY,
    keyFile: env.COFORGE_FILE_DELIVERY_KEY_FILE,
    redirectUri: env.AUTHING_REDIRECT_URI,
  };
}

function sameDeliveryEnv(
  remembered: DeliveryEnvSnapshot | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!remembered) return false;
  const currentEnv = deliveryEnvSnapshot(env);
  return (
    remembered.url === currentEnv.url &&
    remembered.key === currentEnv.key &&
    remembered.keyFile === currentEnv.keyFile &&
    remembered.redirectUri === currentEnv.redirectUri
  );
}

/** Inline secrets only. `pending` means startup still has to read a secret file. */
function inlineFileDeliveryConfig(
  env: NodeJS.ProcessEnv,
): { config: FileDeliveryConfig } | { pending: true } {
  const rawUrl = env.COFORGE_FILE_DELIVERY_URL?.trim();
  if (!rawUrl) return { config: null };
  if (env.COFORGE_FILE_DELIVERY_KEY?.trim() && env.COFORGE_FILE_DELIVERY_KEY_FILE?.trim()) {
    throw new FileDeliveryConfigError(
      "COFORGE_FILE_DELIVERY_KEY and COFORGE_FILE_DELIVERY_KEY_FILE cannot both be set",
    );
  }
  if (env.COFORGE_FILE_DELIVERY_KEY_FILE?.trim()) return { pending: true };
  const baseUrl = normalizeBaseUrl(rawUrl);
  assertNotApplicationOrigin(baseUrl, env);
  const key = env.COFORGE_FILE_DELIVERY_KEY?.trim();
  if (!key) {
    throw new FileDeliveryConfigError(
      "COFORGE_FILE_DELIVERY_KEY is required when COFORGE_FILE_DELIVERY_URL is set",
    );
  }
  return { config: { baseUrl, key } };
}

function deliveryErrorStatus(error: unknown): FileDeliveryStatus {
  const errorType = error instanceof Error ? error.name : typeof error;
  // Message text may name a file path; the type alone says whether the secret is the problem.
  console.error(JSON.stringify({ event: "file_delivery_unavailable", errorType }));
  return { state: "error", errorType };
}

export function createFileDelivery(config: FileDeliveryConfig): FileDelivery | null {
  if (!config) return null;
  return new CdnTypeAFileDelivery(config);
}

/**
 * Alibaba Cloud CDN "Type A" signed URL
 * (help.aliyun.com/zh/cdn/user-guide/type-a-signing):
 *
 *   https://<domain>/<uri>?auth_key=<timestamp>-<rand>-<uid>-<md5hex>
 *   md5hex = md5("<uri>-<timestamp>-<rand>-<uid>-<PrivateKey>")
 *
 * `uri` is the path portion only (`/` + the object key), with every path segment run through
 * `encodeURIComponent` before it is used in either the hash input or the URL, so the hash is
 * always over exactly the string the CDN edge will see. `uid` is always `0`. `rand` defaults to
 * a random UUID with the dashes stripped, but can be injected for deterministic tests.
 */
export class CdnTypeAFileDelivery implements FileDelivery {
  constructor(
    private readonly config: Extract<FileDeliveryConfig, object>,
    private readonly randomToken: () => string = () => crypto.randomUUID().replace(/-/g, ""),
  ) {}

  signedUrl(objectKey: string, now: Date = new Date()): { url: string; expiresAt: Date } {
    const uri = `/${objectKey
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
    const timestamp = Math.floor(now.getTime() / 1000);
    const rand = this.randomToken();
    const uid = "0";
    const sstring = `${uri}-${timestamp}-${rand}-${uid}-${this.config.key}`;
    const md5hex = createHash("md5").update(sstring).digest("hex");
    const authKey = `${timestamp}-${rand}-${uid}-${md5hex}`;
    return {
      url: `${this.config.baseUrl}${uri}?auth_key=${authKey}`,
      expiresAt: new Date((timestamp + FILE_DELIVERY_TTL_SECONDS) * 1000),
    };
  }
}
