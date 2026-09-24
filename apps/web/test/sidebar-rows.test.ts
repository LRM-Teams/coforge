import { expect, test } from "bun:test";

import { directListsOf, directRowsOf } from "#src/features/conversations/sidebar-rows";

/**
 * The Chat sidebar keeps DMs as one row per Agent, so a pin, a mark-unread or a close can change
 * one row on screen before the server answers. These are the conversions from what the server
 * returns and to what the sidebar reads.
 */
const preferences = {
  conversations: ["helper", "scout"],
  pinned: [{ agentId: "helper", sortOrder: 2 }],
  hidden: ["helper", "scout"],
};

test("DM preferences and unread counts become one row per Agent", () => {
  expect(directRowsOf(preferences, { helper: 3, docs: 1 })).toEqual([
    {
      agentId: "helper",
      conversation: true,
      pinned: true,
      pinSortOrder: 2,
      hidden: true,
      unreadCount: 3,
    },
    {
      agentId: "scout",
      conversation: true,
      pinned: false,
      pinSortOrder: null,
      hidden: true,
      unreadCount: 0,
    },
    {
      agentId: "docs",
      conversation: false,
      pinned: false,
      pinSortOrder: null,
      hidden: false,
      unreadCount: 1,
    },
  ]);
});

test("the sidebar reads rows by Agent; a closed DM that is pinned is not closed for the list", () => {
  const lists = directListsOf(directRowsOf(preferences, { helper: 3 }));
  expect(lists.byAgent.get("helper")?.pinSortOrder).toBe(2);
  expect(lists.hiddenAgentIds).toEqual(["scout"]);
  expect(lists.unread).toEqual({ helper: 3 });
});
