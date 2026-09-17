import { expect, test } from "bun:test";
import { handleAgentMessagesPost } from "../src/routes/api/agent/v1/messages";
import type { AgentMessageHold } from "../src/server/conversations/agent-message-hold.server";
import { AppError } from "../src/lib/app-error";
import { AgentSendRejectedError } from "../src/server/conversations/agent-send-rejected-error.server";

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

test("rejects a non-uuid attachmentId with 400", async () => {
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", body: "hello", attachmentId: "not-a-uuid" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { repository: {}, sender: { executeFromAgent: async () => ({ id: "unreachable" }) } },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "invalid attachmentId" });
});

test("rejects malformed mentions with 400", async () => {
  const result = await handleAgentMessagesPost(
    request({ target: "@ada", body: "hello @Ada", mentions: [{ type: "human", id: "x" }] }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    { repository: {}, sender: { executeFromAgent: async () => ({ id: "unreachable" }) } },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({ error: "invalid mentions" });
});

test("maps an AgentSendRejectedError from the sender to its own status and message", async () => {
  const result = await handleAgentMessagesPost(
    request({
      target: "@ada",
      body: "hello",
      attachmentId: "11111111-1111-4111-8111-111111111111",
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new AgentSendRejectedError(403, "attachment is not available for this message");
        },
      },
    },
  );
  expect(result.status).toBe(403);
  expect(await result.json()).toEqual({ error: "attachment is not available for this message" });
});

test("maps an AgentSendRejectedError naming the offending mention to a 400", async () => {
  const result = await handleAgentMessagesPost(
    request({
      target: "@ada",
      body: "hello @ghost",
      mentions: [{ type: "user", id: "11111111-1111-4111-8111-111111111111", name: "ghost" }],
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new AgentSendRejectedError(
            400,
            "mention binding does not match a conversation member: @ghost",
          );
        },
      },
    },
  );
  expect(result.status).toBe(400);
  expect(await result.json()).toEqual({
    error: "mention binding does not match a conversation member: @ghost",
  });
});

test("a channel ACCESS_DENIED AppError from channel resolution is not reported as an attachment error", async () => {
  // getAgentChannel throws AppError("ACCESS_DENIED") when the Agent is not a channel member; this
  // must never be mistaken for AgentSendRejectedError's attachment-unavailable case (the bug this
  // test guards against), and must propagate unchanged rather than becoming a Response.
  const caught = await handleAgentMessagesPost(
    request({ target: "#general", body: "hello" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new AppError("ACCESS_DENIED");
        },
      },
    },
  ).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).not.toContain("attachment");
});

test("a malformed-channel INVALID_INPUT AppError is not reported as a mention error", async () => {
  const caught = await handleAgentMessagesPost(
    request({ target: "#general", body: "hello" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    {
      repository: {},
      sender: {
        executeFromAgent: async () => {
          throw new AppError("INVALID_INPUT");
        },
      },
    },
  ).catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).not.toContain("mention binding");
});

test("a bypassed hold's sent response carries recentUnread; every other response carries none", async () => {
  const holds = new Map<string, AgentMessageHold>();
  const dependencies = {
    repository: {
      readPendingAgentContext: async () => [
        {
          id: "message-1",
          sequence: 1,
          sender: "@bea",
          target: "@ada",
          body: "missed while held",
          createdAt: new Date("2026-09-10T00:00:00Z"),
        },
      ],
    },
    sender: { executeFromAgent: async () => ({ id: "sent-1" }) },
    holdStore: {
      issue: async (hold: AgentMessageHold) => {
        const token = `token-${holds.size}`;
        holds.set(token, hold);
        return token;
      },
      get: async (token: string) => holds.get(token),
      consume: async (token: string) => holds.delete(token),
    },
  };
  const firstHeld = await handleAgentMessagesPost(
    request({ target: "@ada", body: "hello" }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    dependencies,
  );
  const firstBody = await firstHeld.json();
  expect(firstBody.state).toBe("held");
  expect(firstBody.recentUnread).toEqual([]);

  const secondHeld = await handleAgentMessagesPost(
    request({ target: "@ada", body: "hello", holdToken: firstBody.holdToken }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    dependencies,
  );
  const secondBody = await secondHeld.json();
  expect(secondBody.state).toBe("held");
  expect(secondBody.anywayAllowed).toBe(true);

  const bypassed = await handleAgentMessagesPost(
    request({
      target: "@ada",
      body: "hello",
      holdToken: secondBody.holdToken,
      continueAnyway: true,
    }),
    { workspaceId: "workspace-1", agentId: "agent-1" },
    dependencies,
  );
  expect(bypassed.status).toBe(200);
  const bypassedBody = await bypassed.json();
  expect(bypassedBody.state).toBe("sent");
  expect(bypassedBody.recentUnread).toEqual([
    {
      id: "message-1",
      sequence: 1,
      sender: "@bea",
      target: "@ada",
      body: "missed while held",
      createdAt: "2026-09-10T00:00:00.000Z",
    },
  ]);
});
