import type { QueryClient } from "@tanstack/react-query";

import { createIdbStore } from "./idb-store";
import { installQueryCachePersistence } from "./query-cache-persistence";

// The browser's copy of the Query cache (see `features/cache-persistence/AGENTS.md`): the wiring
// of the persistence to IndexedDB, one QueryClient per page, and the build that decides what a
// stored query's shape is.

/** Set by `vite.config.ts` at build time: one value per build, so a deploy that changes what a
 * query returns never opens a page from the previous build's shape. Absent under `bun test`. */
declare const __COFORGE_BUILD_ID__: string | undefined;
const BUILD_ID = typeof __COFORGE_BUILD_ID__ === "string" ? __COFORGE_BUILD_ID__ : "development";

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
    buster: BUILD_ID,
  });
  installed.set(queryClient, persistence);
  current = persistence;
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
