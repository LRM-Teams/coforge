import { expect, test } from "bun:test";
import {
  SEEN_EXACT_SEQS_LIMIT,
  isSeenExactSeqs,
  mergeSeenExactSeqs,
  normalizeSeenExactSeqs,
  threadParentTarget,
  threadRootTarget,
} from "./index";

test("untrusted exact sequences become distinct positive integers above the frontier, ascending", () => {
  expect(normalizeSeenExactSeqs([9, 6, 6, 3, 4, 2.5, -1, "7", 0], 4)).toEqual([6, 9]);
  expect(normalizeSeenExactSeqs("not an array")).toEqual([]);
});

test("untrusted exact sequences keep only the newest limit", () => {
  const kept = normalizeSeenExactSeqs(
    Array.from({ length: SEEN_EXACT_SEQS_LIMIT + 100 }, (_, index) => index + 1),
  );
  expect(kept).toHaveLength(SEEN_EXACT_SEQS_LIMIT);
  expect([kept[0], kept.at(-1)]).toEqual([101, SEEN_EXACT_SEQS_LIMIT + 100]);
});

test("merging ascending exact sequences keeps each once, above the frontier, newest limit", () => {
  expect(mergeSeenExactSeqs(4, [2, 5, 7, 9], [5, 6, 9, 12])).toEqual([5, 6, 7, 9, 12]);
  expect(mergeSeenExactSeqs(0, [], [3])).toEqual([3]);
  const full = Array.from({ length: SEEN_EXACT_SEQS_LIMIT }, (_, index) => index + 1);
  const merged = mergeSeenExactSeqs(0, full, [SEEN_EXACT_SEQS_LIMIT + 1]);
  expect(merged).toHaveLength(SEEN_EXACT_SEQS_LIMIT);
  expect([merged[0], merged.at(-1)]).toEqual([2, SEEN_EXACT_SEQS_LIMIT + 1]);
});

test("a send's exact seen sequences fit the int4 sequence column", () => {
  expect(isSeenExactSeqs([1, 2_147_483_647])).toBe(true);
  expect(isSeenExactSeqs([2_147_483_648])).toBe(false);
});

test("a thread target names its parent and its root; a top-level target has neither", () => {
  expect(threadParentTarget("#general:12345678")).toBe("#general");
  expect(threadParentTarget("#general")).toBeUndefined();
  expect(threadRootTarget("#general:0f0e0d0c-0b0a-4908-8706-050403020100")).toBe(
    "0f0e0d0c-0b0a-4908-8706-050403020100",
  );
  expect(threadRootTarget("@ada:12345678")).toBe("12345678");
  expect(threadRootTarget("@ada")).toBeUndefined();
});
