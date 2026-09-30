import type { QueryClient } from "@tanstack/react-query";

import { createIdbStore } from "./idb-store";
import { installQueryCachePersistence } from "./query-cache-persistence";

// The browser's copy of the Query cache (see `features/cache-persistence/AGENTS.md`): the wiring
// of the persistence to IndexedDB, and one QueryClient per page. What a stored row must look like
// to be opened is `STORED_SHAPE_VERSION` (`persisted-queries.ts`), not the build: a deploy keeps
// what is stored.

type Persistence = ReturnType<typeof installQueryCachePersistence>;
const installed = new WeakMap<QueryClient, Persistence>();
let current: Persistence | undefined;

/**
 * Keeps the client's kept queries in IndexedDB and opens later pages from them. A no-op where
 * there is no IndexedDB, which includes the server render (one QueryClient per request, nothing
 * to keep). `viewerId` is who is signed in as of now; nothing is read or written before it says.
 */
export function installBrowserQueryCachePersistence(
  queryClient: QueryClient,
  viewerId: () => string | undefined,
) {
  if (typeof indexedDB === "undefined") return;
  const persistence = installQueryCachePersistence(queryClient, {
    store: createIdbStore(),
    viewerId,
  });
  installed.set(queryClient, persistence);
  current = persistence;
  // The page's own writes wait up to a second for their burst to end; a hidden page (which may be
  // discarded without another event) starts them now. On `pagehide` this is best effort: each write
  // first reads the store's owner, which an unloading page may not finish.
  // https://developer.chrome.com/docs/web-platform/page-lifecycle-api#developer-recommendations-for-each-state
  const flush = () => void persistence.flush();
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

/** The server's read cursor of the conversation `queryKey` moved to `throughSequence`: what is
 * stored for it carries the new cursor (`noteReadThrough`). A no-op where nothing is kept. */
export function noteReadThrough(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  throughSequence: number,
) {
  installed.get(queryClient)?.noteReadThrough(queryKey, throughSequence);
}

/** The person is leaving the conversation `queryKey`: its window takes the cursor noted for it
 * (`adoptReadThrough`). A no-op where nothing is kept. */
export function adoptReadThrough(queryClient: QueryClient, queryKey: readonly unknown[]) {
  installed.get(queryClient)?.adoptReadThrough(queryKey);
}

/** The page is up: stores the kept queries it already holds, and sweeps what has aged out. */
export async function rememberQueryCache(queryClient: QueryClient) {
  const persistence = installed.get(queryClient);
  if (!persistence) return;
  await persistence.seed();
  await persistence.collectGarbage();
}

/** Removes every kept query from this browser, and keeps this page from keeping more. Sign-out. */
export async function forgetQueryCache() {
  if (current) await current.purge();
  else if (typeof indexedDB !== "undefined") await createIdbStore().clear();
}
