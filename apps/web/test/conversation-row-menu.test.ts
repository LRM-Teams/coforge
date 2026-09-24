import { expect, test } from "bun:test";

import {
  conversationRowMenuEnabled,
  conversationRowMenuItems,
  directRowPreference,
} from "#src/features/conversations/conversation-row-menu-model";
import { directRowsOf } from "#src/features/conversations/sidebar-rows";

/**
 * P3a (#126) of the saved/pinned plan: the conversation row's right-click menu. The mockup
 * (#122, boss's reference image) fixes the item set and their order — Mark as Unread, Pin, then
 * Close Chat behind a separator; "Move to section" was removed from the plan with the schema
 * field itself. Only an active member may open it: the P2b mutations all guard membership
 * server-side, so an unjoined row offering them would only ever fail with ACCESS_DENIED.
 */
test("only an active member's row opens the menu", () => {
  expect(conversationRowMenuEnabled({ joined: true })).toBe(true);
  expect(conversationRowMenuEnabled({ joined: false })).toBe(false);
});

test("items follow the mockup's order: mark-unread, pin, close-chat last", () => {
  expect(conversationRowMenuItems({ pinned: false }).map((item) => item.id)).toEqual([
    "mark-unread",
    "pin",
    "close-chat",
  ]);
});

test("the pin item carries the row's pinned state so the label can read Pin or Unpin", () => {
  const unpinned = conversationRowMenuItems({ pinned: false });
  const pinned = conversationRowMenuItems({ pinned: true });
  expect(unpinned.find((item) => item.id === "pin")?.pinned).toBe(false);
  expect(pinned.find((item) => item.id === "pin")?.pinned).toBe(true);
});

test("a DM row is enabled, pinned and hidden only by its own preferences", () => {
  const rows = new Map(
    directRowsOf(
      {
        conversations: ["agent-dm", "agent-closed"],
        pinned: [{ agentId: "agent-dm", sortOrder: 3 }],
        hidden: ["agent-closed"],
      },
      {},
    ).map((row) => [row.agentId, row]),
  );

  // A conversation: the menu is offered, and its pin carries the order the sidebar sorts by.
  expect(directRowPreference(rows.get("agent-dm"))).toEqual({
    enabled: true,
    pinned: true,
    hidden: false,
    sortOrder: 3,
  });

  // An Agent the viewer has never written to: a row, but not a conversation — no menu, because a
  // preference could only answer NOT_FOUND.
  expect(directRowPreference(rows.get("agent-new"))).toEqual({
    enabled: false,
    pinned: false,
    hidden: false,
    sortOrder: null,
  });

  // A closed conversation is filtered out of the list; only a conversation can be closed, so an
  // Agent row is never hidden by this rule.
  expect(directRowPreference(rows.get("agent-closed")).hidden).toBe(true);
});
