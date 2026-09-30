import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  hashKey,
  infiniteQueryOptions,
  queryOptions,
} from "@tanstack/react-query";

import {
  channelNamesQueryKey,
  sidebarChannelsQueryKey,
  sidebarDirectsQueryKey,
} from "#src/features/conversations/conversation-query-keys";
import { AppError } from "#src/lib/app-error";
import { CONVERSATION_WINDOW_PAGE_SIZE } from "#src/lib/conversation-window";
import {
  persistsQuery,
  storedShapeBuster,
} from "#src/features/cache-persistence/persisted-queries";
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
      // A query's row, not the bookkeeping beside it (who owns the store, when it was swept).
      if (key.includes("tanstack-query-")) writeCount += 1;
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
    /** How many query rows have been written in all. */
    writes: () => writeCount,
    /** Resolves once `count` query rows in all have been written. */
    written: (count: number) => untilRows(() => writeCount >= count),
    /** Resolves once the rows are as `done` says. */
    settled: untilRows,
  };
}

/** Lets every pending storage step run: the store in memory answers within one task. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The query rows in storage, without the bookkeeping beside them. */
const queryRows = (rows: Map<string, unknown>) =>
  [...rows.keys()].filter((key) => key.includes("tanstack-query-"));

/** A page load: a fresh QueryClient (an empty memory) over the storage that outlives it. */
function pageLoad(store: PersistedQueryStore, { viewerId = "user-1" as string | null } = {}) {
  // The app's own defaults (`router.tsx`): a read is fresh for 30 s.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
  });
  const persistence = installQueryCachePersistence(queryClient, {
    store,
    viewerId: () => viewerId ?? undefined,
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

describe("a restored conversation whose read was cut short by loading older messages", () => {
  test("is still read again, so the stored copy does not stay as the newest page", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => ({ ...page(["stored"]), hasOlder: true })),
    );
    await disk.written(1);

    const after = pageLoad(disk.store);
    const query = infiniteQueryOptions({
      queryKey: channelKey("c1"),
      // As the app's window: an older page's cursor, a newer one's cursor after it, and the live
      // end read with no cursor.
      queryFn: async ({
        pageParam,
        signal,
      }: {
        pageParam: string | undefined;
        signal: AbortSignal;
      }) => {
        if (pageParam === "before") return page(["older"]);
        // The newest page's read waits long enough to be cancelled by the older one.
        await new Promise((resolve) => setTimeout(resolve, 20));
        signal.throwIfAborted();
        return { ...page(["stored", "fresh"]), hasOlder: true };
      },
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last: Page) => (last.messages[0]?.body === "older" ? "after" : undefined),
      getPreviousPageParam: () => "before",
    });
    await after.queryClient.ensureInfiniteQueryData(query);
    // The restore has been marked for a read by the time the page mounts it.
    await queryBecomes(after.queryClient, channelKey("c1"), () =>
      Boolean(after.queryClient.getQueryState(channelKey("c1"))?.isInvalidated),
    );
    const observer = new InfiniteQueryObserver(after.queryClient, query);
    const unsubscribe = observer.subscribe(() => {});
    // The older sentinel is on screen at once: loading older cancels the newest page's read.
    await observer.fetchPreviousPage();
    await dataBecomes<{ pages: Page[] }>(
      after.queryClient,
      channelKey("c1"),
      (data) => data.pages.at(-1)?.messages.some((m) => m.body === "fresh") ?? false,
    );
    unsubscribe();
  });
});

describe("a conversation the server says is gone", () => {
  test("is removed from storage: it was deleted, or the person lost access to it", async () => {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["secret"])));
    await disk.written(1);
    expect(queryRows(disk.rows)).toHaveLength(1);

    const after = pageLoad(disk.store);
    const query = windowQuery("c1", async () => {
      throw new AppError("NOT_FOUND");
    });
    await after.queryClient.ensureInfiniteQueryData(query);
    mount(after.queryClient, query);
    await disk.settled(() => queryRows(disk.rows).length === 0);
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
    expect(queryRows(disk.rows)).toHaveLength(1);
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
      buster: storedShapeBuster,
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

describe("a page whose person is no longer the one signed in", () => {
  test("stores nothing once another person has taken the store, and reads nothing back", async () => {
    // Tab one was loaded as user one. In tab two the same browser signed in as user two, whose
    // cookie tab one's reads now carry: what they return is user two's, not user one's.
    const disk = memoryStore();
    const tabOne = pageLoad(disk.store, { viewerId: "user-1" });
    await tabOne.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["one"])));
    await disk.written(1);
    const tabTwo = pageLoad(disk.store, { viewerId: "user-2" });
    await tabTwo.queryClient.fetchInfiniteQuery(windowQuery("c2", async () => page(["two"])));
    await disk.written(2);

    await tabOne.queryClient.fetchInfiniteQuery(
      windowQuery("c3", async () => page(["user two's, read by tab one"])),
    );
    await tabTwo.queryClient.fetchInfiniteQuery(windowQuery("c4", async () => page(["control"])));
    await disk.written(3);
    await settle();
    expect(queryRows(disk.rows)).toEqual([
      'user-2/tanstack-query-["conversation","channel","c2"]',
      'user-2/tanstack-query-["conversation","channel","c4"]',
    ]);

    // Nor does tab one open anything from the store any more.
    const network = gatedRead<Page>();
    network.release(page(["from the network"]));
    const seen = await tabOne.queryClient.ensureInfiniteQueryData(windowQuery("c2", network.read));
    expect(seen.pages[0]?.messages.map((m) => m.body)).toEqual(["from the network"]);
  });

  test("stores nothing once another page of the same browser signed out", async () => {
    const disk = memoryStore();
    const tabOne = pageLoad(disk.store);
    await tabOne.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["one"])));
    await disk.written(1);
    const tabTwo = pageLoad(disk.store);
    await tabTwo.persistence.purge();

    await tabOne.queryClient.fetchInfiniteQuery(windowQuery("c2", async () => page(["late"])));
    await settle();
    expect(queryRows(disk.rows)).toEqual([]);
  });

  test("does not write back a read that was still claiming the store when the page signed out", async () => {
    const disk = memoryStore();
    let releaseKeys: () => void = () => {};
    const keysHeld = new Promise<void>((resolve) => (releaseKeys = resolve));
    const slow: PersistedQueryStore = {
      ...disk.store,
      keys: async () => {
        await keysHeld;
        return disk.store.keys();
      },
    };
    const load = pageLoad(slow);
    const read = load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["x"])));
    const purged = load.persistence.purge();
    releaseKeys();
    await Promise.all([read, purged]);
    await settle();
    expect(queryRows(disk.rows)).toEqual([]);
  });
});

describe("another person's claim under way", () => {
  test("stops the earlier person's tab before it removes their rows, so none is written in between", async () => {
    const disk = memoryStore();
    let releaseDeletes: () => void = () => {};
    const deletesHeld = new Promise<void>((resolve) => (releaseDeletes = resolve));
    const slowDeletes: PersistedQueryStore = {
      ...disk.store,
      delete: async (key) => {
        await deletesHeld;
        return disk.store.delete(key);
      },
    };
    const tabOne = pageLoad(disk.store, { viewerId: "user-1" });
    await tabOne.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["one"])));
    await disk.written(1);
    const tabTwo = pageLoad(slowDeletes, { viewerId: "user-2" });
    const tabTwoRead = tabTwo.queryClient.fetchInfiniteQuery(
      windowQuery("c2", async () => page(["two"])),
    );
    await settle();
    // User two's claim is removing user one's rows; tab one reads meanwhile, with user two's cookie.
    await tabOne.queryClient.fetchInfiniteQuery(windowQuery("c3", async () => page(["theirs"])));
    await settle();
    releaseDeletes();
    await tabTwoRead;
    await disk.written(2);
    await settle();
    expect(queryRows(disk.rows)).toEqual(['user-2/tanstack-query-["conversation","channel","c2"]']);
  });
});

describe("the same person in two tabs", () => {
  test("keeps both tabs storing: the second tab's claim never takes the store from the first", async () => {
    const disk = memoryStore();
    let releaseOwner: () => void = () => {};
    const ownerHeld = new Promise<void>((resolve) => (releaseOwner = resolve));
    let holding = false;
    const slowOwnerWrite: PersistedQueryStore = {
      ...disk.store,
      set: async (key, value) => {
        if (holding && key === "meta/owner") await ownerHeld;
        return disk.store.set(key, value);
      },
    };
    const tabOne = pageLoad(disk.store);
    await tabOne.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["one"])));
    await disk.written(1);
    // Tab two's claim is under way: whatever it removes, it has not recorded its owner yet.
    holding = true;
    const tabTwo = pageLoad(slowOwnerWrite);
    const tabTwoRead = tabTwo.queryClient.fetchInfiniteQuery(
      windowQuery("c2", async () => page(["two"])),
    );
    await settle();
    await tabOne.queryClient.fetchInfiniteQuery(windowQuery("c3", async () => page(["three"])));
    await disk.written(2);
    releaseOwner();
    await tabTwoRead;
    await tabOne.queryClient.fetchInfiniteQuery(windowQuery("c4", async () => page(["four"])));
    await disk.written(4);
    expect(queryRows(disk.rows).sort()).toEqual([
      'user-1/tanstack-query-["conversation","channel","c1"]',
      'user-1/tanstack-query-["conversation","channel","c2"]',
      'user-1/tanstack-query-["conversation","channel","c3"]',
      'user-1/tanstack-query-["conversation","channel","c4"]',
    ]);
  });
});

describe("a write whose ownership check is still out when the page signs out", () => {
  test("is not written after the sign-out cleared storage", async () => {
    const disk = memoryStore();
    let releaseCheck: () => void = () => {};
    const checkHeld = new Promise<void>((resolve) => (releaseCheck = resolve));
    let checked: () => void = () => {};
    const checkAsked = new Promise<void>((resolve) => (checked = resolve));
    let ownerReads = 0;
    const slowCheck: PersistedQueryStore = {
      ...disk.store,
      get: async (key) => {
        const value = await disk.store.get(key);
        // The second ownership check is the write's (the first is the restore's read).
        if (key === "meta/owner" && ++ownerReads === 2) {
          checked();
          await checkHeld;
        }
        return value;
      },
    };
    const load = pageLoad(slowCheck);
    await load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["x"])));
    await checkAsked;
    await load.persistence.purge();
    releaseCheck();
    await settle();
    expect(queryRows(disk.rows)).toEqual([]);
  });
});

describe("storage whose first open is slow once", () => {
  test("is used again once it answers, though the loader's parallel reads all timed out on it", async () => {
    const disk = memoryStore();
    let first = true;
    const coldOpen: PersistedQueryStore = {
      ...disk.store,
      keys: async () => {
        if (first) {
          first = false;
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        return disk.store.keys();
      },
    };
    const load = pageLoad(coldOpen);
    // The Chat loader's reads start together, and all wait on the one first claim.
    await Promise.all([
      load.queryClient.fetchQuery({
        queryKey: sidebarChannelsQueryKey("w1"),
        queryFn: async () => ({ fetchedAt: 1, rows: [] }),
      }),
      load.queryClient.fetchQuery({
        queryKey: channelNamesQueryKey("w1"),
        queryFn: async () => ({ names: [], streamPositions: {} }),
      }),
      load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["one"]))),
    ]);
    await disk.written(3);
    await load.queryClient.fetchInfiniteQuery(windowQuery("c2", async () => page(["two"])));
    await disk.written(4);
  });
});

describe("storage that never answers", () => {
  test("does not hold a read: the page reads the network after a short wait, and stops asking after two", async () => {
    const never = new Promise<never>(() => {});
    const hung: PersistedQueryStore = {
      get: () => never,
      set: () => never,
      delete: () => never,
      keys: () => never,
      entries: () => never,
      clear: () => never,
    };
    const load = pageLoad(hung);
    const first = await load.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => page(["from the network"])),
    );
    expect(first.pages[0]?.messages.map((m) => m.body)).toEqual(["from the network"]);
    // One slow answer may be a cold first open: the next read still asks, and waits as long.
    await load.queryClient.fetchInfiniteQuery(windowQuery("c2", async () => page(["again"])));
    const started = performance.now();
    await load.queryClient.fetchInfiniteQuery(windowQuery("c3", async () => page(["and again"])));
    expect(performance.now() - started).toBeLessThan(100);
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
      get: (key) => (key.includes("tanstack-query-") && asked.push(key), disk.store.get(key)),
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
    expect(queryRows(disk.rows)).toEqual([
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
    const [stored] = queryRows(disk.rows).map((key) => disk.rows.get(key)) as Array<{
      state: { data: unknown };
    }>;
    expect(stored?.state.data).toEqual({ pages: [newest], pageParams: [undefined] });
  });

  test("keeps one page of a conversation's newest messages, however many realtime added", async () => {
    // A page is what a first read returns (Slack: "a page of history … enough to fill the view").
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const bodies = Array.from({ length: CONVERSATION_WINDOW_PAGE_SIZE + 7 }, (_, i) => `m${i}`);
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => ({ ...page(bodies), hasOlder: false })),
    );
    await disk.written(1);
    const [stored] = queryRows(disk.rows).map((key) => disk.rows.get(key)) as Array<{
      state: { data: { pages: Array<Page & { hasOlder: boolean }> } };
    }>;
    const kept = stored?.state.data.pages[0];
    expect(kept?.messages.map((m) => m.body)).toEqual(bodies.slice(-CONVERSATION_WINDOW_PAGE_SIZE));
    // What it no longer holds is history to page back into, as after a first read.
    expect(kept?.hasOlder).toBe(true);
  });

  test("keeps thread state only for the roots it kept, as a first read has it", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const bodies = Array.from({ length: CONVERSATION_WINDOW_PAGE_SIZE + 1 }, (_, i) => `m${i}`);
    // The oldest message, m0, is a thread root that the cut removes; the newest, m20, is one it keeps.
    const newest = `m${CONVERSATION_WINDOW_PAGE_SIZE}`;
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => ({
        ...page(bodies),
        messages: bodies.map((body) => ({ id: body, body })),
        threads: { m0: { replyCount: 9 }, [newest]: { replyCount: 1 } },
        threadReadThrough: { m0: 5, [newest]: 7 },
        followedThreadRootIds: ["m0", newest],
      })),
    );
    await disk.written(1);
    const [stored] = queryRows(disk.rows).map((key) => disk.rows.get(key)) as Array<{
      state: { data: { pages: Array<Record<string, unknown>> } };
    }>;
    const kept = stored?.state.data.pages[0];
    expect(kept?.threads).toEqual({ [newest]: { replyCount: 1 } });
    expect(kept?.threadReadThrough).toEqual({ [newest]: 7 });
    expect(kept?.followedThreadRootIds).toEqual([newest]);
  });

  test("keeps exactly one page as it was, and cuts one message more", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const full = Array.from({ length: CONVERSATION_WINDOW_PAGE_SIZE }, (_, i) => `m${i}`);
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("full", async () => ({ ...page(full), hasOlder: false })),
    );
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("over", async () => ({ ...page([...full, "one more"]), hasOlder: false })),
    );
    await disk.written(2);
    const stored = (id: string) =>
      disk.rows.get(`user-1/tanstack-query-["conversation","channel","${id}"]`) as {
        state: { data: { pages: Array<{ hasOlder: boolean; messages: unknown[] }> } };
      };
    expect(stored("full").state.data.pages[0]?.hasOlder).toBe(false);
    expect(stored("over").state.data.pages[0]?.hasOlder).toBe(true);
    expect(stored("over").state.data.pages[0]?.messages).toHaveLength(
      CONVERSATION_WINDOW_PAGE_SIZE,
    );
  });

  test("leaves a page no longer than one page as it was", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => ({ ...page(["only", "two"]), hasOlder: false })),
    );
    await disk.written(1);
    const [stored] = queryRows(disk.rows).map((key) => disk.rows.get(key)) as Array<{
      state: { data: { pages: Array<Page & { hasOlder: boolean }> } };
    }>;
    expect(stored?.state.data.pages[0]?.messages.map((m) => m.body)).toEqual(["only", "two"]);
    expect(stored?.state.data.pages[0]?.hasOlder).toBe(false);
  });

  test("drops an attachment's signed preview URL, which expires long before the copy does", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const attachment = {
      id: "a1",
      fileName: "photo.png",
      previewUrl: "https://cdn.example/a1?sig",
    };
    const withAttachment = {
      ...page(["a photo"]),
      messages: [{ id: "m0", body: "a photo", attachments: [attachment] }],
    };
    await load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => withAttachment));
    await load.queryClient.fetchQuery({
      queryKey: savedMessagesQuery("w1").queryKey,
      queryFn: async () => ({
        streamPositions: {},
        entries: [{ message: { id: "m0", attachments: [attachment] } }],
      }),
    });
    await disk.written(2);
    const stored = JSON.stringify(queryRows(disk.rows).map((key) => disk.rows.get(key)));
    expect(stored).not.toContain("previewUrl");
    expect(stored).toContain("photo.png");
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
    expect(queryRows(disk.rows)).toEqual([
      'user-1/tanstack-query-["conversation","channel","control"]',
    ]);
  });
});

describe("the Chat sidebar", () => {
  const channels = { fetchedAt: 1, rows: [{ id: "general", name: "general" }] };
  const directs = { fetchedAt: 1, viewerId: "user-1", rows: [{ id: "dm-1" }], partial: false };
  const names = {
    names: [{ id: "general", name: "general" }],
    streamPositions: { "chat:workspace:w1": { offset: 2, epoch: "e1" } },
  };

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
    const entries = Array.from({ length: 150 }, (_, index) => ({ message: { id: `m${index}` } }));
    const streamPositions = { "chat:user:user-1": { offset: 4, epoch: "e1" } };
    await before.queryClient.fetchQuery({
      queryKey: savedMessagesQuery("w1").queryKey,
      queryFn: async () => ({ streamPositions, entries }),
    });
    await disk.written(1);

    const after = pageLoad(disk.store);
    const network = gatedRead<unknown>();
    const opened = await after.queryClient.ensureQueryData({
      queryKey: savedMessagesQuery("w1").queryKey,
      queryFn: network.read,
    });
    // The list is newest first; the read that follows brings the rest. A copy cut to 100 is not the
    // whole list, so it does not claim the place in the stream the whole list was read at.
    expect(opened).toEqual({ streamPositions: {}, entries: entries.slice(0, 100) });
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
    expect(queryRows(disk.rows)).toEqual([
      'user-1/tanstack-query-["conversation","channel-names","w1"]',
    ]);
  });
});

describe("what a stored query must still be to open a page", () => {
  /** Stores a conversation, then opens it in a later page load, `rowBuster` being the version the
   * row was written under when it was not the current one. */
  async function storedThenReopened(
    reopen: { rowBuster?: string; laterBy?: number },
    { network = page(["from the network"]) } = {},
  ) {
    const disk = memoryStore();
    const before = pageLoad(disk.store);
    await before.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => page(["from storage"])),
    );
    await disk.written(1);
    if (reopen.rowBuster !== undefined)
      for (const key of queryRows(disk.rows))
        (disk.rows.get(key) as { buster: string }).buster = reopen.rowBuster;
    setSystemTime(new Date(Date.now() + (reopen.laterBy ?? 0)));
    const after = pageLoad(disk.store);
    const gate = gatedRead<Page>();
    gate.release(network);
    const seen = await after.queryClient.ensureInfiniteQueryData(windowQuery("c1", gate.read));
    return seen.pages[0]?.messages.map((m) => m.body);
  }
  afterEach(() => setSystemTime());

  test("was written under the stored-shape version, however it got there, not under a build id", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(windowQuery("read", async () => page(["read"])));
    await disk.written(1);
    load.queryClient.setQueryData(channelKey("written"), {
      pages: [page(["written by the page"])],
      pageParams: [undefined],
    });
    await load.persistence.flush();
    await disk.written(2);
    const busters = queryRows(disk.rows).map(
      (key) => (disk.rows.get(key) as { buster: string }).buster,
    );
    expect(busters).toEqual([storedShapeBuster, storedShapeBuster]);
  });

  test("was written under the current stored-shape version: an earlier one's shape is discarded", async () => {
    expect(await storedThenReopened({ rowBuster: "0" })).toEqual(["from the network"]);
    // What every row held before the version replaced the per-build id: a commit's sha.
    expect(
      await storedThenReopened({ rowBuster: "b769ab2cbd2ee1fd0a05d3b6ee9e87a2f0f0f9a1" }),
    ).toEqual(["from the network"]);
  });

  test("is still read after a deploy: the shape did not change, so the row stays", async () => {
    // Every page load of every build shares the version; nothing else keys a row.
    expect(await storedThenReopened({})).toEqual(["from storage"]);
  });

  test("is not older than a week", async () => {
    const day = 24 * 60 * 60 * 1000;
    expect(await storedThenReopened({ laterBy: 6 * day })).toEqual(["from storage"]);
    expect(await storedThenReopened({ laterBy: 8 * day })).toEqual(["from the network"]);
  });
});

/** A row as the persister writes it, for a query never read in this test: what an earlier page
 * load left behind, possibly of a shape the app no longer reads. */
function storedRow(queryKey: readonly unknown[], data: unknown) {
  return {
    buster: storedShapeBuster,
    queryHash: hashKey(queryKey),
    queryKey,
    state: { data, dataUpdatedAt: Date.now() },
  };
}
const rowKeyOf = (queryKey: readonly unknown[]) => `user-1/tanstack-query-${hashKey(queryKey)}`;

describe("a stored row of a shape the app no longer reads", () => {
  const savedKey = savedMessagesQuery("w1").queryKey;
  const cases = [
    [
      "a conversation window whose pages are not a list",
      channelKey("c1"),
      { pages: {}, pageParams: [] },
    ],
    [
      "a conversation window page without its messages",
      channelKey("c1"),
      { pages: [{ conversationId: "c1" }], pageParams: [undefined] },
    ],
    [
      "channel names as the bare list they were before they carried a stream position",
      channelNamesQueryKey("w1"),
      [{ id: "general", name: "general" }],
    ],
    [
      "a Saved list as the bare list it was before it carried a stream position",
      savedKey,
      [{ message: { id: "m1" } }],
    ],
    ["a sidebar channel list without its rows", sidebarChannelsQueryKey("w1"), { fetchedAt: 1 }],
    [
      "a sidebar DM list whose rows are not a list",
      sidebarDirectsQueryKey("w1"),
      { fetchedAt: 1, rows: "none" },
    ],
  ] as const;

  for (const [name, queryKey, stored] of cases) {
    test(`is not opened from (${name}): the network read serves instead`, async () => {
      const disk = memoryStore();
      disk.rows.set(rowKeyOf(queryKey), storedRow(queryKey, stored));
      const load = pageLoad(disk.store);
      const network = gatedRead<unknown>();
      network.release({ from: "the network" });
      const seen = await load.queryClient.ensureQueryData({ queryKey, queryFn: network.read });
      expect(seen).toEqual({ from: "the network" });
    });
  }

  test("is removed by the daily sweep, as is a row of a query the app no longer keeps", async () => {
    const disk = memoryStore();
    const names = channelNamesQueryKey("w1");
    const around = ["conversation", "around", "c1", "m1"];
    disk.rows.set(rowKeyOf(names), storedRow(names, [{ id: "general", name: "general" }]));
    disk.rows.set(rowKeyOf(around), storedRow(around, { pages: [], pageParams: [] }));
    const load = pageLoad(disk.store);
    await load.persistence.collectGarbage();
    expect(queryRows(disk.rows)).toEqual([]);
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
    expect(queryRows(disk.rows)).toEqual([
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

describe("a conversation the person read through a message", () => {
  type CursorPage = Page & { readThroughSequence?: number };
  const storedCursor = (disk: ReturnType<typeof memoryStore>) =>
    (
      disk.rows.get('user-1/tanstack-query-["conversation","channel","c1"]') as
        | { state: { data: { pages: CursorPage[] } } }
        | undefined
    )?.state.data.pages[0]?.readThroughSequence;

  test("is stored with that cursor, while the page's own window keeps the one it opened with", async () => {
    // The pane freezes its unread divider for the visit; the next page load opens from storage.
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => ({ ...page(["m"]), readThroughSequence: 100 })),
    );
    await disk.written(1);
    load.persistence.noteReadThrough(channelKey("c1"), 160);
    await load.persistence.flush();
    await disk.written(2);
    expect(storedCursor(disk)).toBe(160);
    const live = load.queryClient.getQueryData<{ pages: CursorPage[] }>(channelKey("c1"));
    expect(live?.pages[0]?.readThroughSequence).toBe(100);
  });

  test("keeps that cursor when a read that started before it stores the window again", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => ({ ...page(["m"]), readThroughSequence: 100 })),
    );
    await disk.written(1);
    // A refetch is already on its way with the server's old cursor when the mark-read lands.
    const network = gatedRead<CursorPage>();
    const refetch = load.queryClient.fetchInfiniteQuery({
      ...windowQuery("c1", network.read),
      staleTime: 0,
    });
    await network.started;
    load.persistence.noteReadThrough(channelKey("c1"), 160);
    network.release({ ...page(["m", "n"]), readThroughSequence: 100 });
    await refetch;
    await disk.written(2);
    await settle();
    expect(storedCursor(disk)).toBe(160);
  });

  test("is taken into the page's own window when the page asks, as when the person leaves it", async () => {
    // Coming back to the conversation in the same page load opens the window from memory.
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => ({ ...page(["m"]), readThroughSequence: 100 })),
    );
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("c2", async () => ({ ...page(["m"]), readThroughSequence: 100 })),
    );
    load.persistence.noteReadThrough(channelKey("c1"), 160);
    load.persistence.adoptReadThrough(channelKey("c1"));
    load.persistence.adoptReadThrough(channelKey("c2"));
    const cursor = (id: string) =>
      load.queryClient.getQueryData<{ pages: CursorPage[] }>(channelKey(id))?.pages[0]
        ?.readThroughSequence;
    expect(cursor("c1")).toBe(160);
    expect(cursor("c2")).toBe(100);
  });

  test("never moves the stored cursor back, and leaves a window without one as it was", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(
      windowQuery("c1", async () => ({ ...page(["m"]), readThroughSequence: 100 })),
    );
    await load.queryClient.fetchInfiniteQuery(windowQuery("c2", async () => page(["m"])));
    await disk.written(2);
    load.persistence.noteReadThrough(channelKey("c1"), 90);
    load.persistence.noteReadThrough(channelKey("c2"), 160);
    await load.persistence.flush();
    await settle();
    expect(storedCursor(disk)).toBe(100);
    const other = disk.rows.get('user-1/tanstack-query-["conversation","channel","c2"]') as {
      state: { data: { pages: CursorPage[] } };
    };
    expect(other.state.data.pages[0]?.readThroughSequence).toBeUndefined();
  });
});

describe("what the page writes itself (realtime, a sent message, the sidebar's changes)", () => {
  test("is kept too, the newest state once per burst, so the next load opens where this one left off", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["read"])));
    await disk.written(1);
    for (const body of ["realtime one", "realtime two", "my own"])
      load.queryClient.setQueryData<{ pages: Page[]; pageParams: unknown[] }>(
        channelKey("c1"),
        (pages) =>
          pages && {
            ...pages,
            pages: [
              { ...pages.pages[0]!, messages: [...pages.pages[0]!.messages, { id: body, body }] },
            ],
          },
      );
    await load.persistence.flush();
    await disk.written(2);
    await settle();
    const [stored] = queryRows(disk.rows).map((key) => disk.rows.get(key)) as Array<{
      state: { data: { pages: Page[] } };
    }>;
    expect(stored?.state.data.pages[0]?.messages.map((m) => m.body)).toEqual([
      "read",
      "realtime one",
      "realtime two",
      "my own",
    ]);
    // One write for the burst, not one per change.
    expect(disk.writes()).toBe(2);

    const after = pageLoad(disk.store);
    const network = gatedRead<Page>();
    const opened = await after.queryClient.ensureInfiniteQueryData(windowQuery("c1", network.read));
    expect(opened.pages[0]?.messages.map((m) => m.body)).toContain("my own");
  });

  test("is written by itself shortly after, without a flush", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const channels = { fetchedAt: 1, rows: [{ id: "general", name: "general", unread: 0 }] };
    load.queryClient.setQueryData(sidebarChannelsQueryKey("w1"), channels);
    load.queryClient.setQueryData(sidebarChannelsQueryKey("w1"), {
      ...channels,
      rows: [{ ...channels.rows[0]!, unread: 3 }],
    });
    await disk.written(1);
    expect(JSON.stringify(queryRows(disk.rows).map((key) => disk.rows.get(key)))).toContain(
      '"unread":3',
    );
  });

  test("keeps nothing a query nobody reviewed for storage holds", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    load.queryClient.setQueryData(["agent", "environment", "agent-1"], { API_KEY: "secret" });
    load.queryClient.setQueryData(channelNamesQueryKey("w1"), {
      names: [{ id: "general" }],
      streamPositions: {},
    });
    await load.persistence.flush();
    await disk.written(1);
    await settle();
    expect(queryRows(disk.rows)).toEqual([
      'user-1/tanstack-query-["conversation","channel-names","w1"]',
    ]);
  });

  test("leaves the kept copy alone when the window it wrote is not one to open at", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["live end"])));
    await disk.written(1);
    // A jump to an old message replaces the window with one around it.
    load.queryClient.setQueryData(channelKey("c1"), {
      pages: [page(["around an old message"], { hasNewer: true })],
      pageParams: [undefined],
    });
    await load.persistence.flush();
    await settle();
    expect(JSON.stringify(queryRows(disk.rows).map((key) => disk.rows.get(key)))).toContain(
      "live end",
    );
  });

  test("does not bring back a conversation the server said is gone meanwhile", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    await load.queryClient.fetchInfiniteQuery(windowQuery("c1", async () => page(["read"])));
    await disk.written(1);
    load.queryClient.setQueryData<{ pages: Page[]; pageParams: unknown[] }>(
      channelKey("c1"),
      (pages) => pages && { ...pages, pages: [page(["read", "realtime"])] },
    );
    // Its refetch answers NOT_FOUND, and the page drops it from memory.
    await load.queryClient
      .fetchInfiniteQuery({
        ...windowQuery("c1", async () => {
          throw new AppError("NOT_FOUND");
        }),
        staleTime: 0,
      })
      .catch(() => {});
    await disk.settled(() => queryRows(disk.rows).length === 0);
    load.queryClient.removeQueries({ queryKey: channelKey("c1"), exact: true });
    await load.persistence.flush();
    await settle();
    expect(queryRows(disk.rows)).toEqual([]);
  });

  test("does not keep a stand-in the page marked stale at once", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    const saved = { streamPositions: {}, entries: [{ message: { id: "m1" } }] };
    await load.queryClient.fetchQuery({
      queryKey: savedMessagesQuery("w1").queryKey,
      queryFn: async () => saved,
    });
    await disk.written(1);
    // The Chat loader's stand-in when the Saved read failed: empty, and stale at once.
    load.queryClient.setQueryData(savedMessagesQuery("w1").queryKey, {
      streamPositions: {},
      entries: [],
    });
    await load.queryClient.invalidateQueries({
      queryKey: savedMessagesQuery("w1").queryKey,
      refetchType: "none",
    });
    await load.persistence.flush();
    await settle();
    expect(JSON.stringify(queryRows(disk.rows).map((key) => disk.rows.get(key)))).toContain('"m1"');
  });

  test("keeps the newest state when the query was rebuilt meanwhile (a Workspace switch)", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    load.queryClient.setQueryData(channelNamesQueryKey("w1"), {
      names: [{ id: "old" }],
      streamPositions: {},
    });
    load.queryClient.clear();
    load.queryClient.setQueryData(channelNamesQueryKey("w1"), {
      names: [{ id: "newest" }],
      streamPositions: {},
    });
    await load.persistence.flush();
    await disk.written(1);
    await settle();
    expect(JSON.stringify(queryRows(disk.rows).map((key) => disk.rows.get(key)))).toContain(
      '"newest"',
    );
  });

  test("writes nothing once the page has signed out", async () => {
    const disk = memoryStore();
    const load = pageLoad(disk.store);
    load.queryClient.setQueryData(channelNamesQueryKey("w1"), {
      names: [{ id: "general" }],
      streamPositions: {},
    });
    await load.persistence.purge();
    await load.persistence.flush();
    await settle();
    expect(queryRows(disk.rows)).toEqual([]);
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
