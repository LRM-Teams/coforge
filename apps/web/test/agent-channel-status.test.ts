import { expect, test } from "bun:test";
import { resolveAgentChannelStatus } from "@/server/agents/agent-channel-status.server";

const scope = { workspaceId: "workspace-1", computerId: "computer-1", agentId: "agent-1" };

test("an Agent with no Computer is unknown without ever calling the display snapshot", async () => {
  const calls: unknown[] = [];
  const result = await resolveAgentChannelStatus(
    { snapshot: async (input) => (calls.push(input), Promise.reject(new Error("unreachable"))) },
    { ...scope, computerId: null },
  );
  expect(result).toEqual({ status: "unknown" });
  expect(calls).toEqual([]);
});

test("a plain online snapshot reports status online with no activity", async () => {
  const result = await resolveAgentChannelStatus(
    {
      snapshot: async () => ({
        protocolMajor: 1,
        workspaceId: scope.workspaceId,
        computerId: scope.computerId!,
        agentId: scope.agentId,
        revision: 1,
        activityKind: "online",
        detailKind: "",
        detail: "",
        entries: [],
        expiresAt: null,
      }),
    },
    scope,
  );
  expect(result).toEqual({ status: "online" });
});

test("a working snapshot reports status online with the activity kind and its detail", async () => {
  const result = await resolveAgentChannelStatus(
    {
      snapshot: async () => ({
        protocolMajor: 1,
        workspaceId: scope.workspaceId,
        computerId: scope.computerId!,
        agentId: scope.agentId,
        revision: 4,
        activityKind: "working",
        detailKind: "tool_call",
        detail: "running tests",
        entries: [],
        expiresAt: null,
      }),
    },
    scope,
  );
  expect(result).toEqual({
    status: "online",
    activity: "working",
    activityDetail: "running tests",
  });
});

test("a working snapshot with no detail text omits activityDetail", async () => {
  const result = await resolveAgentChannelStatus(
    {
      snapshot: async () => ({
        protocolMajor: 1,
        workspaceId: scope.workspaceId,
        computerId: scope.computerId!,
        agentId: scope.agentId,
        revision: 4,
        activityKind: "thinking",
        detailKind: "",
        detail: "",
        entries: [],
        expiresAt: null,
      }),
    },
    scope,
  );
  expect(result).toEqual({ status: "online", activity: "thinking" });
});

test("an offline snapshot reports status offline", async () => {
  const result = await resolveAgentChannelStatus(
    {
      snapshot: async () => ({
        protocolMajor: 1,
        workspaceId: scope.workspaceId,
        computerId: scope.computerId!,
        agentId: scope.agentId,
        revision: 1,
        activityKind: "offline",
        detailKind: "",
        detail: "",
        entries: [],
        expiresAt: Date.now(),
      }),
    },
    scope,
  );
  expect(result).toEqual({ status: "offline" });
});

test("a display read failure (e.g. Redis unavailable) is reported as unknown, never thrown", async () => {
  const result = await resolveAgentChannelStatus(
    {
      snapshot: async () => {
        throw new Error("Redis unavailable");
      },
    },
    scope,
  );
  expect(result).toEqual({ status: "unknown" });
});
