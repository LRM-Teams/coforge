import { describe, expect, test } from "bun:test";

import {
  applyUnreadEvent,
  clearUnread,
  seedUnreadCounts,
  replaceUnreadCounts,
  latestTopLevelSequence,
} from "../src/features/conversations/conversation-unread";
import {
  decodeMessageAvailableEvent,
  workspaceConversationChannel,
} from "../src/features/conversations/conversation-realtime";

const channels = new Set(["channel-a", "channel-b"]);
const noAliases = {};

describe("seedUnreadCounts", () => {
  test("seeds from the server payload and skips zero counts", () => {
    const seeded = seedUnreadCounts([
      { id: "channel-a", unreadCount: 3 },
      { id: "channel-b" },
      { id: "channel-c", unreadCount: 0 },
      { id: "channel-d", unreadCount: 2 },
    ]);
    expect(seeded).toEqual({ "channel-a": 3, "channel-d": 2 });
  });
});

describe("applyUnreadEvent", () => {
  test("bumps only listed, not-open channels on a top-level message", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5 },
      { conversations: channels, conversationAgentIds: noAliases },
    );
    expect(next).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
  });

  test("ignores events for conversations outside the known set", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-x", sequence: 5 },
      { conversations: channels, conversationAgentIds: noAliases },
    );
    expect(next).toEqual({});
  });

  test("ignores events for the currently open conversation", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5 },
      {
        conversations: channels,
        conversationAgentIds: noAliases,
        openConversationId: "channel-a",
      },
    );
    expect(next).toEqual({});
  });

  test("never counts thread replies into conversation unread", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5, threadRootId: "root-1" },
      { conversations: channels, conversationAgentIds: noAliases },
    );
    expect(next).toEqual({});
  });

  test("does not double-count a late duplicate of the same sequence", () => {
    const afterFirst = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5 },
      { conversations: channels, conversationAgentIds: noAliases },
    );
    const afterDuplicate = applyUnreadEvent(
      afterFirst,
      { conversationId: "channel-a", sequence: 5 },
      { conversations: channels, conversationAgentIds: noAliases },
    );
    const afterOlder = applyUnreadEvent(
      afterDuplicate,
      { conversationId: "channel-a", sequence: 3 },
      { conversations: channels, conversationAgentIds: noAliases },
    );
    expect(afterFirst).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
    expect(afterDuplicate).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
    expect(afterOlder).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
  });

  test("increments per new sequence across conversations", () => {
    let state = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 1 },
      { conversations: channels, conversationAgentIds: noAliases },
    );
    state = applyUnreadEvent(
      state,
      { conversationId: "channel-a", sequence: 2 },
      { conversations: channels, conversationAgentIds: noAliases },
    );
    state = applyUnreadEvent(
      state,
      { conversationId: "channel-b", sequence: 9 },
      { conversations: channels, conversationAgentIds: noAliases },
    );
    expect(state["channel-a"]).toBe(2);
    expect(state["channel-b"]).toBe(1);
    expect(state["channel-a:seq"]).toBe(2);
  });

  test("routes a DM event to the Agent-keyed badge through the alias map", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-conversation", sequence: 4 },
      {
        conversations: new Set(["dm-conversation"]),
        conversationAgentIds: { "dm-conversation": "agent-1" },
      },
    );
    expect(next).toEqual({ "agent-1": 1, "agent-1:seq": 4 });
  });

  test("does not double-count a DM event replayed after the alias map learned the conversation", () => {
    const seeded = { "agent-1": 1, "agent-1:seq": 4 };
    const next = applyUnreadEvent(
      seeded,
      { conversationId: "dm-conversation", sequence: 4 },
      {
        conversations: new Set(["dm-conversation"]),
        conversationAgentIds: { "dm-conversation": "agent-1" },
      },
    );
    expect(next).toEqual({ "agent-1": 1, "agent-1:seq": 4 });
  });
});

describe("clearUnread", () => {
  test("clears the badge and records the read boundary", () => {
    const state = { "channel-a": 4, "channel-a:seq": 10, "channel-b": 1 };
    const next = clearUnread(state, "channel-a", 12);
    expect(next).toEqual({ "channel-b": 1, "channel-a:seq": 12 });
  });

  test("keeps the highest boundary the badge already counted when reopened without a sequence", () => {
    const state = { "channel-a": 4, "channel-a:seq": 10 };
    const next = clearUnread(state, "channel-a");
    expect(next).toEqual({ "channel-a:seq": 10 });
  });

  test("never moves the boundary backwards", () => {
    const state = { "channel-a:seq": 12 };
    const next = clearUnread(state, "channel-a", 5);
    expect(next).toEqual({ "channel-a:seq": 12 });
  });

  test("clears an Agent-keyed DM badge by Agent id", () => {
    const state = { "agent-1": 2, "agent-1:seq": 8 };
    const next = clearUnread(state, "agent-1", 9);
    expect(next).toEqual({ "agent-1:seq": 9 });
  });
});

describe("replaceUnreadCounts", () => {
  test("server counts win over local arithmetic; boundaries survive", () => {
    const local = {
      "channel-a": 2,
      "channel-a:seq": 8,
      "agent-1": 5,
    };
    const next = replaceUnreadCounts(local, [
      { id: "channel-a", unreadCount: 1 },
      { id: "agent-1" },
    ]);
    // `agent-1` had no server count (0 unread), so the stale local badge is dropped.
    expect(next).toEqual({ "channel-a": 1, "channel-a:seq": 8 });
  });
});

describe("latestTopLevelSequence", () => {
  test("ignores thread replies", () => {
    expect(
      latestTopLevelSequence([
        { sequence: 1 },
        { sequence: 2, threadRootId: "root" },
        { sequence: 3 },
        { sequence: 4, threadRootId: "root" },
      ]),
    ).toBe(3);
  });

  test("is zero for an empty page", () => {
    expect(latestTopLevelSequence([])).toBe(0);
  });
});

describe("decodeMessageAvailableEvent", () => {
  test("accepts the additive workspace and thread fields", () => {
    const event = decodeMessageAvailableEvent({
      type: "message.available.v1",
      conversationId: "c1",
      messageId: "m1",
      sequence: 3,
      workspaceId: "w1",
      threadRootId: "r1",
    });
    expect(event.workspaceId).toBe("w1");
    expect(event.threadRootId).toBe("r1");
  });

  test("rejects a non-string workspaceId", () => {
    expect(() =>
      decodeMessageAvailableEvent({
        type: "message.available.v1",
        conversationId: "c1",
        messageId: "m1",
        sequence: 3,
        workspaceId: 42,
      }),
    ).toThrow("invalid conversation event");
  });
});

test("workspace conversation channel naming", () => {
  expect(workspaceConversationChannel("w-1")).toBe("chat:workspace:w-1");
});
