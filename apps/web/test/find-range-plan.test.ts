import { expect, test } from "bun:test";
import { planRangeForOffsets } from "../src/features/projects/find-range-plan";

test("match fully inside a single segment", () => {
  expect(planRangeForOffsets([11], 2, 5)).toEqual({
    startSegment: 0,
    startOffset: 2,
    endSegment: 0,
    endOffset: 5,
  });
});

test("match spanning two segments", () => {
  // Segments "foo " (4) + "bar" (3): match "o ba" is offsets 2..6.
  expect(planRangeForOffsets([4, 3], 2, 6)).toEqual({
    startSegment: 0,
    startOffset: 2,
    endSegment: 1,
    endOffset: 2,
  });
});

test("match spanning three segments", () => {
  expect(planRangeForOffsets([2, 2, 2], 1, 5)).toEqual({
    startSegment: 0,
    startOffset: 1,
    endSegment: 2,
    endOffset: 1,
  });
});

test("match starting exactly at a segment boundary lands at the end of the earlier segment", () => {
  // Offset 3 is both "end of segment 0" and "start of segment 1" — the scan
  // picks the first segment whose end reaches it, which is a valid Range
  // boundary (DOM treats a Text node's end offset as equivalent to the next
  // node's start).
  expect(planRangeForOffsets([3, 3], 3, 5)).toEqual({
    startSegment: 0,
    startOffset: 3,
    endSegment: 1,
    endOffset: 2,
  });
});

test("match ending exactly at a segment boundary", () => {
  expect(planRangeForOffsets([3, 3], 1, 3)).toEqual({
    startSegment: 0,
    startOffset: 1,
    endSegment: 0,
    endOffset: 3,
  });
});

test("match spanning every segment", () => {
  expect(planRangeForOffsets([2, 2], 0, 4)).toEqual({
    startSegment: 0,
    startOffset: 0,
    endSegment: 1,
    endOffset: 2,
  });
});

test("zero-length segments (empty text nodes) are skipped over", () => {
  expect(planRangeForOffsets([2, 0, 2], 1, 3)).toEqual({
    startSegment: 0,
    startOffset: 1,
    endSegment: 2,
    endOffset: 1,
  });
});

test("returns null when the end offset is past every segment", () => {
  expect(planRangeForOffsets([3, 3], 1, 10)).toBeNull();
});

test("returns null when the start offset is past every segment", () => {
  expect(planRangeForOffsets([3], 10, 12)).toBeNull();
});

test("returns null for no segments at all", () => {
  expect(planRangeForOffsets([], 0, 1)).toBeNull();
});
