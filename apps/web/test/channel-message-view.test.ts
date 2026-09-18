import { expect, test } from "bun:test";

import {
  channelMessageView,
  type ChannelMessageRow,
} from "../src/server/conversations/public-channels.server";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";

function row(overrides: Partial<ChannelMessageRow>): ChannelMessageRow {
  return {
    id: "message-1",
    sequence: 1,
    threadRootId: null,
    senderMemberId: "member-1",
    body: "hello",
    createdAt: new Date("2026-09-17T10:00:00Z"),
    sender: null,
    attachments: [],
    mentions: [],
    reactions: [],
    ...overrides,
  };
}

test("an Agent-sent channel message carries senderAgentId", () => {
  const view = channelMessageView(
    row({
      sender: {
        agentId: "agent-builder",
        agent: { name: "builder", deletedAt: null },
        user: null,
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.senderKind).toBe("agent");
  expect(view.senderAgentId).toBe("agent-builder");
});

test("a user-sent channel message has no senderAgentId", () => {
  const view = channelMessageView(
    row({
      sender: {
        agentId: null,
        agent: null,
        user: { id: "user-1", username: "ada", avatarObjectKey: null },
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.senderKind).toBe("user");
  expect(view.senderAgentId).toBeUndefined();
});

test("a system message (no sender) has no senderAgentId", () => {
  const view = channelMessageView(row({ sender: null }), WORKSPACE_ID);
  expect(view.senderKind).toBe("system");
  expect(view.senderAgentId).toBeUndefined();
});
