import { expect, test } from "bun:test";
import { AgentSessionInvalidateSchema } from "./gen/coforge/rpc/v1/workspace_pb";
import { encodeAgentSessionInvalidate, decodeAgentSessionInvalidate } from "./index";

function invalidate() {
  return {
    protocolMajor: 1,
    requestId: "report",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "codex" as const,
    sessionId: "stale-native-session",
    daemonInstanceId: "daemon",
    launchId: "launch",
    reason: "missing" as const,
  };
}

test("session invalidate round-trips and rejects a missing scope field", () => {
  const message = invalidate();
  expect(decodeAgentSessionInvalidate(encodeAgentSessionInvalidate(message))).toEqual(message);
  expect(() => encodeAgentSessionInvalidate({ ...message, launchId: "" })).toThrow();
  expect(() => encodeAgentSessionInvalidate({ ...message, workspaceId: "" })).toThrow();
});

test("round-trips the provider_replay_rejected reason", () => {
  const message = { ...invalidate(), reason: "provider_replay_rejected" as const };
  expect(decodeAgentSessionInvalidate(encodeAgentSessionInvalidate(message))).toEqual(message);
});

test("rejects an invalid reason, protocol, provider, and session id", () => {
  const message = invalidate();
  expect(() =>
    encodeAgentSessionInvalidate({ ...message, reason: "unknown" as "missing" }),
  ).toThrow("invalid session invalidate reason");
  expect(() => encodeAgentSessionInvalidate({ ...message, protocolMajor: 2 })).toThrow(
    "invalid session invalidate protocol/provider",
  );
  expect(() =>
    encodeAgentSessionInvalidate({ ...message, provider: "unknown" as "codex" }),
  ).toThrow("invalid session invalidate protocol/provider");
  expect(() => encodeAgentSessionInvalidate({ ...message, sessionId: "" })).toThrow(
    "invalid session invalidate sessionId",
  );
});

test("rejects an oversized payload", () => {
  expect(() => decodeAgentSessionInvalidate(new Uint8Array(32_769))).toThrow("too large");
});

test("keeps wire tags stable, numbered contiguously (no control-fence fields)", () => {
  const fields = Object.fromEntries(
    AgentSessionInvalidateSchema.fields.map((field) => [field.localName, field.number]),
  );
  expect(fields).toMatchObject({
    protocolMajor: 1,
    requestId: 2,
    workspaceId: 3,
    computerId: 4,
    agentId: 5,
    provider: 6,
    sessionId: 7,
    daemonInstanceId: 8,
    launchId: 9,
    reason: 10,
  });
});
