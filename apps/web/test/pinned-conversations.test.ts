import { expect, test } from "bun:test";

import {
  canDropInto,
  dropTarget,
  moveInDirectory,
  pinsAfterDrag,
  splitPinnedConversations,
  type DirectoryLayout,
} from "#src/features/conversations/pinned-conversations";

/**
 * The Chat sidebar's Pinned section: the member's pinned channels and DMs in one list, in the
 * order they were pinned, and nowhere else in the sidebar.
 */
const channel = (name: string, pinSortOrder: number | null = null) => ({
  id: name,
  name,
  pinned: pinSortOrder !== null,
  pinSortOrder,
});
const direct = (id: string, sortOrder: number | null = null, hidden = false) => ({
  agent: { id },
  preference: { pinned: sortOrder !== null, sortOrder, hidden },
});

test("pinned channels and DMs share one list ordered by pin order, and leave their own sections", () => {
  const split = splitPinnedConversations(
    [channel("general"), channel("ops", 2), channel("eng", 0)],
    [direct("helper", 1), direct("scout")],
  );
  expect(split.pinned.map((entry) => entry.id)).toEqual(["eng", "helper", "ops"]);
  expect(split.pinned.map((entry) => entry.kind)).toEqual(["channel", "direct", "channel"]);
  expect(split.channels.map((entry) => entry.id)).toEqual(["general"]);
  expect(split.directs.map((entry) => entry.agent.id)).toEqual(["scout"]);
});

test("pins with the same order keep channels first, each in the order its own list gives", () => {
  const split = splitPinnedConversations(
    [channel("general", 0), channel("ops", 0)],
    [direct("helper", 0)],
  );
  expect(split.pinned.map((entry) => entry.id)).toEqual(["general", "ops", "helper"]);
});

test("with nothing pinned the section is empty and the other sections keep every row", () => {
  const split = splitPinnedConversations([channel("general")], [direct("helper")]);
  expect(split.pinned).toEqual([]);
  expect(split.channels).toHaveLength(1);
  expect(split.directs).toHaveLength(1);
});

test("closing a chat hides it from its own section but never from Pinned", () => {
  const split = splitPinnedConversations(
    [channel("general")],
    [direct("helper", 0, true), direct("scout", null, true), direct("docs")],
  );
  expect(split.pinned.map((entry) => entry.id)).toEqual(["helper"]);
  expect(split.directs.map((entry) => entry.agent.id)).toEqual(["docs"]);
});

/**
 * Dragging rows between the sidebar's sections. Rows are keyed `channel:<id>` / `direct:<agentId>`;
 * `natural` is each section's own order (the channel list, the Agent list), which a row returns to
 * when it leaves Pinned.
 */
const natural = {
  channels: ["channel:general", "channel:ops", "channel:eng"],
  agents: ["direct:helper", "direct:scout"],
};
const layout: DirectoryLayout = {
  pinned: ["channel:ops", "direct:helper"],
  channels: ["channel:general", "channel:eng"],
  agents: ["direct:scout"],
};

test("a row dragged into Pinned lands where it is dropped and leaves its own section", () => {
  const moved = moveInDirectory(layout, natural, "channel:eng", "pinned", 1);
  expect(moved.pinned).toEqual(["channel:ops", "channel:eng", "direct:helper"]);
  expect(moved.channels).toEqual(["channel:general"]);
  expect(pinsAfterDrag(layout, moved)).toEqual({
    pins: [
      { kind: "channel", channelId: "ops" },
      { kind: "channel", channelId: "eng" },
      { kind: "direct", agentId: "helper" },
    ],
    unpinned: [],
  });
});

test("a pinned row dragged back to its own section is unpinned and returns to its natural place", () => {
  const moved = moveInDirectory(layout, natural, "channel:ops", "channels", 0);
  expect(moved.pinned).toEqual(["direct:helper"]);
  expect(moved.channels).toEqual(["channel:general", "channel:ops", "channel:eng"]);
  expect(pinsAfterDrag(layout, moved)).toEqual({
    pins: [{ kind: "direct", agentId: "helper" }],
    unpinned: [{ kind: "channel", channelId: "ops" }],
  });
});

test("a row cannot be dropped into the other kind's section", () => {
  expect(canDropInto("channel:ops", "pinned")).toBe(true);
  expect(canDropInto("channel:ops", "channels")).toBe(true);
  expect(canDropInto("channel:ops", "agents")).toBe(false);
  expect(canDropInto("direct:scout", "channels")).toBe(false);
  expect(moveInDirectory(layout, natural, "channel:ops", "agents", 0)).toBe(layout);
  expect(moveInDirectory(layout, natural, "direct:scout", "channels", 0)).toBe(layout);
});

test("pinned rows reorder among themselves; a section's own rows keep their order", () => {
  const reordered = moveInDirectory(layout, natural, "direct:helper", "pinned", 0);
  expect(reordered.pinned).toEqual(["direct:helper", "channel:ops"]);
  expect(pinsAfterDrag(layout, reordered)).toEqual({
    pins: [
      { kind: "direct", agentId: "helper" },
      { kind: "channel", channelId: "ops" },
    ],
    unpinned: [],
  });

  const unchanged = moveInDirectory(layout, natural, "channel:eng", "channels", 0);
  expect(unchanged.channels).toEqual(["channel:general", "channel:eng"]);
  expect(pinsAfterDrag(layout, unchanged)).toBeNull();
});

/**
 * Where a dragged row lands for what it is over: above or below the hovered row by which half of
 * it the dragged row's centre is in, so crossing a row's middle is what moves it.
 */
test("the row under the dragged one decides by its halves, including a midline crossed inside it", () => {
  const current: DirectoryLayout = {
    pinned: ["channel:a", "channel:b", "channel:c"],
    channels: [],
    agents: [],
  };
  const overB = { key: "channel:b", section: "pinned" as const, type: "row" as const };
  // Dragging c up: in b's lower half nothing moves yet; in its upper half c goes above b.
  expect(dropTarget(current, "channel:c", overB, { dragged: 115, over: 100 })).toEqual({
    section: "pinned",
    index: 2,
  });
  expect(dropTarget(current, "channel:c", overB, { dragged: 95, over: 100 })).toEqual({
    section: "pinned",
    index: 1,
  });
  // Over itself, or over the list it is already in, it stays where it is.
  const overSelf = { key: "channel:c", section: "pinned" as const, type: "row" as const };
  expect(dropTarget(current, "channel:c", overSelf, { dragged: 0, over: 0 })).toBeNull();
  const overList = { key: "section:pinned", section: "pinned" as const, type: "section" as const };
  expect(dropTarget(current, "channel:c", overList, null)).toBeNull();
  // Over a list it is not in yet, it joins at the end.
  expect(dropTarget({ ...current, pinned: [] }, "channel:c", overList, null)).toEqual({
    section: "pinned",
    index: 0,
  });
});

test("a move that leaves every row where it is returns the same layout, so nothing re-renders", () => {
  expect(moveInDirectory(layout, natural, "channel:ops", "pinned", 0)).toBe(layout);
  expect(moveInDirectory(layout, natural, "channel:eng", "channels", 0)).toBe(layout);
});
