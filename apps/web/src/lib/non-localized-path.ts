/** Paths that exist once, without a locale prefix: raw APIs, the device flow, and discovery. */
export function isNonLocalizedPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/")
  );
}
