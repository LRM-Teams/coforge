import { expect, test } from "bun:test";
import { handleAgentMessageResolveGet } from "../src/routes/api/agent/v1/messages_.$messageId.resolve";
import { handleAgentMessageReaction } from "../src/routes/api/agent/v1/messages_.$messageId.reactions";
import { AgentMessageValidationError } from "../src/server/conversations/agent-message-validation-error.server";

const principal = { workspaceId: "workspace-1", agentId: "agent-1" };

test("resolve returns one canonical message record", async () => {
  const calls: unknown[] = [];
  const result = await handleAgentMessageResolveGet(
    new Request("https://server.example/api/agent/v1/messages/abcd1234/resolve?requestId=r-1"),
    "abcd1234",
    principal,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      resolveAgentMessage: async (...args) => {
        calls.push(args);
        return {
          id: "abcd1234-0000-4000-8000-000000000001",
          sequence: 1,
          senderKind: "human",
          senderHandle: "ada",
          senderDescription: "",
          target: "#general",
          body: "hello",
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
          attachments: [],
        };
      },
    },
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "abcd1234"]]);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    protocolMajor: 1,
    requestId: "r-1",
    message: {
      id: "abcd1234-0000-4000-8000-000000000001",
      sequence: 1,
      senderKind: "human",
      senderHandle: "ada",
      senderDescription: "",
      target: "#general",
      body: "hello",
      createdAt: "2026-09-15T00:00:00.000Z",
      attachments: [],
    },
  });
});

test("resolve generates a request id when the daemon omits one", async () => {
  const result = await handleAgentMessageResolveGet(
    new Request("https://server.example/api/agent/v1/messages/abcd1234/resolve"),
    "abcd1234",
    principal,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      resolveAgentMessage: async () => ({
        id: "abcd1234-0000-4000-8000-000000000001",
        sequence: 1,
        senderKind: "human",
        senderHandle: "ada",
        senderDescription: "",
        target: "#general",
        body: "hello",
        createdAt: new Date("2026-09-15T00:00:00.000Z"),
        attachments: [],
      }),
    },
  );
  const body = await result.json();
  expect(typeof body.requestId).toBe("string");
  expect(body.requestId.length).toBeGreaterThan(0);
});

test("resolve returns the exact validation text as a plain-text 400 body", async () => {
  const result = await handleAgentMessageResolveGet(
    new Request("https://server.example/api/agent/v1/messages/deadbeef/resolve"),
    "deadbeef",
    principal,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      resolveAgentMessage: async () => {
        throw new AgentMessageValidationError("message not found or not visible to this Agent");
      },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe("message not found or not visible to this Agent");
});

test("resolve hides an unexpected repository failure behind a generic message", async () => {
  const result = await handleAgentMessageResolveGet(
    new Request("https://server.example/api/agent/v1/messages/deadbeef/resolve"),
    "deadbeef",
    principal,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      resolveAgentMessage: async () => {
        throw new Error("database password leaked");
      },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe("message resolve failed");
});

test("react adds a reaction and returns the canonical response shape with the messageId", async () => {
  const calls: unknown[] = [];
  const result = await handleAgentMessageReaction(
    new Request("https://server.example/api/agent/v1/messages/abcd1234/reactions", {
      method: "POST",
      body: JSON.stringify({ requestId: "r-2", emoji: "👍" }),
    }),
    "abcd1234",
    true,
    principal,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      setAgentMessageReaction: async (...args) => {
        calls.push(args);
        return { messageId: "abcd1234-0000-4000-8000-000000000001" };
      },
    },
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "abcd1234", "👍", true]]);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    protocolMajor: 1,
    requestId: "r-2",
    messageId: "abcd1234-0000-4000-8000-000000000001",
    emoji: "👍",
    active: true,
  });
});

test("react removes a reaction when active is false", async () => {
  const calls: unknown[] = [];
  const result = await handleAgentMessageReaction(
    new Request("https://server.example/api/agent/v1/messages/abcd1234/reactions", {
      method: "DELETE",
      body: JSON.stringify({ emoji: "👍" }),
    }),
    "abcd1234",
    false,
    principal,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      setAgentMessageReaction: async (...args) => {
        calls.push(args);
        return { messageId: "abcd1234-0000-4000-8000-000000000001" };
      },
    },
  );
  expect(calls).toEqual([["workspace-1", "agent-1", "abcd1234", "👍", false]]);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ active: false });
});

test("react returns the exact emoji validation text as a plain-text 400 body", async () => {
  const result = await handleAgentMessageReaction(
    new Request("https://server.example/api/agent/v1/messages/abcd1234/reactions", {
      method: "POST",
      body: JSON.stringify({ emoji: "a b" }),
    }),
    "abcd1234",
    true,
    principal,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      setAgentMessageReaction: async () => ({ messageId: "abcd1234" }),
    },
  );
  expect(result.status).toBe(400);
  expect(await result.text()).toBe(
    "reaction emoji must be one to sixteen characters without whitespace",
  );
});

test("react rejects a missing emoji", async () => {
  const result = await handleAgentMessageReaction(
    new Request("https://server.example/api/agent/v1/messages/abcd1234/reactions", {
      method: "POST",
      body: JSON.stringify({}),
    }),
    "abcd1234",
    true,
    principal,
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      setAgentMessageReaction: async () => ({ messageId: "abcd1234" }),
    },
  );
  expect(result.status).toBe(400);
});
