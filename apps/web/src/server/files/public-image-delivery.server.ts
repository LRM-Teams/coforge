/**
 * Public CDN delivery for profile images — user avatars and project icons.
 *
 * These images are addressed by an unguessable, immutable object key and rendered on every
 * message row, member list, and sidebar, so the product treats "holding the URL" as the access
 * check and lets the URL itself never change. That is what makes a profile image cacheable
 * forever by the browser and the edge, and it is the same boundary Discord draws — its avatar and
 * guild-icon CDN endpoints are unsigned and never expire, while attachment URLs carry `ex`/`is`/
 * `hm` signing material — and the one Slack draws between `avatars.slack-edge.com` and a file's
 * `url_private`, which requires a bearer token. Chat attachments keep the signed, expiring
 * delivery in `file-delivery.server.ts`; nothing in this module touches them.
 *
 * Bytes live in their own bucket (`public-image-storage.server.ts`) behind its own accelerated
 * domain, because Alibaba Cloud grants the CDN bucket-wide read per origin and configures URL
 * signing per domain: a domain that serves an unsigned object key can serve every object key in
 * its bucket. One domain, one bucket, one trust zone, as the
 * attachment and release domains already require. See docs/operations/aliyun-oss-cdn/.
 *
 * Env:
 * - `COFORGE_IMAGE_DELIVERY_URL` — the public image CDN origin, e.g.
 *   `https://images-staging.coforge.cn`. Must be `https:` with no path, query, or hash; exactly
 *   one trailing slash is normalised away. It must be neither the signed attachment domain
 *   (which refuses an unsigned request) nor the application's own origin. Unset disables public
 *   delivery: every profile image keeps its authenticated backend route.
 *
 * There is no key and no expiry here. A URL this module returns is world-readable for as long as
 * the object exists.
 */
/**
 * The rendered sizes this product asks the CDN for. An avatar or icon is displayed at at most
 * ~96px (the profile panel) and ~128px (a project header), so shipping the stored original —
 * which may be the full 5 MB an upload is allowed — to every message row is the single largest
 * cost on a chat screen. Both reference products serve sized variants instead: Slack returns
 * `image_24` … `image_1024` per member, Discord takes `?size=` on its avatar and icon endpoints.
 *
 * Each value is an OSS image style defined on the bucket, not a free-form processing expression.
 * A style is a fixed alias, so the set of variants an anonymous domain will ever produce is
 * bounded (an unsigned URL with arbitrary `x-oss-process` parameters is an invitation to burn
 * processing cost), and the bucket's source-image protection can then refuse anything else.
 * These names are part of provisioning: the styles must exist on the image bucket before the
 * domain serves traffic (docs/operations/aliyun-oss-cdn/profile-image-domain.md §11).
 */
export const PROFILE_IMAGE_STYLES = {
  /** Every user avatar, at twice the largest place one is drawn. */
  avatar: "avatar192",
  /** Every project icon. */
  icon: "icon256",
} as const;

export type ProfileImageStyle = (typeof PROFILE_IMAGE_STYLES)[keyof typeof PROFILE_IMAGE_STYLES];

export interface PublicImageDelivery {
  /** The stable public URL for exactly this object key, rendered at the given style. */
  url(objectKey: string, style: ProfileImageStyle): string;
}

export type PublicImageDeliveryConfig = { baseUrl: string } | null;

export class PublicImageDeliveryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicImageDeliveryConfigError";
  }
}

export function readPublicImageDeliveryConfig(env: NodeJS.ProcessEnv): PublicImageDeliveryConfig {
  const rawUrl = env.COFORGE_IMAGE_DELIVERY_URL?.trim();
  if (!rawUrl) return null;
  const baseUrl = normalizeBaseUrl(rawUrl);
  assertNotSignedAttachmentDomain(baseUrl, env);
  assertNotApplicationOrigin(baseUrl, env);
  return { baseUrl };
}

/**
 * The attachment domain has URL signing enabled for the whole domain, so an unsigned profile
 * image URL on it would 403 every avatar. Pointing both at one domain would also mean one bucket
 * for both classes, which is exactly the isolation the one-domain, one-bucket rule keeps.
 */
function assertNotSignedAttachmentDomain(baseUrl: string, env: NodeJS.ProcessEnv): void {
  const signed = env.COFORGE_FILE_DELIVERY_URL?.trim();
  if (!signed) return;
  let signedOrigin: string;
  try {
    signedOrigin = new URL(signed).origin;
  } catch {
    return;
  }
  if (new URL(baseUrl).origin !== signedOrigin) return;
  throw new PublicImageDeliveryConfigError(
    "COFORGE_IMAGE_DELIVERY_URL must not be the signed attachment delivery domain",
  );
}

/**
 * Profile images are served without any access check, so they must not answer on the origin that
 * holds this application's session cookies. The application origin is taken from the configured
 * OAuth redirect URI, the one setting that already has to name this deployment's public origin;
 * a deployment that does not set it reaches here with nothing to compare, and the check permits
 * the URL (see the same reasoning in `file-delivery.server.ts`).
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
  throw new PublicImageDeliveryConfigError(
    "COFORGE_IMAGE_DELIVERY_URL must not be the application's own origin",
  );
}

function normalizeBaseUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PublicImageDeliveryConfigError("COFORGE_IMAGE_DELIVERY_URL must be a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new PublicImageDeliveryConfigError("COFORGE_IMAGE_DELIVERY_URL must use https");
  }
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new PublicImageDeliveryConfigError(
      "COFORGE_IMAGE_DELIVERY_URL must not have a path, query, or hash",
    );
  }
  return `${url.protocol}//${url.host}`;
}

export type PublicImageDeliveryStatus =
  | { state: "configured" }
  | { state: "disabled" }
  | { state: "error"; errorType: string };

let current:
  | { delivery: PublicImageDelivery | null; status: PublicImageDeliveryStatus }
  | undefined;

/** The process-wide public image delivery selected by the environment, memoised. */
export function getPublicImageDelivery(): PublicImageDelivery | null {
  return resolve().delivery;
}

/** Whether public image delivery is configured, disabled, or failing to load. */
export function publicImageDeliveryStatus(): PublicImageDeliveryStatus {
  return resolve().status;
}

function resolve() {
  if (current) return current;
  try {
    const delivery = createPublicImageDelivery(readPublicImageDeliveryConfig(process.env));
    current = { delivery, status: { state: delivery ? "configured" : "disabled" } };
  } catch (error) {
    const errorType = error instanceof Error ? error.name : typeof error;
    console.error(JSON.stringify({ event: "public_image_delivery_unavailable", errorType }));
    current = { delivery: null, status: { state: "error", errorType } };
  }
  return current;
}

export function createPublicImageDelivery(
  config: PublicImageDeliveryConfig,
): PublicImageDelivery | null {
  if (!config) return null;
  return new CdnPublicImageDelivery(config.baseUrl);
}

/**
 * `https://<domain>/<object key>?x-oss-process=style/<style>`, every path segment
 * `encodeURIComponent`-encoded so the path the edge sees is exactly the key. No signature and no
 * expiry: the URL is the same on every render, which is what lets a browser reuse one cached copy
 * across pages and sessions. The style parameter must be kept in the CDN's cache key (the
 * accelerated domain keeps `x-oss-process` rather than filtering every parameter), so each style
 * is one bounded, long-lived cache entry.
 */
export class CdnPublicImageDelivery implements PublicImageDelivery {
  constructor(private readonly baseUrl: string) {}

  url(objectKey: string, style: ProfileImageStyle): string {
    const path = objectKey
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `${this.baseUrl}/${path}?x-oss-process=style/${style}`;
  }
}

/**
 * The public URL for one profile image, or `null` when this deployment has no image CDN — the
 * caller then keeps its authenticated backend route, which is how local development and any
 * deployment without the domain keep working.
 */
export function publicImageUrl(
  objectKey: string,
  style: ProfileImageStyle,
  delivery: PublicImageDelivery | null = getPublicImageDelivery(),
): string | null {
  return delivery ? delivery.url(objectKey, style) : null;
}

/** Resolves one object key to its public URL, or `null`; the seam callers inject in tests. */
export type PublicImageUrlResolver = (objectKey: string, style: ProfileImageStyle) => string | null;
