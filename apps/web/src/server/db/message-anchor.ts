/**
 * How a Message is addressed by a short anchor. `Message.id` is a native `uuid` column, so a
 * prefix cannot be matched with the usual string operators — `startsWith` (which compiles to a
 * `LIKE`/`ILIKE` pattern) does not apply to a `uuid`. The only form that works is the id **range**
 * an eight-hex-character prefix names, so every lookup by anchor shares this one.
 *
 * A full UUID is the id itself; anything else that reaches here is the eight-hex-character prefix
 * the caller meant (callers validate the shape before this point).
 */
export function messageAnchorWhere(anchor: string): string | { gte: string; lte: string } {
  return anchor.length === 8
    ? {
        gte: `${anchor}-0000-0000-0000-000000000000`,
        lte: `${anchor}-ffff-ffff-ffff-ffffffffffff`,
      }
    : anchor;
}
