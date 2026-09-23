import { describe, expect, test } from "bun:test";

import {
  conversationOpenPosition,
  unreadBoundary,
} from "@/features/conversations/conversation-open-position";

const messages = [
  { id: "m-1", sequence: 1 },
  { id: "m-2", sequence: 2 },
  { id: "m-3", sequence: 3 },
];

describe("unreadBoundary", () => {
  test("is the oldest message past the read cursor", () => {
    expect(unreadBoundary(messages, 1)).toEqual({ id: "m-2", sequence: 2 });
  });

  test("is absent once the cursor has caught up with the newest message", () => {
    expect(unreadBoundary(messages, 3)).toBeUndefined();
  });

  test("is absent without a cursor, so a pane opened for the first time lands at the latest", () => {
    expect(unreadBoundary(messages, undefined)).toBeUndefined();
  });

  test("is the first message when the cursor predates the whole page", () => {
    expect(unreadBoundary(messages, 0)).toEqual({ id: "m-1", sequence: 1 });
  });

  test("is absent in an empty pane", () => {
    expect(unreadBoundary([], 0)).toBeUndefined();
  });

  // Thread replies carry the channel's own sequence numbers, so a thread cursor is compared
  // against the same ordering; only the cursor's source differs.
  test("reads a thread's replies against that thread's own cursor", () => {
    const replies = [
      { id: "r-10", sequence: 10 },
      { id: "r-14", sequence: 14 },
    ];
    expect(unreadBoundary(replies, 10)).toEqual({ id: "r-14", sequence: 14 });
  });
});

describe("conversationOpenPosition", () => {
  const boundary = { id: "m-2", sequence: 2 };

  test("lands on the unread boundary where the viewer left off", () => {
    expect(conversationOpenPosition("first-unread", boundary)).toBe("m-2");
  });

  test("lands at the latest when nothing is unread", () => {
    expect(conversationOpenPosition("first-unread", undefined)).toBeUndefined();
  });

  test("lands at the latest under both newest modes, unread or not", () => {
    expect(conversationOpenPosition("newest-read", boundary)).toBeUndefined();
    expect(conversationOpenPosition("newest-unread", boundary)).toBeUndefined();
  });
});
