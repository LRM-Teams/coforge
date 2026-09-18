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
  userConversationChannel,
  workspaceConversationChannel,
} from "../src/features/conversations/conversation-realtime";

const channels = new Set(["channel-a", "channel-b"]);

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
      { conversations: channels },
    );
    expect(next).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
  });

  test("ignores channel events for conversations outside the known set", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "channel-z", sequence: 5 },
      { conversations: channels },
    );
    expect(next).toEqual({});
  });

  test("ignores events for the currently open conversation", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5 },
      {
        conversations: channels,
        openConversationId: "channel-a",
      },
    );
    expect(next).toEqual({});
  });

  test("never counts thread replies into conversation unread", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5, threadRootId: "root-1" },
      { conversations: channels },
    );
    expect(next).toEqual({});
  });

  test("does not double-count a late duplicate of the same sequence", () => {
    const afterFirst = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 5 },
      { conversations: channels },
    );
    const afterDuplicate = applyUnreadEvent(
      afterFirst,
      { conversationId: "channel-a", sequence: 5 },
      { conversations: channels },
    );
    const afterOlder = applyUnreadEvent(
      afterDuplicate,
      { conversationId: "channel-a", sequence: 3 },
      { conversations: channels },
    );
    expect(afterFirst).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
    expect(afterDuplicate).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
    expect(afterOlder).toEqual({ "channel-a": 1, "channel-a:seq": 5 });
  });

  test("increments per new sequence across conversations", () => {
    let state = applyUnreadEvent(
      {},
      { conversationId: "channel-a", sequence: 1 },
      { conversations: channels },
    );
    state = applyUnreadEvent(
      state,
      { conversationId: "channel-a", sequence: 2 },
      { conversations: channels },
    );
    state = applyUnreadEvent(
      state,
      { conversationId: "channel-b", sequence: 9 },
      { conversations: channels },
    );
    expect(state["channel-a"]).toBe(2);
    expect(state["channel-b"]).toBe(1);
    expect(state["channel-a:seq"]).toBe(2);
  });

  test("bumps a DM badge by the event's own Agent id, with no conversation alias", () => {
    // The user channel is already scoped to this viewer and names its badge directly, so the
    // event needs no listed-conversation check: a DM created after the last list fetch still
    // bumps live (ADR 0046).
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-conversation", sequence: 4, agentId: "agent-1" },
      { conversations: new Set() },
    );
    expect(next).toEqual({ "agent-1": 1, "agent-1:seq": 4 });
  });

  test("does not double-count a replayed DM event", () => {
    const seeded = { "agent-1": 1, "agent-1:seq": 4 };
    const next = applyUnreadEvent(
      seeded,
      { conversationId: "dm-conversation", sequence: 4, agentId: "agent-1" },
      { conversations: new Set() },
    );
    expect(next).toEqual({ "agent-1": 1, "agent-1:seq": 4 });
  });

  test("suppresses a DM event while that DM is the open conversation", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-conversation", sequence: 4, agentId: "agent-1" },
      { conversations: new Set(), openConversationId: "dm-conversation" },
    );
    expect(next).toEqual({});
  });

  test("suppresses a DM event while its Agent badge is the open conversation", () => {
    // The open DM's own incoming events must not flash its badge, even though the DM signal
    // channel carries no conversation id the channel route could match on.
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-conversation", sequence: 4, agentId: "agent-1" },
      { conversations: new Set(), openAgentId: "agent-1" },
    );
    expect(next).toEqual({});
  });

  test("never counts a thread reply in a DM", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-conversation", sequence: 4, agentId: "agent-1", threadRootId: "r1" },
      { conversations: new Set() },
    );
    expect(next).toEqual({});
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
    expect(event.agentId).toBeUndefined();
  });

  test("accepts the additive direct-message agent field", () => {
    const event = decodeMessageAvailableEvent({
      type: "message.available.v1",
      conversationId: "c1",
      messageId: "m1",
      sequence: 3,
      agentId: "a1",
    });
    expect(event.agentId).toBe("a1");
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

  test("rejects a non-string agentId", () => {
    expect(() =>
      decodeMessageAvailableEvent({
        type: "message.available.v1",
        conversationId: "c1",
        messageId: "m1",
        sequence: 3,
        agentId: 42,
      }),
    ).toThrow("invalid conversation event");
  });
});

test("conversation channel naming", () => {
  expect(workspaceConversationChannel("w-1")).toBe("chat:workspace:w-1");
  expect(userConversationChannel("u-1")).toBe("chat:user:u-1");
});
