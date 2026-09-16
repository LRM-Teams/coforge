import { expect, test } from "bun:test";
import {
  muteAgentChannel,
  readAgentMessages,
  executeAgentSendMessageWithPolicy,
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
