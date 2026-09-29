import { isNonLocalizedPath } from "#src/lib/non-localized-path";
import { localizeHref } from "#src/paraglide/runtime";

/** Longer return paths are dropped: the signed sign-in cookie that carries one must stay under the
 * browser's 4 KB cookie limit. */
const MAX_RETURN_TO_LENGTH = 2_048;
const SAME_SITE_BASE = "https://coforge.invalid";

/**
 * The page a person goes back to after signing in (`/login?returnTo=…`), or `undefined` when the
 * value could take them anywhere but a page of this site. Only a path is accepted: a single
 * leading `/` and no `\` (browsers read it as `/`), no scheme, and no control characters, which
 * browsers strip before parsing (`/\t/evil.com` is `//evil.com`). The path comes back resolved
 * and percent-encoded, as a Location header needs it, and must still not start with `//`
 * (`/.//evil.com` resolves to that).
 */
export function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\\")) return undefined;
  if (value.length > MAX_RETURN_TO_LENGTH) return undefined;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  let url: URL;
  try {
    url = new URL(value, SAME_SITE_BASE);
  } catch {
    return undefined;
  }
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (url.origin !== SAME_SITE_BASE || path.startsWith("//")) return undefined;
  return path.length > MAX_RETURN_TO_LENGTH ? undefined : path;
}

/**
 * A return path as a URL to go to: pages get the current locale prefix, as the router's rewrite
 * gives links (an `href` redirect or navigation bypasses it); `/oauth` and the other unprefixed
 * paths stay as they are.
 */
export function localizedReturnHref(path: string): string {
  const { pathname } = new URL(path, "http://localhost");
  return isNonLocalizedPath(pathname) ? path : localizeHref(path);
}

/** Starts sign-in at Authing, coming back to `returnTo` (a `safeReturnTo` path) afterwards. */
export function signInHref(returnTo: string | undefined): string {
  return returnTo ? `/auth/login?returnTo=${encodeURIComponent(returnTo)}` : "/auth/login";
}
