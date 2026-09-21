import { create, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import { AgentStartIntentSchema } from "./gen/coforge/rpc/v1/workspace_pb";
import { AGENT_START_MESSAGE_TYPE, decodeAgentStartIntent, encodeAgentStartIntent } from "./index";

const base = {
  protocolMajor: 1,
  requestId: "request-1",
  workspaceId: "workspace-1",
  computerId: "computer-1",
  agentId: "agent-1",
  provider: "codex" as const,
  model: "gpt-5",
  reasoning: "medium",
};

test("round-trips launchId on a managed (controlEpoch-carrying) start intent", () => {
  const managed = { ...base, controlEpoch: 3, launchId: "launch-1" };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(managed))).toEqual({
    ...managed,
    modelProvider: "",
    providerConfig: undefined,
  });
});

test("round-trips an unmanaged start intent without launchId or controlEpoch", () => {
  expect(decodeAgentStartIntent(encodeAgentStartIntent(base))).toEqual({
    ...base,
    modelProvider: "",
    providerConfig: undefined,
  });
});

test("round-trips the causal-memory tool profile and rejects unknown profiles", () => {
  const fenced = { ...base, toolProfile: "causal-memory" as const };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(fenced))).toEqual({
    ...fenced,
    modelProvider: "",
    providerConfig: undefined,
  });
  expect(() =>
    encodeAgentStartIntent({ ...base, toolProfile: "all-tools" as "causal-memory" }),
  ).toThrow("unsupported Agent tool profile");
  const encoded = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...base,
      messageType: AGENT_START_MESSAGE_TYPE,
      toolProfile: "all-tools",
    }),
  );
  expect(() => decodeAgentStartIntent(encoded)).toThrow("unsupported Agent tool profile");
});

test("rejects encoding a managed start intent with no launchId", () => {
  expect(() => encodeAgentStartIntent({ ...base, controlEpoch: 1 })).toThrow("launchId");
  expect(() => encodeAgentStartIntent({ ...base, controlEpoch: 1, launchId: "  " })).toThrow(
    "launchId",
  );
});

test("rejects decoding a managed start intent with no launchId", () => {
  const encoded = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...base,
      messageType: AGENT_START_MESSAGE_TYPE,
      controlEpoch: 1,
    }),
  );
  expect(() => decodeAgentStartIntent(encoded)).toThrow("launchId");
});

test("rejects an oversized launchId on encode and decode", () => {
  const oversized = "x".repeat(513);
  expect(() => encodeAgentStartIntent({ ...base, controlEpoch: 1, launchId: oversized })).toThrow(
    "invalid Agent start launchId",
  );
  const encoded = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...base,
      messageType: AGENT_START_MESSAGE_TYPE,
      controlEpoch: 1,
      launchId: oversized,
    }),
  );
  expect(() => decodeAgentStartIntent(encoded)).toThrow("invalid agent start intent launchId");
});
