import { createHash } from "node:crypto";

import { readEnvSecret } from "./env-secret.server";

/**
 * Private CDN delivery for immutable object keys (chat attachment images today). Bytes still
 * live in `FileStorage`; this port signs a short-lived HTTPS URL on a CDN domain that fronts the
 * private OSS bucket so the browser can be redirected straight to it instead of the backend
 * proxying every byte. See docs/architecture.md ("Private CDN adapter") and
 * docs/operations/aliyun-oss-cdn.md §5.3/§10. A signed URL is a bearer credential like any other
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
 * docs/operations/aliyun-oss-cdn.md §10); the console must stay at its default of 1800 seconds.
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

export function readFileDeliveryConfig(env: NodeJS.ProcessEnv): FileDeliveryConfig {
  const rawUrl = env.COFORGE_FILE_DELIVERY_URL?.trim();
  if (!rawUrl) return null;
  const baseUrl = normalizeBaseUrl(rawUrl);
  assertNotApplicationOrigin(baseUrl, env);
  const key = readEnvSecret(env, "COFORGE_FILE_DELIVERY_KEY", (message) => {
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
 * already has to name this deployment's public origin. Without it there is nothing to compare, and
 * the browser makes the same check again before it frames anything (`attachmentPreviewKind`).
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
  | { state: "error"; errorType: string };

let current: { delivery: FileDelivery | null; status: FileDeliveryStatus } | undefined;

/**
 * The process-wide delivery selected by the environment, memoised like `getFileStorage`.
 * A configuration error is memoised too, logged once, and rethrown so callers can decide
 * whether to degrade; `fileDeliveryStatus()` reports it without the caller having to catch.
 */
export function getFileDelivery(): FileDelivery | null {
  return resolveFileDelivery().delivery;
}

/** Whether signed CDN delivery is configured, disabled, or failing to load (no secret values). */
export function fileDeliveryStatus(): FileDeliveryStatus {
  return resolveFileDelivery().status;
}

function resolveFileDelivery() {
  if (current) return current;
  try {
    const delivery = createFileDelivery(readFileDeliveryConfig(process.env));
    current = { delivery, status: { state: delivery ? "configured" : "disabled" } };
  } catch (error) {
    const errorType = error instanceof Error ? error.name : typeof error;
    // Message text may name a file path; the type alone says whether the secret is the problem.
    console.error(JSON.stringify({ event: "file_delivery_unavailable", errorType }));
    current = { delivery: null, status: { state: "error", errorType } };
  }
  return current;
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
