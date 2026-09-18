import { expect, test } from "bun:test";

import {
  AGENT_ACTIVITY_DETAIL_KIND,
  decodeAgentActivity,
  encodeAgentActivity,
  type AgentActivity,
} from "./index";

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

// ADR 0021: each new detail kind round-trips through the codec exactly like
// any other stable string value; detail_kind is a plain proto string field.
for (const detailKind of [
  AGENT_ACTIVITY_DETAIL_KIND.TOOL_END,
  AGENT_ACTIVITY_DETAIL_KIND.THINKING_END,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTING_CONTEXT,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_FINISHED,
  AGENT_ACTIVITY_DETAIL_KIND.SUBAGENT_ACTIVITY,
  AGENT_ACTIVITY_DETAIL_KIND.MESSAGE_RECEIVED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_CRASHED,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_INTERRUPTED,
  // This change's additions to the shared vocabulary.
  AGENT_ACTIVITY_DETAIL_KIND.REVIEWING_CHANGES,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_FINISHED,
  AGENT_ACTIVITY_DETAIL_KIND.COMPACTION_STALE,
  AGENT_ACTIVITY_DETAIL_KIND.REVIEW_STALE,
  AGENT_ACTIVITY_DETAIL_KIND.RUNTIME_STALLED,
  AGENT_ACTIVITY_DETAIL_KIND.STALLED_RECOVERY,
  AGENT_ACTIVITY_DETAIL_KIND.SYSTEM_MESSAGE,
]) {
  test(`round trips the ${detailKind} detail kind`, () => {
    const withKind: AgentActivity = { ...activity, detailKind };
    const decoded = decodeAgentActivity(encodeAgentActivity(withKind));
    expect(decoded.detailKind).toBe(detailKind);
  });
}

test("round trips a tool_start entry's toolInput", () => {
  const withEntry: AgentActivity = {
    ...activity,
    entries: [{ kind: "tool_start", toolName: "bash", toolInput: "ls -la /tmp" }],
  };
  const decoded = decodeAgentActivity(encodeAgentActivity(withEntry));
  expect(decoded.entries).toEqual([
    { kind: "tool_start", toolName: "bash", toolInput: "ls -la /tmp" },
  ]);
});

test("omits toolInput on decode when a tool_start entry did not carry one", () => {
  const withEntry: AgentActivity = {
    ...activity,
    entries: [{ kind: "tool_start", toolName: "bash" }],
  };
  const decoded = decodeAgentActivity(encodeAgentActivity(withEntry));
  expect(decoded.entries).toEqual([{ kind: "tool_start", toolName: "bash" }]);
  expect(decoded.entries?.[0]).not.toHaveProperty("toolInput");
});

test("round trips a system entry", () => {
  const withEntry: AgentActivity = {
    ...activity,
    entries: [
      { kind: "system", title: "Session reset", text: "The daemon restarted the session." },
    ],
  };
  const decoded = decodeAgentActivity(encodeAgentActivity(withEntry));
  expect(decoded.entries).toEqual([
    { kind: "system", title: "Session reset", text: "The daemon restarted the session." },
  ]);
});
