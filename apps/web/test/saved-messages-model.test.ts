import { expect, test } from "bun:test";

import {
  agentIdFromDirectKey,
  savedJumpTarget,
} from "@/features/conversations/saved-messages-model";

/**
 * #127's jump-back, amended after the boss's ruling (click a saved card → land at the
 * message's POSITION in the conversation, never open the thread pane). The `#message-<id>`
 * hash is the notification deep-link path: `threadRootFromMessageAnchor` +
 * `openThreadFromHash` auto-promote it into `threadRootId` search, so saved jumps must not
 * carry a hash at all. They navigate with the conversation routes' existing `?message=<uuid>`
 * search param (schema already declares it), which the pane consumes as position-only (load
 * the window around it, scroll, never touch the thread). A thread reply is rendered only
 * through its root's row, so its anchor is the root — "the row in the stream" (muse/deepseek ①).
 *
 * Channels route by conversation id; direct messages route by the Agent id encoded
 * structurally in `directKey` (`agent:<agentId>|user:<userId>`), never guessed from UUIDs.
 */

const channelConversation = {
  id: "22222222-2222-4222-8222-222222222222",
  channelName: "coforge",
  directKey: null,
};

test("a saved channel message jumps to its channel at its own position (search param, no hash)", () => {
  expect(
    savedJumpTarget(channelConversation, {
      id: "33333333-3333-4333-8333-333333333333",
      threadRootId: undefined,
    }),
  ).toEqual({
    to: "/messages/channels/$channelId",
    params: { channelId: "22222222-2222-4222-8222-222222222222" },
    search: { message: "33333333-3333-4333-8333-333333333333" },
  });
});

test("a saved thread reply anchors to its root's row — the stream position, never the thread pane", () => {
  expect(
    savedJumpTarget(channelConversation, {
      id: "33333333-3333-4333-8333-333333333333",
      threadRootId: "99999999-9999-4999-8999-999999999999",
    }),
  ).toEqual({
    to: "/messages/channels/$channelId",
    params: { channelId: "22222222-2222-4222-8222-222222222222" },
    search: { message: "99999999-9999-4999-8999-999999999999" },
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
      { id: "33333333-3333-4333-8333-333333333333", threadRootId: undefined },
    ),
  ).toEqual({
    to: "/messages/$agentId",
    params: { agentId: "a-9" },
    search: { message: "33333333-3333-4333-8333-333333333333" },
  });
  expect(agentIdFromDirectKey("agent:a-9|user:u-1")).toBe("a-9");
});

test("a malformed directKey degrades to the conversation list instead of a broken route", () => {
  expect(agentIdFromDirectKey("not-a-key")).toBeNull();
  expect(
    savedJumpTarget(
      {
        id: "44444444-4444-4444-8444-444444444444",
        channelName: null,
        directKey: "legacy",
      },
      { id: "33333333-3333-4333-8333-333333333333", threadRootId: undefined },
    ),
  ).toEqual({ to: "/messages" });
});
