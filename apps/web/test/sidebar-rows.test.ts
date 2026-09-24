import { expect, test } from "bun:test";

import {
  directRowsOf,
  directViewOf,
  nextPinOrder,
  pinOrdersAfterArrange,
} from "#src/features/conversations/sidebar-rows";

/**
 * The Chat sidebar keeps channels and DMs as keyed rows so a pin, a mark-unread, a close or a drag
 * can change one row on screen before the server answers. These are the conversions between the
 * rows and what the sidebar and the server exchange.
 */
const preferences = {
  conversations: ["helper", "scout"],
  pinned: [{ agentId: "helper", sortOrder: 2 }],
  hidden: ["scout"],
};

test("DM preferences and unread counts become one row per Agent, and back", () => {
  const rows = directRowsOf(preferences, { helper: 3, docs: 1 });
  expect(rows).toEqual([
    { agentId: "helper", conversation: true, pinned: true, sortOrder: 2, hidden: false, unread: 3 },
    {
      agentId: "scout",
      conversation: true,
      pinned: false,
      sortOrder: null,
      hidden: true,
      unread: 0,
    },
    {
      agentId: "docs",
      conversation: false,
      pinned: false,
      sortOrder: null,
      hidden: false,
      unread: 1,
    },
  ]);
  expect(directViewOf(rows)).toEqual({ preferences, unread: { helper: 3, docs: 1 } });
});

test("a closed DM that is pinned is not reported closed", () => {
  const rows = directRowsOf(preferences, {}).map((row) =>
    row.agentId === "helper" ? { ...row, hidden: true } : row,
  );
  expect(directViewOf(rows).preferences.hidden).toEqual(["scout"]);
});

test("a new pin goes after every pin the member has, channels and DMs alike", () => {
  expect(
    nextPinOrder([
      { pinned: true, order: 4 },
      { pinned: false, order: null },
    ]),
  ).toBe(5);
  expect(nextPinOrder([])).toBe(0);
});

test("after a drag the arranged pins take the first places and the other pins follow in order", () => {
  const orders = pinOrdersAfterArrange(
    [
      { key: "channel:ops", order: 0 },
      { key: "direct:helper", order: 1 },
      { key: "channel:eng", order: 2 },
      { key: "direct:docs", order: 3 },
    ],
    { pins: ["channel:eng", "direct:helper"], unpinned: ["channel:ops"] },
  );
  expect(orders).toEqual(
    new Map([
      ["channel:eng", 0],
      ["direct:helper", 1],
      ["direct:docs", 2],
      ["channel:ops", null],
    ]),
  );
});
