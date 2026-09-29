import { describe, expect, test } from "bun:test";

import {
  THREAD_PREVIEW_BODY_MAX,
  mergeWindowThreads,
  newestReflectedSequence,
  previewBody,
  threadReadThrough,
  withReply,
  withThreadRead,
  type ThreadSummary,
} from "#src/features/conversations/thread-summary-model";

const reply = (
  sequence: number,
  fields: Partial<Parameters<typeof withReply>[1]> = {},
): Parameters<typeof withReply>[1] => ({
  id: `reply-${sequence}`,
  sequence,
  senderKind: "user",
  senderName: "Ada",
  body: `body ${sequence}`,
  createdAt: `2026-09-29T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  ...fields,
});

const summary = (fields: Partial<ThreadSummary> = {}): ThreadSummary => ({
  replyCount: 2,
  lastReplySequence: 6,
  lastReplyAt: "2026-09-29T10:00:06.000Z",
  unread: 1,
  latestReplies: [],
  ...fields,
});

describe("withReply", () => {
  test("a first reply starts the summary a server read would have made", () => {
    expect(withReply(undefined, reply(4, { senderKind: "agent" }), { countUnread: true })).toEqual({
      replyCount: 1,
      lastReplySequence: 4,
      lastReplyAt: "2026-09-29T10:00:04.000Z",
      unread: 1,
      latestReplies: [
        {
          id: "reply-4",
          sequence: 4,
          senderName: "Ada",
          senderAvatarUrl: null,
          senderDeleted: false,
          body: "body 4",
          createdAt: "2026-09-29T10:00:04.000Z",
        },
      ],
    });
  });

  test("a reply the summary already reflects changes nothing", () => {
    const before = summary();
    expect(withReply(before, reply(6), { countUnread: true })).toBe(before);
    expect(withReply(before, reply(5, { senderKind: "agent" }), { countUnread: true })).toBe(
      before,
    );
  });

  test("a newer reply counts, becomes the newest and keeps only the last three listed", () => {
    let current: ThreadSummary | undefined;
    for (const sequence of [2, 3, 4, 5])
      current = withReply(current, reply(sequence), { countUnread: true });
    expect(current!.replyCount).toBe(4);
    expect(current!.lastReplySequence).toBe(5);
    expect(current!.latestReplies.map((preview) => preview.id)).toEqual([
      "reply-3",
      "reply-4",
      "reply-5",
    ]);
  });

  test("a system notice moves what the summary reflects but is not a reply", () => {
    const next = withReply(
      summary({ latestReplies: [] }),
      reply(9, { senderKind: "system", senderName: "System" }),
      { countUnread: true },
    );
    expect(next.replyCount).toBe(2);
    expect(next.lastReplySequence).toBe(9);
    expect(next.latestReplies).toEqual([]);
    expect(next.unread).toBe(1);
  });

  test("only an Agent's reply is unread, and never for someone who is not a member", () => {
    const base = summary({ unread: 0 });
    expect(withReply(base, reply(7), { countUnread: true }).unread).toBe(0);
    expect(withReply(base, reply(7, { senderKind: "agent" }), { countUnread: true }).unread).toBe(
      1,
    );
    expect(withReply(base, reply(7, { senderKind: "agent" }), { countUnread: false }).unread).toBe(
      0,
    );
  });

  test("a preview carries the capped one-line body, and a Date time reads as its ISO string", () => {
    const next = withReply(
      undefined,
      reply(3, {
        body: "x".repeat(THREAD_PREVIEW_BODY_MAX * 2),
        createdAt: new Date("2026-09-29T10:00:03Z"),
      }),
      { countUnread: true },
    );
    expect(next.latestReplies[0]!.body).toBe(previewBody("x".repeat(THREAD_PREVIEW_BODY_MAX * 2)));
    expect(next.lastReplyAt).toBe("2026-09-29T10:00:03.000Z");
  });
});

describe("withThreadRead", () => {
  test("reading through the newest reply clears the unread mark", () => {
    expect(withThreadRead(summary({ unread: 3 }), 6).unread).toBe(0);
    expect(withThreadRead(summary({ unread: 3 }), 8).unread).toBe(0);
  });

  test("reading short of the newest reply, or a thread with nothing unread, changes nothing", () => {
    const unread = summary({ unread: 3 });
    expect(withThreadRead(unread, 5)).toBe(unread);
    const read = summary({ unread: 0 });
    expect(withThreadRead(read, 6)).toBe(read);
  });
});

describe("threadReadThrough", () => {
  test("is the later of the stored cursor and this visit's, or unknown when never read", () => {
    const reads = { persistedReads: { a: 4, b: 9 }, localReads: { a: 7 } };
    expect(threadReadThrough(reads, "a")).toBe(7);
    expect(threadReadThrough(reads, "b")).toBe(9);
    expect(threadReadThrough(reads, "never")).toBeUndefined();
  });
});

describe("mergeWindowThreads", () => {
  test("a window of one page hands its own objects back", () => {
    const page = {
      threads: { a: summary() },
      threadReadThrough: { a: 3 },
      followedThreadRootIds: ["a"],
    };
    const merged = mergeWindowThreads([page]);
    expect(merged.threads).toBe(page.threads);
    expect(merged.threadReadThrough).toBe(page.threadReadThrough);
    expect(merged.followedThreadRootIds).toBe(page.followedThreadRootIds);
  });

  test("pages hold different roots, so the window is their union", () => {
    const a = summary({ replyCount: 1 });
    const b = summary({ replyCount: 5 });
    const merged = mergeWindowThreads([
      { threads: { a }, threadReadThrough: { a: 1 }, followedThreadRootIds: ["a"] },
      { threads: { b }, threadReadThrough: { b: 2 }, followedThreadRootIds: ["b"] },
    ]);
    expect(merged.threads).toEqual({ a, b });
    expect(merged.threads.a).toBe(a);
    expect(merged.threadReadThrough).toEqual({ a: 1, b: 2 });
    expect(merged.followedThreadRootIds).toEqual(["a", "b"]);
  });

  test("a direct conversation has no follows, and stays without them", () => {
    const merged = mergeWindowThreads([{ threads: {}, threadReadThrough: {} }]);
    expect(merged.followedThreadRootIds).toBeUndefined();
  });
});

describe("previewBody", () => {
  test("keeps a short body whole and cuts a long one at the cap with an ellipsis", () => {
    expect(previewBody("short")).toBe("short");
    const cut = previewBody("word ".repeat(200));
    expect(cut.length).toBeLessThanOrEqual(THREAD_PREVIEW_BODY_MAX + 1);
    expect(cut).toEndWith("…");
  });

  test("never ends inside a mention or reference token", () => {
    const token = `<@agent:${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}>`;
    const body = `${"a".repeat(THREAD_PREVIEW_BODY_MAX - 5)}${token} and more`;
    const cut = previewBody(body);
    expect(cut).toBe(`${"a".repeat(THREAD_PREVIEW_BODY_MAX - 5)}…`);
    // A token that ends before the cap survives whole.
    const early = `${token} ${"b".repeat(THREAD_PREVIEW_BODY_MAX)}`;
    expect(previewBody(early).startsWith(token)).toBe(true);
  });
});

describe("newestReflectedSequence", () => {
  const page = (rootSequences: number[], threads: Record<string, ThreadSummary> = {}) => ({
    messages: rootSequences.map((sequence) => ({ sequence })),
    threads,
  });

  test("is the newest root when no thread has replies past it", () => {
    expect(newestReflectedSequence(page([2, 5]))).toBe(5);
    expect(newestReflectedSequence(page([2, 5], { a: summary({ lastReplySequence: 4 }) }))).toBe(5);
  });

  test("reaches past the newest root to the newest reply a summary reflects, so that reading what came after it does not fetch those replies again", () => {
    expect(
      newestReflectedSequence(
        page([2, 5], {
          a: summary({ lastReplySequence: 40 }),
          b: summary({ lastReplySequence: 90 }),
        }),
      ),
    ).toBe(90);
  });

  test("is 0 for an empty page", () => {
    expect(newestReflectedSequence(page([]))).toBe(0);
    expect(newestReflectedSequence({ messages: [] })).toBe(0);
  });
});
