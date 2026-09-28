/**
 * The base-URL rule every signed delivery domain obeys, written once.
 *
 * `COFORGE_FILE_DELIVERY_URL` and `COFORGE_IMAGE_DELIVERY_URL` are two settings for the same
 * shape of thing: an origin that serves bytes this application signs. Both must be an https origin
 * with no path, query, or hash, and neither may be the application's own origin — that last rule is
 * the one guarding the cookie-bearing host, so the two features must not drift apart on it.
 *
 * Each caller passes its own environment variable name (which is what the messages name) and its
 * own error class: `getFileDelivery` / `getPublicImageDelivery` treat that class as "misconfigured"
 * and turn it into a disabled state, which a generic error would not do.
 */
export type DeliveryUrlRule = {
  /** The setting the messages name, for example `COFORGE_FILE_DELIVERY_URL`. */
  envVar: string;
  /** The caller's configuration error class. */
  fail: (message: string) => Error;
};

/** An https origin with no path, query, or hash, as `<protocol>//<host>`. */
export function normalizeDeliveryBaseUrl(rawUrl: string, rule: DeliveryUrlRule): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw rule.fail(`${rule.envVar} must be a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw rule.fail(`${rule.envVar} must use https`);
  }
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw rule.fail(`${rule.envVar} must not have a path, query, or hash`);
  }
  return `${url.protocol}//${url.host}`;
}

/**
 * Refuses a delivery URL that is this deployment's own origin.
 *
 * The origin is taken from the configured OAuth redirect URI, the one setting that already has to
 * name this deployment's public origin. `AUTHING_REDIRECT_URI` is optional — the auth config
 * otherwise derives the callback from the request — so a deployment can reach here with nothing to
 * compare, and the check then permits the URL. That is why it is not the only gate at either call
 * site: each one refuses its dangerous case in the browser too (see `file-delivery.server.ts` on
 * framing a sender's document, and `public-image-delivery.server.ts` on the signed domain).
 */
export function assertDeliveryNotApplicationOrigin(
  baseUrl: string,
  env: NodeJS.ProcessEnv,
  rule: DeliveryUrlRule,
): void {
  const redirectUri = env.AUTHING_REDIRECT_URI?.trim();
  if (!redirectUri) return;
  let applicationOrigin: string;
  try {
    applicationOrigin = new URL(redirectUri).origin;
  } catch {
    return;
  }
  if (new URL(baseUrl).origin !== applicationOrigin) return;
  throw rule.fail(`${rule.envVar} must not be the application's own origin`);
}
