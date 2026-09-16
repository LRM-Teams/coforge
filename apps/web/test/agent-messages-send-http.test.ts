import { expect, test } from "bun:test";
import { handleAgentMessagesPost } from "../src/routes/api/agent/v1/messages";
import type { AgentMessageHold } from "../src/server/conversations/agent-message-hold.server";

const request = (body: unknown) =>
  new Request("https://server.example/api/agent/v1/messages", {
    method: "POST",
    body: JSON.stringify(body),
  });

test("rejects an unsupported freshnessContextMode with 400", async () => {
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", body: "hello", freshnessContextMode: "secret" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      repository: {},
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "invalid freshnessContextMode" });
});

test("rejects a missing target or body with 400 before reading freshnessContextMode", async () => {
  const result = await handleAgentMessagesPost(
    request({ body: "hello" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      repository: {},
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
    },
  );
  expect(result.status).toBe(400);
});

test("withheld hold response carries state and a count, never message bodies", async () => {
  // Reviewer isolation: a freshness hold in withheld mode must return only
  // state and a count, never message bodies, senders, or metadata.
  const pendingRows = [
    {
      id: "message-1",
      sequence: 1,
      sender: "@reviewer",
      target: "@ada",
      body: "do not leak this body",
      createdAt: new Date("2026-09-10T00:00:00Z"),
    },
    {
      id: "message-2",
      sequence: 2,
      sender: "@reviewer",
      target: "@ada",
      body: "nor this one",
      createdAt: new Date("2026-09-10T00:01:00Z"),
    },
  ];
  const holds = new Map<string, AgentMessageHold>();
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", body: "reviewer send", freshnessContextMode: "withheld" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      repository: {
        readPendingAgentContext: async () => pendingRows,
      },
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
      holdStore: {
        issue: async (hold: AgentMessageHold) => {
          const token = `token-${holds.size}`;
          holds.set(token, hold);
          return token;
        },
        get: async (token: string) => holds.get(token),
        consume: async (token: string) => holds.delete(token),
      },
    },
  );
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body).toMatchObject({
    state: "held",
    context: [],
    freshnessContextMode: "withheld",
    withheldMessageCount: 2,
  });
  const raw = JSON.stringify(body);
  expect(raw).not.toContain("do not leak this body");
  expect(raw).not.toContain("nor this one");
  expect(raw).not.toContain("@reviewer");
});

test("inline hold response still carries the presented message bodies", async () => {
  const pendingRows = [
    {
      id: "message-1",
      sequence: 1,
      sender: "@reviewer",
      target: "@ada",
      body: "shown inline",
      createdAt: new Date("2026-09-10T00:00:00Z"),
    },
  ];
  const holds = new Map<string, AgentMessageHold>();
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", body: "reviewer send" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      repository: {
        readPendingAgentContext: async () => pendingRows,
      },
      sender: { executeFromAgent: async () => ({ id: "unreachable" }) },
      holdStore: {
        issue: async (hold: AgentMessageHold) => {
          const token = `token-${holds.size}`;
          holds.set(token, hold);
          return token;
        },
        get: async (token: string) => holds.get(token),
        consume: async (token: string) => holds.delete(token),
      },
    },
  );
  expect(result.status).toBe(200);
  const body = await result.json();
  expect(body).toMatchObject({ state: "held" });
  expect(body.freshnessContextMode).toBeUndefined();
  expect(body.withheldMessageCount).toBeUndefined();
  expect(body.context).toEqual([
    {
      id: "message-1",
      sequence: 1,
      sender: "@reviewer",
      target: "@ada",
      body: "shown inline",
      createdAt: "2026-09-10T00:00:00.000Z",
    },
  ]);
});
