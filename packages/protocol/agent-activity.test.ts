import { expect, test } from "bun:test";

import { decodeAgentActivity, encodeAgentActivity, type AgentActivity } from "./index";

const activity: AgentActivity = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  agentId: "agent-1",
  activity: "using_tool",
  level: "info",
  message: "tool",
  occurredAt: "2026-08-29T00:00:00.000Z",
  launchId: "launch-1",
  clientSeq: 1,
};

test("round trips the launch ordering identity", () => {
  expect(decodeAgentActivity(encodeAgentActivity(activity))).toEqual(activity);
});

test("rejects incomplete or invalid launch ordering identity", () => {
  for (const invalid of [
    { ...activity, launchId: "" },
    { ...activity, clientSeq: 0 },
    { ...activity, clientSeq: 1.5 },
    { ...activity, occurredAt: "not-a-time" },
  ])
    expect(() => encodeAgentActivity(invalid)).toThrow("invalid agent activity");
});
