/** The origin the browser actually reached, honouring the reverse proxy that
 * terminates TLS in front of staging and production. Reconstructing the origin
 * from the request URL alone yields the container-internal `http://web:3000`,
 * which is neither the environment the visitor is on nor an address they can
 * reach. The forwarded origin is rebuilt rather than patched onto the request
 * URL, because assigning a portless host to a `URL` keeps the internal port. */
export function publicOrigin(request: Request): string {
  const requestOrigin = new URL(request.url).origin;
  const forwardedProto = firstHop(request.headers.get("x-forwarded-proto"));
  const forwardedHost = firstHop(request.headers.get("x-forwarded-host"));
  if (!forwardedProto || !forwardedHost) return requestOrigin;

  try {
    const forwarded = new URL(`${forwardedProto}://${forwardedHost}`);
    // A host carrying a path, credentials or a query is a malformed header
    // rather than a hop we should trust with the origin.
    if (forwarded.pathname !== "/" || forwarded.username || forwarded.search) return requestOrigin;
    return forwarded.origin;
  } catch {
    return requestOrigin;
  }
}

/** Proxies append to these headers, so only the client-facing hop is ours. */
function firstHop(value: string | null): string | undefined {
  return value?.split(",")[0].trim() || undefined;
}
