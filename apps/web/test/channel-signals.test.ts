import { expect, test } from "bun:test";

import {
  channelNamesAfter,
  compareChannelNames,
} from "#src/features/conversations/channel-signals";

/**
 * A channel created, changed or gone anywhere in the Workspace updates every channel's name (what a
 * body's channel links and the `#` list read) from the event alone, as Slack's `channel_created`
 * and `channel_rename` carry the channel; only an event without the channel's info needs a read.
 */
const ids = { workspaceId: "w" };
const lab = { id: "c-lab", name: "lab", description: "", archived: false };
const general = { id: "c-general", name: "general", description: "Everyone", archived: false };

test("a created channel joins the names, and a changed one takes its new info", () => {
  expect(
    channelNamesAfter([general], {
      type: "channel.created.v1",
      ...ids,
      conversationId: "c-lab",
      channel: { name: "lab", description: "", archived: false },
    }),
  ).toEqual([general, lab]);
  expect(
    channelNamesAfter([general, lab], {
      type: "channel.updated.v1",
      ...ids,
      conversationId: "c-lab",
      channel: { name: "lab-2", description: "Tests", archived: true },
    }),
  ).toEqual([general, { id: "c-lab", name: "lab-2", description: "Tests", archived: true }]);
});

test("a deleted or hidden channel leaves the names", () => {
  expect(
    channelNamesAfter([general, lab], {
      type: "channel.updated.v1",
      ...ids,
      conversationId: "c-lab",
      gone: true,
    }),
  ).toEqual([general]);
});

test("an event naming only ids cannot be applied", () => {
  expect(
    channelNamesAfter([general], { type: "channel.created.v1", ...ids, conversationId: "c-lab" }),
  ).toBeUndefined();
  expect(
    channelNamesAfter([general], { type: "channel.updated.v1", ...ids, conversationId: "c-lab" }),
  ).toBeUndefined();
});

test("channels list #general first, then by name in code point order, whatever the collation", () => {
  expect(["b", "a_b", "general", "a-b", "ab"].sort(compareChannelNames)).toEqual([
    "general",
    "a-b",
    "a_b",
    "ab",
    "b",
  ]);
});
