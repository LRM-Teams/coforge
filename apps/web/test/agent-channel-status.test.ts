import { expect, test } from "bun:test";
import type { AgentDisplaySnapshot } from "@lrm/coforge-sdk/internal";
import {
  resolveAgentChannelStatus,
  resolveAgentChannelStatuses,
} from "#src/server/agents/agent-channel-status.server";

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

function displaySnapshot(
  agentId: string,
  activityKind: AgentDisplaySnapshot["activityKind"],
  detail = "",
): AgentDisplaySnapshot {
  return {
    protocolMajor: 1,
    workspaceId: scope.workspaceId,
    computerId: scope.computerId!,
    agentId,
    revision: 1,
    activityKind,
    detailKind: "",
    detail,
    entries: [],
    expiresAt: null,
  };
}

test("a roster reads every Agent's display in one batched snapshot, in roster order", async () => {
  const batches: Array<readonly { agentId: string }[]> = [];
  const result = await resolveAgentChannelStatuses(
    {
      snapshot: async () => Promise.reject(new Error("a roster must not read one Agent at a time")),
      snapshotMany: async (scopes) => (
        batches.push(scopes),
        scopes.map((input) =>
          displaySnapshot(
            input.agentId,
            input.agentId === "agent-2" ? "working" : "offline",
            "tests",
          ),
        )
      ),
    },
    [
      { ...scope, agentId: "agent-1" },
      { ...scope, agentId: "agent-no-computer", computerId: null },
      { ...scope, agentId: "agent-2" },
    ],
  );
  expect(batches.map((batch) => batch.map((input) => input.agentId))).toEqual([
    ["agent-1", "agent-2"],
  ]);
  expect(result).toEqual([
    { status: "offline" },
    { status: "unknown" },
    { status: "online", activity: "working", activityDetail: "tests" },
  ]);
});

test("a roster with no Computer-bound Agent never reads the display", async () => {
  const result = await resolveAgentChannelStatuses(
    {
      snapshot: async () => Promise.reject(new Error("unreachable")),
      snapshotMany: async () => Promise.reject(new Error("unreachable")),
    },
    [{ ...scope, computerId: null }],
  );
  expect(result).toEqual([{ status: "unknown" }]);
});

test("a failed batched read falls back per Agent, so one unreadable display stays unknown alone", async () => {
  const result = await resolveAgentChannelStatuses(
    {
      snapshot: async (input) => {
        if (input.agentId === "agent-broken") throw new Error("corrupt display");
        return displaySnapshot(input.agentId, "online");
      },
      snapshotMany: async () => Promise.reject(new Error("corrupt display")),
    },
    [
      { ...scope, agentId: "agent-1" },
      { ...scope, agentId: "agent-broken" },
    ],
  );
  expect(result).toEqual([{ status: "online" }, { status: "unknown" }]);
});
