import { expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentSessionReportSchema,
  AgentStartIntentSchema,
} from "#src/internal/gen/coforge/rpc/v1/workspace_pb";
import {
  encodeAgentSessionReport,
  decodeAgentSessionReport,
  encodeAgentStartIntent,
  decodeAgentStartIntent,
  AGENT_START_MESSAGE_TYPE,
  RUNTIME_PROVIDER,
} from "./index";

test("session reports round-trip with launch identity and reject missing scope", () => {
  const report = {
    protocolMajor: 1,
    requestId: "report",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    provider: "codex" as const,
    sessionId: "thread",
    startRequestId: "start",
    daemonInstanceId: "daemon",
    launchId: "launch",
    previousLaunchId: "previous",
    replacedSessionId: "missing-original",
  };
  expect(decodeAgentSessionReport(encodeAgentSessionReport(report))).toEqual(report);
  expect(() => encodeAgentSessionReport({ ...report, launchId: "" })).toThrow();
  const intent = { ...report, model: "model", reasoning: "reasoning" };
  expect(decodeAgentStartIntent(encodeAgentStartIntent(intent)).previousLaunchId).toBe("previous");
  for (const sessionMode of ["create", "resume"] as const)
    expect(
      decodeAgentStartIntent(encodeAgentStartIntent({ ...intent, sessionMode })).sessionMode,
    ).toBe(sessionMode);
  expect(() =>
    decodeAgentStartIntent(
      encodeAgentStartIntent({ ...intent, sessionMode: "resume", sessionId: undefined }),
    ),
  ).toThrow("requires a session ID");
});

test("decodes unchanged reports and round-trips optional session snapshot extensions", () => {
  const legacy = {
    protocolMajor: 1,
    requestId: "report",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "codex" as const,
    sessionId: "thread",
    startRequestId: "start",
    daemonInstanceId: "daemon",
    launchId: "launch",
    previousLaunchId: "previous",
    replacedSessionId: "replaced",
  };
  const oldWire = toBinary(AgentSessionReportSchema, create(AgentSessionReportSchema, legacy));
  expect(decodeAgentSessionReport(oldWire)).toEqual(legacy);

  const extended = {
    ...legacy,
    sessionId: "",
    controlEpoch: 7,
    sequence: 8,
    sessionState: "empty" as const,
  };
  expect(decodeAgentSessionReport(encodeAgentSessionReport(extended))).toEqual(extended);
  expect(
    decodeAgentSessionReport(encodeAgentSessionReport({ ...legacy, controlEpoch: 7 })),
  ).toEqual({ ...legacy, controlEpoch: 7 });
});

test("keeps lifecycle extension tags wire-compatible", () => {
  const reportFields = Object.fromEntries(
    AgentSessionReportSchema.fields.map((field) => [field.localName, field.number]),
  );
  const startFields = Object.fromEntries(
    AgentStartIntentSchema.fields.map((field) => [field.localName, field.number]),
  );
  expect(reportFields).toMatchObject({
    previousLaunchId: 11,
    replacedSessionId: 12,
    controlEpoch: 13,
    sequence: 14,
    sessionState: 15,
  });
  expect(startFields).toMatchObject({ previousLaunchId: 16, sessionMode: 17, controlEpoch: 18 });
});

test("rejects invalid report snapshot extensions and missing correlation", () => {
  const report = {
    protocolMajor: 1,
    requestId: "report",
    workspaceId: "workspace",
    computerId: "computer",
    agentId: "agent",
    provider: "codex" as const,
    sessionId: "thread",
    startRequestId: "start",
    daemonInstanceId: "daemon",
    launchId: "launch",
  };
  expect(() => encodeAgentSessionReport({ ...report, controlEpoch: 0 })).toThrow();
  expect(() => encodeAgentSessionReport({ ...report, sequence: 1 })).toThrow();
  expect(() =>
    encodeAgentSessionReport({ ...report, controlEpoch: 1, sessionState: "empty" }),
  ).toThrow();
  expect(() =>
    encodeAgentSessionReport({
      ...report,
      controlEpoch: 1,
      sequence: 1,
      sessionState: "invalid" as "unknown",
    }),
  ).toThrow();
  for (const sessionState of ["resumable", "unknown"] as const)
    expect(() =>
      encodeAgentSessionReport({
        ...report,
        sessionId: "",
        controlEpoch: 1,
        sequence: 1,
        sessionState,
      }),
    ).toThrow();
  expect(() => decodeAgentSessionReport(new Uint8Array(32_769))).toThrow("too large");
});

test("a start intent decodes for every runtime provider and rejects an unknown one", () => {
  const intent = {
    protocolMajor: 1,
    requestId: "start",
    workspaceId: "w",
    computerId: "c",
    agentId: "a",
    model: "model",
    reasoning: "reasoning",
  };
  // Derived from the vocabulary, not listed: the decoder once carried its own literal list, which
  // went stale when Kiro was added and rejected every Kiro Agent's start.
  for (const provider of Object.values(RUNTIME_PROVIDER))
    expect(decodeAgentStartIntent(encodeAgentStartIntent({ ...intent, provider })).provider).toBe(
      provider,
    );
  const unknown = toBinary(
    AgentStartIntentSchema,
    create(AgentStartIntentSchema, {
      ...intent,
      messageType: AGENT_START_MESSAGE_TYPE,
      provider: "nope",
    }),
  );
  expect(() => decodeAgentStartIntent(unknown)).toThrow("unsupported runtime provider: nope");
});
