import { expect, test } from "bun:test";
import { createStore } from "@tanstack/react-store";

import type { ThreadState } from "#src/features/conversations/thread-store";
import type { ThreadSummary } from "#src/features/conversations/thread-summary-model";

/**
 * A thread's summary under its root — the reply preview, the unread count — is read from the
 * conversation's thread store by root id, so a change to one thread leaves every other thread's
 * reads as they were and their rows are not re-rendered.
 */
const summary = (fields: Partial<ThreadSummary> = {}): ThreadSummary => ({
  replyCount: 1,
  lastReplySequence: 2,
  lastReplyAt: "2026-09-28T00:00:00.000Z",
  unread: 1,
  latestReplies: [],
  ...fields,
});

const threads = (fields: Partial<ThreadState> = {}): ThreadState => ({
  summaries: {},
  formatBody: (body) => body,
  ...fields,
});

/** The selections `useThreadSummary` and `useThreadUnread` subscribe to, as derived stores over the
 * thread store. */
function readersOf(store: ReturnType<typeof createStore<ThreadState>>, rootId: string) {
  const told = { summary: 0, unread: 0 };
  const summaryStore = createStore(() => store.state.summaries[rootId]);
  const unreadStore = createStore(() => store.state.summaries[rootId]?.unread ?? 0);
  const subscriptions = [
    summaryStore.subscribe(() => told.summary++),
    unreadStore.subscribe(() => told.unread++),
  ];
  return { told, stop: () => subscriptions.forEach((subscription) => subscription.unsubscribe()) };
}

test("a reply in one thread notifies only that thread's readers", () => {
  const a = summary({ replyCount: 1 });
  const b = summary({ replyCount: 4 });
  const store = createStore(threads({ summaries: { a, b } }));
  const readA = readersOf(store, "a");
  const readB = readersOf(store, "b");
  try {
    store.setState((state) => ({
      ...state,
      summaries: { ...state.summaries, a: { ...a, replyCount: 2, unread: 2 } },
    }));
    expect(readA.told).toEqual({ summary: 1, unread: 1 });
    expect(readB.told).toEqual({ summary: 0, unread: 0 });
  } finally {
    readA.stop();
    readB.stop();
  }
});

test("reading a thread notifies its unread readers, and no other thread's", () => {
  const a = summary();
  const b = summary();
  const store = createStore(threads({ summaries: { a, b } }));
  const readA = readersOf(store, "a");
  const readB = readersOf(store, "b");
  try {
    store.setState((state) => ({
      ...state,
      summaries: { ...state.summaries, a: { ...a, unread: 0 } },
    }));
    expect(readA.told.unread).toBe(1);
    expect(readB.told).toEqual({ summary: 0, unread: 0 });
  } finally {
    readA.stop();
    readB.stop();
  }
});
