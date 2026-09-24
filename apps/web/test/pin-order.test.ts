import { expect, test } from "bun:test";

import { nextPinOrder, pinOrdersAfterArrange } from "#src/lib/pin-order";

/** The order rules a member's pins follow, shared by the server that stores them and the sidebar
 * that shows a change before the server answers. */
test("a new pin goes after every pin the member has", () => {
  expect(nextPinOrder([4, null, 1])).toBe(5);
  expect(nextPinOrder([])).toBe(0);
});

test("after a drag the arranged pins take the first places and the other pins follow in order", () => {
  const orders = pinOrdersAfterArrange(
    [
      { key: "ops", order: 0 },
      { key: "helper", order: 1 },
      { key: "eng", order: 2 },
      { key: "docs", order: 3 },
    ],
    { pins: ["eng", "helper"], unpinned: ["ops"] },
  );
  expect(orders).toEqual(
    new Map([
      ["eng", 0],
      ["helper", 1],
      ["docs", 2],
      ["ops", null],
    ]),
  );
});
