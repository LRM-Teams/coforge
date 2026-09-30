import {
  PERSISTER_KEY_PREFIX,
  experimental_createQueryPersister,
  type AsyncStorage,
  type PersistedQuery,
} from "@tanstack/query-persist-client-core";
import {
  hashKey,
  notifyManager,
  type Query,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";

import { isAppError } from "#src/lib/app-error";
import {
  isStoredData,
  persistsQuery,
  storedQueryData,
  storedShapeBuster,
  withReadThrough,
} from "./persisted-queries";

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

/** Whether what storage returned for a query is a row this page can open: a row of a shape the
 * app no longer reads (or that something else wrote) is a miss, not a crash. */
function isReadableRow(stored: unknown): stored is StoredQuery {
  if (typeof stored !== "object" || stored === null) return false;
  const { buster, queryHash, queryKey, state } = stored as Partial<StoredQuery>;
  return (
    typeof buster === "string" &&
    typeof queryHash === "string" &&
    Array.isArray(queryKey) &&
    typeof state?.dataUpdatedAt === "number" &&
    isStoredData(queryKey, state.data)
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** When a person's rows were last swept, next to them (not a query's key, so the sweep skips it). */
const COLLECTED_AT_KEY = "meta/collected-at";

/** Whose rows the store holds now. A page loaded as someone else stops using it: another tab signed
 * out, or in as another person, and this page's reads now carry that session's cookie. */
const OWNER_KEY = "meta/owner";
/** How long a read waits for the store before it reads the network instead. */
const STORE_WAIT_MS = 250;
/** Reads in a row the store let time out before this page stops asking it (an IndexedDB open that
 * stalls). One is not enough: a first open on a cold profile, with the one-time claim, can be slow
 * once and then answer. */
const UNANSWERED_READS_LIMIT = 2;

/** How long a write the page makes itself (realtime, a sent message, the sidebar's changes) waits
 * for the rest of its burst: the query is stored once, with its newest state, at most this often. */
const PAGE_WRITE_DELAY_MS = 1_000;

/** The start of every key one person owns; an id cannot spell another person's. */
const namespaceOf = (viewer: string) => `${encodeURIComponent(viewer)}/`;

export function installQueryCachePersistence(
  queryClient: QueryClient,
  {
    store,
    viewerId,
    maxAge = WEEK_MS,
  }: {
    store: PersistedQueryStore;
    /** Who is signed in as of now; storage is inert while this is `undefined`. */
    viewerId: () => string | undefined;
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
    // The owner is recorded first, so the earlier person's tabs stop at their next check, before
    // their rows go. The owner row is overwritten, never removed: the same person's other tab
    // checks it.
    const done = store
      .set(OWNER_KEY, viewer)
      .then(() => store.keys())
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== OWNER_KEY && !key.startsWith(namespace))
            .map((key) => store.delete(key)),
        ),
      )
      .then(storeAnswered);
    claimed = { viewer, done };
    // A store that failed the claim is claimed again by the next use.
    done.catch(() => {
      if (claimed?.done === done) claimed = undefined;
    });
    return done;
  };
  /**
   * Set by `purge`, or when the store has passed to someone else (`OWNER_KEY`): a read still in
   * flight must not write back, and this page opens nothing more from storage.
   */
  let sealed = false;
  /**
   * Reads in a row the store did not answer in time, and whether reads have stopped waiting on it.
   * Only reads stop: a write waits for the store however long it takes. Once the store answers
   * anything (a first open on a cold profile, slow once), reads wait on it again.
   */
  let unansweredReads = 0;
  let unresponsive = false;
  /** Writes made while reads do not wait on the store: the newest per query, not each one, so a
   * store that never answers holds one row's data per kept query rather than every read's. */
  const deferredWrites = new Map<string, StoredQuery | undefined>();
  function storeAnswered() {
    unansweredReads = 0;
    unresponsive = false;
    const writes = [...deferredWrites];
    deferredWrites.clear();
    for (const [key, value] of writes) void storage.setItem(key, value);
  }
  /**
   * A key in the signed-in person's own namespace, or `undefined` while nobody is known, once the
   * page is sealed, or when the store now belongs to someone else. Ownership is checked on every
   * use: a sign-out or another sign-in in another tab happens while this page stays open.
   */
  const keyOf = async (key: string) => {
    const viewer = viewerId();
    if (!viewer || sealed) return undefined;
    await claim(viewer);
    const owner = await store.get(OWNER_KEY);
    // A sign-out may have sealed the page while the owner was being read.
    if (sealed || owner !== viewer) {
      sealed = true;
      return undefined;
    }
    return `${namespaceOf(viewer)}${key}`;
  };
  /** What a read waits for: the store's answer, or a miss once `STORE_WAIT_MS` has passed. */
  const answered = <T>(work: Promise<T>, miss: T): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        unansweredReads += 1;
        if (unansweredReads >= UNANSWERED_READS_LIMIT) unresponsive = true;
        resolve(miss);
      }, STORE_WAIT_MS);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
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
    // The one call a read waits on before it reaches the network, so it waits only so long.
    getItem: (key) =>
      safely(
        async () =>
          unresponsive
            ? undefined
            : answered(
                (async () => {
                  const own = await keyOf(key);
                  if (!own) return undefined;
                  const stored = (await store.get(own)) as StoredQuery | undefined;
                  storeAnswered();
                  return stored;
                })(),
                undefined,
              ),
        undefined,
      ),
    // A write is not time-boxed; while reads do not wait on the store it is deferred, and written
    // once the store answers anything.
    setItem: (key, value) =>
      safely(async () => {
        if (unresponsive) {
          deferredWrites.set(key, value);
          return;
        }
        const own = await keyOf(key);
        if (!own) return;
        if (value === undefined) await store.delete(own);
        else await store.set(own, value);
      }, undefined),
    removeItem: (key) =>
      safely(async () => {
        if (unresponsive) {
          deferredWrites.set(key, undefined);
          return;
        }
        const own = await keyOf(key);
        if (own) await store.delete(own);
      }, undefined),
    // What garbage collection walks: this person's rows, under the keys the persister gave them.
    entries: () =>
      safely(async () => {
        const viewer = viewerId();
        if (!viewer || !(await keyOf(""))) return [];
        const namespace = namespaceOf(viewer);
        return (await store.entries())
          .filter(([key]) => key.startsWith(namespace))
          .map(([key, value]): [string, StoredQuery | undefined] => [
            key.slice(namespace.length),
            value as StoredQuery | undefined,
          ]);
      }, []),
  };
  /** Read cursors the server moved past what the page's windows hold, by query (`noteReadThrough`). */
  const readThrough = new Map<string, number>();
  /** What goes to storage for a query: only what a restore needs, cut to its first paint, with the
   * read cursor the server moved to. */
  const toStored = (persisted: Omit<PersistedQuery, "state"> & { state: Query["state"] }) => {
    const kept = storedQueryData(persisted.queryKey, persisted.state.data);
    if (kept === undefined) return undefined;
    const cursor = readThrough.get(persisted.queryHash);
    const data = cursor === undefined ? kept : withReadThrough(persisted.queryKey, kept, cursor);
    return {
      buster: persisted.buster,
      queryHash: persisted.queryHash,
      queryKey: persisted.queryKey,
      state: { data, dataUpdatedAt: persisted.state.dataUpdatedAt },
    } satisfies StoredQuery;
  };
  const persister = experimental_createQueryPersister<StoredQuery | undefined>({
    storage,
    buster: storedShapeBuster,
    maxAge,
    // The read after a restore is `revalidateRestored`'s, not the persister's own (see there).
    refetchOnRestore: false,
    filters: { predicate: (query) => persistsQuery(query.queryKey) },
    serialize: (persisted) => toStored(persisted),
    // A row this page cannot open makes the persister remove it and read the network (its
    // "malformed"), on a restore and on the daily sweep alike.
    deserialize: (stored): PersistedQuery => {
      if (!isReadableRow(stored)) throw new Error("nothing readable stored");
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
        awaitingRead.add(query.queryHash);
        void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true });
      });
    return data;
  };
  /**
   * Restored queries whose own read has not succeeded yet. Loading older or newer pages cancels
   * that read (TanStack's `fetchPreviousPage` cancels a refetch in flight) and its success clears
   * the invalidation, which would leave the stored copy as the newest page for good: such a query
   * is invalidated again, until a read of the query itself succeeds.
   */
  const awaitingRead = new Set<string>();
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
    const { queryHash } = event.query;
    if (!awaitingRead.has(queryHash)) return;
    if (!event.query.state.fetchMeta?.fetchMore) {
      awaitingRead.delete(queryHash);
      return;
    }
    notifyManager.schedule(() => {
      void queryClient.invalidateQueries({ queryKey: event.query.queryKey, exact: true });
    });
  });
  // What the server says is gone (deleted, or this person lost access: both are `NOT_FOUND`) does
  // not stay in storage, where nothing would ever read it again but a restore.
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "error") return;
    if (!persistsQuery(event.query.queryKey)) return;
    if (!isAppError(event.action.error) || event.action.error.code !== "NOT_FOUND") return;
    void storage.removeItem(`${PERSISTER_KEY_PREFIX}-${event.query.queryHash}`);
  });
  /**
   * The persister stores a query only after its read runs (`setQueryData` is not persisted, the
   * docs say; they persist such writes with `persistQueryByKey`). What the page writes itself is
   * most of what a person last saw: realtime messages, their own sends, read positions, the
   * sidebar's unread counts. So a kept query the page wrote is stored too, with its newest state,
   * once per `PAGE_WRITE_DELAY_MS`. A write whose data is not one to open at (a window around an
   * old message) leaves the stored copy as it is.
   */
  const pageWrites = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Stores the query as the cache holds it now, if it still does: one the server answered
   * `NOT_FOUND` for (removed from storage above) or the page dropped is not written back, one that
   * was rebuilt (a Workspace switch clears the cache) is stored as rebuilt, and a stand-in the page
   * marked stale at once (the Chat loader's empty Saved list) is not stored as data.
   */
  const storePageWrite = (queryHash: string) => {
    clearTimeout(pageWrites.get(queryHash));
    pageWrites.delete(queryHash);
    const query = queryClient.getQueryCache().get(queryHash);
    if (!query || query.state.status !== "success" || query.state.isInvalidated) return;
    const stored = toStored({
      buster: storedShapeBuster,
      queryHash,
      queryKey: query.queryKey,
      state: query.state,
    });
    if (!stored) return;
    return storage.setItem(`${PERSISTER_KEY_PREFIX}-${queryHash}`, stored);
  };
  /** Moves the cursor of a window held only in storage; nothing stored stays nothing. */
  const storeReadThrough = async (queryHash: string, throughSequence: number) => {
    const key = `${PERSISTER_KEY_PREFIX}-${queryHash}`;
    const stored = await storage.getItem(key);
    if (!stored) return;
    const data = withReadThrough(stored.queryKey, stored.state.data, throughSequence);
    if (data === stored.state.data) return;
    await storage.setItem(key, { ...stored, state: { ...stored.state, data } });
  };
  const schedulePageWrite = (queryHash: string) => {
    if (pageWrites.has(queryHash)) return;
    pageWrites.set(
      queryHash,
      setTimeout(() => void storePageWrite(queryHash), PAGE_WRITE_DELAY_MS),
    );
  };
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.action.type !== "success" || !event.action.manual) return;
    if (persistsQuery(event.query.queryKey)) schedulePageWrite(event.query.queryHash);
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
        const marker = await keyOf(COLLECTED_AT_KEY);
        if (!marker) return;
        const last = await store.get(marker);
        if (typeof last === "number" && Date.now() - last < DAY_MS) return;
        await persister.persisterGc();
        await store.set(marker, Date.now());
      }, undefined);
    },
    /**
     * The person read the conversation `queryKey` through `throughSequence` and the server's cursor
     * moved there. The page's window keeps the cursor it opened with (its divider stays for the
     * visit); what is stored carries the new one from now on, so the next page load draws no
     * divider over messages already read.
     */
    noteReadThrough(queryKey: QueryKey, throughSequence: number) {
      if (!persistsQuery(queryKey)) return;
      const queryHash = hashKey(queryKey);
      if ((readThrough.get(queryHash) ?? -1) >= throughSequence) return;
      readThrough.set(queryHash, throughSequence);
      // A window this page holds is stored from memory, with the cursor (`toStored`); one it holds
      // only in storage (read on another page or device) is moved where it is stored, so the next
      // open, here or after a reload, draws its divider where the person now is.
      if (queryClient.getQueryCache().get(queryHash)?.state.status === "success")
        schedulePageWrite(queryHash);
      else void storeReadThrough(queryHash, throughSequence);
    },
    /**
     * Takes the cursor noted for `queryKey` into the page's own window: the person is leaving the
     * conversation, so its divider is no longer on screen, and coming back in this page load opens
     * the window from memory.
     */
    adoptReadThrough(queryKey: QueryKey) {
      const cursor = readThrough.get(hashKey(queryKey));
      if (cursor === undefined) return;
      const current = queryClient.getQueryData(queryKey);
      if (current === undefined) return;
      const moved = withReadThrough(queryKey, current, cursor);
      if (moved !== current) queryClient.setQueryData(queryKey, moved);
    },
    /** Stores the page's own writes still waiting for their burst to end: the page is going away. */
    async flush() {
      await Promise.all([...pageWrites.keys()].map((queryHash) => storePageWrite(queryHash)));
    },
    /** Sign-out: removes every kept query, and keeps this page from writing any more. */
    async purge() {
      sealed = true;
      await store.clear();
    },
  };
}
