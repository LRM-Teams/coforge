import { describe, expect, test } from "bun:test";

import {
  CONVERSATION_WINDOW_MAX_PAGES,
  CONVERSATION_WINDOW_PAGE_SIZE,
  newestSequence,
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

describe("newestSequence", () => {
  test("is the last message's sequence, reply included", () => {
    expect(newestSequence([{ sequence: 3 }, { sequence: 4 }, { sequence: 9 }])).toBe(9);
  });

  test("is undefined for an empty page", () => {
    expect(newestSequence([])).toBeUndefined();
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
