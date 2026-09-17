import { expect, test } from "bun:test";
import { handleAgentEventsGet } from "../src/routes/api/agent/v1/events";

const request = (search = "") => new Request(`https://server.example/api/agent/v1/events${search}`);

const baseRepository = {
  setAgentChannelMuted: async () => {},
  setAgentThreadFollowed: async () => {},
};

test("forwards the requested limit and scope to the repository drain", async () => {
  let received: unknown;
  const result = await handleAgentEventsGet(
    request("?requestId=request-1&limit=10"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      ...baseRepository,
      drainAgentEvents: async (...args) => {
        received = args;
        return { messages: [], hasMore: false };
      },
    },
  );
  expect(received).toEqual(["workspace-1", "agent-1", 10]);
  expect(result.status).toBe(200);
});

test("returns the canonical response shape with hasMore passthrough", async () => {
  const result = await handleAgentEventsGet(
    request("?requestId=request-2"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      ...baseRepository,
      drainAgentEvents: async () => ({
        messages: [
          {
            id: "message-1",
            sequence: 6,
            sender: "@ada",
            target: "@ada",
            body: "hello",
            createdAt: new Date("2026-09-15T00:00:00.000Z"),
            attachments: [],
          },
        ],
        hasMore: true,
      }),
    },
  );
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body).toEqual({
    protocolMajor: 1,
    requestId: "request-2",
    hasMore: true,
    events: [
      {
        id: "message-1",
        sequence: 6,
        sender: "@ada",
        target: "@ada",
        body: "hello",
        createdAt: "2026-09-15T00:00:00.000Z",
        attachments: [],
      },
    ],
  });
});

test("generates a request id when the daemon omits one", async () => {
  const result = await handleAgentEventsGet(
    request(),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      ...baseRepository,
      drainAgentEvents: async () => ({ messages: [], hasMore: false }),
    },
  );
  const body = await result.json();
  expect(typeof body.requestId).toBe("string");
  expect(body.requestId.length).toBeGreaterThan(0);
});

test("passes hasMore false through when the drain is exhausted", async () => {
  const result = await handleAgentEventsGet(
    request(),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      ...baseRepository,
      drainAgentEvents: async () => ({ messages: [], hasMore: false }),
    },
  );
  const body = await result.json();
  expect(body.hasMore).toBe(false);
  expect(body.events).toEqual([]);
});

test("rejects a non-integer limit with a 400", async () => {
  const result = await handleAgentEventsGet(
    request("?limit=abc"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      ...baseRepository,
      drainAgentEvents: async () => ({ messages: [], hasMore: false }),
    },
  );
  expect(result.status).toBe(400);
});

test("returns a 400 when the repository rejects an out-of-range limit", async () => {
  const result = await handleAgentEventsGet(
    request("?limit=-1"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      ...baseRepository,
      drainAgentEvents: async (_workspaceId, _agentId, limit) => {
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
          throw new Error("invalid events limit");
        return { messages: [], hasMore: false };
      },
    },
  );
  expect(result.status).toBe(400);
});

test("hides an unexpected repository failure behind a generic message", async () => {
  const result = await handleAgentEventsGet(
    request(),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      ...baseRepository,
      drainAgentEvents: async () => {
        throw new Error("database password leaked");
      },
    },
  );
  expect(result.status).toBe(400);
  const body = await result.json();
  expect(body.error).toBe("invalid events query");
});
