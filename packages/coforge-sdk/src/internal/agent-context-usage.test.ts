import { expect, test } from "bun:test";
import { AgentContextUsageSchema } from "./gen/coforge/rpc/v1/workspace_pb";
import { encodeAgentContextUsage, decodeAgentContextUsage } from "./index";

function contextUsage() {
  return {
    protocolMajor: 1,
    requestId: "report",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "claude-code" as const,
    launchId: "launch",
    sessionId: "native-session",
    usedTokens: 27_908,
    windowTokens: 200_000,
    observedAtMs: 1_758_000_000_000,
    daemonInstanceId: "daemon",
    clientSeq: 3,
  };
}

test("context usage round-trips and rejects a missing scope field", () => {
  const message = contextUsage();
  expect(decodeAgentContextUsage(encodeAgentContextUsage(message))).toEqual(message);
  expect(() => encodeAgentContextUsage({ ...message, launchId: "" })).toThrow();
  expect(() => encodeAgentContextUsage({ ...message, workspaceId: "" })).toThrow();
  expect(() => encodeAgentContextUsage({ ...message, sessionId: "" })).toThrow();
});

test("round-trips a zero usedTokens reading", () => {
  const message = { ...contextUsage(), usedTokens: 0 };
  expect(decodeAgentContextUsage(encodeAgentContextUsage(message))).toEqual(message);
});

test("rejects an invalid protocol, provider, and numeric field", () => {
  const message = contextUsage();
  expect(() => encodeAgentContextUsage({ ...message, protocolMajor: 2 })).toThrow(
    "invalid context usage protocol/provider",
  );
  expect(() =>
    encodeAgentContextUsage({ ...message, provider: "unknown" as "claude-code" }),
  ).toThrow("invalid context usage protocol/provider");
  expect(() => encodeAgentContextUsage({ ...message, usedTokens: -1 })).toThrow(
    "invalid context usage usedTokens",
  );
  expect(() => encodeAgentContextUsage({ ...message, windowTokens: 0 })).toThrow(
    "invalid context usage windowTokens",
  );
  expect(() => encodeAgentContextUsage({ ...message, observedAtMs: 0 })).toThrow(
    "invalid context usage observedAtMs",
  );
  expect(() => encodeAgentContextUsage({ ...message, clientSeq: 0 })).toThrow(
    "invalid context usage clientSeq",
  );
});

test("keeps wire tags stable, numbered contiguously", () => {
  const fields = Object.fromEntries(
    AgentContextUsageSchema.fields.map((field) => [field.localName, field.number]),
  );
  expect(fields).toMatchObject({
    protocolMajor: 1,
    requestId: 2,
    workspaceId: 3,
    computerId: 4,
    agentId: 5,
    provider: 6,
    launchId: 7,
    sessionId: 8,
    usedTokens: 9,
    windowTokens: 10,
    observedAtMs: 11,
    daemonInstanceId: 12,
    clientSeq: 13,
  });
});
