/** The origin the browser actually reached. Behind the staging and production reverse
 * proxy the request URL carries the right host — Caddy passes the client's `Host` header
 * through, and the Bun server builds `request.url` from it — but the wrong scheme, because
 * TLS terminates at the proxy. So the scheme has to come from `X-Forwarded-Proto`, and the
 * host is taken from the same hop for consistency.
 *
 * The forwarded origin is rebuilt rather than patched onto the request URL: assigning a
 * portless host to a `URL` leaves whatever port was already there, which would be wrong for
 * any caller whose request URL does carry one. */
export function publicOrigin(request: Request): string {
  const requestOrigin = new URL(request.url).origin;
  const forwardedProto = firstHop(request.headers.get("x-forwarded-proto"));
  const forwardedHost = firstHop(request.headers.get("x-forwarded-host"));
  if (!forwardedProto || !forwardedHost) return requestOrigin;

  let forwarded: URL;
  try {
    forwarded = new URL(`${forwardedProto}://${forwardedHost}`);
  } catch {
    return requestOrigin;
  }
  // Anything but http(s) is a malformed hop rather than one to trust with the origin, and
  // some schemes are worse than useless: `file://evil.com` has an opaque origin, so `.origin`
  // is the literal string "null", which callers would happily paste into a shell command.
  if (forwarded.protocol !== "http:" && forwarded.protocol !== "https:") return requestOrigin;
  // A host carrying a path, credentials or a query is malformed the same way. Both halves of
  // the credential are checked: `:pw@evil.com` leaves `username` empty.
  if (forwarded.pathname !== "/" || forwarded.username || forwarded.password) {
    return requestOrigin;
  }
  if (forwarded.search) return requestOrigin;
  return forwarded.origin;
}

/** Proxies append to these headers, so only the client-facing hop is ours. */
function firstHop(value: string | null): string | undefined {
  return value?.split(",")[0].trim() || undefined;
}
