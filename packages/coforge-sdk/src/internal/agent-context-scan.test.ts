import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentContextScanRequestSchema,
  AgentContextScanResponseSchema,
} from "#src/internal/gen/coforge/rpc/v1/daemon_runtime_pb";
import {
  encodeAgentContextScanRequest,
  decodeAgentContextScanRequest,
  encodeAgentContextScanResponse,
  decodeAgentContextScanResponse,
  AGENT_CONTEXT_SCAN_MESSAGE_TYPE,
  AGENT_CONTEXT_SCAN_RESPONSE_MESSAGE_TYPE,
} from "./index";

function scanRequest() {
  return {
    protocolMajor: 1,
    requestId: "req-1",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "claude-code" as const,
    launchId: "launch",
    sessionId: "native-session",
    messageType: AGENT_CONTEXT_SCAN_MESSAGE_TYPE,
  };
}

function scanResponse() {
  return {
    ...scanRequest(),
    accepted: true,
    status: "available" as const,
    message: undefined,
    reportJson: new TextEncoder().encode(JSON.stringify({ ok: true })),
    messageType: AGENT_CONTEXT_SCAN_RESPONSE_MESSAGE_TYPE,
  };
}

test("context scan request round-trips", () => {
  const message = scanRequest();
  expect(decodeAgentContextScanRequest(encodeAgentContextScanRequest(message))).toEqual(message);
});

test("context scan response round-trips, including its report bytes", () => {
  const message = scanResponse();
  expect(decodeAgentContextScanResponse(encodeAgentContextScanResponse(message))).toEqual(message);
});

test("a response with no report omits reportJson and message on decode", () => {
  const message = {
    ...scanRequest(),
    accepted: false,
    status: "no_session" as const,
    messageType: AGENT_CONTEXT_SCAN_RESPONSE_MESSAGE_TYPE,
  };
  const decoded = decodeAgentContextScanResponse(encodeAgentContextScanResponse(message));
  expect(decoded.reportJson).toBeUndefined();
  expect(decoded.message).toBeUndefined();
  expect(decoded.status).toBe("no_session");
});

test("rejects a request whose on-the-wire messageType names the wrong kind", () => {
  // Bypasses the encode wrapper (which always stamps the correct messageType) to prove the
  // decoder's own guard, not just the encoder's discipline, rejects a mismatched envelope.
  const bytes = toBinary(
    AgentContextScanRequestSchema,
    create(AgentContextScanRequestSchema, {
      ...scanRequest(),
      messageType: AGENT_CONTEXT_SCAN_RESPONSE_MESSAGE_TYPE,
    }),
  );
  expect(() => decodeAgentContextScanRequest(bytes)).toThrow("invalid daemon runtime message type");
});

test("rejects a response whose on-the-wire messageType names the wrong kind", () => {
  const bytes = toBinary(
    AgentContextScanResponseSchema,
    create(AgentContextScanResponseSchema, {
      ...scanResponse(),
      messageType: AGENT_CONTEXT_SCAN_MESSAGE_TYPE,
    }),
  );
  expect(() => decodeAgentContextScanResponse(bytes)).toThrow(
    "invalid daemon runtime message type",
  );
});

test("keeps request wire tags stable, numbered contiguously", () => {
  const fields = Object.fromEntries(
    AgentContextScanRequestSchema.fields.map((field) => [field.localName, field.number]),
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
    messageType: 9,
  });
});

test("keeps response wire tags stable, numbered contiguously", () => {
  const fields = Object.fromEntries(
    AgentContextScanResponseSchema.fields.map((field) => [field.localName, field.number]),
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
    accepted: 9,
    status: 10,
    message: 11,
    reportJson: 12,
    messageType: 13,
  });
});
