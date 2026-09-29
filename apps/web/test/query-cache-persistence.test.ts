import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  infiniteQueryOptions,
  queryOptions,
} from "@tanstack/react-query";

import {
  channelNamesQueryKey,
  sidebarChannelsQueryKey,
  sidebarDirectsQueryKey,
} from "#src/features/conversations/conversation-query-keys";
import { AppError } from "#src/lib/app-error";
import { persistsQuery } from "#src/features/cache-persistence/persisted-queries";
import {
  installQueryCachePersistence,
  type PersistedQueryStore,
} from "#src/features/cache-persistence/query-cache-persistence";
import { agentActivityKeys } from "#src/features/agents/agent-activity-queries";
import { agentEnvironmentKey } from "#src/features/agents/profile-panel/agent-profile-queries";
import {
  channelNamesQuery,
  conversationAroundQuery,
  directConversationQuery,
  publicChannelQuery,
  savedMessagesQuery,
} from "#src/features/conversations/conversation-queries";
import { channelMembersQueryKey } from "#src/features/conversations/conversation-query-keys";
import {
  conversationThreadQueryKey,
  conversationThreadsQueryKey,
} from "#src/features/conversations/thread-cache";
import {
  sidebarChannelsQuery,
  sidebarDirectsQuery,
} from "#src/features/conversations/sidebar-collections";

/**
 * The browser's copy of the Query cache (Slack's client-store boot): what a page load reads from
 * storage before the network answers, whose data it is, and what is never kept. The tests use a
 * store in memory and a QueryClient per "page load", with the network held open by a gate.
 */

/** A store in memory that tells when a change has landed, so a test waits on that and not on time. */
function memoryStore() {
  const rows = new Map<string, unknown>();
  const changes: Array<() => void> = [];
  let writeCount = 0;
  const changed = () => {
    for (const waiter of changes.splice(0)) waiter();
  };
  const store: PersistedQueryStore = {
    get: async (key) => rows.get(key),
    set: async (key, value) => {
      rows.set(key, value);
      writeCount += 1;
      changed();
    },
    delete: async (key) => {
      rows.delete(key);
      changed();
    },
    keys: async () => [...rows.keys()],
    entries: async () => [...rows.entries()],
    clear: async () => rows.clear(),
  };
  const untilRows = async (done: () => boolean) => {
    while (!done()) await new Promise<void>((resolve) => changes.push(resolve));
  };
  return {
    store,
    rows,
    /** Resolves once `count` writes in all have landed. */
    written: (count: number) => untilRows(() => writeCount >= count),
    /** Resolves once the rows are as `done` says. */
    settled: untilRows,
  };
}

/** A page load: a fresh QueryClient (an empty memory) over the storage that outlives it. */
function pageLoad(
  store: PersistedQueryStore,
  { viewerId = "user-1" as string | null, buster = "build-1" } = {},
) {
  // The app's own defaults (`router.tsx`): a read is fresh for 30 s.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
  });
  const persistence = installQueryCachePersistence(queryClient, {
    store,
    viewerId: () => viewerId ?? undefined,
    buster,
  });
  return { queryClient, persistence };
}

/** A network read that answers only when the test lets it. */
function gatedRead<T>() {
  let release: (value: T) => void = () => {};
  const answer = new Promise<T>((resolve) => (release = resolve));
  let reads = 0;
  let begin: () => void = () => {};
  const started = new Promise<void>((resolve) => (begin = resolve));
  return {
    read: () => {
      reads += 1;
      begin();
      return answer;
    },
    release,
    /** Resolves when the read has been asked for. */
    started,
    reads: () => reads,
  };
}

const channelKey = (id: string) => ["conversation", "channel", id] as const;
type Page = {
  conversationId: string;
  messages: { id: string; body: string }[];
  hasNewer?: boolean;
};
const page = (messages: string[], fields: Partial<Page> = {}): Page => ({
  conversationId: "c1",
  messages: messages.map((body, index) => ({ id: `m${index}`, body })),
  ...fields,
});
const windowQuery = (id: string, read: (context: { signal: AbortSignal }) => Promise<Page>) =>
  infiniteQueryOptions({
    queryKey: channelKey(id),
    queryFn: (context) => read(context),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: () => undefined,
  });

/** What a component does with a query: observes it, which reads it again when it is stale. */
function mount(queryClient: QueryClient, options: ReturnType<typeof windowQuery>) {
  return new InfiniteQueryObserver(queryClient, options).subscribe(() => {});
}

/** Resolves when the query's state satisfies `matches`. */
function queryBecomes(
  queryClient: QueryClient,
  key: readonly unknown[],
  matches: (state: { status: string }) => boolean,
) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const state = queryClient.getQueryState(key);
      if (state && matches(state)) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
  });
}

/** Resolves when the query's data satisfies `matches`, however it got there. */
function dataBecomes<T>(
  queryClient: QueryClient,
  key: readonly unknown[],
  matches: (d: T) => boolean,
) {
  return new Promise<void>((resolve) => {
    const check = () => {
      const data = queryClient.getQueryData<T>(key);
      if (data !== undefined && matches(data)) {
        unsubscribe();
        resolve();
      }
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(check);
    check();
  });
}

describe("a conversation opened in an earlier page load", () => {
  test("is on screen from storage while its network read is still open, then the read replaces it", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => page(["hello from yesterday"])),
    );
    await disk.written(1);

    const after = pageLoad(disk.store);
    const network = gatedRead<Page>();
    const query = windowQuery("c1", network.read);
    const restored = await after.queryClient.ensureInfiniteQueryData(query);
    expect(restored.pages[0]?.messages.map((m) => m.body)).toEqual(["hello from yesterday"]);
    expect(network.reads()).toBe(0);

    // Restoring is not the last word: the page that shows it reads it again, and the answer wins.
    mount(after.queryClient, query);
    await network.started;
    network.release(page(["hello from yesterday", "and a new one"]));
    await dataBecomes<typeof restored>(
      after.queryClient,
      channelKey("c1"),
      (data) => data.pages[0]?.messages.some((m) => m.body === "and a new one") ?? false,
    );
  });

  test("is read again by the next page that shows it, if the first read was cancelled meanwhile", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["stored"])));
    await disk.written(1);

    const after = pageLoad(disk.store);
    const network = gatedRead<Page>();
    // A read that uses its abort signal is cancelled when the last page showing it goes away.
    const query = windowQuery("c1", (context) => {
      void context.signal;
      return network.read();
    });
    await after.queryClient.ensureInfiniteQueryData(query);
    const unmount = mount(after.queryClient, query);
    await network.started;
    unmount();
    const second = mount(after.queryClient, query);
    await dataBecomes(after.queryClient, channelKey("c1"), () => network.reads() === 2);
    network.release(page(["stored", "arrived meanwhile"]));
    await dataBecomes<{ pages: Page[] }>(
      after.queryClient,
      channelKey("c1"),
      (data) => data.pages[0]?.messages.some((m) => m.body === "arrived meanwhile") ?? false,
    );
    second();
  });
});

describe("a conversation the server says is gone", () => {
  test("is removed from storage: it was deleted, or the person lost access to it", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["secret"])));
    await disk.written(1);
    expect(disk.rows.size).toBe(1);

    const after = pageLoad(disk.store);
    const query = windowQuery("c1", async () => {
      throw new AppError("NOT_FOUND");
    });
    await after.queryClient.ensureInfiniteQueryData(query);
    mount(after.queryClient, query);
    await disk.settled(() => disk.rows.size === 0);
  });

  test("stays when the read failed for any other reason", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["secret"])));
    await disk.written(1);

    const after = pageLoad(disk.store);
    let failed: () => void = () => {};
    const readFailed = new Promise<void>((resolve) => (failed = resolve));
    const query = windowQuery("c1", async () => {
      failed();
      throw new AppError("TEMPORARILY_UNAVAILABLE");
    });
    await after.queryClient.ensureInfiniteQueryData(query);
    mount(after.queryClient, query);
    await readFailed;
    // The read is over once the query has recorded its error.
    await queryBecomes(after.queryClient, channelKey("c1"), (state) => state.status === "error");
    expect(disk.rows.size).toBe(1);
  });
});

describe("another person on the same browser", () => {
  test("reads nothing of the first person's stored conversations", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store, { viewerId: "user-1" });
    await before.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => page(["private to user one"])),
    );
    await disk.written(1);

    const other = pageLoad(disk.store, { viewerId: "user-2" });
    const network = gatedRead<Page>();
    network.release(page(["what user two is allowed to see"]));
    const seen = await other.queryClient.ensureInfiniteQueryData(windowQuery("c1", network.read));
    expect(seen.pages[0]?.messages.map((m) => m.body)).toEqual(["what user two is allowed to see"]);
    expect(network.reads()).toBe(1);
  });
});

describe("a different person signing in", () => {
  test("removes what the earlier person left in storage, before anything is read", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store, { viewerId: "user-1" });
    await before.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => page(["private to user one"])),
    );
    await disk.written(1);
    expect([...disk.rows.keys()].some((key) => key.startsWith("user-1/"))).toBe(true);

    const other = pageLoad(disk.store, { viewerId: "user-2" });
    await other.queryClient.fetchInfiniteQuery(windowQuery("c2", async () => page(["for two"])));
    await disk.written(2);

    expect([...disk.rows.keys()].filter((key) => key.startsWith("user-1/"))).toEqual([]);
    expect([...disk.rows.keys()].some((key) => key.startsWith("user-2/"))).toBe(true);
  });
});

describe("signing out", () => {
  test("removes every stored query, so the next page load starts from the network", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => page(["read before signing out"])),
    );
    await disk.written(1);

    await before.persistence.purge();
    expect(disk.rows.size).toBe(0);

    const after = pageLoad(disk.store);
    const network = gatedRead<Page>();
    network.release(page(["fresh from the network"]));
    const seen = await after.queryClient.ensureInfiniteQueryData(windowQuery("c1", network.read));
    expect(seen.pages[0]?.messages.map((m) => m.body)).toEqual(["fresh from the network"]);
  });
});

describe("a page that has signed out", () => {
  test("uses storage no more, so a write of its own that lands late is not read back", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.persistence.purge();

    // What a query still in flight would have written after the purge.
    disk.rows.set('user-1/tanstack-query-["conversation","channel","c1"]', {
      buster: "build-1",
      queryHash: '["conversation","channel","c1"]',
      queryKey: channelKey("c1"),
      state: {
        data: { pages: [page(["late read of a signed-out person"])], pageParams: [undefined] },
        dataUpdatedAt: Date.now(),
      },
    });
    const network = gatedRead<Page>();
    network.release(page(["from the network"]));
    const seen = await load.queryClient.ensureInfiniteQueryData(windowQuery("c1", network.read));
    expect(seen.pages[0]?.messages.map((m) => m.body)).toEqual(["from the network"]);
  });
});

describe("before the page knows who is signed in", () => {
  test("nothing is read or written, and queries run as they always did", async () => {
    const disk = memoryStore();
    const touched: string[] = [];
    const watched: PersistedQueryStore = {
      get: (key) => (touched.push(`get ${key}`), disk.store.get(key)),
      set: (key, value) => (touched.push(`set ${key}`), disk.store.set(key, value)),
      delete: (key) => (touched.push(`delete ${key}`), disk.store.delete(key)),
      keys: () => (touched.push("keys"), disk.store.keys()),
      entries: () => (touched.push("entries"), disk.store.entries()),
      clear: () => (touched.push("clear"), disk.store.clear()),
    };
    const load = pageLoad(watched, { viewerId: null });
    const data = await load.queryClient.fetchQuery(
      queryOptions({ queryKey: ["conversation", "channel-names", "w1"], queryFn: async () => [1] }),
    );
    expect(data).toEqual([1]);
    expect(touched).toEqual([]);
  });
});

describe("what the browser keeps", () => {
  test("is an allow-list: a query nobody reviewed for storage is neither read from it nor kept in it", async () => {
    const disk = memoryStore();
    const asked: string[] = [];
    const watched: PersistedQueryStore = {
      ...disk.store,
      get: (key) => (asked.push(key), disk.store.get(key)),
    };
    const load = pageLoad(watched);
    for (const key of [
      ["agent", "environment", "agent-1"],
      ["agent", "activity", "workspace-1"],
      ["conversation", "around", "c1", "m1"],
      ["conversation", "channel-members", "c1"],
      ["conversation", "mentionables", "c1"],
      ["task-overview", "workspace-1", true],
      ["project", "acme", "object", "abc"],
      ["search-directory", "workspace-1"],
    ])
      await load.queryClient.fetchQuery({ queryKey: key, queryFn: async () => ({ secret: true }) });
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("control", async () => page(["control"])),
    );
    // The writes go in order: whatever the page decided to keep before the control is stored.
    await disk.written(1);
    expect([...disk.rows.keys()]).toEqual([
      'user-1/tanstack-query-["conversation","channel","control"]',
    ]);
    expect(asked).toEqual(['user-1/tanstack-query-["conversation","channel","control"]']);
  });

  test("keeps only the newest page of a conversation, the first paint of opening it", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const older = page(["older"]);
    const newest = page(["newest"]);
    const query = infiniteQueryOptions({
      queryKey: channelKey("c1"),
      queryFn: ({ pageParam }) => Promise.resolve(pageParam === undefined ? newest : older),
      initialPageParam: undefined as number | undefined,
      getNextPageParam: () => undefined,
      getPreviousPageParam: () => 1,
    });
    await load.queryClient.fetchInfiniteQuery(query);
    await new InfiniteQueryObserver(load.queryClient, query).fetchPreviousPage();
    expect(load.queryClient.getQueryData(channelKey("c1"))).toMatchObject({
      pages: [older, newest],
    });
    await disk.written(2);
    const [stored] = [...disk.rows.values()] as Array<{ state: { data: unknown } }>;
    expect(stored?.state.data).toEqual({ pages: [newest], pageParams: [undefined] });
  });

  test("does not keep a conversation window that is not its live end", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const inHistory = page(["from a jump to an old message"], { hasNewer: true });
    await load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => inHistory));
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("control", async () => page(["control"])),
    );
    await disk.written(1);
    expect([...disk.rows.keys()]).toEqual([
      'user-1/tanstack-query-["conversation","channel","control"]',
    ]);
  });
});

describe("the Chat sidebar", () => {
  const channels = { fetchedAt: 1, rows: [{ id: "general", name: "general" }] };
  const directs = { fetchedAt: 1, viewerId: "user-1", rows: [{ id: "dm-1" }], partial: false };
  const names = [{ id: "general", name: "general" }];

  test("opens from storage: its lists and the channel names are on screen before the network answers", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchQuery({
      queryKey: sidebarChannelsQueryKey("w1"),
      queryFn: async () => channels,
    });
    await before.queryClient.fetchQuery({
      queryKey: sidebarDirectsQueryKey("w1"),
      queryFn: async () => directs,
    });
    await before.queryClient.fetchQuery({
      queryKey: channelNamesQueryKey("w1"),
      queryFn: async () => names,
    });
    await disk.written(3);

    const after = pageLoad(disk.store);
    const network = gatedRead<unknown>();
    const read = (key: readonly unknown[]) =>
      after.queryClient.ensureQueryData({ queryKey: key, queryFn: network.read });
    expect(await read(sidebarChannelsQueryKey("w1"))).toEqual(channels);
    expect(await read(sidebarDirectsQueryKey("w1"))).toEqual(directs);
    expect(await read(channelNamesQueryKey("w1"))).toEqual(names);
  });

  test("is read again once a page shows it, though the lists never go stale on their own", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchQuery({
      queryKey: sidebarChannelsQueryKey("w1"),
      queryFn: async () => channels,
    });
    await disk.written(1);

    const after = pageLoad(disk.store);
    const network = gatedRead<typeof channels>();
    // The Chat layout's loader reads the lists with `staleTime: Infinity` (`chatListStaleTime`).
    const query = {
      queryKey: sidebarChannelsQueryKey("w1"),
      queryFn: network.read,
      staleTime: Infinity,
    };
    const opened = await after.queryClient.ensureQueryData(query);
    expect(opened).toEqual(channels);
    new QueryObserver(after.queryClient, query).subscribe(() => {});
    await network.started;
    const fresh = { fetchedAt: 2, rows: [...channels.rows, { id: "random", name: "random" }] };
    network.release(fresh);
    await dataBecomes<typeof channels>(
      after.queryClient,
      sidebarChannelsQueryKey("w1"),
      (data) => data.fetchedAt === 2,
    );
  });

  test("keeps the newest saved messages, which the Chat loader reads before it shows anything", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    const saved = Array.from({ length: 150 }, (_, index) => ({ message: { id: `m${index}` } }));
    await before.queryClient.fetchQuery({
      queryKey: savedMessagesQuery("w1").queryKey,
      queryFn: async () => saved,
    });
    await disk.written(1);

    const after = pageLoad(disk.store);
    const network = gatedRead<unknown>();
    const opened = await after.queryClient.ensureQueryData({
      queryKey: savedMessagesQuery("w1").queryKey,
      queryFn: network.read,
    });
    // The list is newest first; the read that follows brings the rest.
    expect(opened).toEqual(saved.slice(0, 100));
  });

  test("does not keep a DM list that fell back per call: the page re-reads it and must not open from it", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchQuery({
      queryKey: sidebarDirectsQueryKey("w1"),
      queryFn: async () => ({ ...directs, viewerId: undefined, partial: true }),
    });
    await load.queryClient.fetchQuery({
      queryKey: channelNamesQueryKey("w1"),
      queryFn: async () => names,
    });
    await disk.written(1);
    expect([...disk.rows.keys()]).toEqual([
      'user-1/tanstack-query-["conversation","channel-names","w1"]',
    ]);
  });
});

describe("what a stored query must still be to open a page", () => {
  async function storedThenReopened(
    reopen: { buster?: string; laterBy?: number },
    { network = page(["from the network"]) } = {},
  ) {
    const disk = memoryStore();
    const before = pageLoad(disk.store, { buster: "build-1" });
    await before.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => page(["from storage"])),
    );
    await disk.written(1);
    setSystemTime(new Date(Date.now() + (reopen.laterBy ?? 0)));
    const after = pageLoad(disk.store, { buster: reopen.buster ?? "build-1" });
    const gate = gatedRead<Page>();
    gate.release(network);
    const seen = await after.queryClient.ensureInfiniteQueryData(windowQuery("c1", gate.read));
    return seen.pages[0]?.messages.map((m) => m.body);
  }
  afterEach(() => setSystemTime());

  test("comes from the same build: another build's shape is discarded", async () => {
    expect(await storedThenReopened({ buster: "build-2" })).toEqual(["from the network"]);
  });

  test("is not older than a week", async () => {
    const day = 24 * 60 * 60 * 1000;
    expect(await storedThenReopened({ laterBy: 6 * day })).toEqual(["from storage"]);
    expect(await storedThenReopened({ laterBy: 8 * day })).toEqual(["from the network"]);
  });
});

describe("storage that fails", () => {
  test("never fails a read: the page falls back to the network", async () => {
    const broken: PersistedQueryStore = {
      get: () => Promise.reject(new Error("IndexedDB is unavailable")),
      set: () => Promise.reject(new Error("QuotaExceededError")),
      delete: () => Promise.reject(new Error("IndexedDB is unavailable")),
      keys: () => Promise.resolve([]),
      entries: () => Promise.resolve([]),
      clear: () => Promise.reject(new Error("IndexedDB is unavailable")),
    };
    const load = pageLoad(broken);
    const data = await load.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => page(["from the network"])),
    );
    expect(data.pages[0]?.messages.map((m) => m.body)).toEqual(["from the network"]);
  });
});

describe("a conversation already in memory", () => {
  test("is not replaced by what storage holds: the page's own data is newer", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["stored"])));
    await disk.written(1);

    // What the server rendered into the page, hydrated before any read runs.
    const after = pageLoad(disk.store);
    const rendered = { pages: [page(["rendered by the server"])], pageParams: [undefined] };
    after.queryClient.setQueryData(channelKey("c1"), rendered);
    const network = gatedRead<Page>();
    const seen = await after.queryClient.ensureInfiniteQueryData(windowQuery("c1", network.read));
    expect(seen).toEqual(rendered);
  });
});

describe("a page that already holds kept queries", () => {
  test("has them stored once it is up, so the next load can open from them", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    // These reached the cache without a read that stored them (hydrated, or read before the person
    // was known).
    const channels = { fetchedAt: 1, rows: [{ id: "general", name: "general" }] };
    before.queryClient.setQueryData(sidebarChannelsQueryKey("w1"), channels);
    before.queryClient.setQueryData(["agent", "environment", "agent-1"], { API_KEY: "secret" });
    await before.persistence.seed();
    await disk.written(1);
    expect([...disk.rows.keys()]).toEqual([
      'user-1/tanstack-query-["conversation","sidebar","w1","channels"]',
    ]);

    const after = pageLoad(disk.store);
    const network = gatedRead<unknown>();
    const seen = await after.queryClient.ensureQueryData({
      queryKey: sidebarChannelsQueryKey("w1"),
      queryFn: network.read,
    });
    expect(seen).toEqual(channels);
  });
});

describe("queries nobody opened again", () => {
  afterEach(() => setSystemTime());
  const day = 24 * 60 * 60 * 1000;

  test("are removed once they are older than a week, at most once a day", async () => {
    const disk = memoryStore();
    const scans: string[] = [];
    const watched: PersistedQueryStore = {
      ...disk.store,
      entries: () => (scans.push("entries"), disk.store.entries()),
    };
    const start = Date.now();
    const first = pageLoad(watched);
    await first.queryClient.fetchInfiniteQuery(windowQuery("old", async () => page(["old"])));
    await disk.written(1);

    setSystemTime(new Date(start + 8 * day));
    const later = pageLoad(watched);
    await later.queryClient.fetchInfiniteQuery(windowQuery("new", async () => page(["new"])));
    await disk.written(2);
    await later.persistence.collectGarbage();
    const kept = [...disk.rows.keys()]
      .filter((key) => key.includes("tanstack-query-"))
      .map((key) => key.slice(key.indexOf("[")));
    expect(kept).toEqual(['["conversation","channel","new"]']);

    await later.persistence.collectGarbage();
    expect(scans).toEqual(["entries"]);
    setSystemTime(new Date(start + 10 * day));
    await later.persistence.collectGarbage();
    expect(scans).toEqual(["entries", "entries"]);
  });
});

describe("the queries the app really defines", () => {
  test("a conversation, the sidebar lists and the channel names are kept", () => {
    expect(persistsQuery(publicChannelQuery("c1").query.queryKey)).toBe(true);
    expect(persistsQuery(directConversationQuery("c1").query.queryKey)).toBe(true);
    expect(persistsQuery(sidebarChannelsQuery("w1").queryKey)).toBe(true);
    expect(persistsQuery(sidebarDirectsQuery("w1").queryKey)).toBe(true);
    expect(persistsQuery(channelNamesQuery("w1").queryKey)).toBe(true);
    expect(persistsQuery(savedMessagesQuery("w1").queryKey)).toBe(true);
  });

  test("what is volatile, secret or another query's business is not", () => {
    expect(persistsQuery(conversationAroundQuery("c1", "m1").queryKey)).toBe(false);
    expect(persistsQuery(conversationThreadQueryKey("c1", "m1"))).toBe(false);
    expect(persistsQuery(conversationThreadsQueryKey("c1"))).toBe(false);
    expect(persistsQuery(channelMembersQueryKey("c1"))).toBe(false);
    expect(persistsQuery(agentEnvironmentKey("agent-1"))).toBe(false);
    expect(persistsQuery(agentActivityKeys.workspace("w1"))).toBe(false);
  });
});
