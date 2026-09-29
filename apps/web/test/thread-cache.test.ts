import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver, type InfiniteData } from "@tanstack/react-query";

import {
  applyThreadRead,
  conversationThreadQueryKey,
  foldThreadReplies,
  setThreadFollowed,
  updateLoadedReply,
  type ThreadReplies,
} from "#src/features/conversations/thread-cache";
import type { ThreadSummary } from "#src/features/conversations/thread-summary-model";

// What the window and an opened thread hold in the Query cache, and how a realtime reply, a read and
// a follow reach them: a reply to a thread that is not open changes only its root's summary, one to
// an open thread also appends, and nothing changes identity without a reason.

const PAGES_KEY = ["conversation", "channel", "channel-1"];
const CONVERSATION = "channel-1";

type Message = {
  id: string;
  sequence: number;
  threadRootId?: string;
  senderKind: "user" | "agent" | "system";
  senderName: string;
  body: string;
  createdAt: string;
  reactions?: string[];
};
type Page = {
  conversationId: string;
  hasOlder: boolean;
  messages: Message[];
  threads: Record<string, ThreadSummary>;
  threadReadThrough: Record<string, number>;
  followedThreadRootIds: string[];
};

const message = (sequence: number, fields: Partial<Message> = {}): Message => ({
  id: `message-${sequence}`,
  sequence,
  senderKind: "user",
  senderName: "Ada",
  body: `body ${sequence}`,
  createdAt: `2026-09-29T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  ...fields,
});
const reply = (sequence: number, rootId: string, fields: Partial<Message> = {}) =>
  message(sequence, { threadRootId: rootId, ...fields });

const summary = (fields: Partial<ThreadSummary> = {}): ThreadSummary => ({
  replyCount: 1,
  lastReplySequence: 5,
  lastReplyAt: "2026-09-29T10:00:05.000Z",
  unread: 0,
  latestReplies: [],
  ...fields,
});

function pageOf(fields: Partial<Page> = {}): Page {
  return {
    conversationId: CONVERSATION,
    hasOlder: false,
    messages: [message(1), message(2), message(3)],
    threads: { "message-2": summary(), "message-3": summary({ lastReplySequence: 4 }) },
    threadReadThrough: { "message-2": 3 },
    followedThreadRootIds: ["message-2"],
    ...fields,
  };
}

function seeded(pages: Page[] = [pageOf()]) {
  const client = new QueryClient();
  client.setQueryData<InfiniteData<Page, unknown>>(PAGES_KEY, {
    pages,
    pageParams: pages.map(() => undefined),
  });
  return client;
}
const pagesOf = (client: QueryClient) =>
  client.getQueryData<InfiniteData<Page, unknown>>(PAGES_KEY)!.pages;
const threadOf = (client: QueryClient, rootId: string) =>
  client.getQueryData<ThreadReplies<Message>>(conversationThreadQueryKey(CONVERSATION, rootId));

/** A thread's read the test answers itself: each read of it waits for its answer in `answers`. */
function threadReads(client: QueryClient, rootId: string) {
  const answers: Array<(replies: Message[]) => void> = [];
  const observer = new QueryObserver<ThreadReplies<Message>>(client, {
    queryKey: conversationThreadQueryKey(CONVERSATION, rootId),
    queryFn: () =>
      new Promise((resolve) => {
        answers.push((replies) => resolve({ replies }));
      }),
  });
  return { answers, watch: () => observer.subscribe(() => {}) };
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const fold = (client: QueryClient, replies: Message[], viewerIsMember = true) =>
  foldThreadReplies<Message, Page>(client, {
    pagesKey: PAGES_KEY,
    conversationId: CONVERSATION,
    replies,
    viewerIsMember,
  });

describe("a realtime reply", () => {
  test("to a thread that is not open changes only its root's summary", () => {
    const client = seeded();
    const before = pagesOf(client)[0]!;

    fold(client, [reply(9, "message-2", { senderKind: "agent" })]);

    const after = pagesOf(client)[0]!;
    expect(after.threads["message-2"]).toMatchObject({
      replyCount: 2,
      lastReplySequence: 9,
      unread: 1,
    });
    expect(after.threads["message-2"]!.latestReplies.map((preview) => preview.id)).toEqual([
      "message-9",
    ]);
    // Every other root's summary, and the messages themselves, are the objects they were.
    expect(after.threads["message-3"]).toBe(before.threads["message-3"]!);
    expect(after.messages).toBe(before.messages);
    // No thread was loaded for it, and none is made.
    expect(threadOf(client, "message-2")).toBeUndefined();
  });

  test("to a thread that is open also appends to its replies, in order", () => {
    const client = seeded();
    client.setQueryData<ThreadReplies<Message>>(
      conversationThreadQueryKey(CONVERSATION, "message-2"),
      {
        replies: [reply(4, "message-2"), reply(5, "message-2")],
      },
    );
    const before = threadOf(client, "message-2")!;

    fold(client, [reply(9, "message-2"), reply(7, "message-2")]);

    const after = threadOf(client, "message-2")!;
    expect(after.replies.map((each) => each.sequence)).toEqual([4, 5, 7, 9]);
    // The replies already there keep their objects.
    expect(after.replies[0]).toBe(before.replies[0]!);
    expect(after.replies[1]).toBe(before.replies[1]!);
    expect(pagesOf(client)[0]!.threads["message-2"]!.replyCount).toBe(3);
  });

  test("that the summary already reflects changes nothing, and is not listed twice", () => {
    const client = seeded();
    client.setQueryData<ThreadReplies<Message>>(
      conversationThreadQueryKey(CONVERSATION, "message-2"),
      {
        replies: [reply(4, "message-2"), reply(5, "message-2")],
      },
    );
    const pages = pagesOf(client);
    const thread = threadOf(client, "message-2")!;

    fold(client, [reply(5, "message-2"), reply(4, "message-2")]);

    expect(pagesOf(client)).toBe(pages);
    expect(threadOf(client, "message-2")).toBe(thread);
  });

  test("to a root outside the loaded window updates no summary, and still an open thread", () => {
    const client = seeded();
    client.setQueryData<ThreadReplies<Message>>(
      conversationThreadQueryKey(CONVERSATION, "evicted"),
      {
        replies: [reply(4, "evicted")],
      },
    );
    const pages = pagesOf(client);

    fold(client, [reply(9, "evicted"), reply(10, "never-loaded")]);

    expect(pagesOf(client)).toBe(pages);
    expect(threadOf(client, "evicted")!.replies.map((each) => each.sequence)).toEqual([4, 9]);
    expect(threadOf(client, "never-loaded")).toBeUndefined();
  });

  test("lands on the page that holds its root, whichever page that is", () => {
    const older = pageOf({
      messages: [message(1)],
      threads: { "message-1": summary() },
      threadReadThrough: {},
      followedThreadRootIds: [],
    });
    const newer = pageOf({ messages: [message(20)], threads: {}, threadReadThrough: {} });
    const client = seeded([older, newer]);

    fold(client, [reply(30, "message-1")]);

    const [olderAfter, newerAfter] = pagesOf(client);
    expect(olderAfter!.threads["message-1"]!.lastReplySequence).toBe(30);
    expect(newerAfter).toBe(newer);
  });

  test("starts the summary of a root that had no replies", () => {
    const client = seeded();

    fold(client, [reply(9, "message-1")]);

    expect(pagesOf(client)[0]!.threads["message-1"]).toMatchObject({
      replyCount: 1,
      lastReplySequence: 9,
    });
  });

  test("is never unread for someone who is not a member", () => {
    const client = seeded();

    fold(client, [reply(9, "message-2", { senderKind: "agent" })], false);

    expect(pagesOf(client)[0]!.threads["message-2"]!.unread).toBe(0);
  });

  test("to a thread whose first read is under way starts that read over, which may have been answered before the reply existed", async () => {
    const client = seeded();
    const { answers, watch } = threadReads(client, "message-2");
    const stop = watch();
    expect(answers).toHaveLength(1);

    fold(client, [reply(6, "message-2")]);
    await settled();

    // The read that was under way is given up, and a second one made.
    expect(answers).toHaveLength(2);
    answers[0]!([reply(5, "message-2")]);
    answers[1]!([reply(5, "message-2"), reply(6, "message-2")]);
    await settled();
    expect(threadOf(client, "message-2")!.replies.map((each) => each.sequence)).toEqual([5, 6]);
    stop();
  });

  test("to a thread that is being read again keeps what it holds, and starts that read over", async () => {
    const client = seeded();
    client.setQueryData<ThreadReplies<Message>>(
      conversationThreadQueryKey(CONVERSATION, "message-2"),
      { replies: [reply(5, "message-2")] },
    );
    const { answers, watch } = threadReads(client, "message-2");
    const stop = watch();
    expect(answers).toHaveLength(1);

    fold(client, [reply(6, "message-2")]);
    await settled();

    // The reply is in the thread at once, and the read that may have missed it is replaced.
    expect(threadOf(client, "message-2")!.replies.map((each) => each.sequence)).toEqual([5, 6]);
    expect(answers).toHaveLength(2);
    answers[1]!([reply(5, "message-2"), reply(6, "message-2")]);
    await settled();
    expect(threadOf(client, "message-2")!.replies.map((each) => each.sequence)).toEqual([5, 6]);
    stop();
  });

  test("that a thread being read again already holds does not start that read over", async () => {
    const client = seeded();
    client.setQueryData<ThreadReplies<Message>>(
      conversationThreadQueryKey(CONVERSATION, "message-2"),
      { replies: [reply(5, "message-2"), reply(6, "message-2")] },
    );
    const { answers, watch } = threadReads(client, "message-2");
    const stop = watch();

    // The same reply arrives twice (its signal and the reconciliation both carry it).
    fold(client, [reply(6, "message-2")]);
    await settled();

    expect(answers).toHaveLength(1);
    stop();
  });

  test("to a thread that is not being read starts no read", async () => {
    const client = seeded();
    const { answers } = threadReads(client, "message-2");

    fold(client, [reply(6, "message-2")]);
    await settled();

    expect(answers).toHaveLength(0);
  });

  test("a top-level message is not a reply and changes nothing", () => {
    const client = seeded();
    const pages = pagesOf(client);

    fold(client, [message(9)]);

    expect(pagesOf(client)).toBe(pages);
  });
});

describe("reading a thread", () => {
  test("clears its unread mark and moves its cursor, on its own page only", () => {
    const older = pageOf({
      messages: [message(1)],
      threads: { "message-1": summary({ unread: 2 }) },
      threadReadThrough: {},
      followedThreadRootIds: [],
    });
    const newer = pageOf({
      messages: [message(20)],
      threads: { "message-20": summary({ unread: 1 }) },
      threadReadThrough: {},
    });
    const client = seeded([older, newer]);

    applyThreadRead(client, { pagesKey: PAGES_KEY, rootId: "message-1", throughSequence: 5 });

    const [olderAfter, newerAfter] = pagesOf(client);
    expect(olderAfter!.threads["message-1"]!.unread).toBe(0);
    expect(olderAfter!.threadReadThrough).toEqual({ "message-1": 5 });
    expect(newerAfter).toBe(newer);
  });

  test("a cursor never moves back, and a read of a thread not in the window changes nothing", () => {
    const client = seeded();
    const pages = pagesOf(client);

    applyThreadRead(client, { pagesKey: PAGES_KEY, rootId: "message-2", throughSequence: 1 });
    applyThreadRead(client, { pagesKey: PAGES_KEY, rootId: "evicted", throughSequence: 9 });

    expect(pagesOf(client)).toBe(pages);
  });
});

describe("following a thread", () => {
  test("a follow lands on the page that holds the root, and an unfollow leaves no page holding it", () => {
    const older = pageOf({
      messages: [message(1)],
      threads: {},
      threadReadThrough: {},
      followedThreadRootIds: ["message-1"],
    });
    const newer = pageOf({
      messages: [message(20)],
      threads: {},
      threadReadThrough: {},
      followedThreadRootIds: [],
    });
    const client = seeded([older, newer]);

    setThreadFollowed(client, { pagesKey: PAGES_KEY, rootId: "message-1", followed: false });
    expect(pagesOf(client).flatMap((page) => page.followedThreadRootIds)).toEqual([]);

    setThreadFollowed(client, { pagesKey: PAGES_KEY, rootId: "message-1", followed: true });
    expect(pagesOf(client).map((page) => page.followedThreadRootIds)).toEqual([["message-1"], []]);
    // Already followed: nothing to write.
    const pages = pagesOf(client);
    setThreadFollowed(client, { pagesKey: PAGES_KEY, rootId: "message-1", followed: true });
    expect(pagesOf(client)).toBe(pages);
  });
});

describe("a change to a loaded reply", () => {
  test("is written into the open thread that holds it, and only that one", () => {
    const client = seeded();
    const keyA = conversationThreadQueryKey(CONVERSATION, "message-2");
    const keyB = conversationThreadQueryKey(CONVERSATION, "message-3");
    client.setQueryData<ThreadReplies<Message>>(keyA, {
      replies: [reply(4, "message-2"), reply(5, "message-2")],
    });
    client.setQueryData<ThreadReplies<Message>>(keyB, { replies: [reply(6, "message-3")] });
    const untouched = client.getQueryData<ThreadReplies<Message>>(keyB)!;

    updateLoadedReply<Message>(client, CONVERSATION, "message-5", (each) => ({
      ...each,
      reactions: ["👍"],
    }));

    expect(client.getQueryData<ThreadReplies<Message>>(keyA)!.replies[1]!.reactions).toEqual([
      "👍",
    ]);
    expect(client.getQueryData<ThreadReplies<Message>>(keyB)).toBe(untouched);
  });
});
