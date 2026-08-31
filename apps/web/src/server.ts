import handler from "@tanstack/react-start/server-entry";

import { paraglideMiddleware } from "./paraglide/server";

export function isNonLocalizedRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/")
  );
}

export default {
  async fetch(request: Request): Promise<Response> {
    return isNonLocalizedRequest(request)
      ? handler.fetch(request)
      : paraglideMiddleware(request, () => handler.fetch(request));
  },
};
