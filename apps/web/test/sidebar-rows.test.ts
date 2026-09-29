import { expect, test } from "bun:test";

import {
  directListsOf,
  directRowsOf,
  listedDirectIds,
} from "#src/features/conversations/sidebar-rows";

/**
 * The Chat sidebar keeps DMs as one row per conversation, with an Agent or a member alike, so a
 * pin, a mark-unread or a close can change one row on screen before the server answers. These are
 * the conversions from what the server returns and to what the sidebar reads.
 */
const grace = {
  kind: "people" as const,
  userId: "grace",
  username: "grace",
  displayName: "Grace",
  avatarUrl: null,
};
const preferences = {
  conversations: [
    { conversationId: "dm-helper", peer: { kind: "agent" as const, agentId: "helper" } },
    { conversationId: "dm-grace", peer: grace },
    { conversationId: "dm-scout", peer: { kind: "agent" as const, agentId: "scout" } },
  ],
  pinned: [{ conversationId: "dm-helper", sortOrder: 2 }],
  hidden: ["dm-helper", "dm-scout"],
};

test("DM preferences and unread counts become one row per conversation", () => {
  // A count for a conversation the list does not name makes no row.
  expect(directRowsOf(preferences, { "dm-helper": 3, "dm-grace": 1, "dm-other": 4 })).toEqual([
    {
      conversationId: "dm-helper",
      position: 0,
      peer: { kind: "agent", agentId: "helper" },
      pinned: true,
      pinSortOrder: 2,
      hidden: true,
      unreadCount: 3,
    },
    {
      conversationId: "dm-grace",
      position: 1,
      peer: grace,
      pinned: false,
      pinSortOrder: null,
      hidden: false,
      unreadCount: 1,
    },
    {
      conversationId: "dm-scout",
      position: 2,
      peer: { kind: "agent", agentId: "scout" },
      pinned: false,
      pinSortOrder: null,
      hidden: true,
      unreadCount: 0,
    },
  ]);
});

test("the sidebar reads rows by conversation, in the server's order; a closed DM that is pinned is not closed for the list", () => {
  // The synced collection hands rows back in its own key order.
  const lists = directListsOf(directRowsOf(preferences, { "dm-helper": 3 }).reverse());
  expect(lists.rows.map((row) => row.conversationId)).toEqual([
    "dm-helper",
    "dm-grace",
    "dm-scout",
  ]);
  expect(lists.closedIds).toEqual(["dm-scout"]);
  expect(lists.unread).toEqual({ "dm-helper": 3 });
  // An Agent's own DM, for what opens it from outside the list.
  expect(lists.agentDms.get("helper")).toBe("dm-helper");
  expect(lists.agentDms.has("grace")).toBe(false);
});

test("the listed DMs are the open ones with a member, or with an Agent that is still there", () => {
  const lists = directListsOf(directRowsOf(preferences, {}));
  expect(listedDirectIds(lists, [{ id: "helper" }, { id: "scout" }])).toEqual([
    "dm-helper",
    "dm-grace",
  ]);
  // A deleted Agent's DM is not listed.
  expect(listedDirectIds(lists, [])).toEqual(["dm-grace"]);
});
