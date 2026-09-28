import { describe, expect, test } from "bun:test";
import { DbClient } from "@tanstack/react-db";
import { QueryClient } from "@tanstack/react-query";
import {
  materializeSavedMessages,
  optimisticSavedEntry,
  savedMessagesStore,
  saveMessageOptimistically,
  unsaveMessageOptimistically,
  type SavedEntry,
} from "#src/features/conversations/saved-messages-collection";

function entry(id: string, savedAt = new Date(0)): SavedEntry {
  return {
    savedAt,
    conversation: { id: "conversation-1", channelName: "general", directKey: null },
    message: { id } as SavedEntry["message"],
  };
}

function gate() {
  let release!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  return { promise, release, fail };
}

/** A materialized Saved collection whose server calls are held open until released. */
function setup(initial: SavedEntry[]) {
  const calls: string[] = [];
  let pending = gate();
  let serverList = initial;
  const queryClient = new QueryClient();
  const dbClient = new DbClient({ queryClient });
  const collection = materializeSavedMessages(dbClient, "workspace-1", initial, {
    list: async () => serverList,
    save: async ({ messageId }) => {
      calls.push(`save:${messageId}`);
      await pending.promise;
    },
    unsave: async ({ messageId }) => {
      calls.push(`unsave:${messageId}`);
      await pending.promise;
    },
  });
  return {
    collection,
    calls,
    setServerList: (list: SavedEntry[]) => (serverList = list),
    release: () => pending.release(),
    fail: (error: Error) => pending.fail(error),
    reset: () => (pending = gate()),
  };
}

describe("saved messages collection", () => {
  test("starts from the loader's list", () => {
    const { collection } = setup([entry("m1")]);
    expect(collection.has("m1")).toBe(true);
    expect(collection.has("m2")).toBe(false);
  });

  test("a save shows at once and persists through the save call", async () => {
    const s = setup([]);
    const done = saveMessageOptimistically(s.collection, entry("m2"));
    expect(s.collection.has("m2")).toBe(true);
    expect(s.calls).toEqual(["save:m2"]);
    s.setServerList([entry("m2")]);
    s.release();
    await done;
    expect(s.collection.has("m2")).toBe(true);
  });

  test("an unsave hides the message at once and persists through the unsave call", async () => {
    const s = setup([entry("m1")]);
    const done = unsaveMessageOptimistically(s.collection, "m1");
    expect(s.collection.has("m1")).toBe(false);
    s.setServerList([]);
    s.release();
    await done;
    expect(s.collection.has("m1")).toBe(false);
    expect(s.calls).toEqual(["unsave:m1"]);
  });

  test("a failed save rolls the star back and reports the failure", async () => {
    const s = setup([]);
    const done = saveMessageOptimistically(s.collection, entry("m3"));
    expect(s.collection.has("m3")).toBe(true);
    s.fail(new Error("offline"));
    await expect(done).rejects.toThrow("offline");
    expect(s.collection.has("m3")).toBe(false);
  });

  test("the store lists newest save first and notifies only on a change", async () => {
    const s = setup([entry("old", new Date(1)), entry("new", new Date(2))]);
    const store = savedMessagesStore(s.collection);
    const first = store.entries();
    expect(first.map((saved) => saved.message.id)).toEqual(["new", "old"]);
    // The same snapshot until something changes: `useSyncExternalStore` needs that.
    expect(store.entries()).toBe(first);
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);
    const done = saveMessageOptimistically(s.collection, entry("newest", new Date(3)));
    expect(notified).toBeGreaterThan(0);
    expect(store.entries().map((saved) => saved.message.id)).toEqual(["newest", "new", "old"]);
    expect(store.has("newest")).toBe(true);
    s.setServerList([
      entry("newest", new Date(3)),
      entry("new", new Date(2)),
      entry("old", new Date(1)),
    ]);
    s.release();
    await done;
    unsubscribe();
  });

  test("a stream row becomes a Saved entry the server's list will replace", () => {
    const saved = optimisticSavedEntry(
      {
        id: "m9",
        sequence: 9,
        senderKind: "user",
        senderName: "Dev User",
        body: "ship it",
        createdAt: "2026-09-24T01:00:00.000Z",
        attachments: [],
      },
      "conversation-1",
    );
    expect(saved.conversation).toEqual({
      id: "conversation-1",
      channelName: null,
      directKey: null,
    });
    expect(saved.message).toMatchObject({
      id: "m9",
      threadRootId: undefined,
      senderMemberId: null,
      senderDeleted: false,
      senderAvatarUrl: null,
      mentions: [],
      createdAt: new Date("2026-09-24T01:00:00.000Z"),
    });
  });

  test("unsaving a row from the loader's list notifies subscribers at once", async () => {
    // TanStack DB 0.9.2 emits no change event for an optimistic delete of a seeded row until the
    // write persists; the store must still tell the row its star changed right away.
    const s = setup([entry("m1")]);
    const store = savedMessagesStore(s.collection);
    let notified = 0;
    const unsubscribe = store.subscribe(() => notified++);
    const done = store.unsave("m1");
    expect(notified).toBeGreaterThan(0);
    expect(store.has("m1")).toBe(false);
    expect(store.entries()).toEqual([]);
    s.setServerList([]);
    s.release();
    await done;
    unsubscribe();
  });

  test("a refused unsave puts the star back and tells the subscribers", async () => {
    const s = setup([entry("m1")]);
    const store = savedMessagesStore(s.collection);
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.has("m1")));
    const done = store.unsave("m1");
    s.fail(new Error("offline"));
    await expect(done).rejects.toThrow("offline");
    expect(store.has("m1")).toBe(true);
    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(true);
    unsubscribe();
  });
});
