import { expect, test } from "bun:test";
import { createStore } from "@tanstack/react-store";

import {
  threadReadThrough,
  threadReplies,
  unreadAgentReplies,
  type ThreadMessage,
  type ThreadState,
} from "#src/features/conversations/thread-store";

/**
 * A thread's summary under its root — the reply preview, the unread count — is read from the
 * conversation's thread store by root id, so a change to one thread leaves every other thread's
 * reads as they were and their rows are not re-rendered.
 */
const reply = (
  id: string,
  sequence: number,
  senderKind: ThreadMessage["senderKind"] = "agent",
): ThreadMessage => ({
  id,
  sequence,
  threadRootId: "root",
  senderKind,
  senderName: senderKind === "agent" ? "Nova" : "Frank",
  body: `reply ${id}`,
  createdAt: "2026-09-28T00:00:00.000Z",
  attachments: [],
});

const threads = (fields: Partial<ThreadState> = {}): ThreadState => ({
  replies: new Map(),
  persistedReads: {},
  localReads: {},
  formatBody: (body) => body,
  ...fields,
});

test("a thread's read cursor is the later of the stored one and this visit's", () => {
  const state = threads({ persistedReads: { a: 4, b: 9 }, localReads: { a: 7 } });
  expect(threadReadThrough(state, "a")).toBe(7);
  expect(threadReadThrough(state, "b")).toBe(9);
  expect(threadReadThrough(state, "never-read")).toBeUndefined();
});

test("unread replies are the Agents' replies past the cursor; a thread never read counts them all", () => {
  const replies = [reply("1", 2), reply("2", 3, "user"), reply("3", 5), reply("4", 6, "system")];
  expect(unreadAgentReplies(replies, 2)).toBe(1);
  expect(unreadAgentReplies(replies, undefined)).toBe(2);
  expect(unreadAgentReplies(replies, 9)).toBe(0);
});

test("reading one thread notifies only that thread's readers", () => {
  // The same selections `useThreadUnread` subscribes to, as derived stores over the thread store.
  const store = createStore(
    threads({
      replies: new Map([
        ["a", [reply("a1", 2)]],
        ["b", [reply("b1", 3)]],
      ]),
    }),
  );
  const unreadOf = (rootId: string) =>
    createStore(() =>
      unreadAgentReplies(
        threadReplies(store.state, rootId),
        threadReadThrough(store.state, rootId),
      ),
    );
  const told = { a: 0, b: 0 };
  const a = unreadOf("a").subscribe(() => told.a++);
  const b = unreadOf("b").subscribe(() => told.b++);
  try {
    store.setState((state) => ({ ...state, localReads: { ...state.localReads, a: 2 } }));
    expect(told).toEqual({ a: 1, b: 0 });
  } finally {
    a.unsubscribe();
    b.unsubscribe();
  }
});

test("a root with no replies reads as an empty thread", () => {
  const state = threads();
  expect(threadReplies(state, "none")).toEqual([]);
  // One empty list for every such root, so a selection of it never changes.
  expect(threadReplies(state, "none")).toBe(threadReplies(state, "other"));
});
