import { expect, test } from "bun:test";

import { decodeAgentStatus, encodeAgentStatus, type AgentStatus } from "./index";

const status: AgentStatus = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  status: "active",
};

test("round trips an Agent runtime status", () => {
  expect(decodeAgentStatus(encodeAgentStatus(status))).toEqual(status);
});

test("rejects an invalid Agent runtime status", () => {
  const invalid = structuredClone(status);
  Reflect.set(invalid, "status", "starting");
  expect(() => encodeAgentStatus(invalid)).toThrow("invalid agent status");
});
