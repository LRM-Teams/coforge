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
  activityKind: "working",
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

test("round trips a busy heartbeat re-send of the same activity frame", () => {
  const heartbeat: AgentActivity = {
    ...activity,
    detailKind: "runtime_progress",
    clientSeq: 2,
    isHeartbeat: true,
    entries: [],
  };
  delete (heartbeat as { runtimeError?: unknown }).runtimeError;
  const decoded = decodeAgentActivity(encodeAgentActivity(heartbeat));
  expect(decoded.isHeartbeat).toBe(true);
  expect(decoded.detailKind).toBe("runtime_progress");
});

test("omits isHeartbeat on decode when the frame was not a heartbeat", () => {
  const decoded = decodeAgentActivity(encodeAgentActivity(activity));
  expect(decoded.isHeartbeat).toBeUndefined();
});

test("round trips a probe reply's probeId", () => {
  const probeReply: AgentActivity = { ...activity, probeId: "probe-1" };
  const decoded = decodeAgentActivity(encodeAgentActivity(probeReply));
  expect(decoded.probeId).toBe("probe-1");
});

test("omits probeId on decode when the frame was not a probe reply", () => {
  const decoded = decodeAgentActivity(encodeAgentActivity(activity));
  expect(decoded.probeId).toBeUndefined();
});
