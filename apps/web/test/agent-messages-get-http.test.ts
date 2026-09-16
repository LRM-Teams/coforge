import { expect, test } from "bun:test";
import { handleAgentMessagesGet } from "../src/routes/api/agent/v1/messages";

const request = (search: string) =>
  new Request(`https://server.example/api/agent/v1/messages${search}`);

test("read forwards the sequence window to the repository and returns the canonical response shape", async () => {
  let received: unknown;
  const result = await handleAgentMessagesGet(
    request("?target=%40ada&fromSequence=5&throughSequence=12&requestId=request-1"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      readMessagesPage: async (...args) => {
        received = args;
        return {
          messages: [
            {
              id: "message-1",
              sequence: 6,
              sender: "@ada",
              target: "@ada",
              body: "hello",
              createdAt: new Date("2026-09-15T00:00:00.000Z"),
            },
          ],
          hasOlder: false,
          hasNewer: true,
        };
      },
    },
  );
  expect(received).toEqual([
    "workspace-1",
    "agent-1",
    "@ada",
    {
      before: undefined,
      after: undefined,
      around: undefined,
      limit: undefined,
      fromSequence: 5,
      throughSequence: 12,
    },
  ]);
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body).toEqual({
    protocolMajor: 1,
    requestId: "request-1",
    accepted: true,
    attentionCount: 0,
    messages: [
      {
        id: "message-1",
        sequence: 6,
        sender: "@ada",
        target: "@ada",
        body: "hello",
        createdAt: "2026-09-15T00:00:00.000Z",
      },
    ],
    hasOlder: false,
    hasNewer: true,
    olderCursor: "message-1",
    newerCursor: "message-1",
  });
});

test("read generates a request id when the daemon omits one", async () => {
  const result = await handleAgentMessagesGet(
    request("?target=%40ada"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      readMessagesPage: async () => ({ messages: [], hasOlder: false, hasNewer: false }),
    },
  );
  const body = await result.json();
  expect(body.accepted).toBe(true);
  expect(typeof body.requestId).toBe("string");
  expect(body.requestId.length).toBeGreaterThan(0);
});

test("search returns the canonical response shape and echoes the request id", async () => {
  const result = await handleAgentMessagesGet(
    request("?query=hello&requestId=request-2"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      searchMessages: async () => [
        {
          id: "message-2",
          sequence: 1,
          sender: "@ada",
          target: "@ada",
          body: "hello",
          createdAt: new Date("2026-09-15T00:00:00.000Z"),
        },
      ],
    },
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    protocolMajor: 1,
    requestId: "request-2",
    accepted: true,
    attentionCount: 0,
    messages: [
      {
        id: "message-2",
        sequence: 1,
        sender: "@ada",
        target: "@ada",
        body: "hello",
        createdAt: "2026-09-15T00:00:00.000Z",
      },
    ],
  });
});

test("rejects a missing target with 400", async () => {
  const result = await handleAgentMessagesGet(
    request(""),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { setAgentChannelMuted: async () => {}, setAgentThreadFollowed: async () => {} },
  );
  expect(result.status).toBe(400);
});

test("rejects a non-integer sequence window with 400", async () => {
  const result = await handleAgentMessagesGet(
    request("?target=%40ada&fromSequence=not-a-number"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { setAgentChannelMuted: async () => {}, setAgentThreadFollowed: async () => {} },
  );
  expect(result.status).toBe(400);
});
