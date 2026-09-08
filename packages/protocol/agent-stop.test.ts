import { create, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import { AgentStopIntentSchema } from "./gen/coforge/rpc/v1/workspace_pb";
import { AGENT_STOP_MESSAGE_TYPE, decodeAgentStopIntent, encodeAgentStopIntent } from "./index";

const stop = {
  protocolMajor: 1,
  requestId: "stop-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
};

test("round-trips the minimal Agent stop control identity", () => {
  expect(decodeAgentStopIntent(encodeAgentStopIntent(stop))).toEqual({
    ...stop,
    messageType: AGENT_STOP_MESSAGE_TYPE,
  });
});

test("round-trips paired fenced stop fields and rejects partial fencing", () => {
  const fenced = { ...stop, provider: "codex" as const, controlEpoch: 7 };
  expect(decodeAgentStopIntent(encodeAgentStopIntent(fenced))).toEqual({
    ...fenced,
    messageType: AGENT_STOP_MESSAGE_TYPE,
  });
  expect(() => encodeAgentStopIntent({ ...stop, provider: "codex" })).toThrow("paired");
  expect(() => encodeAgentStopIntent({ ...stop, controlEpoch: 7 })).toThrow("paired");
});

test("rejects Agent stop intents with an invalid scope or message type", () => {
  const encoded = (overrides: Partial<typeof stop & { messageType: string }>) =>
    toBinary(
      AgentStopIntentSchema,
      create(AgentStopIntentSchema, {
        ...stop,
        messageType: AGENT_STOP_MESSAGE_TYPE,
        ...overrides,
      }),
    );

  expect(() => decodeAgentStopIntent(encoded({ workspaceId: "" }))).toThrow(
    "invalid agent stop intent",
  );
  expect(() => decodeAgentStopIntent(encoded({ computerId: "" }))).toThrow(
    "invalid agent stop intent",
  );
  expect(() =>
    decodeAgentStopIntent(encoded({ messageType: "coforge.rpc.v1.AgentStartIntent" })),
  ).toThrow("invalid agent stop intent");
});
