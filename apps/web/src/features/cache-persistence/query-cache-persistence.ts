import {
  PERSISTER_KEY_PREFIX,
  experimental_createQueryPersister,
  type AsyncStorage,
  type PersistedQuery,
} from "@tanstack/query-persist-client-core";
import { notifyManager, type QueryClient, type QueryKey } from "@tanstack/react-query";

import { isAppError } from "#src/lib/app-error";
import { persistsQuery, storedQueryData } from "./persisted-queries";

/** Where kept queries go: a key-value store that outlives the page (IndexedDB in the browser). */
export type PersistedQueryStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
  entries(): Promise<Array<[string, unknown]>>;
  clear(): Promise<void>;
};

/** What is in storage for one query: only what a restore needs, never the query's error or fetch
 * state. */
type StoredQuery = {
  buster: string;
  queryHash: string;
  queryKey: QueryKey;
  state: { data: unknown; dataUpdatedAt: number };
};

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** When a person's rows were last swept, next to them (not a query's key, so the sweep skips it). */
const COLLECTED_AT_KEY = "meta/collected-at";

/** The start of every key one person owns; an id cannot spell another person's. */
const namespaceOf = (viewer: string) => `${encodeURIComponent(viewer)}/`;

export function installQueryCachePersistence(
  queryClient: QueryClient,
  {
    store,
    viewerId,
    buster,
    maxAge = WEEK_MS,
  }: {
    store: PersistedQueryStore;
    /** Who is signed in as of now; storage is inert while this is `undefined`. */
    viewerId: () => string | undefined;
    /** A different value discards everything stored: the shape of what queries return changed. */
    buster: string;
    maxAge?: number;
  },
) {
  /**
   * The store, claimed for one person the first time they use it: whatever another person left
   * (a sign-out that never ran, a session that ended) goes before anything is read or written.
   */
  let claimed: { viewer: string; done: Promise<void> } | undefined;
  const claim = (viewer: string) => {
    if (claimed?.viewer === viewer) return claimed.done;
    const namespace = namespaceOf(viewer);
    const done = store
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => !key.startsWith(namespace)).map((key) => store.delete(key)),
        ),
      )
      .then(() => undefined);
    claimed = { viewer, done };
    // A store that failed the claim is claimed again by the next use.
    done.catch(() => {
      if (claimed?.done === done) claimed = undefined;
    });
    return done;
  };
  /** Set by `purge`: a read still in flight when someone signs out must not write it back. */
  let sealed = false;
  /** A key in the signed-in person's own namespace, or `undefined` while nobody is known. */
  const keyOf = async (key: string) => {
    const viewer = viewerId();
    if (!viewer || sealed) return undefined;
    await claim(viewer);
    return `${namespaceOf(viewer)}${key}`;
  };
  /** Storage is a cache: a store that fails (no IndexedDB in a private window, a full disk) is a
   * miss and a dropped write, never a failed read. TanStack's persister does not catch these. */
  const safely = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await work();
    } catch {
      return fallback;
    }
  };
  const storage: AsyncStorage<StoredQuery | undefined> = {
    getItem: (key) =>
      safely(async () => {
        const own = await keyOf(key);
        return own ? ((await store.get(own)) as StoredQuery | undefined) : undefined;
      }, undefined),
    setItem: (key, value) =>
      safely(async () => {
        const own = await keyOf(key);
        if (!own) return;
        if (value === undefined) await store.delete(own);
        else await store.set(own, value);
      }, undefined),
    removeItem: (key) =>
      safely(async () => {
        const own = await keyOf(key);
        if (own) await store.delete(own);
      }, undefined),
    // What garbage collection walks: this person's rows, under the keys the persister gave them.
    entries: () =>
      safely(async () => {
        const viewer = viewerId();
        if (!viewer || sealed) return [];
        await claim(viewer);
        const namespace = namespaceOf(viewer);
        return (await store.entries())
          .filter(([key]) => key.startsWith(namespace))
          .map(([key, value]): [string, StoredQuery | undefined] => [
            key.slice(namespace.length),
            value as StoredQuery | undefined,
          ]);
      }, []),
  };
  const persister = experimental_createQueryPersister<StoredQuery | undefined>({
    storage,
    buster,
    maxAge,
    // The read after a restore is `revalidateRestored`'s, not the persister's own (see there).
    refetchOnRestore: false,
    filters: { predicate: (query) => persistsQuery(query.queryKey) },
    serialize: (persisted) => {
      const data = storedQueryData(persisted.queryKey, persisted.state.data);
      if (data === undefined) return undefined;
      return {
        buster: persisted.buster,
        queryHash: persisted.queryHash,
        queryKey: persisted.queryKey,
        state: { data, dataUpdatedAt: persisted.state.dataUpdatedAt },
      };
    },
    deserialize: (stored): PersistedQuery => {
      if (!stored) throw new Error("nothing stored");
      return {
        buster: stored.buster,
        queryHash: stored.queryHash,
        queryKey: stored.queryKey,
        state: {
          data: stored.state.data,
          dataUpdateCount: 1,
          dataUpdatedAt: stored.state.dataUpdatedAt,
          error: null,
          errorUpdateCount: 0,
          errorUpdatedAt: 0,
          fetchFailureCount: 0,
          fetchFailureReason: null,
          fetchMeta: null,
          isInvalidated: false,
          status: "success",
          fetchStatus: "idle",
        },
      };
    },
  });
  /**
   * A restored read is only a first paint: the network read always follows, whatever the query's
   * `staleTime` says (the Chat lists never go stale on their own). It follows because the restored
   * query is marked invalidated, which is what TanStack's own stale check reads: a page that shows
   * it (now or later) reads it again, and the Chat loader's "marked stale" reads it too. The
   * persister's own `refetchOnRestore` is a bare `query.fetch()` that a page unmounting meanwhile
   * cancels for good; an invalidated query stays invalidated until a read of it succeeds.
   */
  const persisterFn: typeof persister.persisterFn = async (queryFn, context, query) => {
    const restoring = query.state.data === undefined;
    let networkRead = false;
    const data = await persister.persisterFn(
      (readContext) => {
        networkRead = true;
        return queryFn(readContext);
      },
      context,
      query,
    );
    // After the query took the restored data as its result, which clears the flag.
    if (restoring && !networkRead)
      notifyManager.schedule(() => {
        void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
      });
    return data;
  };
  // What the server says is gone (deleted, or this person lost access: both are `NOT_FOUND`) does
  // not stay in storage, where nothing would ever read it again but a restore.
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "error") return;
    if (!persistsQuery(event.query.queryKey)) return;
    if (!isAppError(event.action.error) || event.action.error.code !== "NOT_FOUND") return;
    void storage.removeItem(`${PERSISTER_KEY_PREFIX}-${event.query.queryHash}`);
  });
  const defaults = queryClient.getDefaultOptions();
  queryClient.setDefaultOptions({
    ...defaults,
    queries: {
      ...defaults.queries,
      persister: persisterFn,
      // A persister would make every query `offlineFirst`; only the network mode the app has always
      // had keeps a paused read paused.
      networkMode: defaults.queries?.networkMode ?? "online",
    },
  });
  return {
    /**
     * Stores the kept queries the page already holds: a read that finished while nobody was known
     * yet (a client-side entry into a Workspace from a page outside one) wrote nothing, and a query
     * that arrived hydrated ran no read here. The next page load opens from them all the same.
     */
    async seed() {
      await safely(async () => {
        const held = queryClient.getQueryCache().findAll({
          predicate: (query) => query.state.status === "success" && persistsQuery(query.queryKey),
        });
        await Promise.all(held.map((query) => persister.persistQuery(query)));
      }, undefined);
    },
    /**
     * Removes what is past `maxAge`, for queries nobody opened again (opening one removes it
     * anyway). It reads every row, so it runs at most once a day.
     */
    async collectGarbage() {
      await safely(async () => {
        const viewer = viewerId();
        if (!viewer || sealed) return;
        await claim(viewer);
        const marker = `${namespaceOf(viewer)}${COLLECTED_AT_KEY}`;
        const last = await store.get(marker);
        if (typeof last === "number" && Date.now() - last < DAY_MS) return;
        await persister.persisterGc();
        await store.set(marker, Date.now());
      }, undefined);
    },
    /** Sign-out: removes every kept query, and keeps this page from writing any more. */
    async purge() {
      sealed = true;
      await store.clear();
    },
  };
}
