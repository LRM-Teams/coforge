import { expect, test } from "bun:test";
import {
  drainAgentEvents,
  muteAgentChannel,
  readAgentMessages,
  executeAgentSendMessageWithPolicy,
  reactToAgentMessage,
  resolveAgentMessage,
  searchAgentMessages,
  unfollowAgentThread,
  type AgentMessageRepository,
} from "../src/server/agents/agent-messages.service";
import type { AgentMessageHold } from "../src/server/conversations/agent-message-hold.server";

function repository(overrides: Partial<AgentMessageRepository> = {}): AgentMessageRepository {
  return {
    setAgentChannelMuted: async () => {},
    setAgentThreadFollowed: async () => {},
    ...overrides,
  };
}

test("channel actions preserve the authenticated scope", async () => {
  const calls: unknown[] = [];
  await muteAgentChannel(
    repository({
      setAgentChannelMuted: async (...args) => {
        calls.push(args);
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    "#general",
    true,
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "#general", true]]);
});

test("thread unfollow rejects a channel without a thread", async () => {
  await expect(
    unfollowAgentThread(repository(), { workspaceId: "w", agentId: "a" }, "#general"),
  ).rejects.toThrow("channel thread target");
});

test("drain maps Date values and forwards the limit and hasMore flag", async () => {
  const calls: unknown[] = [];
  const result = await drainAgentEvents(
    repository({
      drainAgentEvents: async (...args) => {
        calls.push(args);
        return {
          messages: [
            {
              id: "message-1",
              sequence: 1,
              sender: "@ada",
              target: "@ada",
              body: "hello",
              createdAt: new Date("2026-09-15T00:00:00.000Z"),
            },
          ],
          hasMore: true,
        };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    10,
  );
  expect(calls).toEqual([["workspace-1", "agent-1", 10]]);
  expect(result.hasMore).toBe(true);
  expect(result.messages[0]?.createdAt).toBe("2026-09-15T00:00:00.000Z");
});

test("drain rejects when the repository does not support the events seam", async () => {
  await expect(drainAgentEvents(repository(), { workspaceId: "w", agentId: "a" })).rejects.toThrow(
    "Agent event drain is unavailable",
  );
});

test("search maps Date values at the application boundary", async () => {
  const result = await searchAgentMessages(
    repository({
      searchMessages: async () => [
        {
          id: "message-1",
          sequence: 1,
          sender: "agent-1",
          target: "#general",
          body: "hello",
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
        },
      ],
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { query: "hello" },
  );
  expect(result[0]?.createdAt).toBe("2026-09-15T00:00:00.000Z");
});

test("read preserves the authenticated scope and page arguments", async () => {
  let received: unknown;
  const result = await readAgentMessages(
    repository({
      readMessagesPage: async (...args) => {
        received = args;
        return { messages: [], hasOlder: true, hasNewer: false };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    "#general",
    { around: "message-1", limit: 10 },
  );
  expect(received).toEqual([
    "workspace-1",
    "agent-1",
    "#general",
    { around: "message-1", limit: 10 },
  ]);
  expect(result).toEqual({ messages: [], hasOlder: true, hasNewer: false });
});

test("send policy forwards a clean message to the sender", async () => {
  const calls: unknown[] = [];
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository(),
      sender: {
        executeFromAgent: async (input) => {
          calls.push(input);
          return { id: "message-1" };
        },
      },
    },
    {
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      target: "#general",
      body: "hello",
    },
  );
  expect(calls).toEqual([
    {
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      target: "#general",
      body: "hello",
    },
  ]);
  expect(result).toMatchObject({
    accepted: true,
    messageId: "message-1",
    sideEffectDecision: "forward",
  });
});

test("resolve maps Date values at the application boundary", async () => {
  const calls: unknown[] = [];
  const result = await resolveAgentMessage(
    repository({
      resolveAgentMessage: async (...args) => {
        calls.push(args);
        return {
          id: "message-1",
          sequence: 1,
          sender: "@ada",
          target: "#general",
          body: "hello",
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
        };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    "abcd1234",
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "abcd1234"]]);
  expect(result.createdAt).toBe("2026-09-15T00:00:00.000Z");
});

test("resolve without repository support fails clearly", async () => {
  await expect(
    resolveAgentMessage(repository(), { workspaceId: "w", agentId: "a" }, "abcd1234"),
  ).rejects.toThrow("Agent message resolve is unavailable");
});

test("react preserves the authenticated scope and reaction fields", async () => {
  const calls: unknown[] = [];
  const result = await reactToAgentMessage(
    repository({
      setAgentMessageReaction: async (...args) => {
        calls.push(args);
        return { messageId: "message-1" };
      },
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    "abcd1234",
    "👍",
    true,
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "abcd1234", "👍", true]]);
  expect(result).toEqual({ messageId: "message-1" });
});

test("react rejects an emoji with whitespace before reaching the repository", async () => {
  await expect(
    reactToAgentMessage(
      repository({ setAgentMessageReaction: async () => ({ messageId: "message-1" }) }),
      { workspaceId: "w", agentId: "a" },
      "abcd1234",
      "a b",
      true,
    ),
  ).rejects.toThrow("reaction emoji must be one to sixteen characters without whitespace");
});

test("react rejects an emoji longer than sixteen characters", async () => {
  await expect(
    reactToAgentMessage(
      repository({ setAgentMessageReaction: async () => ({ messageId: "message-1" }) }),
      { workspaceId: "w", agentId: "a" },
      "abcd1234",
      "x".repeat(17),
      true,
    ),
  ).rejects.toThrow("reaction emoji must be one to sixteen characters without whitespace");
});

test("send policy advances the read-through boundary before reading pending context", async () => {
  const calls: unknown[] = [];
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository({
        advanceAgentReadThrough: async (...args) => {
          calls.push(args);
          return 5;
        },
        readPendingAgentContext: async (...args) => {
          calls.push(["pending", ...args]);
          return [];
        },
      }),
      sender: { executeFromAgent: async () => ({ id: "message-1" }) },
      // An explicit hold store keeps this test off real Redis; the repository
      // fixture makes `readPendingAgentContext` truthy, which otherwise makes
      // the policy resolve the default (Redis-backed) hold store eagerly.
      holdStore: {
        issue: async () => {
          throw new Error("unexpected hold issue");
        },
        get: async () => undefined,
        consume: async () => false,
      },
    },
    {
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-a",
      target: "@user",
      body: "Hello",
      seenUpToSequence: 7,
    },
  );
  expect(calls).toEqual([
    ["workspace-1", "agent-a", "@user", 7],
    ["pending", "workspace-1", "agent-a", "@user", 5],
  ]);
  expect(result).toMatchObject({
    accepted: true,
    messageId: "message-1",
    sideEffectDecision: "forward",
  });
});

test("send policy fails closed when a trusted seen sequence cannot be advanced", async () => {
  await expect(
    executeAgentSendMessageWithPolicy(
      {
        repository: repository(),
        sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
      },
      {
        requestId: "request-1",
        workspaceId: "workspace-1",
        agentId: "agent-a",
        target: "@user",
        body: "Hello",
        seenUpToSequence: 7,
      },
    ),
  ).rejects.toThrow("advancement is unavailable");
});

test("send policy re-holds new pending context on retry, then forwards once the Agent has caught up", async () => {
  // executeAgentSendMessageWithPolicy presents held context inline (unlike the
  // removed RPC-only "withheld" freshness mode): once a hold's presentedThrough
  // covers everything currently pending, retrying with that same holdToken
  // forwards the send without requiring an explicit continueAnyway.
  let sent = 0;
  const boundaries: Array<number | undefined> = [];
  const receipts = new Map<string, AgentMessageHold>();
  const holdStore = {
    issue: async (hold: AgentMessageHold) => {
      const token = `token-${receipts.size}`;
      receipts.set(token, hold);
      return token;
    },
    get: async (token: string) => receipts.get(token),
    consume: async (token: string) => receipts.delete(token),
  };
  let latestSequence = 8;
  const repo = repository({
    readPendingAgentContext: async (_workspaceId, _agentId, _target, after) => {
      boundaries.push(after);
      return (after ?? 0) < latestSequence
        ? [
            {
              id: `message-${latestSequence}`,
              sequence: latestSequence,
              sender: "@reviewer",
              target: "@user",
              body: `pending review ${latestSequence}`,
              createdAt: new Date("2026-09-10T00:00:00Z"),
            },
          ]
        : [];
    },
  });
  const sender = {
    executeFromAgent: async () => {
      sent++;
      return { id: "sent-message" };
    },
  };
  const send = async (holdToken?: string) =>
    executeAgentSendMessageWithPolicy(
      { repository: repo, sender, holdStore },
      {
        requestId: crypto.randomUUID(),
        workspaceId: "workspace-1",
        agentId: "agent-a",
        target: "@user",
        body: "independent review",
        holdToken,
      },
    );
  const first = await send();
  expect(first).toMatchObject({ accepted: false, sideEffectDecision: "hold" });
  expect(first.messages.map((m) => m.body)).toEqual(["pending review 8"]);
  expect(sent).toBe(0);

  // A new reviewer message arrives after the first hold was issued.
  latestSequence = 9;
  const retried = await send(first.holdToken);
  expect(retried).toMatchObject({ accepted: false, sideEffectDecision: "hold" });
  expect(retried.messages.map((m) => m.body)).toEqual(["pending review 9"]);
  expect(sent).toBe(0);

  // No further messages: retrying the same hold now forwards the send.
  const caughtUp = await send(retried.holdToken);
  expect(caughtUp).toMatchObject({ accepted: true, sideEffectDecision: "forward" });
  expect(sent).toBe(1);
  expect(boundaries).toEqual([undefined, 8, 9]);
});

test("send policy in withheld mode hides bodies, counts all pending, and ignores presentedThrough on re-hold", async () => {
  // Reviewer isolation (`freshnessContextMode: "withheld"`): a hold must never
  // leak message bodies, senders, or metadata, and its count must cover every
  // pending row above the Agent's seen boundary — not just the last three
  // shown inline, and not narrowed by a prior hold's presentedThrough, since
  // nothing was actually presented.
  const boundaries: Array<number | undefined> = [];
  const receipts = new Map<string, AgentMessageHold>();
  const holdStore = {
    issue: async (hold: AgentMessageHold) => {
      const token = `token-${receipts.size}`;
      receipts.set(token, hold);
      return token;
    },
    get: async (token: string) => receipts.get(token),
    consume: async (token: string) => receipts.delete(token),
  };
  const pendingRows = Array.from({ length: 5 }, (_, index) => ({
    id: `message-${index + 1}`,
    sequence: index + 1,
    sender: "@reviewer",
    target: "@user",
    body: `pending review ${index + 1}`,
    createdAt: new Date("2026-09-10T00:00:00Z"),
  }));
  let sent = 0;
  const repo = repository({
    readPendingAgentContext: async (_workspaceId, _agentId, _target, after) => {
      boundaries.push(after);
      return pendingRows;
    },
  });
  const sender = {
    executeFromAgent: async () => {
      sent++;
      return { id: "sent-message" };
    },
  };
  const send = async (holdToken?: string, continueAnyway?: boolean) =>
    executeAgentSendMessageWithPolicy(
      { repository: repo, sender, holdStore },
      {
        requestId: crypto.randomUUID(),
        workspaceId: "workspace-1",
        agentId: "agent-a",
        target: "@user",
        body: "reviewer isolation send",
        holdToken,
        continueAnyway,
        freshnessContextMode: "withheld",
      },
    );

  const first = await send();
  expect(first).toMatchObject({
    accepted: false,
    sideEffectDecision: "hold",
    messages: [],
    freshnessContextMode: "withheld",
    withheldMessageCount: 5,
    anywayAllowed: false,
  });

  const second = await send(first.holdToken);
  expect(second).toMatchObject({
    accepted: false,
    sideEffectDecision: "hold",
    messages: [],
    freshnessContextMode: "withheld",
    withheldMessageCount: 5,
    anywayAllowed: true,
  });
  expect(boundaries).toEqual([undefined, undefined]);
  expect(sent).toBe(0);

  const sentResult = await send(second.holdToken, true);
  expect(sentResult).toMatchObject({
    accepted: true,
    sideEffectDecision: "anyway_accepted",
    freshnessContextMode: "withheld",
  });
  expect(sent).toBe(1);
});

test("send policy in withheld mode prefers the repository's true pending count over the bounded window", async () => {
  // The repository's readPendingAgentContext window is bounded (production
  // caps it at 3 rows for inline display); when the repository also exposes
  // countPendingAgentContext, withheld mode must report that true count
  // instead of the bounded window's length.
  const boundaries: Array<number | undefined> = [];
  const countCalls: Array<number | undefined> = [];
  const repo = repository({
    readPendingAgentContext: async (_workspaceId, _agentId, _target, after) => {
      boundaries.push(after);
      return [
        {
          id: "message-5",
          sequence: 5,
          sender: "@reviewer",
          target: "@user",
          body: "pending review 5",
          createdAt: new Date("2026-09-10T00:00:00Z"),
        },
        {
          id: "message-6",
          sequence: 6,
          sender: "@reviewer",
          target: "@user",
          body: "pending review 6",
          createdAt: new Date("2026-09-10T00:00:00Z"),
        },
        {
          id: "message-7",
          sequence: 7,
          sender: "@reviewer",
          target: "@user",
          body: "pending review 7",
          createdAt: new Date("2026-09-10T00:00:00Z"),
        },
      ];
    },
    countPendingAgentContext: async (_workspaceId, _agentId, _target, after) => {
      countCalls.push(after);
      return 7;
    },
  });
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repo,
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
      holdStore: {
        issue: async () => "token-0",
        get: async () => undefined,
        consume: async () => false,
      },
    },
    {
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-a",
      target: "@user",
      body: "independent review",
      freshnessContextMode: "withheld",
    },
  );
  expect(result).toMatchObject({
    accepted: false,
    sideEffectDecision: "hold",
    messages: [],
    freshnessContextMode: "withheld",
    withheldMessageCount: 7,
  });
  expect(boundaries).toEqual([undefined]);
  expect(countCalls).toEqual([undefined]);
});

test("send policy in inline mode is unchanged by the withheld addition", async () => {
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository(),
      sender: {
        executeFromAgent: async () => ({ id: "message-1" }),
      },
    },
    {
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      target: "#general",
      body: "hello",
      freshnessContextMode: "inline",
    },
  );
  expect(result).toMatchObject({
    accepted: true,
    messageId: "message-1",
    sideEffectDecision: "forward",
    freshnessContextMode: "inline",
  });
});

test("send policy rejects continueAnyway without a valid hold", async () => {
  const result = await executeAgentSendMessageWithPolicy(
    {
      repository: repository(),
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
      holdStore: {
        get: async () => undefined,
        issue: async () => {
          throw new Error("unexpected hold issue");
        },
        consume: async () => false,
      },
    },
    {
      requestId: "request-1",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      target: "#general",
      body: "hello",
      continueAnyway: true,
    },
  );
  expect(result).toMatchObject({ accepted: false, sideEffectDecision: "anyway_denied" });
});
