import { describe, expect, test } from "bun:test";

import {
  CONVERSATION_WINDOW_MAX_PAGES,
  CONVERSATION_WINDOW_PAGE_SIZE,
  flushWindowUpdates,
  foldWindowUpdates,
  newestRootSequence,
  nextPageCursor,
  previousPageCursor,
  windowPageFlags,
} from "../src/lib/conversation-window";

describe("previousPageCursor", () => {
  test("pages up from the oldest loaded sequence while older history remains", () => {
    expect(previousPageCursor({ hasOlder: true }, 40)).toEqual({ before: 40 });
  });

  test("stops at the start of history", () => {
    expect(previousPageCursor({ hasOlder: false }, 1)).toBeUndefined();
  });

  test("has nothing to page from an empty page", () => {
    expect(previousPageCursor({ hasOlder: true }, undefined)).toBeUndefined();
  });
});

describe("nextPageCursor", () => {
  test("pages down from the newest loaded sequence while the tail is still missing", () => {
    expect(nextPageCursor({ hasNewer: true }, 91)).toEqual({ after: 91 });
  });

  test("stops once the retained page is the live tail", () => {
    expect(nextPageCursor({ hasNewer: false }, 91)).toBeUndefined();
  });

  test("treats a page without the flag as the tail", () => {
    expect(nextPageCursor({}, 91)).toBeUndefined();
  });

  test("has nothing to page from an empty page", () => {
    expect(nextPageCursor({ hasNewer: true }, undefined)).toBeUndefined();
  });
});

describe("newestRootSequence", () => {
  test("is the last top-level message's sequence when the page ends in a reply", () => {
    // Root 20 was fetched and answered twice; root 30 is the next root the page did not fetch.
    // Using the last message (reply 32) as the cursor would skip root 30 entirely.
    expect(
      newestRootSequence([
        { sequence: 20 },
        { sequence: 25, threadRootId: "root-20" },
        { sequence: 32, threadRootId: "root-20" },
      ]),
    ).toBe(20);
  });

  test("is the newest root, not the newest reply, when roots follow one another", () => {
    expect(
      newestRootSequence([
        { sequence: 10 },
        { sequence: 12, threadRootId: "root-10" },
        { sequence: 20 },
      ]),
    ).toBe(20);
  });

  test("is undefined for an empty page", () => {
    expect(newestRootSequence([])).toBeUndefined();
  });
});

describe("windowPageFlags", () => {
  test("the initial page is the live tail", () => {
    expect(windowPageFlags("initial", true)).toEqual({ hasOlder: true, hasNewer: false });
    expect(windowPageFlags("initial", false)).toEqual({ hasOlder: false, hasNewer: false });
  });

  test("a backward page always has newer content above it", () => {
    expect(windowPageFlags("backward", true)).toEqual({ hasOlder: true, hasNewer: true });
    expect(windowPageFlags("backward", false)).toEqual({ hasOlder: false, hasNewer: true });
  });

  test("a forward page only reaches the tail when the fetch did not overflow", () => {
    expect(windowPageFlags("forward", true)).toEqual({ hasOlder: true, hasNewer: true });
    expect(windowPageFlags("forward", false)).toEqual({ hasOlder: true, hasNewer: false });
  });
});

describe("window size", () => {
  test("retains the 100-row window the brief asks for", () => {
    expect(CONVERSATION_WINDOW_PAGE_SIZE * CONVERSATION_WINDOW_MAX_PAGES).toBe(100);
  });
});

type TestMessage = { id: string; sequence: number };

const bySequence = (base: readonly TestMessage[], incoming: readonly TestMessage[]) => {
  const byId = new Map(base.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.sequence - right.sequence);
};

const message = (id: string, sequence: number): TestMessage => ({ id, sequence });

describe("foldWindowUpdates", () => {
  test("folds realtime into the newest page when it is the live tail", () => {
    const fold = foldWindowUpdates(
      { hasNewer: false, messages: [message("a", 1)] },
      [],
      [message("b", 2)],
      bySequence,
    );
    expect(fold).toEqual({ messages: [message("a", 1), message("b", 2)], pending: [] });
  });

  test("buffers a late reply while the newest page is not the tail", () => {
    // The reply to a still-retained root: the forward page loader can never fetch it, so it must
    // not be dropped.
    const fold = foldWindowUpdates(
      { hasNewer: true, messages: [message("a", 1)] },
      [message("reply", 50)],
      [message("reply", 50)],
      bySequence,
    );
    expect(fold).toEqual({ messages: undefined, pending: [message("reply", 50)] });
  });

  test("a page that is gone folds nothing", () => {
    expect(foldWindowUpdates(undefined, [], [message("b", 2)], bySequence)).toBeUndefined();
  });
});

describe("flushWindowUpdates", () => {
  test("merges the buffer once the newest page is the tail again", () => {
    expect(
      flushWindowUpdates(
        { hasNewer: false, messages: [message("a", 1)] },
        [message("reply", 50)],
        bySequence,
      ),
    ).toEqual([message("a", 1), message("reply", 50)]);
  });

  test("waits while the tail is still missing", () => {
    expect(
      flushWindowUpdates(
        { hasNewer: true, messages: [message("a", 1)] },
        [message("reply", 50)],
        bySequence,
      ),
    ).toBeUndefined();
  });

  test("is a no-op with nothing buffered", () => {
    expect(
      flushWindowUpdates({ hasNewer: false, messages: [message("a", 1)] }, [], bySequence),
    ).toBeUndefined();
  });
});
