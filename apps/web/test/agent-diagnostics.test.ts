import { expect, test } from "bun:test";

import { agentDiagnosticInfo } from "#src/features/agents/agent-diagnostics";

const agent = {
  id: "agent-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  computerVersion: "0.1.1-dev.2",
  runtime: "claude-code",
  model: "claude-opus-4-6",
  stopped: false,
  status: "active",
};

test("the copied diagnostic info names the Agent, its Computer, runtime and current activity", () => {
  expect(
    agentDiagnosticInfo({
      agent,
      display: { activityKind: "working", detailKind: "tool_started", detail: "Reading file" },
      lastActivityAtMs: Date.UTC(2026, 8, 29, 2, 0, 5),
      reportedAt: new Date(Date.UTC(2026, 8, 29, 2, 1, 0)),
    }),
  ).toBe(
    [
      "CoForge Agent diagnostic info",
      "reportedAtUtc: 2026-09-29T02:01:00.000Z",
      "workspaceId: workspace-1",
      "agentId: agent-1",
      "computerId: computer-1",
      "runtime: claude-code",
      "model: claude-opus-4-6",
      "computerVersion: 0.1.1-dev.2",
      "agentStatus: active",
      "activity: working",
      "activityKind: tool_started",
      "lastActivityAtUtc: 2026-09-29T02:00:05.000Z",
    ].join("\n"),
  );
});

test("an Agent in error leads with the error message; missing facts read as unknown", () => {
  expect(
    agentDiagnosticInfo({
      agent: {
        ...agent,
        computerId: null,
        computerVersion: null,
        model: "",
        stopped: true,
        status: "inactive",
      },
      display: {
        activityKind: "error",
        detailKind: "runtime_crashed",
        detail: "Provider process exited (code 1)",
      },
      lastActivityAtMs: undefined,
      reportedAt: new Date(Date.UTC(2026, 8, 29, 2, 1, 0)),
    }).split("\n"),
  ).toEqual([
    "CoForge Agent diagnostic info",
    "errorMessage: Provider process exited (code 1)",
    "reportedAtUtc: 2026-09-29T02:01:00.000Z",
    "workspaceId: workspace-1",
    "agentId: agent-1",
    "computerId: unknown",
    "runtime: claude-code",
    "model: default",
    "computerVersion: unknown",
    "agentStatus: stopped",
    "activity: error",
    "activityKind: runtime_crashed",
    "lastActivityAtUtc: unknown",
  ]);
});
