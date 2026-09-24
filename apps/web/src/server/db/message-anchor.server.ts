import { AppError } from "#src/lib/app-error";

/** What an anchor may be: six to eight hex characters, or a whole UUID, in any case. */
const MESSAGE_ANCHOR =
  /^(?:[0-9a-f]{6,8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * How a Message is addressed by a short anchor. `Message.id` is a native `uuid` column, so a
 * prefix cannot be matched with the usual string operators — `startsWith` (which compiles to a
 * `LIKE`/`ILIKE` pattern) does not apply to a `uuid`. The only form that works is the id **range**
 * a hex prefix names, so every lookup by anchor shares this one.
 *
 * An anchor is a whole UUID, which is the id itself, or a prefix of six to eight hex characters.
 * Agent targets and reminder ids take eight; a thread reference written in a message takes six to
 * eight. Anything else is refused here (`INVALID_INPUT`) rather than widened into a range, so a
 * caller that forgets to check its own grammar can never resolve a message by a shorter prefix.
 */
export function messageAnchorWhere(anchor: string): string | { gte: string; lte: string } {
  if (!MESSAGE_ANCHOR.test(anchor)) throw new AppError("INVALID_INPUT");
  const hex = anchor.toLowerCase();
  if (hex.length > 8) return hex;
  const pad = 8 - hex.length;
  return {
    gte: `${hex}${"0".repeat(pad)}-0000-0000-0000-000000000000`,
    lte: `${hex}${"f".repeat(pad)}-ffff-ffff-ffff-ffffffffffff`,
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
