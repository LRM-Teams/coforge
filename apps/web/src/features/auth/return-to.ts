import { isNonLocalizedPath } from "#src/lib/non-localized-path";
import { localizeHref } from "#src/paraglide/runtime";

/**
 * The page a person goes back to after signing in (`/login?returnTo=…`), or `undefined` when the
 * value could take them anywhere but a page of this site. Only a path is accepted: a single
 * leading `/` and no second `/` or `\` after it (both make a protocol-relative URL), no scheme,
 * and no control characters, which browsers strip before parsing (`/\t/evil.com` is
 * `//evil.com`).
 */
export function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  if (value[1] === "/" || value[1] === "\\") return undefined;
  if (value.includes("\\")) return undefined;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return value;
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
