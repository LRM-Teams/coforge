import { create, toBinary } from "@bufbuild/protobuf";
import { expect, test } from "bun:test";
import { AgentStartIntentSchema } from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
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

test("round-trips a resume prompt, which replaces every recovery field", () => {
  const resumed = { ...base, resumePrompt: "Stop editing the schema; only the frontend." };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(resumed))).toEqual({
    ...resumed,
    modelProvider: "",
    providerConfig: undefined,
  });
  expect(() => encodeAgentStartIntent({ ...resumed, unreadSummary: { "#general": 1 } })).toThrow(
    "resume prompt",
  );
});

test("rejects a blank or oversized resume prompt on encode and decode", () => {
  expect(() => encodeAgentStartIntent({ ...base, resumePrompt: "  " })).toThrow("resume prompt");
  expect(() => encodeAgentStartIntent({ ...base, resumePrompt: "x".repeat(8193) })).toThrow(
    "resume prompt",
  );
  const encoded = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...base,
      messageType: AGENT_START_MESSAGE_TYPE,
      resumePrompt: "x".repeat(8193),
    }),
  );
  expect(() => decodeAgentStartIntent(encoded)).toThrow("resume prompt");
});

test("rejects decoding a resume prompt that also carries message recovery", () => {
  const recovery = {
    messageId: "message-1",
    deliveryId: "delivery-1",
    conversationId: "conversation-1",
    sequence: 1n,
    target: "#general",
    latestSenderKind: "human",
    latestSenderHandle: "ada",
    latestSenderDescription: "",
    body: "hello",
  };
  for (const carried of [{ wakeMessage: recovery }, { resumeMessages: [recovery] }]) {
    const encoded = toBinary(
      AgentStartIntentSchema,
      create(AgentStartIntentSchema, {
        ...base,
        messageType: AGENT_START_MESSAGE_TYPE,
        resumePrompt: "Only the frontend.",
        ...carried,
      }),
    );
    expect(() => decodeAgentStartIntent(encoded)).toThrow("resume prompt");
  }
});
