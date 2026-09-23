import { expect, test } from "bun:test";

import {
  agentIdFromDirectKey,
  savedJumpTarget,
} from "../src/features/conversations/saved-messages-model";

/**
 * #127's jump-back: a saved card returns to its original conversation through the existing
 * `#message-<id>` hash anchor the notification deep links already promote. Channels route by
 * conversation id; direct messages route by Agent id, which is encoded structurally in the
 * repository's own `directKey` format (`agent:<agentId>|user:<userId>`), so the parse never has
 * to guess from UUIDs or a viewer id.
 */

test("a saved channel message jumps to its channel at the message hash anchor", () => {
  expect(
    savedJumpTarget(
      { id: "22222222-2222-4222-8222-222222222222", channelName: "coforge", directKey: null },
      "33333333-3333-4333-8333-333333333333",
    ),
  ).toEqual({
    to: "/messages/channels/$channelId",
    params: { channelId: "22222222-2222-4222-8222-222222222222" },
    hash: "message-33333333-3333-4333-8333-333333333333",
  });
});

test("a saved direct message parses the Agent id out of its directKey for the DM route", () => {
  expect(
    savedJumpTarget(
      {
        id: "44444444-4444-4444-8444-444444444444",
        channelName: null,
        directKey: "agent:a-9|user:u-1",
      },
      "33333333-3333-4333-8333-333333333333",
    ),
  ).toEqual({
    to: "/messages/$agentId",
    params: { agentId: "a-9" },
    hash: "message-33333333-3333-4333-8333-333333333333",
  });
  expect(agentIdFromDirectKey("agent:a-9|user:u-1")).toBe("a-9");
});

test("a malformed directKey degrades to the conversation list instead of a broken route", () => {
  expect(agentIdFromDirectKey("not-a-key")).toBeNull();
  expect(
    savedJumpTarget(
      { id: "44444444-4444-4444-8444-444444444444", channelName: null, directKey: "legacy" },
      "33333333-3333-4333-8333-333333333333",
    ),
  ).toEqual({ to: "/messages" });
});
