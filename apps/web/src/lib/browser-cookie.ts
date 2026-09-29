/**
 * Cookies the browser writes so the server render can read them on its next request: what the
 * server cannot know until the browser says it (the last page, `last-location.ts`). Each is on
 * every path, for a fixed time, and `Secure` on an https page; names are the caller's, and safe as
 * they are.
 */

/** The `Set-Cookie`/`document.cookie` string for one cookie; the value is percent-encoded. */
export function browserCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

/** The `name=value` pairs of a `Cookie` header, as written: values are still percent-encoded. */
export function cookiePairs(cookieHeader: string | undefined): [name: string, value: string][] {
  const pairs: [string, string][] = [];
  for (const part of (cookieHeader ?? "").split(";")) {
    const pair = part.trim();
    const separator = pair.indexOf("=");
    if (separator > 0) pairs.push([pair.slice(0, separator), pair.slice(separator + 1)]);
  }
  return pairs;
}
