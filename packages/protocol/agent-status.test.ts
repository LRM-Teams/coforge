import { expect, test } from "bun:test";

import { decodeAgentStatus, encodeAgentStatus, type AgentStatus } from "./index";

const status: AgentStatus = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  status: "active",
  daemonInstanceId: "daemon-1",
  clientSeq: 1,
  observedAtMs: 1_750_000_000_000,
};

test("round trips an Agent runtime status", () => {
  expect(decodeAgentStatus(encodeAgentStatus(status))).toEqual(status);
});

test("rejects an invalid Agent runtime status", () => {
  const invalid = structuredClone(status);
  Reflect.set(invalid, "status", "starting");
  expect(() => encodeAgentStatus(invalid)).toThrow("invalid agent status");
});

test("rejects unsafe ordering fields", () => {
  expect(() => encodeAgentStatus({ ...status, clientSeq: 0 })).toThrow("invalid agent status");
  expect(() => encodeAgentStatus({ ...status, observedAtMs: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
    "invalid agent status",
  );
});
