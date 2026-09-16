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
