import { QueryClient } from "@tanstack/react-query";
import { DbClient, DbProvider } from "@tanstack/react-db";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { GlobalError } from "#src/features/errors/page-load-error";
import { deLocalizeUrl, localizeUrl } from "#src/paraglide/runtime";
import { PENDING_DELAY_MS, PENDING_MIN_MS } from "#src/lib/pending-policy";
import { isNonLocalizedPath } from "#src/lib/non-localized-path";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  // One QueryClient per request on the server and per app on the client; the SSR
  // integration dehydrates it into the document and hydrates it before render.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Live pages keep themselves current over realtime; a remount need not refetch.
        staleTime: 30_000,
        retry: false,
      },
    },
  });
  // TanStack DB's collections live on one `DbClient` per QueryClient, provided to the whole app:
  // every component that materializes a collection shares the one instance (`useDbClient`).
  const dbClient = new DbClient({ queryClient });
  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    Wrap: ({ children }) => <DbProvider client={dbClient}>{children}</DbProvider>,
    scrollRestoration: true,
    // The pending fallback policy, stated once for every route (see lib/pending-policy.ts).
    defaultPendingMs: PENDING_DELAY_MS,
    defaultPendingMinMs: PENDING_MIN_MS,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 30_000,
    defaultErrorComponent: GlobalError,
    rewrite: {
      input: ({ url }) => (isNonLocalizedPath(url.pathname) ? url : deLocalizeUrl(url)),
      output: ({ url }) => (isNonLocalizedPath(url.pathname) ? url : localizeUrl(url)),
    },
  });
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
