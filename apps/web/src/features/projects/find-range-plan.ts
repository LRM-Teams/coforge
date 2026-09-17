/**
 * Pure planning step for `use-find-in-file.ts`'s `buildRangeForMatch`: maps a
 * (start, end) character offset within a row's plain text onto a text-node
 * index and in-node offset, given only the lengths of the row's text nodes
 * (in document order). Kept free of the DOM so the offset arithmetic — the
 * part that's actually easy to get wrong, especially at segment boundaries —
 * can be unit tested without a real `Text`/`Range`.
 *
 * A match can straddle a token boundary (the row's text is split across
 * several highlighting `<span>`s), so `start` and `end` don't need to land in
 * the same segment.
 */
export interface RangePlan {
  startSegment: number;
  startOffset: number;
  endSegment: number;
  endOffset: number;
}

export function planRangeForOffsets(
  segmentLengths: number[],
  start: number,
  end: number,
): RangePlan | null {
  let offset = 0;
  let startSegment = -1;
  let startOffset = 0;
  let endSegment = -1;
  let endOffset = 0;

  for (let index = 0; index < segmentLengths.length; index++) {
    const length = segmentLengths[index];
    if (startSegment === -1 && offset + length >= start) {
      startSegment = index;
      startOffset = start - offset;
    }
    if (offset + length >= end) {
      endSegment = index;
      endOffset = end - offset;
      break;
    }
    offset += length;
  }

  if (startSegment === -1 || endSegment === -1) return null;
  return { startSegment, startOffset, endSegment, endOffset };
}
