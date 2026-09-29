import { describe, expect, test } from "bun:test";

import {
  applyMarked,
  applyUnreadEvent,
  sidebarListsChangedBy,
  sidebarRefreshQueue,
  workspaceSignalLists,
  clearUnread,
  closedConversationLists,
  seedUnreadCounts,
  unknownAgentOf,
  replaceUnreadCounts,
  latestTopLevelSequence,
  persistReadCursor,
} from "#src/features/conversations/conversation-unread";
import {
  decodeMessageAvailableEvent,
  userConversationChannel,
  workspaceConversationChannel,
} from "#src/features/conversations/conversation-realtime";

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

  test("bumps a DM badge by its conversation id, even for a DM the list has not read yet", () => {
    // The user channel is already scoped to this viewer, and a DM event says it is one (the Agent
    // or member on the other side): a DM created after the last list fetch still bumps live.
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-conversation", sequence: 4, agentId: "agent-1" },
      { conversations: new Set() },
    );
    expect(next).toEqual({ "dm-conversation": 1, "dm-conversation:seq": 4 });
  });

  test("bumps a DM between members by its conversation id too", () => {
    const next = applyUnreadEvent(
      {},
      { conversationId: "dm-people", sequence: 2, peerUserId: "grace" },
      { conversations: new Set() },
    );
    expect(next).toEqual({ "dm-people": 1, "dm-people:seq": 2 });
  });

  test("does not double-count a replayed DM event", () => {
    const seeded = { "dm-conversation": 1, "dm-conversation:seq": 4 };
    const next = applyUnreadEvent(
      seeded,
      { conversationId: "dm-conversation", sequence: 4, agentId: "agent-1" },
      { conversations: new Set() },
    );
    expect(next).toEqual(seeded);
  });

  test("suppresses a DM event while that DM is the open conversation", () => {
    for (const event of [
      { conversationId: "dm-conversation", sequence: 4, agentId: "agent-1" },
      { conversationId: "dm-conversation", sequence: 4, peerUserId: "grace" },
    ])
      expect(
        applyUnreadEvent({}, event, {
          conversations: new Set(),
          openConversationId: "dm-conversation",
        }),
      ).toEqual({});
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

  test("a suppressed conversation keeps its boundary but no badge", () => {
    // `newest-unread`: the server cursor has deliberately not advanced for the open
    // conversation, so a refresh must not re-raise the badge of what is on screen.
    const next = replaceUnreadCounts(
      { "channel-a": 0, "channel-a:seq": 8, "channel-b": 0 },
      [
        { id: "channel-a", unreadCount: 3 },
        { id: "channel-b", unreadCount: 2 },
      ],
      new Set(["channel-a"]),
    );
    expect(next).toEqual({ "channel-b": 2, "channel-a:seq": 8 });
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

describe("persistReadCursor", () => {
  test("returns after the first success", async () => {
    const calls: number[] = [];
    await persistReadCursor(async () => {
      calls.push(1);
    }, "channel:c1");
    expect(calls).toHaveLength(1);
  });

  test("retries once after a transient failure", async () => {
    let attempts = 0;
    await persistReadCursor(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("502");
    }, "channel:c1");
    expect(attempts).toBe(2);
  });

  test("gives up after the retry and warns instead of throwing", async () => {
    let attempts = 0;
    const warnings: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      await persistReadCursor(async () => {
        attempts += 1;
        throw new Error("502");
      }, "agent:a1");
    } finally {
      console.warn = original;
    }
    expect(attempts).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0])).toContain("read cursor did not persist");
  });
});

test("a new top-level message in a chat the sidebar is not showing makes only that kind's list stale", () => {
  // The listed chats: channels and the DMs the sidebar shows, by conversation id.
  const listed = new Set(["channel-1", "dm-listed"]);
  const message = { conversationId: "channel-2", sequence: 5 };

  // A channel missing from the list (the viewer closed it) re-reads the channel list; a closed DM,
  // and a DM that started after the sidebar read its list, re-read the DM list.
  expect(closedConversationLists(message, listed)).toEqual(["channels"]);
  expect(
    closedConversationLists(
      { ...message, conversationId: "dm-closed", agentId: "agent-closed" },
      listed,
    ),
  ).toEqual(["dms"]);
  expect(
    closedConversationLists({ ...message, conversationId: "dm-new", agentId: "agent-new" }, listed),
  ).toEqual(["dms"]);
  expect(
    closedConversationLists(
      { ...message, conversationId: "dm-member", peerUserId: "grace" },
      listed,
    ),
  ).toEqual(["dms"]);

  // Listed chats and thread replies do not: nothing new would appear in the list.
  expect(closedConversationLists({ ...message, conversationId: "channel-1" }, listed)).toEqual([]);
  expect(
    closedConversationLists(
      { ...message, conversationId: "dm-listed", agentId: "agent-open" },
      listed,
    ),
  ).toEqual([]);
  expect(closedConversationLists({ ...message, threadRootId: "root-1" }, listed)).toEqual([]);
});

test("a DM signal from an Agent outside the viewer's roster names that Agent; anything else names none", () => {
  const known = new Set(["agent-known"]);
  const message = { conversationId: "dm-1", sequence: 1 };
  // A new Agent (made from an action card, or in another tab) writing first: its row needs it.
  expect(unknownAgentOf({ ...message, agentId: "agent-new" }, known)).toBe("agent-new");
  expect(unknownAgentOf({ ...message, agentId: "agent-known" }, known)).toBeUndefined();
  expect(unknownAgentOf({ ...message, peerUserId: "grace" }, known)).toBeUndefined();
  expect(unknownAgentOf({ ...message, conversationId: "channel-1" }, known)).toBeUndefined();
});

describe("the viewer's own channel events", () => {
  const marked = (conversationId: string, unreadCount: number) => ({
    type: "channel.marked.v1" as const,
    workspaceId: "workspace-a",
    conversationId,
    unreadCount,
  });

  test("a read elsewhere sets the channel's badge to the count it left, keeping its boundary", () => {
    const current = { "channel-a": 4, "channel-a:seq": 9, "channel-b": 2 };
    expect(applyMarked(current, marked("channel-a", 1), {})).toEqual({
      "channel-a": 1,
      "channel-a:seq": 9,
      "channel-b": 2,
    });
    expect(applyMarked(current, marked("channel-a", 0), {})).toEqual({
      "channel-a:seq": 9,
      "channel-b": 2,
    });
    // Marked unread in another tab: the badge appears here too.
    expect(applyMarked({}, marked("channel-b", 3), {})).toEqual({ "channel-b": 3 });
  });

  test("the channel on screen keeps no badge, whatever the count", () => {
    const current = { "channel-a:seq": 9 };
    expect(applyMarked(current, marked("channel-a", 2), { openConversationId: "channel-a" })).toBe(
      current,
    );
  });

  test("names the one list each event makes stale, and none for a read", () => {
    const ids = { workspaceId: "workspace-a", conversationId: "channel-a" };
    expect(sidebarListsChangedBy(marked("channel-a", 0))).toEqual([]);
    for (const type of [
      "channel.joined.v1",
      "channel.left.v1",
      "channel.closed.v1",
      "channel.opened.v1",
    ] as const)
      expect(sidebarListsChangedBy({ type, ...ids })).toEqual(["channels"]);
    expect(
      sidebarListsChangedBy({ type: "pref.changed.v1", workspaceId: "workspace-a", name: "muted" }),
    ).toEqual(["channels"]);
    // Pins are one order across channels and DMs.
    expect(
      sidebarListsChangedBy({ type: "pref.changed.v1", workspaceId: "workspace-a", name: "pins" }),
    ).toEqual(["channels", "dms"]);
  });
});

describe("the viewer's own DM events", () => {
  const ids = { workspaceId: "workspace-a", conversationId: "dm-a" };

  test("a DM read elsewhere sets its badge like a channel's", () => {
    expect(
      applyMarked(
        { "dm-a": 5, "dm-a:seq": 7 },
        { type: "dm.marked.v1", ...ids, unreadCount: 0 },
        {},
      ),
    ).toEqual({ "dm-a:seq": 7 });
    expect(
      applyMarked(
        {},
        { type: "dm.marked.v1", ...ids, unreadCount: 1 },
        { openConversationId: "dm-a" },
      ),
    ).toEqual({});
  });

  test("a DM started, closed or brought back makes only the DM list stale", () => {
    expect(sidebarListsChangedBy({ type: "dm.marked.v1", ...ids, unreadCount: 0 })).toEqual([]);
    for (const type of ["dm.created.v1", "dm.opened.v1", "dm.closed.v1"] as const)
      expect(sidebarListsChangedBy({ type, ...ids })).toEqual(["dms"]);
  });
});

describe("sidebarRefreshQueue", () => {
  test("lists named while a re-read is running are read once, together, after it", async () => {
    const reads: string[][] = [];
    const running: (() => void)[] = [];
    const refresh = sidebarRefreshQueue(
      (lists) =>
        new Promise<void>((resolve) => {
          reads.push([...lists].sort());
          running.push(resolve);
        }),
    );
    const first = refresh(["channels"]);
    await Promise.resolve();
    expect(reads).toEqual([["channels"]]);

    const second = refresh(["dms"]);
    const third = refresh(["channels"]);
    expect(second).toBe(third);
    running.shift()!();
    await first;
    await Promise.resolve();
    expect(reads).toEqual([["channels"], ["channels", "dms"]]);
    running.shift()!();
    await second;
  });
});

describe("workspaceSignalLists", () => {
  const ids = { workspaceId: "workspace-a", conversationId: "channel-z" };

  test("a channel created or changed anywhere in the Workspace makes the channel list stale", () => {
    expect(workspaceSignalLists({ type: "channel.created.v1", ...ids })).toEqual(["channels"]);
    expect(workspaceSignalLists({ type: "channel.updated.v1", ...ids })).toEqual(["channels"]);
    expect(
      workspaceSignalLists(
        new TextEncoder().encode(JSON.stringify({ type: "channel.created.v1", ...ids })),
      ),
    ).toEqual(["channels"]);
  });

  test("anything else on the Workspace channel is not a list change", () => {
    expect(
      workspaceSignalLists({
        type: "message.available.v1",
        conversationId: "channel-z",
        messageId: "m",
        sequence: 1,
      }),
    ).toBeUndefined();
    expect(workspaceSignalLists({ type: "channel.created.v1", workspaceId: "w" })).toBeUndefined();
  });
});
