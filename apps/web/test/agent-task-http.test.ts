import { expect, test } from "bun:test";
import { decodeTaskResponse, encodeTaskRequest } from "@coforge/protocol";
import { createAgentTaskMethod } from "../src/server/agents/agent-task-http.server";

test("Agent Task method trusts authenticated identity rather than payload identity", async () => {
  const calls: unknown[] = [];
  const method = createAgentTaskMethod(
    {
      execute: async (principal, command) => {
        calls.push({ principal, command });
        return { tasks: [] };
      },
    },
    { computerIdForAuthorizedAgent: async () => "computer" },
  );
  const payload = encodeTaskRequest({
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    agentId: "agent",
    operation: "list",
    target: "#general",
  });
  const result = await method(payload, {
    principal: {
      userId: "owner-must-not-pass",
      workspaceId: "workspace",
      computerId: "computer",
      agentId: "agent",
    },
  });
  expect(result).toBeInstanceOf(Uint8Array);
  expect(decodeTaskResponse(result as Uint8Array).tasks).toEqual([]);
  expect(calls).toEqual([
    {
      principal: { workspaceId: "workspace", agentId: "agent" },
      command: { requestId: "request", operation: "list", target: "#general" },
    },
  ]);
  expect(
    await method(payload, {
      principal: {
        userId: "owner",
        workspaceId: "workspace",
        computerId: "computer",
        agentId: "other",
      },
    }),
  ).toEqual({ code: 403, message: "Task principal scope mismatch" });
  expect(calls).toHaveLength(1);
});

test("Agent Task method rejects stale owner and Computer assignments", async () => {
  const calls: unknown[] = [];
  const assignments = new Map([
    ["owner:workspace:agent", "current-computer"],
    ["other-owner:workspace:agent", "current-computer"],
  ]);
  const method = createAgentTaskMethod(
    {
      execute: async (principal, command) => {
        calls.push({ principal, command });
        return { tasks: [] };
      },
    },
    {
      computerIdForAuthorizedAgent: async (workspaceId, agentId, userId) =>
        assignments.get(`${userId}:${workspaceId}:${agentId}`),
    },
  );
  const payload = encodeTaskRequest({
    protocolMajor: 1,
    requestId: "request",
    workspaceId: "workspace",
    agentId: "agent",
    operation: "list",
    target: "#general",
  });

  for (const principal of [
    {
      userId: "former-owner",
      workspaceId: "workspace",
      computerId: "current-computer",
      agentId: "agent",
    },
    {
      userId: "owner",
      workspaceId: "workspace",
      computerId: "stale-computer",
      agentId: "agent",
    },
  ]) {
    expect(await method(payload, { principal })).toEqual({
      code: 403,
      message: "Task principal scope mismatch",
    });
  }
  expect(calls).toHaveLength(0);
});
