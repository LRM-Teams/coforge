import { expect, test } from "bun:test";
import { handleAgentMessagesSearchGet } from "#src/routes/api/agent/v1/messages_.search";

const request = (search: string) =>
  new Request(`https://server.example/api/agent/v1/messages/search${search}`);

test("search returns the canonical response shape and echoes the request id", async () => {
  let received: unknown;
  const result = await handleAgentMessagesSearchGet(
    request("?query=hello&idempotencyKey=request-2"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      searchMessages: async (...args) => {
        received = args;
        return [
          {
            id: "message-2",
            sequence: 1,
            senderKind: "human",
            senderHandle: "ada",
            senderDescription: "",
            target: "@ada",
            body: "hello",
            createdAt: new Date("2026-09-15T00:00:00.000Z"),
            attachments: [],
          },
        ];
      },
    },
  );
  expect(received).toEqual([
    "workspace-1",
    "agent-1",
    {
      query: "hello",
      target: undefined,
      sender: undefined,
      sort: "relevance",
      limit: undefined,
      offset: undefined,
    },
  ]);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({
    protocolMajor: 1,
    idempotencyKey: "request-2",
    results: [
      {
        id: "message-2",
        sequence: 1,
        senderKind: "human",
        senderHandle: "ada",
        senderDescription: "",
        target: "@ada",
        body: "hello",
        createdAt: "2026-09-15T00:00:00.000Z",
        attachments: [],
      },
    ],
  });
});

test("search allows a filter-only query with no `query` text", async () => {
  let received: unknown;
  const result = await handleAgentMessagesSearchGet(
    request("?target=%40ada&sender=%40ada&sort=recent"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      searchMessages: async (...args) => {
        received = args;
        return [];
      },
    },
  );
  expect(received).toEqual([
    "workspace-1",
    "agent-1",
    {
      query: undefined,
      target: "@ada",
      sender: "@ada",
      sort: "recent",
      limit: undefined,
      offset: undefined,
    },
  ]);
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ results: [] });
});

test("search generates a request id when the daemon omits one", async () => {
  const result = await handleAgentMessagesSearchGet(
    request("?query=hello"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      searchMessages: async () => [],
    },
  );
  const body = await result.json();
  expect(typeof body.idempotencyKey).toBe("string");
  expect(body.idempotencyKey.length).toBeGreaterThan(0);
});

test("rejects an unsupported search query with 400", async () => {
  const result = await handleAgentMessagesSearchGet(
    request("?query=hello"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { setAgentChannelMuted: async () => {}, setAgentThreadFollowed: async () => {} },
  );
  expect(result.status).toBe(400);
});

test("search passes its time window through", async () => {
  let received: unknown;
  await handleAgentMessagesSearchGet(
    request(
      "?query=release&after=2026-09-01T00%3A00%3A00.000Z&before=2026-09-10T00%3A00%3A00.000Z",
    ),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      searchMessages: async (...args) => {
        received = args;
        return [];
      },
    },
  );
  expect(received).toMatchObject([
    "workspace-1",
    "agent-1",
    {
      query: "release",
      after: "2026-09-01T00:00:00.000Z",
      before: "2026-09-10T00:00:00.000Z",
    },
  ]);
});

test("search rejects a time window that is not a date", async () => {
  const result = await handleAgentMessagesSearchGet(
    request("?query=release&after=last-week"),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      setAgentChannelMuted: async () => {},
      setAgentThreadFollowed: async () => {},
      searchMessages: async () => [],
    },
  );
  expect(result.status).toBe(400);
});
