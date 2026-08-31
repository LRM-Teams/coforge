import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { deLocalizeUrl, localizeUrl } from "./paraglide/runtime";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    rewrite: {
      input: ({ url }) => (isNonLocalizedPath(url.pathname) ? url : deLocalizeUrl(url)),
      output: ({ url }) => (isNonLocalizedPath(url.pathname) ? url : localizeUrl(url)),
    },
  });

  return router;
}

function isNonLocalizedPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/") ||
    pathname === "/.well-known" ||
    pathname.startsWith("/.well-known/")
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
