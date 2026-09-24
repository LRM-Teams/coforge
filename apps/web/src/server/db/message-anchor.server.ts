/**
 * How a Message is addressed by a short anchor. `Message.id` is a native `uuid` column, so a
 * prefix cannot be matched with the usual string operators — `startsWith` (which compiles to a
 * `LIKE`/`ILIKE` pattern) does not apply to a `uuid`. The only form that works is the id **range**
 * a hex prefix names, so every lookup by anchor shares this one.
 *
 * A full UUID is the id itself; anything else that reaches here is a prefix of six to eight hex
 * characters, lower-case, that the caller meant (callers validate the shape before this point).
 * Agent targets and reminder ids take eight; a thread reference written in a message takes six to
 * eight.
 */
export function messageAnchorWhere(anchor: string): string | { gte: string; lte: string } {
  if (anchor.length > 8) return anchor;
  const pad = 8 - anchor.length;
  return {
    gte: `${anchor}${"0".repeat(pad)}-0000-0000-0000-000000000000`,
    lte: `${anchor}${"f".repeat(pad)}-ffff-ffff-ffff-ffffffffffff`,
  };
}

/**
 * The top-level messages of one channel (or other conversation) an anchor names: the one rule a
 * thread is found by, whether an Agent targets it (`#name:<8 hex>`) or a message refers to it. More
 * than one match means the anchor is ambiguous.
 */
export function channelThreadRootWhere(conversationId: string, anchor: string) {
  return { conversationId, threadRootId: null, id: messageAnchorWhere(anchor) };
}
