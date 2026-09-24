import { expect, test } from "bun:test";

import { splitPinnedConversations } from "#src/features/conversations/pinned-conversations";

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
const direct = (id: string, sortOrder: number | null = null) => ({
  agent: { id },
  preference: { pinned: sortOrder !== null, sortOrder },
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
