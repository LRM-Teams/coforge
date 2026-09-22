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
        agent: { name: "builder", displayName: "Builder", deletedAt: null, avatarObjectKey: null },
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
        user: {
          id: "user-1",
          username: "ada",
          displayName: "Ada Lovelace",
          avatarObjectKey: null,
        },
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.senderKind).toBe("user");
  expect(view.senderAgentId).toBeUndefined();
});

test("a channel mention exposes the current display label separately from its stable handle", () => {
  const view = channelMessageView(
    row({
      mentions: [
        {
          kind: "user",
          actorId: "user-ada",
          handle: "ada",
          member: { user: { displayName: "Ada Lovelace" }, agent: null },
        },
      ],
    }),
    WORKSPACE_ID,
  );
  expect(view.mentions).toEqual([
    { kind: "user", actorId: "user-ada", handle: "ada", label: "Ada Lovelace" },
  ]);
});

test("a system message (no sender) has no senderAgentId", () => {
  const view = channelMessageView(row({ sender: null }), WORKSPACE_ID);
  expect(view.senderKind).toBe("system");
  expect(view.senderAgentId).toBeUndefined();
});

// The browser shows a display name, like Slack; `@handle` stays what you type and what the
// Agent-facing projection sends. Before this, a person read as "@ada" beside an Agent reading
// as its display name, and the three browser projections each had their own rule.
test("a person's message is attributed to their display name, not their @username", () => {
  const view = channelMessageView(
    row({
      sender: {
        agentId: null,
        agent: null,
        user: {
          id: "user-1",
          username: "ada",
          displayName: "Ada Lovelace",
          avatarObjectKey: null,
        },
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.senderName).toBe("Ada Lovelace");
});

test("a person with no display name falls back to their username, without an @", () => {
  const view = channelMessageView(
    row({
      sender: {
        agentId: null,
        agent: null,
        user: {
          id: "user-1",
          username: "ada",
          displayName: null,
          avatarObjectKey: null,
        },
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.senderName).toBe("ada");
});

test("a blank display name is treated as unset rather than shown as an empty name", () => {
  const view = channelMessageView(
    row({
      sender: {
        agentId: null,
        agent: null,
        user: {
          id: "user-1",
          username: "ada",
          displayName: "   ",
          avatarObjectKey: null,
        },
      },
    }),
    WORKSPACE_ID,
  );
  expect(view.senderName).toBe("ada");
});

test("an Agent's message is attributed to its display name, falling back to its handle", () => {
  const named = channelMessageView(
    row({
      sender: {
        agentId: "agent-builder",
        agent: { name: "builder", displayName: "Builder", deletedAt: null, avatarObjectKey: null },
        user: null,
      },
    }),
    WORKSPACE_ID,
  );
  expect(named.senderName).toBe("Builder");

  const unnamed = channelMessageView(
    row({
      sender: {
        agentId: "agent-builder",
        agent: { name: "builder", displayName: null, deletedAt: null, avatarObjectKey: null },
        user: null,
      },
    }),
    WORKSPACE_ID,
  );
  expect(unnamed.senderName).toBe("builder");
});

test("a server-authored message stays attributed to System", () => {
  expect(channelMessageView(row({ sender: null }), WORKSPACE_ID).senderName).toBe("System");
});
