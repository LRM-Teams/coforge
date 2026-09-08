import { create, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import {
  AgentWorkspaceResetRequestSchema,
  AgentControlResultSchema,
} from "./gen/coforge/rpc/v1/agent_control_pb";
import {
  AGENT_WORKSPACE_RESET_METHOD,
  AGENT_CONTROL_RESULT_METHOD,
  AGENT_SESSION_METHOD,
  decodeAgentWorkspaceResetRequest,
  decodeAgentControlResult,
  encodeAgentWorkspaceResetRequest,
  encodeAgentControlResult,
  validateAgentSessionSnapshot,
} from "./index";

const scope = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  provider: "codex" as const,
  epoch: 1,
};

test("round-trips independently discriminated lifecycle envelopes", () => {
  const reset = scope;
  const result = {
    ...scope,
    phase: "started" as const,
    launchId: "launch-1",
    sequence: 2,
    identity: { sessionId: "native.session_1", state: "resumable" as const },
  };
  const snapshot = {
    ...scope,
    launchId: "launch-1",
    sequence: 3,
    identity: { sessionId: "", state: "empty" as const },
    daemonInstanceId: "daemon-1",
  };
  expect(decodeAgentWorkspaceResetRequest(encodeAgentWorkspaceResetRequest(reset))).toEqual(reset);
  expect(decodeAgentControlResult(encodeAgentControlResult(result))).toEqual(result);
  expect(validateAgentSessionSnapshot(snapshot)).toEqual(snapshot);

  const wrong = toBinary(
    AgentWorkspaceResetRequestSchema,
    create(AgentWorkspaceResetRequestSchema, {
      ...reset,
      messageType: "coforge.rpc.v1.AgentControlResult",
    }),
  );
  expect(() => decodeAgentWorkspaceResetRequest(wrong)).toThrow();
});

test("rejects malformed lifecycle scope, enums, counters, and native session IDs", () => {
  expect(() => encodeAgentWorkspaceResetRequest({ ...scope, epoch: 0 })).toThrow();
  expect(() => encodeAgentWorkspaceResetRequest({ ...scope, agentId: "../agent" })).toThrow();
  expect(() =>
    decodeAgentControlResult(
      toBinary(
        AgentControlResultSchema,
        create(AgentControlResultSchema, {
          ...scope,
          phase: "surprise",
          sequence: 1,
          messageType: "coforge.rpc.v1.AgentControlResult",
        }),
      ),
    ),
  ).toThrow();
  expect(() =>
    validateAgentSessionSnapshot({
      ...scope,
      launchId: "launch-1",
      sequence: 2 ** 31,
      identity: { sessionId: "native/path", state: "resumable" },
    }),
  ).toThrow();
  expect(() =>
    validateAgentSessionSnapshot({
      ...scope,
      launchId: "launch-1",
      sequence: 1,
      identity: { sessionId: "id", state: "future" as "unknown" },
    }),
  ).toThrow();
  expect(() =>
    validateAgentSessionSnapshot({
      ...scope,
      launchId: "launch-1",
      sequence: 1,
      identity: { sessionId: "", state: "unknown" },
    }),
  ).toThrow();
});

test("enforces lifecycle payload and safe error-code limits", () => {
  expect(() =>
    encodeAgentControlResult({
      ...scope,
      phase: "failed",
      sequence: 1,
      errorCode: "x".repeat(81),
    }),
  ).toThrow();
  expect(() => decodeAgentWorkspaceResetRequest(new Uint8Array(32_769))).toThrow();
});

test("exports stable lifecycle methods", () => {
  expect(AGENT_WORKSPACE_RESET_METHOD).toBe("agent:reset-workspace");
  expect(AGENT_CONTROL_RESULT_METHOD).toBe("agent:control:result");
  expect(AGENT_SESSION_METHOD).toBe("agent:session");
});
