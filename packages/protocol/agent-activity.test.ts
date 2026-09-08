import { expect, test } from "bun:test";

import { decodeAgentActivity, encodeAgentActivity, type AgentActivity } from "./index";

const activity: AgentActivity = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  detailKind: "tool_started",
  level: "info",
  detail: "tool",
  observedAtMs: Date.parse("2026-08-29T00:00:00.000Z"),
  launchId: "launch-1",
  clientSeq: 1,
  runtimeError: {
    errorClass: "CodexAuthError",
    errorReason: "turn_failed",
    fingerprint: "deadbeef",
  },
};

test("round trips the launch ordering identity", () => {
  expect(decodeAgentActivity(encodeAgentActivity(activity))).toEqual(activity);
});

test("rejects incomplete or invalid launch ordering identity", () => {
  for (const invalid of [
    { ...activity, launchId: "" },
    { ...activity, clientSeq: 0 },
    { ...activity, clientSeq: 1.5 },
    { ...activity, observedAtMs: NaN },
  ])
    expect(() => encodeAgentActivity(invalid)).toThrow("invalid agent activity");
});
