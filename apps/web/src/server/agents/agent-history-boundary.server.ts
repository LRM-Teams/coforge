/**
 * The `model_seen_up_to_seq` for one Agent history page: the page's newest sequence when
 * the page joins what the Agent had already read without a gap, else `null`. It is the one
 * contiguity rule: a page that joins also moves the Agent's read-through to its boundary.
 *
 * `readThrough` is the Agent's read-through for the target before this read. A page read from an
 * explicit window start (`fromSequence`) never joins: it is not a read of what is unread, and with
 * an anchor it would page across a range the anchor does not describe. Otherwise an unanchored read
 * (which starts right after the read-through) joins; a page after an anchor joins when the anchor
 * is within what was read; a page before an anchor joins when it reaches back into what was read
 * or to the target's first message; an `around` read joins nothing.
 */
export function agentHistoryModelSeenBoundary(page: {
  anchor?: "before" | "after" | "around";
  anchorSequence?: number;
  fromSequence?: number;
  readThrough: number;
  minSequence?: number;
  maxSequence?: number;
  hasOlder: boolean;
}): number | null {
  if (page.fromSequence !== undefined) return null;
  if (page.maxSequence === undefined || page.minSequence === undefined) return null;
  const joins =
    page.anchor === undefined
      ? true
      : page.anchor === "after"
        ? page.anchorSequence !== undefined && page.anchorSequence <= page.readThrough
        : page.anchor === "before"
          ? !page.hasOlder || page.minSequence <= page.readThrough
          : false;
  return joins ? page.maxSequence : null;
}
