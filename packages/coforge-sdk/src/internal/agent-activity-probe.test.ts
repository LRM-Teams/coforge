import { create, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import { AgentActivityProbeSchema } from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import {
  AGENT_ACTIVITY_PROBE_MESSAGE_TYPE,
  decodeAgentActivityProbe,
  encodeAgentActivityProbe,
} from "./index";

const probe = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  probeId: "probe-1",
};

test("round-trips the Agent activity probe identity", () => {
  expect(decodeAgentActivityProbe(encodeAgentActivityProbe(probe))).toEqual(probe);
});

test("rejects Agent activity probes with a missing field or the wrong message type", () => {
  const encoded = (overrides: Partial<typeof probe & { messageType: string }>) =>
    toBinary(
      AgentActivityProbeSchema,
      create(AgentActivityProbeSchema, {
        ...probe,
        messageType: AGENT_ACTIVITY_PROBE_MESSAGE_TYPE,
        ...overrides,
      }),
    );

  expect(() => decodeAgentActivityProbe(encoded({ workspaceId: "" }))).toThrow(
    "invalid agent activity probe",
  );
  expect(() => decodeAgentActivityProbe(encoded({ computerId: "" }))).toThrow(
    "invalid agent activity probe",
  );
  expect(() => decodeAgentActivityProbe(encoded({ agentId: "" }))).toThrow(
    "invalid agent activity probe",
  );
  expect(() => decodeAgentActivityProbe(encoded({ probeId: "" }))).toThrow(
    "invalid agent activity probe",
  );
  expect(() =>
    decodeAgentActivityProbe(encoded({ messageType: "coforge.rpc.v1.AgentStartIntent" })),
  ).toThrow("invalid agent activity probe");
});
