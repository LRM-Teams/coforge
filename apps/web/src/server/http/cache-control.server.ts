/**
 * The two `cache-control` values the web app answers with that do not explain themselves.
 *
 * `no-store` on its own stays spelled out where it is used: it is a standard token that already says
 * what it means, and a name for it would only add an import. These two encode a decision instead —
 * who may keep the bytes, and for how long — and each is used by several routes that have to agree,
 * which is the drift this file exists to stop.
 */

/**
 * An avatar served from a URL that carries a version token: the bytes behind that URL can never
 * change, so a year is safe and revalidation is waste. `private` because the response belongs to the
 * viewer who asked for it.
 */
export const IMMUTABLE_IMAGE_CACHE_CONTROL = "private, max-age=31536000, immutable";

/**
 * Something the viewer is allowed to see but not to keep, and that no intermediary may store:
 * attachment downloads, the signed-URL redirect that hands one out, and the error answers of the
 * routes that serve them.
 */
export const PRIVATE_NO_STORE = "private, no-store";
