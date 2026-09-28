/**
 * The order rules a member's pinned channels and DMs follow. The server stores pins by them
 * (`server/conversations/conversation-pins.server.ts`) and the Chat sidebar applies them before
 * the server answers, so both put every pin in the same place.
 */

/** A new pin goes after every pin the member has. */
export function nextPinOrder(orders: readonly (number | null)[]) {
  return orders.reduce<number>(
    (next, order) => (order === null ? next : Math.max(next, order + 1)),
    0,
  );
}

/**
 * Every pin's order after a drag: the arranged pins take the first places, the ones dragged out
 * are unpinned (`null`), and the member's other pins follow in their old order.
 */
export function pinOrdersAfterArrange<Key>(
  current: readonly { key: Key; order: number }[],
  arrangement: { pins: readonly Key[]; unpinned: readonly Key[] },
) {
  const arranged = new Set(arrangement.pins);
  const unpinned = new Set(arrangement.unpinned);
  const others = [...current]
    .sort((left, right) => left.order - right.order)
    .filter((pin) => !arranged.has(pin.key) && !unpinned.has(pin.key));
  return new Map<Key, number | null>([
    ...arrangement.pins.map((key, index) => [key, index] as const),
    ...others.map((pin, rank) => [pin.key, arrangement.pins.length + rank] as const),
    ...[...unpinned].filter((key) => !arranged.has(key)).map((key) => [key, null] as const),
  ]);
}
